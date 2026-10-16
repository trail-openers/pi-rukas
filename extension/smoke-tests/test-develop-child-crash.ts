#!/usr/bin/env bun
/**
 * #1403 — a develop child that DIES mid-pass must not be accounted as a
 * finished pass, and the work it left in its worktree must not be dropped.
 *
 * The incident (tehas cycle 238-261015-223744): in develop round 3 the
 * developer child's engine exited non-zero. The step was reported
 * `step-completed ... develop, round 3, recovered: false`, the safety net
 * never logged its `tree clean` line for that round, and the fix the dead
 * pass had already written sat uncommitted in the worktree while the
 * consolidated branch carried only the earlier commits.
 *
 * Three defects, three groups of assertions:
 *
 *  (A) ACCOUNTING — the dead child's workstream enters the fan-out verdicts
 *      with a reason naming the process-level failure. Pre-fix it never
 *      entered the verdicts at all when it was the only workstream, so
 *      `branches-converged` read `[{default, ok: true}]` and the step
 *      completed normally.
 *
 *  (B) THE VICTIM'S OWN VERDICT — the #679 "any evidence" probe and the
 *      #1403 verdict filter agree on ONE predicate: a worktree left dirty
 *      with no commits ahead of its base is evidence nobody has judged, so
 *      the safety net runs on it and either commits it or notes why it did
 *      not. A pass that merely claimed success with an empty tree does NOT
 *      drag a sibling's evidence into its own commit.
 *
 *  (C) THE CRASH IS ITS OWN FACT — a structured `childCrash` record on the
 *      state, distinct from `capHit`/`capEvidence`, naming the dead child,
 *      its exit code, and the paths left uncommitted.
 *
 * No real Pi spawn: every dispatch is mocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import { hasAnyWorktreeEvidence } from "../src/work-driver-safety-net.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import {
  type WorkEvent,
  type WorkState,
  initialState,
  readState,
  writeState,
} from "../src/workflow-state.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "developer",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

/** The dead-child shape: the process exited non-zero with no structured kill. */
const deadChild = (): DispatchResult => mkResult({ ok: false, text: "", exitCode: 1 });

/** The provider error-stop shape (exit 0, synthetic stopReason: "error"). */
const providerStopped = (): DispatchResult =>
  mkResult({ ok: false, text: "", exitCode: 0, errorStop: { reason: "error", message: "boom" } });

const developStarts = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).filter((e) => e.kind === "step-started" && e.step === "develop").length;
const developCapped = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).some((e) => e.kind === "cap-hit" && e.cap === "step-failed:develop");
const safetyNetEvents = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).filter((e) => e.kind === "safety-net-commit");
const childCrashRecords = (s: WorkState | undefined) =>
  ((s?.pipelineState as { childCrash?: unknown[] } | undefined)?.childCrash ?? []) as Array<{
    workstreamId: string;
    kind: string;
    paths?: string[];
    committed?: string[];
    exitCode?: number | null;
  }>;
const convergedOf = (s: WorkState | undefined) =>
  [...(s?.eventLog ?? [])]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged" && e.step === "develop",
    );

// The outcome-verification gate needs the project's verify command; it is not
// what is under test (the incident's gate never ran because the step looked ok).
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

/**
 * Run a develop step from a seeded state with one worktree per workstream id.
 * `developer(label, attempt, cwd)` decides what that dispatch does; a returned
 * result is used verbatim, and by default a "commit"/"dirty" outcome is
 * produced for the matching keyword.
 */
async function runDevelop(
  issue: number,
  ids: string[],
  developer: (
    label: string,
    attempt: number,
    cwd: string,
  ) => Promise<DispatchResult> | DispatchResult,
): Promise<{ labels: string[]; dir: string; after: WorkState | undefined }> {
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-child-crash-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ids);
    const worktrees: Record<string, string> = {};
    const workstreams: Record<string, unknown> = {};
    for (const id of ids) {
      worktrees[id] = `${dir}/.worktrees/${id}`;
      workstreams[id] = { id, scope: id, paths: [], outOfScope: [] };
    }
    const s = initialState(issue, 1_000_000);
    await writeState(dir, {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees,
        workstreams,
        workstreamBaseShas: shas,
        branchName: `feature/issue-${issue}-child-crash`,
      },
    });
    const labels: string[] = [];
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async (n) => ({ stdout: `title:\tmock #${n}\n\nmock body` }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = opts?.label ?? spec.role;
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role !== "developer") throw new Error(`smoke: halting at ${label}`);
        labels.push(label);
        const cwd = spec.cwd ?? dir;
        const out = await developer(label, labels.filter((l) => l === label).length, cwd);
        return out;
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    return { labels, dir, after: await readState(dir, issue) };
  } finally {
    // The caller inspects the worktrees after the run; keep them on disk by
    // copying the verdict out — the temp dir is removed by the caller.
  }
}

// ---------------------------------------------------------------------------
// (A) N=1 — the dead pass's verdict names the crash; the step never reports done
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-child-crash-n1-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ["default"]);
    const wt = `${dir}/.worktrees/default`;
    const s = initialState(1401, 1_000_000);
    await writeState(dir, {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "default", paths: [], outOfScope: [] } },
        workstreamBaseShas: shas,
        branchName: "feature/issue-1401-child-crash",
      },
    });
    const labels: string[] = [];
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue: 1401,
      issueBodyFetcherFn: async (n) => ({ stdout: `title:\tmock #${n}\n\nmock body` }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = opts?.label ?? spec.role;
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role !== "developer") throw new Error(`smoke: halting at ${label}`);
        labels.push(label);
        // The dead pass writes the fix into the tree and then its engine dies.
        writeFileSync(path.join(spec.cwd ?? dir, "libexec-stop"), "lock fix\n");
        return deadChild();
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 1401);

    const conv = convergedOf(after);
    assert(
      conv !== undefined && conv.verdicts.length === 1 && conv.verdicts[0]?.ok === false,
      `(A) N=1 dead child: the converged verdict is ok:false, not a bare ok (got ${JSON.stringify(
        conv?.verdicts,
      )})`,
    );
    assert(
      conv?.verdicts[0]?.reason !== undefined &&
        /exit code 1/i.test(conv.verdicts[0]?.reason ?? ""),
      `(A) the verdict reason names the process-level failure (got ${JSON.stringify(
        conv?.verdicts[0]?.reason,
      )})`,
    );
    assert(
      after?.pipelineState.status !== "success" &&
        (after?.eventLog ?? []).some((e) => e.kind === "dispatch-failed"),
      `(A) the step is not recorded as an ordinary success (status ${after?.pipelineState.status})`,
    );
    assert(developCapped(after), "(A) the develop step halts with a named cap");
    assert(labels.length >= 1, `(A) the developer was dispatched (${labels.join(",")})`);

    const crash = childCrashRecords(after);
    assert(
      crash.length >= 1 &&
        crash.every((c) => c.workstreamId === "default") &&
        crash.every((c) => c.crash === "engine-exit") &&
        crash[0]?.exitCode === 1,
      `(C) the state carries a structured childCrash record naming the child + exit code (got ${JSON.stringify(
        crash,
      )})`,
    );
    const dirty = (after?.pipelineState as { developLeftover?: Record<string, string[]> })
      ?.developLeftover;
    assert(
      dirty !== undefined && (dirty.default ?? []).includes("libexec-stop"),
      `(C) the uncommitted paths the dead pass left behind are recorded (got ${JSON.stringify(
        dirty,
      )})`,
    );
    assert(
      safetyNetEvents(after).length === 1,
      "(B) the dead pass's own uncommitted work is committed by the safety net",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (A2) N=1 — a clean crash leaves no leftovers claim, but is still a crash
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-child-crash-clean-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ["default"]);
    const wt = `${dir}/.worktrees/default`;
    const s = initialState(1402, 1_000_000);
    await writeState(dir, {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "default", paths: [], outOfScope: [] } },
        workstreamBaseShas: shas,
        branchName: "feature/issue-1402-child-crash",
      },
    });
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue: 1402,
      issueBodyFetcherFn: async (n) => ({ stdout: `title:\tmock #${n}\n\nmock body` }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = opts?.label ?? spec.role;
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role !== "developer") throw new Error(`smoke: halting at ${label}`);
        return deadChild();
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 1402);
    const crash = childCrashRecords(after);
    assert(crash.length >= 1, "(C) a crash with a clean tree is still recorded as a crash");
    assert(
      (crash[0]?.paths ?? []).length === 0 && crash[0]?.committed === undefined,
      `(C) and says so: no paths left uncommitted (got ${JSON.stringify(crash[0])})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (A3) N>1 — a dead child among healthy siblings does not converge ok
// ---------------------------------------------------------------------------
{
  const { labels, after } = await runDevelop(1403, ["a", "b"], (label, attempt, cwd) => {
    if (label === "developer[b]") return deadChild();
    if (attempt === 1) return deadChild(); // first pass of a dies too -> retry
    gitIn(cwd, ["commit", "--allow-empty", "-qm", `work ${label}`]);
    return mkResult();
  });
  const conv = convergedOf(after);
  assert(
    conv?.verdicts.find((v) => v.id === "b")?.ok === false,
    `(A) N>1 dead child: workstream b's verdict is ok:false (got ${JSON.stringify(conv?.verdicts)})`,
  );
  assert(developCapped(after), "(A) the fan-out halts rather than advancing to adversarial");
  assert(labels.includes("developer[b]"), `(A) b was dispatched (${labels.join(",")})`);
  const crash = childCrashRecords(after);
  assert(
    crash.some((c) => c.workstreamId === "b"),
    `(C) the crash names b (got ${JSON.stringify(crash)})`,
  );
}

// ---------------------------------------------------------------------------
// (B) A claimed-ok empty pass must NOT inherit a sibling's uncommitted evidence
// ---------------------------------------------------------------------------
{
  // Unit level: the evidence probe still reports the dirty tree…
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-child-crash-evid-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ["a", "b"]);
    const state = initialState(1404, 1_000_000);
    const withState: WorkState = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        currentStep: "develop",
        worktrees: { a: `${dir}/.worktrees/a`, b: `${dir}/.worktrees/b` },
        baseSha: shas.a,
        workstreamBaseShas: shas,
      },
    };
    writeFileSync(`${dir}/.worktrees/a/left.ts`, "evidence\n");
    const ctx = { repoRoot: dir } as unknown as CycleContext;
    const evidence = await hasAnyWorktreeEvidence(ctx, withState);
    assert(evidence === true, "(B) a dirty worktree anywhere is evidence the gates must judge");

    // …but the safety net's per-workstream eligibility is the SAME predicate:
    // a workstream that has nothing of its own is not eligible.
    const { safetyNetWorktree } = await import("../src/work-driver-safety-net.ts");
    const notes: string[] = [];
    const ev = await safetyNetWorktree(
      "b",
      dir,
      `${dir}/.worktrees/b`,
      shas.b,
      async (_cmd, opts) => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const p = promisify(execFile);
        return p("git", ["-C", opts.cwd, ...(_cmd as unknown as string[])]);
      },
      notes,
    );
    assert(ev === undefined, "(B) a workstream with a clean tree commits nothing of its own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (B2) End-to-end: a dead child's uncommitted fix reaches a commit
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-child-crash-commit-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ["default"]);
    const wt = `${dir}/.worktrees/default`;
    const s = initialState(1405, 1_000_000);
    await writeState(dir, {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "default", paths: [], outOfScope: [] } },
        workstreamBaseShas: shas,
        branchName: "feature/issue-1405-child-crash",
      },
    });
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue: 1405,
      issueBodyFetcherFn: async (n) => ({ stdout: `title:\tmock #${n}\n\nmock body` }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = opts?.label ?? spec.role;
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role !== "developer") throw new Error(`smoke: halting at ${label}`);
        writeFileSync(path.join(spec.cwd ?? dir, "the-fix.ts"), "the fix\n");
        return deadChild();
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 1405);
    const ahead = gitIn(wt, ["rev-list", "--count", `${shas.default}..HEAD`]);
    assert(
      Number(ahead) >= 1,
      `(B) the dead pass's fix is committed, not left in the tree (${ahead.trim()} commit(s))`,
    );
    const crash = childCrashRecords(after);
    assert(
      crash.length === 1 && (crash[0]?.committed ?? []).includes("the-fix.ts"),
      `(C) the crash record names what the driver committed (got ${JSON.stringify(crash[0])})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (D) A provider error-stop (exit 0) is a crash too — and stays non-crash shaped
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-child-crash-provider-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ["default"]);
    const wt = `${dir}/.worktrees/default`;
    const s = initialState(1406, 1_000_000);
    await writeState(dir, {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: wt },
        workstreams: { default: { id: "default", scope: "default", paths: [], outOfScope: [] } },
        workstreamBaseShas: shas,
        branchName: "feature/issue-1406-child-crash",
      },
    });
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue: 1406,
      issueBodyFetcherFn: async (n) => ({ stdout: `title:\tmock #${n}\n\nmock body` }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = opts?.label ?? spec.role;
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role !== "developer") throw new Error(`smoke: halting at ${label}`);
        writeFileSync(path.join(spec.cwd ?? dir, "partial.ts"), "partial\n");
        return providerStopped();
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 1406);
    const crash = childCrashRecords(after);
    assert(
      crash.length >= 1 && crash.every((c) => c.crash === "provider-error-stop"),
      `(D) an exit-0 error-stop is recorded as its own crash kind (got ${JSON.stringify(crash)})`,
    );
    assert(
      (after?.eventLog ?? []).some((e) => e.kind === "dispatch-failed-provider"),
      "(D) and still routes through the provider-error event, not a process failure",
    );
    assert(developStarts(after) >= 1, "(D) the step ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

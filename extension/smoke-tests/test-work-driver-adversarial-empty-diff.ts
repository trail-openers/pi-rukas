#!/usr/bin/env bun
/**
 * Smoke test for #286: adversarial empty-diff short-circuit.
 *
 * Covers:
 * - Single workstream empty diff → no adversarial dispatch, skip event, ok verdict.
 * - Mixed case: 2 workstreams, one empty + one real → exactly 1 adversarial invocation.
 * - All-empty case → adversarial-approved with rounds=0 and both skip events.
 * - Env kill-switch (PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP=0) restores old behaviour.
 * - Schema is additive only (new event kind, v1 state files load unchanged).
 *
 * No real Pi spawn happens; all adversarialLoopFn calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkEvent, initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body`,
});

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

// Disable features not under test.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

// Helper: seed state at the adversarial step.
async function seedAdversarialState(
  dir: string,
  issue: number,
  worktrees: Record<string, string>,
  workstreams?: Record<
    string,
    { id: string; scope: string; paths: string[]; outOfScope: string[] }
  >,
) {
  const ws = workstreams ?? {
    default: { id: "default", scope: "test", paths: [], outOfScope: [] },
  };
  const s = {
    ...initialState(issue, 1_000_000),
    pipelineState: {
      ...initialState(issue, 1_000_000).pipelineState,
      currentStep: "adversarial" as const,
      lastCompletedStep: "develop" as const,
      worktrees,
      workstreams: ws,
      branchName: `feature/issue-${issue}`,
    },
  };
  await writeState(dir, s);
}

// ============================================================================
// T1 — Single workstream, empty diff → skip
// ============================================================================
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-empty-single-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    // Seed a git repo so fetchDiff can run (returns empty since nothing changed).
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp(
      'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );

    await seedAdversarialState(dir, 286, { default: dir });

    let adversarialCalls = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 286,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () => {
        adversarialCalls++;
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          text: "APPROVED after round 1",
          loopOutcome: "approved",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "pr: 9999" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 286);
    const events = after?.eventLog ?? [];

    assert(adversarialCalls === 0, "#286 T1: NO adversarial dispatch for empty diff");

    const skipEvents = events.filter((e) => e.kind === "adversarial-skipped-empty-diff") as Extract<
      WorkEvent,
      { kind: "adversarial-skipped-empty-diff" }
    >[];
    assert(skipEvents.length === 1, "#286 T1: one adversarial-skipped-empty-diff event");
    assert(
      skipEvents[0]?.workstreamId === "default",
      "#286 T1: skip event carries workstreamId=default",
    );

    // Skipped workstream counts as ok → aggregate is adversarial-approved.
    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(approved !== undefined, "#286 T1: adversarial-approved aggregate fires");
    if (approved?.kind === "adversarial-approved") {
      assert(approved.rounds === 0, "#286 T1: aggregate rounds=0 (no reviews ran)");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// T2 — Mixed case: 2 workstreams, one empty + one real → exactly 1 invocation
// ============================================================================
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-empty-mixed-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    // Create two sub-dirs — one clean (empty diff), one with staged changes.
    const emptyDir = path.join(dir, "empty");
    const realDir = path.join(dir, "real");
    await fs.mkdir(emptyDir, { recursive: true });
    await fs.mkdir(realDir, { recursive: true });

    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // emptyDir: init + commit, nothing modified → empty diff.
    await execp("git init -q", { cwd: emptyDir });
    await execp(
      'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
      { cwd: emptyDir, shell: "/bin/bash" },
    );

    // realDir: init + commit + modified file → non-empty diff.
    await execp("git init -q", { cwd: realDir });
    await execp(
      'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
      { cwd: realDir, shell: "/bin/bash" },
    );
    await fs.writeFile(path.join(realDir, "foo.txt"), "modified content");
    await execp("git add foo.txt", { cwd: realDir });

    await seedAdversarialState(
      dir,
      287,
      {
        "task-a": emptyDir,
        "task-b": realDir,
      },
      {
        "task-a": { id: "task-a", scope: "empty work", paths: [], outOfScope: [] },
        "task-b": { id: "task-b", scope: "real work", paths: ["foo.txt"], outOfScope: [] },
      },
    );

    let adversarialCalls = 0;
    let lastDiff: string | undefined;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 287,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        adversarialCalls++;
        lastDiff = params.diff;
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          text: "APPROVED after round 1",
          loopOutcome: "approved",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "pr: 9999" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 287);
    const events = after?.eventLog ?? [];

    assert(
      adversarialCalls === 1,
      `#286 T2: exactly 1 adversarial invocation (got ${adversarialCalls})`,
    );
    assert(
      lastDiff?.includes("modified content") || lastDiff?.length > 0,
      "#286 T2: adversarial received non-empty diff for task-b",
    );

    // One skip event (task-a) + one approved for task-b.
    const skipEvents = events.filter((e) => e.kind === "adversarial-skipped-empty-diff") as Extract<
      WorkEvent,
      { kind: "adversarial-skipped-empty-diff" }
    >[];
    assert(skipEvents.length === 1, "#286 T2: exactly 1 skip event");
    assert(skipEvents[0]?.workstreamId === "task-a", "#286 T2: skip event for task-a (empty)");

    // Aggregate verdict: task-a ok (skip) + task-b ok (approved) → approved.
    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(approved !== undefined, "#286 T2: adversarial-approved aggregate (mixed ok)");

    // branches-converged has both workstreams.
    const converged = events.find((e) => e.kind === "branches-converged");
    assert(converged !== undefined, "#286 T2: branches-converged present");
    if (converged?.kind === "branches-converged") {
      assert(converged.verdicts.length === 2, "#286 T2: branches-converged has 2 verdicts");
      assert(
        converged.verdicts.every((v) => v.ok === true),
        "#286 T2: all verdicts ok (skip + approved)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// T3 — All-empty case → adversarial-approved with rounds=0 and both skip events
// ============================================================================
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-empty-all-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    const emptyA = path.join(dir, "a");
    const emptyB = path.join(dir, "b");
    await fs.mkdir(emptyA, { recursive: true });
    await fs.mkdir(emptyB, { recursive: true });

    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    for (const d of [emptyA, emptyB]) {
      await execp("git init -q", { cwd: d });
      await execp(
        'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
        { cwd: d, shell: "/bin/bash" },
      );
    }

    await seedAdversarialState(
      dir,
      288,
      {
        "task-a": emptyA,
        "task-b": emptyB,
      },
      {
        "task-a": { id: "task-a", scope: "empty", paths: [], outOfScope: [] },
        "task-b": { id: "task-b", scope: "empty", paths: [], outOfScope: [] },
      },
    );

    let adversarialCalls = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 288,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () => {
        adversarialCalls++;
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          text: "APPROVED after round 1",
          loopOutcome: "approved",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "pr: 9999" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 288);
    const events = after?.eventLog ?? [];

    assert(adversarialCalls === 0, "#286 T3: NO adversarial dispatch (all empty)");

    const skipEvents = events.filter((e) => e.kind === "adversarial-skipped-empty-diff") as Extract<
      WorkEvent,
      { kind: "adversarial-skipped-empty-diff" }
    >[];
    assert(skipEvents.length === 2, `#286 T3: 2 skip events (got ${skipEvents.length})`);
    const skipIds = skipEvents.map((e) => e.workstreamId).sort();
    assert(
      JSON.stringify(skipIds) === JSON.stringify(["task-a", "task-b"]),
      "#286 T3: skip events cover both workstreams",
    );

    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(approved !== undefined, "#286 T3: adversarial-approved aggregate fires (all empty)");
    if (approved?.kind === "adversarial-approved") {
      assert(approved.rounds === 0, "#286 T3: aggregate rounds=0");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// T4 — Env kill-switch restores old behaviour (reviewer spawned on empty diff)
// ============================================================================
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-empty-killswitch-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp(
      'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );

    await seedAdversarialState(dir, 289, { default: dir });

    // Temporarily disable the skip.
    const origSkip = process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP;
    process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

    let adversarialCalls = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 289,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () => {
        adversarialCalls++;
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          text: "APPROVED after round 1",
          loopOutcome: "approved",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "pr: 9999" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    try {
      await runWorkDriver(ctx).catch(() => {});

      const after = await readState(dir, 289);
      const events = after?.eventLog ?? [];

      assert(
        adversarialCalls === 1,
        `#286 T4: adversarial WAS called with kill-switch (got ${adversarialCalls})`,
      );

      const skipEvents = events.filter((e) => e.kind === "adversarial-skipped-empty-diff");
      assert(skipEvents.length === 0, "#286 T4: NO skip event with kill-switch active");

      const approved = events.find((e) => e.kind === "adversarial-approved");
      assert(approved !== undefined, "#286 T4: adversarial-approved fires (loop ran normally)");
    } finally {
      // Restore env.
      if (origSkip === undefined) {
        delete process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP;
      } else {
        process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = origSkip;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// T5 — Schema is additive only: v1 state files with new event kind load fine
// ============================================================================
{
  // The new event kind is added to the discriminated union. Older readers
  // that don't recognise it will still parse the JSON (they just won't
  // match the kind). No schema bump needed — same as lens-skipped-empty-diff.
  const s = initialState(290, 1_000_000);
  assert(s.schemaVersion === 1, "#286 T5: schema version is still 1");

  // Verify the event can be appended and round-trips.
  const { appendEvent } = await import("../src/workflow-state.ts");
  const s2 = appendEvent(s, {
    kind: "adversarial-skipped-empty-diff",
    at: 1_000_100,
    workstreamId: "default",
  });
  assert(s2.eventLog.length === 1, "#286 T5: event appended to log");
  assert(
    s2.eventLog[0]?.kind === "adversarial-skipped-empty-diff",
    "#286 T5: event kind preserved",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

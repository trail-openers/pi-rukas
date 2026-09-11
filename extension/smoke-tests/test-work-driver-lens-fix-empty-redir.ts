#!/usr/bin/env bun
/**
 * #654 — empty-diff shape: re-dispatch the fix ONCE with explicit no-diff
 * evidence rather than re-flagging identical findings at escalating severity.
 *
 * The #492 no-diff cap parks the cycle when a lens-fix dispatch writes
 * nothing. The fix developer may have narrated the fix without writing it,
 * or edited the wrong tree. #654's answer: the NEXT lens-fix entry
 * re-dispatches the fix ONCE with the explicit finding that the previous fix
 * wrote nothing (naming the worktree path verbatim). After that one
 * re-dispatch, the existing round cap / the #492 no-diff cap handles the
 * outcome — the same findings are never re-flagged at escalating severity
 * without an intervening diff change.
 *
 * Split out of test-work-driver-lens-fix-edge-cases.ts (500-line gate).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { countLensFixEmptyResends } from "../src/work-driver-lens.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

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
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_FORGE = "none";

setupSpawnGuard();

// #654 — the re-dispatch runs at most ONCE per review round. A second
// lens-fix entry in the same round (after the re-dispatch already ran and
// still produced no diff) must NOT re-dispatch again — it goes through the
// normal dispatch, and the existing cap handles the outcome. This is the
// "re-dispatch the fix ONCE" bound.
//
// The pre-seeded state carries a lens-fix-empty-resend event (the re-dispatch
// already fired), so runLensFix's countLensFixEmptyResends returns 1, and it
// must NOT emit a second resend event. The lens-fix dispatch that runs is the
// normal one (no RE-DISPATCH prompt), and the existing no-diff cap parks the
// cycle.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-empty-once-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    const origin = path.join(dir, "origin.git");
    const root = path.join(dir, "root");
    const wt = path.join(dir, "wt");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(dir, "root", ".git", "info", "exclude"), "\n.pi/\n");
    await fs.writeFile(path.join(root, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/lens-empty-once", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "ok\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/lens-empty-once", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });

    const findingsBlob = JSON.stringify([
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "feature.txt",
        line: 1,
        title: "trivial",
        description: "nothing to fix",
        suggestion: "leave as is",
      },
    ]);

    let s = initialState(655, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "adversarial",
        worktrees: { default: wt },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/lens-empty-once",
        prNumber: 6550,
        reviewRound: 1,
      },
      eventLog: [
        // The re-dispatch already happened this round (one resend recorded),
        // the re-review found the issue again, and the cycle re-entered
        // lens-fix. This entry must NOT re-dispatch a second time — it goes
        // through the normal dispatch, and the existing cap handles the
        // outcome.
        {
          kind: "lens-issues-found" as const,
          at: 1_100_000,
          jobId: "j-lens-1",
          round: 1,
          findings: findingsBlob,
          verdict: "ISSUES_FOUND" as const,
        },
        {
          kind: "lens-fix-empty-resend" as const,
          at: 1_150_000,
          jobId: "j-resend-1",
          round: 1,
          worktree: wt,
          evidence: `git status --porcelain at ${wt} was empty`,
        },
      ],
    };
    await writeState(root, s);

    const lensFixPrompts: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: root,
      issue: 655,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label?.startsWith("developer:lens-fix")) {
          lensFixPrompts.push(spec.prompt);
          return mkResult({ role: "developer", ok: true, text: "nothing-to-fix: false positive" });
        }
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () => {
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        });
      },
      lensReviewFn: async () => {
        return mkLensSummary({
          verdict: "ISSUES_FOUND",
          totalFindings: 1,
          findings: [
            {
              severity: "MEDIUM",
              lens: "SIMPLICITY",
              path: "feature.txt",
              line: 1,
              title: "trivial",
            },
          ],
        } as never);
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(root, 655);
    const events = after?.eventLog ?? [];
    const resends = events.filter((e) => e.kind === "lens-fix-empty-resend");
    // The pre-seeded resend is already in the log; the driver must NOT add a
    // second one (the re-dispatch ran once already this round).
    assert(
      resends.length === 1,
      `no second re-dispatch in the same round (got ${resends.length} resend events)`,
    );
    // The lens-fix dispatch that ran must NOT carry the RE-DISPATCH prompt
    // (the re-dispatch already happened; this is the normal dispatch).
    const reDispatchPrompt = lensFixPrompts.find((p) => p.includes("RE-DISPATCH"));
    assert(
      reDispatchPrompt === undefined,
      "a second lens-fix entry in the same round does not re-dispatch with the RE-DISPATCH prompt",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #654 — unit test for countLensFixEmptyResends: the re-dispatch budget
// counter. It counts lens-fix-empty-resend events AFTER the current round's
// lens-issues-found anchor, so re-dispatches from earlier rounds don't count
// against the current round's budget. The re-dispatch fires when the count
// is >= 1 (a prior re-dispatch in THIS round already wrote nothing).
{
  // No events → 0.
  assert(countLensFixEmptyResends([], 1) === 0, "countLensFixEmptyResends: empty log → 0");

  // One lens-issues-found (round 1), no resend events → 0.
  assert(
    countLensFixEmptyResends([{ kind: "lens-issues-found", round: 1 }], 1) === 0,
    "countLensFixEmptyResends: lens-issues-found only → 0",
  );

  // One lens-issues-found (round 1) + one resend (round 1) → 1.
  assert(
    countLensFixEmptyResends(
      [
        { kind: "lens-issues-found", round: 1 },
        { kind: "lens-fix-empty-resend", round: 1 },
      ],
      1,
    ) === 1,
    "countLensFixEmptyResends: one resend in the same round → 1",
  );

  // A resend from a PRIOR round (round 1) does NOT count against round 2.
  assert(
    countLensFixEmptyResends(
      [
        { kind: "lens-issues-found", round: 1 },
        { kind: "lens-fix-empty-resend", round: 1 },
        { kind: "lens-issues-found", round: 2 },
      ],
      2,
    ) === 0,
    "countLensFixEmptyResends: prior-round resend does not count for the current round",
  );

  // Two resends in the same round → 2.
  assert(
    countLensFixEmptyResends(
      [
        { kind: "lens-issues-found", round: 1 },
        { kind: "lens-fix-empty-resend", round: 1 },
        { kind: "lens-fix-empty-resend", round: 1 },
      ],
      1,
    ) === 2,
    "countLensFixEmptyResends: two resends in the same round → 2",
  );

  // The anchor is the LATEST lens-issues-found for the given round. A resend
  // BEFORE the latest anchor does not count.
  assert(
    countLensFixEmptyResends(
      [
        { kind: "lens-issues-found", round: 1 },
        { kind: "lens-fix-empty-resend", round: 1 },
        { kind: "lens-issues-found", round: 1 },
      ],
      1,
    ) === 0,
    "countLensFixEmptyResends: resend before the latest anchor does not count",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

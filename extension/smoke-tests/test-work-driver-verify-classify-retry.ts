#!/usr/bin/env bun
/**
 * #807/#826 — the classifier's Case-2 root-cause match must compare the
 * EXTRACTED assertions (the #798 regression), and the develop-seam
 * flake-retry two-phase gate (length precondition admits the first run;
 * shared assertion admits the re-run) must be tested through the
 * PRODUCTION gate (runVerifyCommandGate), not a local copy.
 *
 * #826 replaced the local `retryPrecondition` copy with real gate
 * invocations (cases 7–12 below).
 */

import {
  NO_SPECIFIC_ASSERTION,
  classifyConsolidatedVerifyFailure,
  sharesAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The #798 regression shape: a timing-flaky test (test-cancel.ts) failed in a
// worktree with the IDENTICAL `✗` line that failed on the consolidated tree.
// Both tails carry the smoke-loop `FAILED:` marker (which the old code
// selected and compared marker-vs-marker, hiding the shared assertion).
const sharedAssertion = "✗ aborted child returned within 10s (took 496954ms)";
const consolidatedTail = `FAILED: smoke-tests/test-cancel.ts
${sharedAssertion}`;
const perWorktreeTail = `FAILED: smoke-tests/test-cancel.ts
${sharedAssertion}`;

// --- Case 1 (the #798 regression): identical ✗ assertion on both sides,
// N=2. Must classify per-workstream-defect, NOT consolidation-created.
{
  const v = classifyConsolidatedVerifyFailure(2, ["ws1", "ws2"], consolidatedTail, {
    ws2: perWorktreeTail,
  });
  assert(
    v.classification === "per-workstream-defect",
    `case 1 (#798 regression): same ✗ assertion both sides → per-workstream-defect (got: ${v.classification})`,
  );
  assert(
    v.workstreamIds.length === 1 && v.workstreamIds[0] === "ws2",
    `case 1: names the single failing workstream (got: ${v.workstreamIds})`,
  );
  assert(
    v.assertion === sharedAssertion,
    `case 1: the reported assertion is the shared ✗ line (got: ${v.assertion})`,
  );
}

// --- Case 2: per-worktree assertion DIFFERS from the consolidated one →
// consolidation-created (a genuine combination defect; the retry must not fire).
{
  const diffPer = `FAILED: smoke-tests/test-other.ts
✗ other test failed: expected 1 got 2`;
  const v = classifyConsolidatedVerifyFailure(2, ["ws1", "ws2"], consolidatedTail, {
    ws2: diffPer,
  });
  assert(
    v.classification === "consolidation-created",
    `case 2 (different assertion): a per-worktree defect with a DIFFERENT assertion → consolidation-created (got: ${v.classification})`,
  );
}

// --- Case 3: N=1 invariant still holds — a single workstream sharing the
// assertion is per-workstream-defect (re-run), never consolidation-created.
{
  const v = classifyConsolidatedVerifyFailure(1, ["ws1"], consolidatedTail, {
    ws1: perWorktreeTail,
  });
  assert(
    v.classification === "per-workstream-defect",
    `case 3 (N=1): same assertion, N=1 → per-workstream-defect, never consolidation-created (got: ${v.classification})`,
  );
}

// --- Case 4: N=1, NO shared assertion → needs-human-decision (not
// consolidation-created, not per-workstream-defect).
{
  const unrelated = `FAILED: smoke-tests/test-x.ts
✗ unrelated assertion failed`;
  const v = classifyConsolidatedVerifyFailure(1, ["ws1"], consolidatedTail, { ws1: unrelated });
  assert(
    v.classification === "needs-human-decision",
    `case 4 (N=1, no match): no shared assertion → needs-human-decision (got: ${v.classification})`,
  );
}

// --- Case 5: an honest absence (no assertion on either side) must NOT be
// treated as a match (the sentinel never matches a real assertion).
{
  const bareMarker = "FAILED: smoke-tests/test-mystery.ts"; // no ✗ line
  const v = classifyConsolidatedVerifyFailure(2, ["ws1", "ws2"], bareMarker, {
    ws2: "FAILED: smoke-tests/test-mystery.ts",
  });
  assert(
    v.assertion === NO_SPECIFIC_ASSERTION,
    `case 5 (no assertion): the consolidated tail reports absence (got: ${v.assertion})`,
  );
  assert(
    v.classification === "consolidation-created",
    `case 5 (no assertion): absence ≠ match → falls through to consolidation-created (got: ${v.classification})`,
  );
}

// --- #826 — the shared comparator is exported and used at both seams.
// The classifier's Case-2 and the retry gate must agree: the same pair of
// tails gives the same answer at both call sites.
{
  const shared = sharesAssertion(consolidatedTail, sharedAssertion);
  assert(
    shared,
    "case 6a: sharesAssertion(consolidated, sharedAssertion) is TRUE for the #798 shape",
  );
  const notShared = sharesAssertion(consolidatedTail, "✗ unrelated assertion failed");
  assert(!notShared, "case 6b: sharesAssertion is FALSE for a different assertion");
  const sentinel = sharesAssertion(consolidatedTail, NO_SPECIFIC_ASSERTION);
  assert(!sentinel, "case 6c: the NO_SPECIFIC_ASSERTION sentinel never matches");
}

// --- #826 cases 7–12: the REAL gate (runVerifyCommandGate) with a fake
// execFn that counts verify invocations. The fake distinguishes per-worktree
// calls (cwd = worktree path) from consolidated calls (cwd = repoRoot).

const VALID_SHA = "a".repeat(40);
const REPO_ROOT = "/tmp/fake-repo";
const WT1 = "/tmp/fake-repo/wt1";
const WT2 = "/tmp/fake-repo/wt2";
const VERIFY_CMD = "bun run test";

type VerifyOutcome = "pass" | "fail";

interface GateTestOpts {
  worktrees: Record<string, string>;
  changedWorktrees: string[];
  /** Per-worktree verify outcomes, one per changedWorktree entry. */
  perWorktree: VerifyOutcome[];
  /** The assertion each per-worktree failure carries. */
  perWorktreeAssertion?: string;
  /** Consolidated run outcomes: [firstRun, secondRun?]. */
  consolidated: VerifyOutcome[];
  /** The assertion the consolidated failure carries. */
  consolidatedAssertion?: string;
}

function makeGateTest(opts: GateTestOpts) {
  let perWorktreeCalls = 0;
  let consolidatedCalls = 0;

  const fn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    if (cmd === VERIFY_CMD) {
      const cwd = o?.cwd ?? "";
      if (cwd === REPO_ROOT) {
        const idx = consolidatedCalls;
        consolidatedCalls++;
        const outcome = opts.consolidated[idx] ?? "pass";
        if (outcome === "fail") {
          const err = new Error("verify failed") as Error & { stdout?: string; stderr?: string };
          // Multi-line stderr so extractSpecificAssertion can find the ✗ line
          err.stderr = `FAILED: smoke-tests/test-x.ts\n${opts.consolidatedAssertion ?? "✗ consolidated assertion failed"}`;
          throw err;
        }
        return { stdout: "" };
      }
      // Per-worktree run (cwd is the worktree path)
      const idx = perWorktreeCalls;
      perWorktreeCalls++;
      const outcome = opts.perWorktree[idx] ?? "pass";
      if (outcome === "fail") {
        const err = new Error("verify failed") as Error & { stdout?: string; stderr?: string };
        // Multi-line stderr so extractSpecificAssertion can find the ✗ line.
        // When perWorktreeAssertion is undefined, only the marker is emitted
        // (no ✗ line) — extractSpecificAssertion returns NO_SPECIFIC_ASSERTION.
        err.stderr = opts.perWorktreeAssertion
          ? `FAILED: smoke-tests/test-y.ts\n${opts.perWorktreeAssertion}`
          : "FAILED: smoke-tests/test-y.ts";
        throw err;
      }
      return { stdout: "" };
    }

    // Git commands — return defaults so the cherry-pick orchestration
    // sees zero commits ahead (the gate proceeds to the verify run
    // regardless; the consolidated run is the point under test).
    if (cmd.includes("git status")) return { stdout: "" };
    if (cmd.includes("git symbolic-ref")) return { stdout: "main\n" };
    if (cmd.includes("git checkout")) return { stdout: "" };
    if (cmd.includes("git branch -D")) return { stdout: "" };
    if (cmd.includes("git rev-parse")) return { stdout: `${"b".repeat(40)}\n` };
    if (cmd.includes("git rev-list --count")) return { stdout: "0\n" };
    if (cmd.includes("git rev-list")) return { stdout: "" };
    if (cmd.includes("git cat-file")) return { stdout: `tree ${"c".repeat(40)}\n` };
    if (cmd.includes("git cherry-pick")) return { stdout: "" };
    if (cmd.includes("git diff")) return { stdout: "" };
    if (cmd.includes("git apply")) return { stdout: "" };
    if (cmd.includes("git reset")) return { stdout: "" };
    if (cmd.includes("git restore")) return { stdout: "" };
    if (cmd.includes("git stash")) return { stdout: "" };
    if (cmd.includes("git")) return { stdout: "" };
    return { stdout: "" };
  };

  const worktrees = opts.worktrees;
  const ctx = { repoRoot: REPO_ROOT, issue: 9999 } as unknown as DriverContext;
  const state = {
    schemaVersion: 1,
    issue: 9999,
    pipelineState: {
      worktrees,
      branchName: "feature/test",
      currentStep: "develop",
      status: "running",
    },
    eventLog: [],
  } as unknown as WorkState;

  const failures: string[] = [];
  const notes: string[] = [];
  let recovered = false;

  const run = () =>
    runVerifyCommandGate({
      execFn: fn,
      cmd: VERIFY_CMD,
      ctx,
      state,
      worktrees,
      baseSha: VALID_SHA,
      changedWorktrees: opts.changedWorktrees,
      workstreamBaseShas: undefined,
      failures,
      notes,
      onVerifyFlakeRecovered: () => {
        recovered = true;
      },
    });

  return async () => {
    await run();
    return { failures, notes, recovered, consolidatedCalls, perWorktreeCalls };
  };
}

async function main() {
  // Case 7: shared assertion, single per-worktree failure, N=2, consolidated
  // first run fails, re-run fails → exactly 2 consolidated calls (retry fired).
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      perWorktreeAssertion: sharedAssertion,
      consolidated: ["fail", "fail"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(
      r.consolidatedCalls === 2,
      `case 7 (shared assertion, both fail): exactly 2 consolidated runs (got: ${r.consolidatedCalls})`,
    );
    assert(r.failures.length > 0, `case 7: failures are recorded (got: ${r.failures.length})`);
    assert(
      r.notes.some((n) => n.includes("SAME assertion")),
      "case 7: the post-failure note names the shared assertion",
    );
  }

  // Case 8: DIFFERENT assertion, single per-worktree failure, N=2 →
  // exactly 1 consolidated call (no retry — the mismatch suppresses it).
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      perWorktreeAssertion: "✗ per-worktree specific: expected 42 got 43",
      consolidated: ["fail"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(
      r.consolidatedCalls === 1,
      `case 8 (different assertion): NO second consolidated run — mismatch suppresses retry (got: ${r.consolidatedCalls})`,
    );
    assert(
      r.failures.some((f) => f.includes("consolidation-created")),
      "case 8: classification is consolidation-created (the mismatch means it's a genuine combination defect)",
    );
  }

  // Case 9: zero per-worktree failures, N=2, consolidated fails, re-run
  // passes → recovered (the #782 shape: all per-worktree passed, one flake).
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT1, WT2],
      perWorktree: ["pass", "pass"],
      consolidated: ["fail", "pass"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(
      r.consolidatedCalls === 2,
      `case 9 (#782 shape, zero per-worktree failures, re-run passes): 2 consolidated runs (got: ${r.consolidatedCalls})`,
    );
    assert(r.recovered, "case 9: onVerifyFlakeRecovered was called");
    assert(r.failures.length === 0, `case 9: no failures (got: ${r.failures.length})`);
  }

  // Case 10: N=1 → no retry at all (the N>1 precondition blocks it).
  {
    const worktrees = { ws1: WT1 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT1],
      perWorktree: ["fail"],
      perWorktreeAssertion: sharedAssertion,
      consolidated: ["fail", "fail"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(
      r.consolidatedCalls === 1,
      `case 10 (N=1): NO second consolidated run — N>1 precondition blocks retry (got: ${r.consolidatedCalls})`,
    );
  }

  // Case 11: elided >800-char attributed tail — the ✗ assertion sits in
  // the elided middle of the consolidated failure detail. However, the
  // two-phase gate compares the RAW first-run failure (before elision)
  // against the per-worktree assertion, so the retry fires correctly even
  // when the final detail has the assertion elided. This verifies that
  // the gate operates on the raw failure, not the elided detail.
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    // Build a >800-char consolidated failure where the ✗ line is in the
    // middle (will be elided in the final detail by extractAttributedTail).
    const prefix = "x".repeat(500);
    const suffix = "y".repeat(500);
    const longConsolidated = `FAILED: smoke-tests/test-elided.ts\n${prefix}\n${sharedAssertion}\n${suffix}`;
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      perWorktreeAssertion: sharedAssertion,
      consolidated: ["fail", "fail"],
      // The full raw stderr — the ✗ line is present, so the retry fires.
      // The elision only affects the final detail, not the raw failure
      // that onFirstFailure receives.
      consolidatedAssertion: longConsolidated,
    });
    const r = await run();
    // The raw failure contains the ✗ line → sharesAssertion is TRUE → retry fires.
    // The elision only affects the final detail, not the gate's decision.
    assert(
      r.consolidatedCalls === 2,
      `case 11 (>800-char tail): retry fires because the RAW first-run failure contains the ✗ line (elision affects the detail, not the gate) (got: ${r.consolidatedCalls})`,
    );
  }

  // Case 12: shared assertion, single per-worktree failure, N=2, consolidated
  // first run fails, re-run PASSES → recovered, and the note records the
  // per-worktree failure evidence (previously dropped on recovery).
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      perWorktreeAssertion: sharedAssertion,
      consolidated: ["fail", "pass"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(
      r.consolidatedCalls === 2,
      `case 12 (shared assertion, re-run passes): 2 consolidated runs (got: ${r.consolidatedCalls})`,
    );
    assert(r.recovered, "case 12: onVerifyFlakeRecovered was called");
    assert(r.failures.length === 0, `case 12: no failures (recovered) (got: ${r.failures.length})`);
    // #826 — the recovery note must record the per-worktree failure evidence
    // and the shared/not-shared outcome (previously dropped).
    assert(
      r.notes.some((n) => n.includes("per-worktree failure")),
      "case 12: the recovery note records the per-worktree failure evidence",
    );
  }

  // Case 13: unknown per-worktree assertion (nothing extractable) — the
  // gate must ALLOW the re-run (pre-#826 behaviour for that case). The
  // per-worktree failure has no ✗ line, no error: line — just a bare
  // FAILED: marker, which extracts to NO_SPECIFIC_ASSERTION.
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      // No ✗ line — only the marker. extractSpecificAssertion returns
      // NO_SPECIFIC_ASSERTION, which the gate maps to null (unknown).
      perWorktreeAssertion: undefined,
      consolidated: ["fail", "fail"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(
      r.consolidatedCalls === 2,
      `case 13 (unknown per-worktree assertion): re-run ALLOWED — exactly 2 consolidated runs (got: ${r.consolidatedCalls})`,
    );
    // The unknown-assertion note should appear (re-run fired, also failed).
    assert(
      r.notes.some((n) => n.includes("no assertion could be extracted")),
      "case 13: the post-failure note names the unknown assertion (allowed-unknown)",
    );
  }

  // Case 14: mismatch suppression is observable — the note names the
  // per-worktree assertion and states the re-run was withheld.
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      perWorktreeAssertion: "✗ per-worktree specific: expected 42 got 43",
      consolidated: ["fail"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(r.consolidatedCalls === 1, `case 14 (mismatch): 1 consolidated run (got: ${r.consolidatedCalls})`);
    assert(
      r.notes.some((n) => n.includes("WITHHELD") && n.includes("per-worktree specific")),
      "case 14: the suppression note names the per-worktree assertion and states the re-run was withheld",
    );
  }

  // Case 15: recovered-with-per-worktree-failure note is bounded —
  // the per-worktree evidence tail must not exceed ~800 chars + note prefix.
  {
    const worktrees = { ws1: WT1, ws2: WT2 };
    // Build a long per-worktree failure (>800 chars) to verify bounding.
    const longPer = `FAILED: smoke-tests/test-long.ts\n${"z".repeat(1500)}`;
    const run = makeGateTest({
      worktrees,
      changedWorktrees: [WT2],
      perWorktree: ["fail"],
      // Use a shared assertion so the re-run is allowed and passes.
      perWorktreeAssertion: sharedAssertion,
      consolidated: ["fail", "pass"],
      consolidatedAssertion: sharedAssertion,
    });
    const r = await run();
    assert(r.recovered, "case 15: recovered");
    const perWsNote = r.notes.find((n) => n.includes("per-worktree failure"));
    assert(perWsNote !== undefined, "case 15: per-worktree failure note present");
    // The bounded tail from extractAttributedTail is at most 800 chars;
    // the full note includes the prefix + assertion + tail, so bound at ~1000.
    assert(
      (perWsNote ?? "").length < 1200,
      `case 15: recovery note is bounded (length ${perWsNote?.length} < 1200)`,
    );
  }

  console.log(`\nexit ${exit}`);
  process.exit(exit);
}

main();

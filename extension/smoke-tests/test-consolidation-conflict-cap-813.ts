#!/usr/bin/env bun
/**
 * #813 (cap renderer) — `explainCap("consolidated-verify-conflict")` with NO
 * fence record states what was observed instead of asserting that the
 * decomposition is incoherent.
 *
 * This is the SECOND of the two operator surfaces. The first —
 * `reportConsolidatedVerifyOutcome`'s failure string — is covered by
 * test-consolidation-conflict-attribution-813.ts, which owns the reporter's
 * real-run and coupling cases; the acceptance criteria require the no-fence
 * branch to be covered on both renderers, and the two render independently
 * (different lead-ins, different scan inputs), so one file pinned and one
 * silent is not coverage.
 *
 * What the cap text must now do: name what the driver recorded, keep the
 * worktrees the operator has to inspect, point at #1005's merge behaviour —
 * and NOT tell anyone to re-split a plan the driver never proved wrong.
 */

import { explainCap } from "../src/work-driver-explain.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import { initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const PATHS = {
  a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
  b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
};

/** A develop-step state with two worktrees, their declared paths, and a cap. */
function stateWithCap(evidence: string, fenceViolations?: FenceViolationRecord[]): WorkState {
  const s = initialState(813, 1_000_000);
  s.pipelineState = {
    ...s.pipelineState,
    worktrees: { a: "/w/a", b: "/w/b" },
    workstreams: { ...PATHS },
    ...(fenceViolations !== undefined
      ? { verifyEvidence: { step: "develop", failures: [], at: 1, fenceViolations } }
      : {}),
  };
  s.eventLog.push({
    kind: "cap-hit",
    at: 1,
    cap: "consolidated-verify-conflict",
    reviewRound: 0,
    nextStep: "handoff",
    evidence,
  });
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// Case 1 — no fence record, no file named. The old text asserted "two
// workstreams edited the same lines; the decomposition is incoherent" and
// told the operator to re-split. Both are gone; the observation and the
// worktrees remain.
// ──────────────────────────────────────────────────────────────────────────
{
  const text = explainCap(
    "consolidated-verify-conflict",
    stateWithCap(
      "consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict",
    ),
  );
  assert(
    !/incoherent/.test(text),
    `case 1: no-fence text does NOT say "incoherent" (got: ${text.slice(0, 260)})`,
  );
  assert(
    !/edited the same lines, so the work is individually plausible/.test(text),
    `case 1: the "edited the same lines" inference is gone (got: ${text.slice(0, 260)})`,
  );
  assert(
    !/fix is to re-split the work into non-overlapping/.test(text),
    `case 1: the text does not tell the operator to re-split (got: ${text.slice(0, 260)})`,
  );
  assert(
    /which workstream|could not be combined/.test(text),
    `case 1: the text states what was observed (got: ${text.slice(0, 260)})`,
  );
  assert(
    /1005/.test(text) || /merge[ds]? the pair|merge-and-retry/.test(text),
    `case 1: the text points at the #1005 merge behaviour (got: ${text.slice(0, 260)})`,
  );
  assert(
    /Worktrees:/.test(text),
    `case 1: the worktree list is preserved (got: ${text.slice(0, 200)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 2 — the cap's evidence names a file the OTHER workstream declared.
// That is the #792 shape #1005 exists for: disjoint declared paths, coupling
// through types. The text says the pair is likely coupled and points at the
// merge-and-retry, which is the fix; re-splitting the same split is not.
// ──────────────────────────────────────────────────────────────────────────
{
  const text = explainCap(
    "consolidated-verify-conflict",
    stateWithCap(
      "consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict on src/a.ts",
    ),
  );
  assert(!/incoherent/.test(text), `case 2: no "incoherent" claim (got: ${text.slice(0, 260)})`);
  assert(
    /likely coupled/i.test(text) && /#1005/.test(text),
    `case 2: names the coupling and points at #1005 (got: ${text.slice(0, 260)})`,
  );
  assert(
    /src\/a\.ts/.test(text) && /workstream a\b/.test(text),
    `case 2: names the file and the declaring workstream (got: ${text.slice(0, 260)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 3 — a sibling-declared fence record still wins (regression guard for
// the pre-existing #814 attribution: this fix must not displace it).
// ──────────────────────────────────────────────────────────────────────────
{
  const fence: FenceViolationRecord[] = [
    { workstreamId: "b", file: "src/a.ts", declaredById: "a", kind: "sibling-declared" },
  ];
  const text = explainCap("consolidated-verify-conflict", stateWithCap("cherry-pick conflict", fence));
  assert(
    text.includes("workstream b touched src/a.ts, declared by workstream a"),
    `case 3: the fence attribution still wins when a record exists (got: ${text.slice(0, 260)})`,
  );
  assert(
    !/incoherent/.test(text),
    `case 3: still no "incoherent" with a fence record (got: ${text.slice(0, 200)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 4 — an `undeclared` record is a warning, not a violation: the fence
// attribution must not fire, and the no-fence diagnosis runs (over-claim
// gone). Same shape as the #814 undeclared-only case, now on the #813 text.
// ──────────────────────────────────────────────────────────────────────────
{
  const text = explainCap(
    "consolidated-verify-conflict",
    stateWithCap("cherry-pick conflict", [
      { workstreamId: "a", file: "src/extra.ts", kind: "undeclared" },
    ]),
  );
  assert(
    !text.includes("fence was violated"),
    `case 4: an undeclared record does not trigger the fence attribution (got: ${text.slice(0, 200)})`,
  );
  assert(
    !/incoherent/.test(text),
    `case 4: the no-fence branch no longer over-claims (got: ${text.slice(0, 200)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

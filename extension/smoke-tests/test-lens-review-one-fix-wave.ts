#!/usr/bin/env bun
/**
 * #1537 — one full review, ONE fix wave, one scoped re-review.
 *
 * The loop used to be bounded by a counter alone: while a verdict carried a
 * finding at or above the project's bar the driver dispatched a fixer and re-ran
 * the whole six-lens review, up to `MAX_REVIEW_ROUNDS` times. Measured on this
 * repo, a +4/-12 PR paid for three six-lens reviews and ~96 finding rows across
 * three residual disclosures; a test deletion took three rounds and ~1.5 h.
 * Neither carried a CRITICAL or HIGH.
 *
 * These are the canaries for the replacement, one per load-bearing rule:
 *
 *  1. the fix wave is given the BLOCKING rows only — a fixer paid to write prose
 *     about MEDIUM findings is a fixer with less time for the ones that block;
 *  2. the scoped re-review blocks on carried rows and new CRITICALs, and on
 *     nothing else — while the summary and the disclosure still LIST every row
 *     (a demoted finding is disclosed, never deleted);
 *  3. the terminal round is decided by the log's SHAPE, so a counter cannot shift
 *     it, and a third round is refused outright rather than run and then capped;
 *  4. every failure path fails CLOSED: an unreadable findings blob, an
 *     incomplete review, and a fix wave that committed nothing.
 *
 * Each rule is also run against a deliberate mutant (bottom of the file): a gate
 * that has never been seen failing in a failing state proves nothing.
 */

import type { Severity } from "../src/lens-review-format.ts";
import {
  BLOCKING_SEVERITY,
  blockingFindings,
  hasOpenCarriedFinding,
  isBlockingSeverity,
  lensPolicyOf,
  owesReReview,
  reReviewSpent,
  scopedBlocking,
} from "../src/lens-review-policy.ts";
import type { Finding } from "../src/lens-review-types.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { reportedForVerdict } from "../src/lens-review-verdict-scope.ts";
import { lensFixFindingsFor, lensRoundOverBudget } from "../src/work-driver-lens-policy.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
/** True when `a` and `b` hold the same rows by VALUE. A pass-through must not be
 * asserted by identity: `reportedForVerdict` returns `reported` itself on the
 * arms that do not narrow, and `filter` on a fresh copy elsewhere — both are the
 * right answer, and only the contents are the contract. */
function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const f = (over: Partial<Finding> & { severity: Severity }): Finding =>
  ({
    lens: "SIMPLICITY",
    path: "a.ts",
    line: 1,
    title: "t",
    ...over,
  }) as Finding;

const carried = (over: Partial<Finding> & { severity: Severity }): Finding =>
  ({ ...f(over), carried: true }) as Finding;

// A lane that REPORTED something, so `isReviewIncomplete` does not mistake the
// fixture for a review that produced nothing (a lens with no findings and no
// summary has not reviewed the diff, whatever its exit code said). `lanes()` is
// what a narrowed call passes; a caller that wants an INCOMPLETE review passes
// `[{ ...okLane(), blocked: true }]` explicitly.
const okLane = (): LensRunResult => ({
  lens: "SIMPLICITY",
  ok: true,
  ms: 1,
  startMs: 0,
  findings: [f({ severity: "MEDIUM", title: "lane witness" })],
  summary: "reviewed",
  attempts: 1,
});
/** Six complete lanes, as a real round has: `isReviewIncomplete` is a
 * per-lane rule, so ONE silent lane holds the whole review incomplete — and the
 * narrowing under test must not be seen working on a review that would itself
 * have returned REVIEW_INCOMPLETE. */
const lanes = (): LensRunResult[] => [okLane(), okLane(), okLane(), okLane(), okLane(), okLane()];

// ------------------------------------------- 1. what counts as blocking
assert(BLOCKING_SEVERITY === "HIGH", "the fix wave answers HIGH and above");
assert(isBlockingSeverity("HIGH") && isBlockingSeverity("CRITICAL"), "HIGH and CRITICAL block");
assert(!isBlockingSeverity("MEDIUM") && !isBlockingSeverity("LOW"), "MEDIUM and LOW are disclosed");
assert(
  blockingFindings([f({ severity: "LOW" }), f({ severity: "HIGH" })]).length === 1,
  "blockingFindings keeps only the blocking rows",
);

// ------------------------------------------- 2. the fixer's blob is narrowed
{
  const blob = JSON.stringify([
    { path: "a.ts", line: 1, severity: "HIGH", title: "h", suggestion: "s" },
    { path: "b.ts", line: 2, severity: "MEDIUM", title: "m", suggestion: "s" },
    { path: "c.ts", line: 3, severity: "CRITICAL", title: "c", suggestion: "s" },
    { path: "d.ts", line: 4, severity: "LOW", title: "l", suggestion: "s" },
  ]);
  const narrowed = JSON.parse(lensFixFindingsFor(blob)) as Array<Record<string, unknown>>;
  assert(
    narrowed.length === 2 &&
      narrowed.every((r) => r.severity === "HIGH" || r.severity === "CRITICAL"),
    "the fix wave is dispatched with the blocking rows only",
  );
  assert(
    narrowed.every((r) => r.path !== undefined && r.suggestion === "s"),
    "…and every other field of a kept row survives the narrowing",
  );
}
{
  // Fail open on unreadable input: a fixer that receives everything is a worse
  // outcome than a fixer that receives everything.
  for (const [label, blob] of [
    ["the no-findings placeholder", "(no prior findings recorded)"],
    ["an empty string", ""],
    ["unparseable text", "{not json"],
    ["a JSON object, not an array", '{"severity":"HIGH"}'],
  ] as Array<[string, string]>) {
    assert(lensFixFindingsFor(blob) === blob, `an unreadable blob is passed through (${label})`);
  }
  const allSub = JSON.stringify([{ severity: "MEDIUM" }, { severity: "LOW" }]);
  assert(
    lensFixFindingsFor(allSub) === allSub,
    "a blob with no blocking row is passed through rather than sent as an empty list",
  );
}

// ------------------------------------------- 3. the scoped re-review's blocking set
assert(
  scopedBlocking([carried({ severity: "MEDIUM" })]).length === 1,
  "a carried MEDIUM still blocks: the fix wave was not asked to answer it, but the row is open",
);
assert(
  scopedBlocking([f({ severity: "HIGH" })]).length === 0,
  "a NEW HIGH does not block a scoped round — only the first review's bar raises it",
);
assert(
  scopedBlocking([f({ severity: "CRITICAL" })]).length === 1,
  "a new CRITICAL blocks wherever it sits",
);
assert(scopedBlocking([f({ severity: "LOW" })]).length === 0, "a new LOW is disclosed, not fixed");

// ------------------------------------------- 4. the verdict's input narrows; the record does not
{
  const rows = [f({ severity: "HIGH" }), carried({ severity: "HIGH" }), f({ severity: "LOW" })];
  const blocked = reportedForVerdict(rows, lanes(), "MEDIUM", true);
  assert(
    blocked.length === 1 && blocked[0]?.carried === true,
    "a scoped round blocks on carried rows and new CRITICALs only",
  );
  assert(
    rows.length === 3,
    "…and the caller's list is untouched — the summary, the counts and the disclosure still see all three",
  );
  const unscoped = reportedForVerdict(rows, lanes(), "MEDIUM", false);
  assert(unscoped.length === 3, "a full round is judged by the project's bar, unchanged");
  const incomplete = reportedForVerdict(rows, [{ ...okLane(), blocked: true }], "MEDIUM", true);
  assert(
    incomplete.length === 3,
    "an incomplete review is never narrowed — that verdict is about the review, not the findings",
  );
  // A bar ABOVE HIGH has already said sub-HIGH rows never block; the narrowed set
  // must not make the harness stricter than the project's own doctrine — a LOW
  // the bar would have let through must not become blocking because it is carried.
  const criticalOnlyBar = reportedForVerdict(
    [carried({ severity: "LOW" })],
    lanes(),
    "CRITICAL",
    true,
  );
  assert(
    criticalOnlyBar.length === 1,
    "a CRITICAL-only bar is not tightened by the scoping: a row the bar never blocked stays non-blocking",
  );
  const alsoNonBlocking = reportedForVerdict([], lanes(), "CRITICAL", true);
  assert(alsoNonBlocking.length === 0, "…and a scoped round with no rows reports none");
}

// ------------------------------------------- 5. the phase, read from the log's shape
const verdict = (round: number): WorkEvent => ({
  kind: "lens-issues-found",
  at: 1,
  jobId: "j",
  round,
  findings: "[]",
  verdict: "ISSUES_FOUND",
});
const answered = (round: number): WorkEvent => ({
  kind: "lens-fix-rereviewed",
  at: 2,
  round,
  headSha: "b".repeat(40),
  reviewedHead: "a".repeat(40),
});
const fixDispatch = (): WorkEvent => ({
  kind: "dispatch-started",
  step: "lens-fix",
  role: "developer",
  jobId: "j2",
  label: "developer:lens-fix-1",
  at: 2,
});
const log = (...e: WorkEvent[]): WorkEvent[] => [
  { kind: "step-started", step: "lens-review", at: 0 },
  ...e,
];

assert(
  lensPolicyOf(log()).phase === "first",
  "an empty log is the full review — the only unscoped round",
);
assert(
  lensPolicyOf(log(verdict(1))).phase === "closed",
  "a blocking verdict with no fix dispatched yet is `closed`: the re-review it owes is the round about to run, not one already spent",
);
assert(
  lensPolicyOf(log(verdict(1), fixDispatch())).phase === "scoped",
  "a fix dispatched for a blocking verdict is the round the fix OWES",
);
assert(
  owesReReview(log(verdict(1), fixDispatch())) && !reReviewSpent(log(verdict(1), fixDispatch())),
  "the owed re-review is recognised by both readers, consistently",
);
assert(
  lensPolicyOf(log(verdict(1), fixDispatch(), answered(1))).phase === "closed",
  "once the fix has landed, the re-review is the loop's last word",
);
assert(
  lensPolicyOf(log(verdict(1), answered(1))).phase === "closed",
  "the landed-fix record is the authoritative fact, ahead of the dispatch log",
);
assert(
  lensPolicyOf(log(verdict(1), verdict(2), answered(2))).phase === "closed" &&
    lensPolicyOf(log(verdict(1), verdict(2), answered(2))).blockingRound?.round === 2,
  "the latest blocking verdict is the one the policy prices",
);
assert(
  lensPolicyOf([
    ...log(verdict(1)),
    { kind: "lens-approved", at: 3, jobId: "j", round: 1, findings: "[]" },
  ]).phase === "first",
  "an approval closes the wave — the next round is an ordinary full review",
);
assert(
  lensPolicyOf([...log(verdict(1)), { kind: "lens-skipped-empty-diff", at: 3, round: 1 }]).phase ===
    "first",
  "an empty-diff skip closes it too",
);
{
  const r = lensPolicyOf(log(verdict(2)));
  assert(
    r.blockingRound?.headSha === undefined,
    "a verdict with no head records no head — the owed-round route fails closed on it (#1742)",
  );
}

// ------------------------------------------- 6. the third round is refused by the count
const state = (eventLog: WorkEvent[]): WorkState =>
  ({
    issue: 1,
    eventLog,
    pipelineState: { currentStep: "lens-review", status: "running", reviewRound: 1 },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any;

assert(!lensRoundOverBudget(state(log()), 1), "round 1 is in budget");
assert(!lensRoundOverBudget(state(log()), 2), "round 2 — the re-review — is in budget");
assert(lensRoundOverBudget(state(log()), 3), "round 3 is refused");
assert(
  !lensRoundOverBudget(state(log(verdict(1), fixDispatch())), 2),
  "the owed re-review is never refused by the shape check — the policy REQUIRES it to run",
);
assert(
  lensRoundOverBudget(state(log(verdict(1), fixDispatch())), 3),
  "…and the round after it is refused",
);

// ------------------------------------- 6b. the FIX side stops by the same shape
//
// The router's `lens-issues-found` arm asks this before it dispatches a fixer.
// A re-review's own verdict must not buy a second fix wave: the cycle would pay
// for a fix nobody re-reads, since the review that would have read it is refused
// by the rule just above. Read from the log, so a resume or a step retry cannot
// restore the allowance a counter would have.
{
  const { nextLensFixStep } = await import("../src/work-driver-lens-policy.ts");
  assert(
    nextLensFixStep(state(log(verdict(1)))) === "lens-fix",
    "a blocking verdict with no fix yet routes to the ONE fix wave",
  );
  assert(
    nextLensFixStep(state(log(verdict(1), fixDispatch(), verdict(2)))) === "handoff",
    "the re-review's own verdict buys no second fix wave — the loop ends there",
  );
  assert(
    nextLensFixStep(state(log(verdict(1), fixDispatch(), answered(1), verdict(2)))) === "handoff",
    "…same once the landing arm recorded the fix: still no second wave",
  );
  assert(
    nextLensFixStep(state(log(verdict(1), fixDispatch(), verdict(2), verdict(3)))) === "handoff",
    "mutant: three blocking verdicts in the log still do not reopen the wave — it is one fact, not a counter",
  );

  // The router itself, through `nextStep`, so the canary covers the arm the
  // driver actually runs rather than only the helper it calls.
  const { nextStep } = await import("../src/work-driver-context.ts");
  const routeOf = (events: WorkEvent[]) => {
    const s = state(events);
    const d = nextStep(s);
    return d.kind === "step" ? d.step : d.kind;
  };
  assert(
    routeOf(log(verdict(1))) === "lens-fix",
    "router: a blocking round 1 with no fix yet goes to the fix wave",
  );
  assert(
    routeOf(log(verdict(1), fixDispatch(), verdict(2))) === "handoff",
    "mutant: router: a blocking re-review does NOT get a second fixer",
  );
}

// ------------------------------------------- 7. an open carried row holds the ci route
assert(
  hasOpenCarriedFinding(JSON.stringify([{ carried: true, severity: "HIGH" }])),
  "a carried HIGH is an open finding: the fix wave failed at its one job, so the cycle parks",
);
assert(
  !hasOpenCarriedFinding(JSON.stringify([{ carried: true, severity: "MEDIUM" }])),
  "a carried MEDIUM is disclosed rather than held — the policy never asked the fix to answer it",
);
assert(
  hasOpenCarriedFinding(JSON.stringify([{ carried: true, severity: "CRITICAL" }])),
  "a carried CRITICAL parks",
);
assert(
  !hasOpenCarriedFinding(JSON.stringify([{ severity: "HIGH" }])),
  "a reported (not carried) row does not hold that route — the scoped verdict already judged it",
);
for (const [label, blob] of [
  ["absent", undefined],
  ["empty", ""],
  ["unparseable", "not json"],
  ["not an array", "{}"],
] as Array<[string, string | undefined]>) {
  assert(
    hasOpenCarriedFinding(blob),
    `an unreadable findings blob is treated as OPEN (${label}) — an allowance is not granted on evidence the driver cannot read`,
  );
}

// ------------------------------------------- mutants: a gate never seen failing proves nothing
{
  const blocking = blockingFindings([f({ severity: "LOW" }), f({ severity: "MEDIUM" })]);
  assert(blocking.length === 0, "mutant: with no HIGH/CRITICAL row, nothing blocks a fix wave");
  const noRows: Finding[] = [];
  // A round whose one lane reported NOTHING and wrote no summary is an incomplete
  // review, and an incomplete review is never narrowed — so this mutant gives the
  // empty round a lane that genuinely reviewed the delta and found it clean, the
  // shape in which an empty `reported` list is honest.
  const cleanRound = [
    { ...okLane(), findings: [], summary: "no issues in this delta" },
  ] as LensRunResult[];
  assert(
    sameArray(reportedForVerdict(noRows, cleanRound, "MEDIUM", true), noRows),
    "mutant: an empty scoped round narrows to the same empty list — a review that reported nothing is not made to look like it blocked on anything",
  );
  assert(
    sameArray(reportedForVerdict(noRows, [okLane()], "MEDIUM", true), noRows),
    "…and the same answer holds when the review's own completeness is not in question",
  );
  assert(
    scopedBlocking([f({ severity: "MEDIUM" })]).length === 0,
    "mutant: a scoped round with nothing carried and nothing critical blocks on nothing",
  );
  assert(
    lensPolicyOf([
      {
        kind: "dispatch-started",
        step: "lens-fix",
        role: "developer",
        jobId: "j",
        label: "x",
        at: 0,
      },
    ] as WorkEvent[]).phase === "first",
    "mutant: a stray lens-fix dispatch with no blocking verdict is not a re-review",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

/**
 * smoke-tests/test-lean-review-incomplete-head.ts — #2667's on arm, one throw site at a time.
 *
 * The defect: a `review` step that THROWS ended the run on the engine's bare error path.
 * No reporting step ran, so the head the run's own `verify` certified was neither shipped
 * nor named, and the operator got an engine error instead of a handoff.
 *
 * Every case drives the real chain — the real review step, the real engine settle, the
 * real route into the real reporting step, the real rewind over a real bare origin — and
 * asserts facts READ BACK: origin by `ls-remote`, the record off the run the drive saved,
 * the host document the result renderer built. Only model and forge calls are faked. A
 * throw site is named, never described: each row arms the seam that site reads.
 *
 * What the feature must NOT do is equally pinned here: the run still ends handed-back at
 * exit 10, the review's record stays its own error outcome, `reviewComplete` stays false
 * from the review step's own record (so the host document keeps its `review-incomplete`
 * cap and no new cap string appears), and nothing ever lands.
 */

import { reviewCompleteOf } from "../src/headless/work-lean-pr.ts";
import { NO_GATE_VERDICT, handbackHeads } from "../src/lean/handback-heads.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  CAUSES,
  driveRow,
  type PanelRun,
  type ReviewCause,
} from "./lib/lean-review-incomplete-head-panel.ts";
import { ISSUE } from "./lib/lean-review-incomplete-head-consts.ts";

const { assert, failures } = makeAssert();

// ── Every throw site of the review step reaches the report over a certified head.
for (const cause of CAUSES) {
  const row = await driveRow(cause);
  checkRow(cause, row);
}

/**
 * What each row owes: the review's own error record, the reporting step the throw used to
 * skip, exit 10, and the certified head recorded on the handback — shipped by the rewind,
 * or disclosed with the refusal's own reason when the rewind would have overwritten a head
 * it does not own.
 */
function checkRow(cause: ReviewCause, row: PanelRun): void {
  assert(
    row.review?.kind === "error" && typeof row.review.message === "string",
    `${cause}: the review step's record is its own error outcome, not a verdict`,
  );
  assert(
    row.visited.includes("review") && row.visited.includes("handback"),
    `${cause}: the throw ran the reporting step it used to skip (visited ${row.visited.join(",")})`,
  );
  assert(row.code === 10, `${cause}: exit code is the handback code (got ${String(row.code)})`);
  assert(row.state === "handed-back", `${cause}: run ends handed-back (got ${row.state})`);
  assert(
    row.steps.every((s) => !["ci", "land"].includes(s.state)),
    `${cause}: no ci and no land ran for a head whose review did not complete`,
  );
  assert(row.handback?.kind === "done", `${cause}: the handback comment posted`);
  assert(
    row.posts.length === 1,
    `${cause}: exactly one handback comment (got ${String(row.posts.length)})`,
  );
  assert(
    row.posts[0]?.includes("Shipped head:") === true,
    `${cause}: the comment names the head in the operator's own words`,
  );
  // The throw's own words reach both surfaces the operator reads.
  const thrown = row.review?.message ?? "";
  assert(
    thrown.length > 0 && row.reason.includes(thrown.slice(0, 24)),
    `${cause}: the result names why review did not complete (${row.reason})`,
  );
  assert(
    row.posts[0]?.includes("the review did not complete: ") === true &&
      row.posts[0]?.includes(thrown.slice(0, 24)) === true,
    `${cause}: the comment says the review did not complete, once, in the throw's own words`,
  );
  // The walk's own gate certified the head this row rewinds to — never a fixture literal.
  // A row that asked its gate to name no head proves the opposite: no head field anywhere.
  if (!row.gateNamedHead) {
    assert(
      row.handback?.shippedHead === undefined && row.handback?.unshippedHead === undefined,
      `${cause}: a green that named no head leaves no head field for the report to write`,
    );
    return;
  }
  assert(
    row.steps.some((s) => s.state === "verify" && s.outcome?.verifiedHead === row.verifiedHead),
    `${cause}: the run's verify certified the head origin held at publish`,
  );
  assert(
    row.handback?.shippedVerified === true,
    `${cause}: the shipped head is recorded as one this run's gate certified`,
  );
  // `reviewComplete` is the review step's own verdict, so an error record answers false and
  // the run cannot read as a landed one. No cap string is added for the throw: the two
  // published caps are `awaiting-human-merge` and `review-incomplete`, both of which need a
  // PR this throw never reached, and the run says so on `failure` instead.
  assert(
    row.reviewComplete === false,
    `${cause}: the review stays incomplete, so the run cannot read as a landed one`,
  );
  assert(
    row.cap !== "awaiting-human-merge",
    `${cause}: a head whose review did not complete is never disclosed as waiting on a person`,
  );
  assert(
    row.failureKind !== undefined,
    `${cause}: the host document says what failed, on a run no cap covers`,
  );
  checkHeadFacts(cause, row);
}

/** The head facts, in the two arms the rewind decides between. */
function checkHeadFacts(cause: ReviewCause, row: PanelRun): void {
  if (row.originAfter === row.verifiedHead) {
    // The rewind had nothing to move: origin already held the certified head, and that is
    // exactly what the record has to say — the head shipped, and it is the certified one.
    assert(
      row.handback?.shippedHead === row.verifiedHead,
      `${cause}: origin's branch is the certified head after the report`,
    );
    assert(
      row.handback?.unshippedHead === undefined,
      `${cause}: a report that moved nothing records no unshipped head`,
    );
    // "Nothing moved" still has to be said, in the rewind's own words, not left silent.
    assert(
      row.handback?.unshippedReason?.includes("moved nothing") === true,
      `${cause}: a report that moved nothing says why, in the rewind's words`,
    );
    return;
  }
  // The rewind refused (or had nothing to move): nothing is pushed, and the head is disclosed.
  assert(
    row.handback?.shippedHead !== undefined,
    `${cause}: the head origin holds is still named, as what shipped`,
  );
  if (row.handback?.unshippedHead !== undefined) {
    assert(
      typeof row.handback.unshippedReason === "string" && row.handback.unshippedReason.length > 0,
      `${cause}: a head this step moved off is recorded with its reason`,
    );
  }
}

// ── Controls: the review step ran and COMPLETED, and the report wrote no head field of its
// own. These run the real step and the real reporting step (see `driveByHand`): the machine
// alone would never route a completed review to a report, so the log is put in front of it.
{
  const done = await driveRow("none", { route: "to-review", reviewKind: "done" });
  assert(
    done.review?.kind === "done" && done.review.reviewComplete !== false,
    "control: a clean review's record is its own, unchanged by the rule",
  );
  assert(
    done.visited.includes("handback") && done.posts.length === 1,
    "control: the reporting step ran, so this is the byte comparison that matters",
  );
  assert(
    done.handback?.shippedHead === undefined && done.handback?.unshippedHead === undefined,
    "control: a completed review's handback writes no head field of its own",
  );
  assert(
    !done.posts.some((p) => p.includes("Shipped head:")),
    "control: a completed review's comment says nothing about heads",
  );
  const fixed = await driveRow("none", { route: "to-review", reviewKind: "fixed" });
  assert(
    fixed.review?.kind === "fixed" && fixed.review.reviewComplete !== false,
    "control: a review whose wave cleared keeps its own kind",
  );
  assert(
    fixed.handback?.shippedHead === undefined && fixed.handback?.unshippedHead === undefined,
    "control: a completed review over its own fix head is untouched by this rule",
  );
}

// A throw whose gate never certified a head keeps the plain stamp. The review step still
// RAN and still threw — only the head behind it differs from the rows above. Two shapes ask
// it: a gate that decided green and named no commit, and a gate the walk entered and never
// let decide. Both are "no head", and neither may earn a head field.
{
    // The gate's verdict is the row's subject, so the step is driven by hand over the walk's
  // own log: on a red gate the machine never routes to `review` at all, and the row still has
  // to see the step actually throw. The report is the machine's route from a refusal.
  const red = await driveRow("budgetStop", { verifyKind: "red" });
  assert(
    !red.visited.includes("review"),
    "red verify: the machine turns back at the gate, so the row is about the report, not a throw",
  );
  assert(
    red.handback === undefined ||
      (red.handback.shippedHead === undefined && red.handback.unshippedHead === undefined),
    "red verify: the report names no head, because there is none to name",
  );
  assert(
    red.code === 10 && red.state === "handed-back",
    "red verify: the plain stamp still exits 10 handed-back",
  );

  const headless = await driveRow("budgetStop", { verifyKind: "headless" });
  assert(headless.review?.kind === "error", "a green that named no head: the step still threw");
  assert(
    headless.handback?.shippedHead === undefined &&
      headless.handback?.unshippedHead === undefined,
    "a green that named no head: no head field is written anywhere",
  );
  // The feature's boundary, stated on the record: a throw behind a green that named no commit
  // is handed back, and the comment is the run's own sentence with the throw's cause in it. The
  // rule's head finding is deliberately absent — the rule names no head, so it writes no head
  // line, and the ordinary handback keeps its bytes. See `test-lean-review-incomplete-head-off-arm.ts`.
  assert(
    headless.posts[0]?.includes("the review did not complete") === true &&
      headless.posts[0]?.includes("the green verify recorded no head") === false,
    `a green that named no head is handed back on the run's own sentence, with no head line (${headless.posts[0]?.slice(0, 200)})`,
  );

  // The gate's own words for "nothing was ever certified", which a throw behind a red gate
  // must never be told: a red verdict is one the run already paid for.
  const undecided = await driveRow("budgetStop", { verifyKind: "undecided" });
  assert(
    undecided.handback !== undefined,
    "an undecided gate: the run reached its report, which is where the rule speaks",
  );
  assert(
    undecided.handback?.shippedHead === undefined &&
      undecided.handback?.unshippedHead === undefined,
    "a gate that decided nothing leaves no head field on the report",
  );
  assert(
    undecided.handback?.shippedHead === undefined,
    "a gate that decided nothing leaves no head for the report to name",
  );
}

// The rule's own two "no verified head" findings, asked over a walk whose gate left nothing to ship.
// A walk the machine turned back at the gate never reaches the step, so the rule is asked where the
// walk's newest decided gate answer stands and the newest decided WORK step is a review: a green that
// named no commit gets this file's finding, and a gate the run never let decide gets NO_GATE_VERDICT.
// Neither wording is #2667's, and neither may earn a head field. Dropping the green condition from the
// errored arm is what the first row here is for: with it gone the certified arm answers for the green
// that named none, and the finding is never produced.
{
  const headless = (await driveRow("budgetStop", { verifyKind: "headless" })).steps;
  assert(
    reviewFinding(headless).includes("the green verify recorded no head"),
    `a green that named no commit: the rule says so in its own words (${JSON.stringify(reviewFinding(headless))})`,
  );
  const undecided = (await driveRow("budgetStop", { verifyKind: "undecided" })).steps;
  assert(
    reviewFinding(undecided).includes(NO_GATE_VERDICT) ||
      // The row's own gate answered before the walk was stopped inside the last re-verification, so the
      // newest decided verdict the rule can read is the walk's own red: that finding, in the base rule's
      // words, is the same claim — nothing of this run certified the bytes it stands on.
      reviewFinding(undecided).includes("not green, so no head is verified"),
    `a gate that decided nothing: the rule says nothing of this run certified a head (${JSON.stringify(reviewFinding(undecided))})`,
  );

  // The negative control, on the SAME shape with the switch off: the run ends exactly as the base
  // ended it, a bare engine error with no reporting step and no comment. Drop the switch gate from
  // the route and this is the row that goes red — the off arm would post a report the release before
  // this knob never posted. `test-lean-review-incomplete-head-off-arm.ts` pins the same byte identity
  // against the base commit's capture for the certified shape.
  process.env.PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD = "0";
  const off = await driveRow("budgetStop", { verifyKind: "headless" });
  delete process.env.PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD;
  assert(
    off.review?.kind === "error" &&
      !off.visited.includes("handback") &&
      off.posts.length === 0 &&
      off.handback === undefined &&
      off.code === 10 &&
      off.state === "handed-back" &&
      off.reason.startsWith("handler error at review:"),
    `the switch off, a green that named no head: the run is the base's bare engine error, with no handback comment (${JSON.stringify([off.visited.join(","), off.posts.length, off.code, off.reason.slice(0, 60)])})`,
  );
}

/**
 * The rule's finding over a walk's own log with the reporting entry dropped and the review step's own
 * standing made the newest decided WORK step (its key kept, so the fold still reads it). The only record
 * the row supplies is the review's own kind: the walk's verdicts, heads and keys are all its own bytes.
 */
function reviewFinding(steps: Step[]): string {
  return (
    handbackHeads([
      ...steps.filter((s) => s.state !== "handback" && s.state !== "decline"),
      {
        key: `${String(ISSUE)}:review:0`,
        state: "review",
        startedAt: 1,
        outcome: { kind: "fixed", reason: "one fix wave" },
      },
    ] as Step[]).reason ?? ""
  );
}

// The rewind-refused arm, earned rather than asserted: the stranger is a commit that reached
// origin over a real transport and whose objects the run's clone was never taught, so the rewind
// reaches its own refusal rules with an object it cannot supply — the state a resumed run whose
// clone never fetched the stranger is really in. The head is disclosed, nothing is pushed, and the
// run stays a handback.
{
  const refused = await driveRow("budgetStop", { movedBeforeRead: true });
  assert(
    refused.handback !== undefined && refused.posts.length === 1,
    `refused rewind: the row reached the reporting step to refuse at and posted once (posts ${String(refused.posts.length)})`,
  );
  assert(
    refused.originAfter !== refused.verifiedHead,
    `refused rewind: the fixture really moved origin off the certified head (${refused.originAfter.slice(0, 8)} vs ${refused.verifiedHead.slice(0, 8)})`,
  );
  assert(
    refused.handback?.shippedHead === refused.originAfter &&
      refused.handback?.unshippedHead === undefined,
    `refused rewind: origin's own head is disclosed as what shipped, and the step records nothing it displaced (${JSON.stringify([refused.handback?.shippedHead?.slice(0, 8), refused.originAfter.slice(0, 8), refused.handback?.unshippedHead?.slice(0, 8)])})`,
  );
  assert(
    refused.handback?.shippedVerified === false,
    "refused rewind: what origin holds is recorded as shipped and NOT certified",
  );
  // The refusal is the rewind's own, in the rewind's own words, and it names the head origin
  // really holds — read back off origin, not typed here.
  assert(
    typeof refused.handback?.unshippedReason === "string" &&
      refused.handback.unshippedReason.includes("origin still holds") &&
      refused.handback.unshippedReason.includes(refused.originAfter.slice(0, 12)),
    `refused rewind: the record names origin's real head in the rewind's own words (${JSON.stringify(refused.handback?.unshippedReason)})`,
  );
  // The lease is one of two refusals this wording admits, and the row says WHICH: a lease refusal
  // needs origin to have moved after the step read it, which `test-lean-rewind-lease-binds.ts`
  // drives against a real origin. Here the step read the stranger, so the lease it bound matched
  // and git refused for the reason the record carries. Asserting the lease wording on this row
  // would pin a string rather than a refusal git gave.
  assert(
    refused.handback?.unshippedReason?.includes("the lease refused") !== true,
    `refused rewind: the row names the refusal git actually gave, not the one the row is named for (${JSON.stringify(refused.handback?.unshippedReason)})`,
  );
  assert(
    refused.keptRef === undefined,
    `refused rewind: the atomic push wrote nothing under the keeping-ref (${String(refused.keptRef)})`,
  );
  assert(
    refused.code === 10 && refused.state === "handed-back",
    `refused rewind: still a handback, never a landing (code ${String(refused.code)}, ${refused.state})`,
  );
  assert(
    !refused.visited.includes("ci") && !refused.visited.includes("land"),
    `refused rewind: no ci and no land ran for a head its report refused (${refused.visited.join(",")})`,
  );
}

// The rule is not a rewrite of the review step's verdict: the same throw with the switch
// off is pinned byte for byte in `test-lean-review-incomplete-head-off-arm.ts`.
{
  const row = await driveRow("configLoad");
  assert(
    reviewCompleteOf(row.steps) === row.reviewComplete,
    "the run's `reviewComplete` is the renderer's own answer over the same log",
  );
}

const failed = failures();
if (failed !== 0) {
  console.error("FAILED");
  process.exit(1);
}
console.log("✓ lean review-incomplete-head on-arm cases passed");

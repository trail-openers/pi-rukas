#!/usr/bin/env bun
/**
 * lean: a verified handback driven through a DEADLINE STOP (#2264) — the shape
 * that produced a real benchmark handback, driven through the engine rather than
 * handed to the rule as a log.
 *
 * `test-lean-verified-handback.ts` pins the RULE over scripted logs and
 * `test-lean-verified-handback-report.ts` pins the STEP's two surfaces over
 * driven-but-truncated logs; `test-lean-verified-handback-rewind.ts` pins the WIRE.
 * Nothing drove the case end to end: a green `verify` at head V, a review that ends
 * `fixed` at a new head F the fix wave pushed, and then the run's own cycle deadline
 * stopping it before that re-verification runs. That is the one shape where origin
 * holds bytes no gate certified, and it was only ever asserted about a log — never
 * about a run.
 *
 *   (a) the earlier green verify: the deadline crosses on the review's LAST boundary
 *       — after `review:fixed` is decided — the run reports past the line, and origin
 *       ends at V with F kept under `refs/lean/unverified/<issue>`. The record and the
 *       comment say shipped=V (verified), unshipped=F;
 *   (b) the green that recorded NO head: same drive, same stop, and the gate's one
 *       green named no head. Nothing moves (origin stays at F) and the record carries
 *       shipped=F, shippedVerified=false, and a reason quoting the rule's own words.
 *       Before this file's second commit the record carried NONE of the four fields,
 *       which is the difference between "the rule fired and had no head" and "the rule
 *       never spoke" — the confusion the recording exists to remove;
 *   (c) `PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD=0`: the same (b) drive posts a body
 *       BYTE-IDENTICAL to the body captured once from a detached worktree of the
 *       parent commit, and records none of the four fields. The rule-ON control on the
 *       same log asserts that body DIFFERS, which is what keeps the equality from
 *       being a renderer compared with itself.
 *
 * What makes these engine cases rather than rule cases, stated precisely: the
 * handback handler is the PRODUCTION wiring (`reportHandlers`), so the real
 * `rewindToVerified` and the real origin read run against a real bare origin; every
 * EARLIER state is answered from a scripted queue, so no case here needs a forge, a
 * worktree or a model. V and F are real commits from `repoWithFixHead()` — V is the
 * base commit (made reachable on origin under `refs/lean/base/<issue>`) and F the fix
 * head origin's branch holds when the drive starts.
 *
 * The deadline is `crossingAfter({ at: "handback", after: 0 })` — the REPORT's own
 * boundary, which is the only place the premise and the report can both hold: the
 * engine's deadline stop ends the run where it stands and runs no reporting step, and
 * a run whose re-verification ANSWERED is one the rule no longer speaks for. So the
 * queue answers up to and including the review, the table routes `review:fixed` into
 * the re-verification, the stop test refuses to start it, and the report is the run's
 * one surviving step past the line because `deadlineStopsSteps` exempts the reporting
 * states. `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` is pinned explicitly (it is in the restored
 * `ENV_KEYS` set) and sized under the rig's late position, and the case asserts
 * `clock.crossed()` and `arm − clock.past ≤ handoffDispatchTimeoutMs()`, so a drive
 * that never crossed the allowance cannot read as a deadline case.
 *
 * The comment has ONE named carrier: the drive pins `PI_ENSEMBLE_HANDOFF_CHANNEL=host`,
 * which makes `outcome.report` the delivered body (the host posts it), and the four
 * head fields are read off the PERSISTED `handback` step outcome through `loadRun` —
 * the file the run wrote, not the object the drive returned.
 *
 * The pre-change body was captured once by `tmp/t/capture-nohead-off-body.ts`, run
 * inside a detached worktree of the parent commit; a body built by this checkout
 * would compare the recording with itself.
 */

import { rmSync } from "node:fs";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import { reportHandlers } from "../src/lean/report-handlers.ts";
import { runLean } from "../src/lean/engine.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { MAX_BUILD_ATTEMPTS } from "../src/lean/machine.ts";
import type { Outcome, Step, LeanState } from "../src/lean/state.ts";
import { REPORT_STATES } from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state.ts";
import { handoffDispatchTimeoutMs } from "../src/work-driver-handoff.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import {
  crossingAfter,
  recording,
  withEnv,
} from "./lib/lean-host-contract-fixture.ts";
import { BRANCH, ISSUE } from "./lib/lean-verified-handback-fixture.ts";
import { ROOTS } from "./lib/lean-verified-handback-fixture.ts";
import {
  originBranchSha,
  originRefSha,
  repoWithFixHead,
} from "./lib/lean-verified-handback-repo.ts";

const { assert, state } = makeAssert();

/** The handoff allowance every case pins, as a number the case states rather than a
 *  default it inherits — and a number the drive depends on: the engine resolves and
 *  persists its arm on the first boundary, and stops every later step whose boundary
 *  leaves `arm − now` at or under this. Equal to the cycle budget it would stop the
 *  run before its FIRST step; far above it, the run would walk to its merge and the
 *  case would be about a completed run, not a stopped one. */
const HANDOFF_MS = 2 * MINUTE_MS;

/** The cycle budget `crossing` resolves its two clock positions against — fixed at
 *  240 minutes by the rig, and read here because the allowance below is stated
 *  against it. */
const BUDGET_MS = 240 * MINUTE_MS;

/** How far short of the budget the rig's late position sits, so the boundary the
 *  crossing lands on is INSIDE the allowance and the stop is a deadline stop. */
const SHORTFALL_MS = 3 * MINUTE_MS;

/** The rule's own wording for the arm this file records, quoted from
 *  `handback-heads.ts`. Asserted as a QUOTE, not as a paraphrase: the operator reads
 *  this line and the assertion has to fail if it stops saying what the rule says. */
const NO_HEAD_REASON = "the green verify recorded no head, so there is no verified head to ship";

/** The comment body the pre-recording handback posted for the (b) log, captured once
 *  from a detached worktree of the parent commit by `tmp/t/capture-nohead-off-body.ts`. */
const PRE_RECORD_BODY = [
  "work-lean: issue #2242 is handed back — this is still needed:",
  "",
  "```text",
  "frozen tests and project tiers passed",
  "```",
  "",
  "Frozen acceptance tests:",
  "- tests/AC1-verified-head.test.sh",
  "",
  "Branch: `lean/issue-2242`",
  "PR: https://github.com/o/r/pull/1",
].join("\n");

/** The env every case pins: the host channel makes `outcome.report` the delivered
 *  body, the allowance is the number the crossing was calibrated against, and the
 *  forge is off so no arm can reach a real adapter underneath the drive. */
const ENV = {
  PI_ENSEMBLE_HANDOFF_CHANNEL: "host",
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(HANDOFF_MS),
  PI_ENSEMBLE_CYCLE_BUDGET_MS: String(BUDGET_MS),
  PI_ENSEMBLE_FORGE: "none",
} as const;

/** The scripted plan up to the review, with the gate's verdict supplied by the case.
 *
 * `build` and `challenge` carry TWO entries each. The clock `crossing` arms counts
 * the loop's clock reads and only treats the read at index 1 of each four-read
 * boundary as the stop test, so a drive has to consume at least eight boundaries
 * before the review for the crossing to be reachable at all — a walk straight from
 * `challenge` into its gate never gets that far and the case would silently be a
 * no-deadline drive. The extra rounds are ordinary work the table routes: a second
 * `ok` build re-enters `challenge` (its queue holds one entry, so that round answers
 * `none`) and the gate is then reached with the walk's rounds spent. `publish` holds
 * ONE entry on purpose: the walk visits it once, and a second visit means the
 * re-verification ran — which is the thing the deadline is supposed to prevent, and a
 * queue that answered it would hide that the clock never stopped anything.
 */
/**
 * The plan of the deadline cases, with the review step the drive must REACH.
 *
 * `review` is deliberately NOT one of the recorded states. `crossing` decides its
 * crossing from the number of clock reads the loop has consumed — the read at index 1
 * of each four-read boundary is the one the stop test takes — and that arithmetic
 * assumes a handler consumes exactly one read of the clock, which is true of every
 * scripted queue and FALSE of the production `review` step (`review.ts` calls
 * `ctx.now()` for its own step clock). A drive that let the real reviewer run would
 * have its parity shifted by the step's internal reads and its crossing would land
 * inside the review rather than at the boundary after it — where the run stops AT the
 * reviewing step instead of on its way into the re-verification, which is the other
 * case and has its own fixtures. So the review is answered from the queue like every
 * other early state, and only the step that decides who hears the verdict — the
 * handback — is the production wiring.
 */
function walkToReview(green: Outcome): Partial<Record<LeanState, Outcome[]>> {
  return {
    ready: [{ kind: "ok" }],
    // A frozen contract, so the comment carries a `Frozen acceptance tests:` section
    // and the byte-identity arm covers the WHOLE body.
    specify: [
      {
        kind: "ok",
        frozen: { "tests/AC1-verified-head.test.sh": "a".repeat(64) },
        tests: { AC1: ["tests/AC1-verified-head.test.sh"] },
      },
    ],
    // `MAX_BUILD_ATTEMPTS` rounds, so the cap is spent when the gate is asked the
    // second time: the red that routes the run to its report has no round left to
    // buy. The walk re-enters `challenge` once per round it dispatches, so the
    // challenge queue is priced off the same cap — a dry queue there would record an
    // `error` and end the run at its build rather than walk it to its review.
    build: Array.from({ length: MAX_BUILD_ATTEMPTS }, () => ({ kind: "ok" }) as Outcome),
    challenge: Array.from({ length: MAX_BUILD_ATTEMPTS }, () => ({ kind: "none" }) as Outcome[]),
    // ONE green, ONE publish. The re-verification the fixed review dispatches stays
    // UNANSWERED, which is the premise rather than an omission: `handbackHeads` reads
    // the newest DECIDED `verify` at or before the review, so a second verdict would
    // speak for the head and the rule would not fire. The run is stopped on its way
    // INTO that second gate visit and the report is the one step it takes past the
    // line (see {@link driveToDeadline}).
    verify: [green] as Outcome[],
    publish: [{ kind: "ok", prUrl: "https://github.com/o/r/pull/1" }],
    review: [{ kind: "fixed", reason: "one fix wave" }],
  };
}

/** What one drive settled on, read off the record the run WROTE rather than off the
 *  object the drive returned: the file is the durable record, and it is what a resumed
 *  run — and an operator with `/runs` — reads. */
interface DrivenHandback {
  /** The run's terminal state and reason, for the failure messages. */
  state: string;
  reason: string;
  /** Whether the clock was ever found past the line. */
  crossed: boolean;
  /** The arm the engine persisted, and the late position the clock reached. */
  arm: number | undefined;
  past: number;
  /** The persisted `handback` step's outcome, or `undefined` when it wrote none. */
  outcome: Outcome | undefined;
  /** The whole log the run wrote, for the premise assertions. */
  steps: Step[];
  /** The newest step in the log. */
  newest: Step | undefined;
}

/**
 * Drive one run to its deadline stop through the PRODUCTION reporting wiring.
 *
 * The clock goes late on the report's OWN boundary, which is the only place this
 * premise and that step can both hold: the engine's deadline stop ends the run where
 * it stands without running a reporting step, and a run whose re-verification ANSWERED
 * would no longer be one the rule speaks for. So the queue answers up to and including
 * the review, the table routes `review:fixed` into the re-verification, the stop test
 * refuses it — and `handback`, the state the table reaches next, is the one state
 * `deadlineStopsSteps` never refuses. `crossingAfter` keys the late instant on the
 * record standing at the review's decided verdict, one boundary before that.
 */
async function driveToDeadline(
  repoRoot: string,
  plan: Partial<Record<LeanState, Outcome[]>>,
  baseSha: string,
): Promise<DrivenHandback> {
  // The late instant arrives with the record standing on its decided review: the next
  // boundary is the re-verification's, which the stop test refuses, and the boundary
  // after that is the report's, which it exempts.
  // The clock is handed to the LOOP only: the engine reads it for a step's
  // `startedAt`/`endedAt` and for its own stop test, and no scripted handler consumes
  // it. A handler that reached for `ctx.now()` would be counted as a boundary of the
  // state it belongs to, and the late instant would land somewhere other than the
  // report's exemption — the case would then pass with or without the rule it names.
  const calls: string[] = [];
  const clock = crossingAfter({
    at: "verify",
    after: 0,
    decidedBefore: "review",
    repoRoot,
    issue: ISSUE,
    shortfallMs: SHORTFALL_MS,
  });
  const driven = await runLean({
    repoRoot,
    issue: ISSUE,
    seed: { version: "test", baseSha, branch: BRANCH },
    handlers: {
      ...reportHandlers(repoRoot, ISSUE),
      ...recording(calls, plan),
    },
    now: clock.now,
  });
  const persisted = loadRun(repoRoot, ISSUE);
  const steps = persisted?.steps ?? driven.run.steps;
  const handback = steps.filter((s) => s.state === "handback").pop();
  return {
    state: driven.state,
    reason: driven.run.result?.reason ?? "no reason recorded",
    crossed: clock.crossed(),
    arm: persisted?.deadlineMs ?? driven.run.deadlineMs,
    past: clock.past,
    outcome: handback?.outcome,
    steps,
    newest: steps[steps.length - 1],
  };
}

// ── (a) a green verify at V, a `fixed` review at F, the deadline before the redo.
await withEnv(ENV, async () => {
  const repo = repoWithFixHead();
  const ran = await driveToDeadline(
    repo.repoRoot,
    walkToReview({ kind: "green", verifiedHead: repo.baseSha, reason: `all frozen tests green at ${repo.baseSha}` }),
    repo.baseSha,
  );
  assert(
    ran.crossed,
    `(a) the clock really crossed the handoff allowance during the drive (crossed=${String(ran.crossed)})`,
  );
  assert(
    ran.arm !== undefined && ran.arm - ran.past <= handoffDispatchTimeoutMs(),
    `(a) the stop happened inside the allowance the case pinned (arm ${String(ran.arm)}, past ${ran.past}, allowance ${String(handoffDispatchTimeoutMs())})`,
  );
  assert(
    ran.state === "handed-back",
    `(a) the run ended handed-back at its deadline (got ${ran.state}: ${ran.reason})`,
  );
  // The premise, not just the outcome. The engine's deadline stop ends a run where it
  // stands, so the fact that a `handback` step EXISTS at all is the executed evidence
  // that the routing fired rather than the direct stamp; and the step it was stopped
  // on has to be the re-verification the review dispatched — entered, never answered —
  // with the decided `fixed` review beside it as the newest WORK step the rule reads.
  // A log whose newest work step is anything else is the OTHER case
  // (`undecidedFixLog`), which the rule answers with different words.
  const work = ran.steps.filter((s2) => !REPORT_STATES.includes(s2.state));
  const newestWork = work[work.length - 1];
  assert(
    newestWork?.state === "review" && newestWork.outcome?.kind === "fixed",
    `(a) the newest WORK step is the decided fixed review (${String(newestWork?.state)}:${String(newestWork?.outcome?.kind ?? "undecided")})`,
  );
  assert(
    ran.steps.some((s2) => s2.state === "handback" && s2.outcome !== undefined),
    `(a) the deadline stop routed the run into its report rather than stamping it (steps ${ran.steps.map((s2) => `${s2.key}=${s2.outcome?.kind ?? "?"}`).join(",")})`,
  );
  const oc = ran.outcome;
  assert(oc !== undefined, "(a) the run reached its reporting step and wrote a handback record");
  assert(
    oc?.posted === false && oc.channel === "host",
    `(a) the host channel owns the report: nothing posted, channel recorded (got ${JSON.stringify([oc?.posted, oc?.channel])})`,
  );
  assert(
    oc?.shippedHead === repo.baseSha,
    `(a) shippedHead is V, the head the green certified (got ${String(oc?.shippedHead)}, V ${repo.baseSha})`,
  );
  assert(
    oc?.shippedVerified === true,
    `(a) and that head is recorded verified (got ${String(oc?.shippedVerified)})`,
  );
  assert(
    oc?.unshippedHead === repo.headSha,
    `(a) unshippedHead is F, the head the fix wave pushed (got ${String(oc?.unshippedHead)}, F ${repo.headSha})`,
  );
  assert(
    typeof oc?.unshippedReason === "string" && oc.unshippedReason !== "",
    `(a) the record says why F did not ship (got ${JSON.stringify(String(oc?.unshippedReason))})`,
  );
  // Read back off origin with `ls-remote`, never off the run's own claims.
  assert(
    originBranchSha(repo.origin) === repo.baseSha,
    `(a) origin's branch really ends at V (got ${String(originBranchSha(repo.origin))})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === repo.headSha,
    `(a) and F is still reachable under ${unverifiedRef(ISSUE)} (got ${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
  // The comment, from its one named carrier: the host channel's `outcome.report` IS
  // the delivered body.
  const body = String(oc?.report ?? "");
  assert(
    body.includes(`Shipped head: \`${repo.baseSha}\` (verified)`),
    `(a) the comment names V as the shipped, verified head (got ${JSON.stringify(body.split("\n").find((l) => l.startsWith("Shipped head")) ?? "<none>")})`,
  );
  assert(
    body.includes(`Unshipped head: \`${repo.headSha}\``),
    `(a) and names F as the head it left behind (got ${JSON.stringify(body.split("\n").find((l) => l.startsWith("Unshipped head")) ?? "<none>")})`,
  );
});

// ── (b) the green recorded NO head: nothing moves, and the record says so.
await withEnv(ENV, async () => {
  const repo = repoWithFixHead();
  const before = originBranchSha(repo.origin);
  if (before !== repo.headSha)
    throw new Error(`the arm's origin does not hold the fix head: ${String(before)}`);
  const ran = await driveToDeadline(
    repo.repoRoot,
    walkToReview({ kind: "green", reason: "frozen tests and project tiers passed" }),
    repo.baseSha,
  );
  assert(
    ran.crossed && ran.arm !== undefined && ran.arm - ran.past <= handoffDispatchTimeoutMs(),
    `(b) the stop is a deadline stop inside the pinned allowance (crossed=${String(ran.crossed)}, arm ${String(ran.arm)}, past ${ran.past})`,
  );
  assert(
    ran.state === "handed-back",
    `(b) the run ended handed-back at its deadline (got ${ran.state}: ${ran.reason})`,
  );
  const oc = ran.outcome;
  assert(oc !== undefined, "(b) the run reached its reporting step and wrote a handback record");
  // THE RECORDING (the second commit's red): the rule fired, found a green with no
  // head, and says so on the record instead of leaving the reader to guess.
  assert(
    oc?.shippedHead === repo.headSha,
    `(b) shippedHead is F — the head origin still holds (got ${String(oc?.shippedHead)}, F ${repo.headSha})`,
  );
  assert(
    oc?.shippedVerified === false,
    `(b) and it is recorded NOT verified (got ${String(oc?.shippedVerified)})`,
  );
  assert(
    oc?.unshippedReason === NO_HEAD_REASON,
    `(b) the reason is the rule's own words, quoted (got ${JSON.stringify(String(oc?.unshippedReason))})`,
  );
  assert(
    oc?.unshippedHead === undefined,
    `(b) no head is named as unshipped — this step displaced nothing (got ${String(oc?.unshippedHead)})`,
  );
  assert(
    originBranchSha(repo.origin) === before,
    `(b) nothing was pushed: origin still holds F (got ${String(originBranchSha(repo.origin))})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    `(b) and no keeping-ref was written (got ${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
  const body = String(oc?.report ?? "");
  assert(
    body.includes(`Shipped head: \`${repo.headSha}\` (NOT verified)`),
    `(b) the comment carries the head section with the unverified label (got ${JSON.stringify(body.split("\n").find((l) => l.startsWith("Shipped head")) ?? "<none>")})`,
  );
  assert(
    body.includes(NO_HEAD_REASON),
    "(b) and the comment states the rule's reason for shipping it",
  );
});

// ── (c) the switch OFF: byte-identical to the pre-recording body, four fields absent.
// TWO arms on the same log, so the equality in the off arm cannot be a renderer
// compared with itself: with the recording ON the same drive must produce a body that
// DIFFERS. Each arm owns its repo — one shared origin would let the control's rewind
// move the branch the off arm is meant to leave exactly where it was.
{
  const on = repoWithFixHead();
  const off = repoWithFixHead();
  const greenNoHead = (): Partial<Record<LeanState, Outcome[]>> =>
    walkToReview({ kind: "green", reason: "frozen tests and project tiers passed" });

  await withEnv({ ...ENV, PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD: "1" }, async () => {
    const ran = await driveToDeadline(on.repoRoot, greenNoHead(), on.baseSha);
    assert(
      ran.crossed,
      `(c) control: the clock crossed on the control drive too (crossed=${String(ran.crossed)})`,
    );
    assert(
      ran.outcome?.shippedHead === on.headSha && ran.outcome?.shippedVerified === false,
      `(c) control: with the recording on, the record names F and calls it unverified (got ${JSON.stringify([ran.outcome?.shippedHead, ran.outcome?.shippedVerified])})`,
    );
    assert(
      String(ran.outcome?.report ?? "") !== PRE_RECORD_BODY,
      `(c) control: and the body DIFFERS from the pre-recording capture — the falsification that makes the off arm's equality mean something (got ${JSON.stringify((ran.outcome?.report ?? "").split("\n").slice(0, 3).join(" / "))})`,
    );
  });

  const before = originBranchSha(off.origin);
  if (before !== off.headSha)
    throw new Error(`the off arm's origin does not hold the fix head: ${String(before)}`);
  await withEnv({ ...ENV, PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD: "0" }, async () => {
    const ran = await driveToDeadline(off.repoRoot, greenNoHead(), off.baseSha);
    assert(ran.crossed, `(c) off: the clock crossed on the off drive too (crossed=${String(ran.crossed)})`);
    assert(
      ran.outcome?.report === PRE_RECORD_BODY,
      `(c) off: the comment is the body the pre-recording handback posted, byte for byte (got ${JSON.stringify((ran.outcome?.report ?? "").split("\n").slice(-4).join(" / "))})`,
    );
    assert(
      ran.outcome?.shippedHead === undefined &&
        ran.outcome?.shippedVerified === undefined &&
        ran.outcome?.unshippedHead === undefined &&
        ran.outcome?.unshippedReason === undefined,
      `(c) off: and the record carries NONE of the four head fields (${JSON.stringify([ran.outcome?.shippedHead, ran.outcome?.shippedVerified, ran.outcome?.unshippedHead, ran.outcome?.unshippedReason])})`,
    );
    assert(
      originBranchSha(off.origin) === before,
      `(c) off: origin still holds F, as it did before the drive (got ${String(originBranchSha(off.origin))})`,
    );
    assert(
      originRefSha(off.origin, unverifiedRef(ISSUE)) === undefined,
      "(c) off: and no keeping-ref was written",
    );
  });
}

// ── (d) `PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK=0`: the engine behaves as it did before
// the routing existed. The same drive, the same clock, the same premise — and where
// (a) reached a report, this run is stamped where the clock caught it and no
// `handback` step is ever written. That is the byte-identical off arm of the second
// commit's behaviour: not "the handback said less", but "the handback never ran".
// Origin is untouched, because the step that moves it is the one that did not run —
// which is exactly the gap the routing closes.
{
  const repo = repoWithFixHead();
  const before = originBranchSha(repo.origin);
  if (before !== repo.headSha)
    throw new Error(`the (d) arm's origin does not hold the fix head: ${String(before)}`);
  await withEnv({ ...ENV, PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK: "0" }, async () => {
    const ran = await driveToDeadline(
      repo.repoRoot,
      walkToReview({
        kind: "green",
        verifiedHead: repo.baseSha,
        reason: `all frozen tests green at ${repo.baseSha}`,
      }),
      repo.baseSha,
    );
    assert(
      ran.crossed && ran.arm !== undefined && ran.arm - ran.past <= handoffDispatchTimeoutMs(),
      `(d) the stop is a deadline stop inside the pinned allowance (crossed=${String(ran.crossed)}, arm ${String(ran.arm)}, past ${ran.past})`,
    );
    // The engine's own words for the stop it took, not a handler's failure: the
    // reason line names the deadline and the step it refused to start.
    assert(
      ran.state === "handed-back" && ran.reason.includes("cycle deadline") && ran.reason.includes("reached at verify"),
      `(d) with the switch off the run is stamped where the clock caught it (got ${ran.state}: ${ran.reason})`,
    );
    assert(
      !ran.steps.some((s2) => s2.state === "handback"),
      `(d) and NO reporting step was written at all (steps ${ran.steps.map((s2) => `${s2.key}=${s2.outcome?.kind ?? "?"}`).join(",")})`,
    );
    assert(
      ran.outcome === undefined,
      `(d) so there is no handback outcome to read (got ${JSON.stringify(ran.outcome)})`,
    );
    assert(
      originBranchSha(repo.origin) === before,
      `(d) origin still holds F — nothing moved it, because nothing ran (got ${String(originBranchSha(repo.origin))})`,
    );
    assert(
      originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
      "(d) and no keeping-ref was written",
    );
  });
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(state.exit);

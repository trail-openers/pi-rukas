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
 * `rewindToVerified` and the real origin read run against a real bare origin; every
 * EARLIER state is answered from a scripted queue, so no case here needs a forge, a
 * worktree or a model. V and F are real commits from `repoWithFixHead()` — V is the
 * base commit (made reachable on origin under `refs/lean/base/<issue>`) and F the fix
 * head origin's branch holds when the drive starts.
 *
 * The clock is `crossingAfter({ at: "verify", decidedBefore: "review" })` — the rig's
 * late instant arrives with the record standing on its decided `review:fixed`, so the
 * crossing lands on the RE-VERIFICATION's boundary: the stop test refuses to start the
 * gate the review dispatched, and `handback` — the state the table reaches next — is the
 * one state `deadlineStopsSteps` never refuses. That exemption is the only place this
 * premise and that report can both hold: the engine's deadline stop ends a run where it
 * stands and runs no reporting step, and a run whose re-verification ANSWERED is one the
 * rule no longer speaks for. Do NOT restore `at: "handback"` — reporting states are
 * exempt, so the clock would never stop anything and the case would silently become a
 * no-deadline drive. The crossing, the allowance comparison and `clock.crossed()` all
 * live in `lib/lean-verified-handback-deadline-rig.ts` (`driveToDeadline`); this file
 * only asserts what the record and the comment say.
 *
 * `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` is pinned explicitly (it is in the restored
 * `ENV_KEYS` set) and sized under the rig's late position, and the case asserts
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
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { runLean } from "../src/lean/engine.ts";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import { reportHandlers } from "../src/lean/report-handlers.ts";
import type { LeanState, Outcome, Step } from "../src/lean/state.ts";
import { REPORT_STATES } from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state.ts";
import { handoffDispatchTimeoutMs } from "../src/work-driver-handoff.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { recording, withEnv } from "./lib/lean-host-contract-fixture.ts";
import {
  type DrivenHandback,
  ENV,
  NO_HEAD_REASON,
  PRE_RECORD_BODY,
  driveToDeadline,
  walkToReview,
} from "./lib/lean-verified-handback-deadline-rig.ts";
import { ISSUE, ROOTS } from "./lib/lean-verified-handback-fixture.ts";
import {
  originBranchSha,
  originRefSha,
  repoWithFixHead,
} from "./lib/lean-verified-handback-repo.ts";

const { assert, state } = makeAssert();

/** The instant the resume's clock returns: any time inside the allowance, since the
 *  run it is driving is finished and must not be handed a deadline at all. */
const start = Date.now();

// ── (a) a green verify at V, a `fixed` review at F, the deadline before the redo.
await withEnv(ENV, async () => {
  const repo = repoWithFixHead();
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
  // The reason line is the record's own answer to "why is this not what the gate approved?":
  // the report's sentence, and verbatim the step the clock refused. A routed run that lost the
  // second half would be indistinguishable, on its reason alone, from an ordinary handback.
  assert(
    ran.reason.includes("cycle deadline reached at verify"),
    `(a) the routed reason names the step the clock refused (got ${JSON.stringify(ran.reason)})`,
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
  // The comment has to name the head it left behind; whether the RECORD also carries a
  // sentence for it is not this case's claim (the rewind's landed arm reports no
  // refusal, and there is nothing to refuse). Asserted where the fact is stated.
  assert(
    typeof oc?.unshippedHead === "string",
    `(a) the record names the head F it left unshipped (got ${String(oc?.unshippedHead)})`,
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
  // And the log itself, before anything reads it. The routing runs the report as a step, so the log ends
  // on the report's own entry carrying its verdict — the shape a normal handback leaves, and the one that
  // makes the record say in its own words that the run got reported. What must NOT be there is a decided
  // `verify` after the review: the clock refused that gate, and a verdict for a step that never ran would
  // both certify bytes nobody checked and tell `handback-heads.ts` the gate had spoken, so a resumed run
  // would stop rewinding and lose the head fields from its next comment.
  assert(
    ran.newest?.state === "handback" && ran.newest.outcome?.kind === "done",
    `(a) the log's newest entry is the report step the routing ran, with its verdict (${String(ran.newest?.state)}:${String(ran.newest?.outcome?.kind ?? "undecided")})`,
  );
  assert(
    !ran.steps.some(
      (s2) => s2.state === "verify" && s2.outcome !== undefined && s2.key !== "2242:verify:0",
    ),
    `(a) and no decided re-verification was fabricated behind the clock (${ran.steps.map((s2) => `${s2.key}=${s2.outcome?.kind ?? "?"}`).join(",")})`,
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

  // THE ROUTED RECORD MUST RESUME. `runLean` re-opens it, folds the log through the table, and
  // refuses a file whose snapshot the fold cannot reproduce — and because that loader runs before
  // the routing's switch is read, a record the routing wrote wrongly is unresumable PERMANENTLY:
  // no env value recovers it, and the documented answer to "a run timed out, re-run it" is closed.
  // The routing moves the state via `apply()`, which is the writer that keeps state and log in
  // agreement, so this second drive is the executed evidence of that and not a restatement of it.
  const reopened = await runLean({
    repoRoot: repo.repoRoot,
    issue: ISSUE,
    handlers: {
      ...reportHandlers(repo.repoRoot, ISSUE),
      // A queue the resume can NEVER draw on: the run is finished, and if it drove it would reach
      // the gate again, find this dry queue, and the engine would end it on a handler `error` — a
      // `handed-back` these assertions could not tell from the real thing.
      ...recording([], { verify: [] }),
    },
    // A time BEFORE the drive's own arm: the record persists the arm its first round
    // resolved, so an early clock here keeps every boundary of the resume inside the
    // allowance and cannot re-stop the run the routing already reported. A late clock
    // would make the assertions below depend on the routing's `handback` step being
    // exempt from the stop test rather than on the resume being clean.
    now: () => start - 10 * MINUTE_MS,
  });
  assert(
    reopened.state === "handed-back",
    `(a) re-driving the routed run returns rather than refusing it (got ${reopened.state})`,
  );
  // The claim the resume's return has to carry, beyond `state`: a run that had re-driven into its
  // own gate would have been ended by the engine's handler-error or no-handler stamp, and neither
  // sentence is the report's. Byte-identical to the first drive's reason is the evidence that this
  // drive ran nothing.
  assert(
    reopened.run.result?.reason === ran.reason,
    `(a) and the resume drove nothing: its reason is still the report's own sentence (${JSON.stringify(reopened.run.result?.reason)}, was ${JSON.stringify(ran.reason)})`,
  );
  assert(
    reopened.code === 10,
    `(a) and exits with the handback code, not a fresh stop (got ${String(reopened.code)})`,
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
  assert(
    ran.reason.includes("cycle deadline reached at verify"),
    `(b) and its reason names the step the clock refused (got ${JSON.stringify(ran.reason)})`,
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
    assert(
      ran.crossed,
      `(c) off: the clock crossed on the off drive too (crossed=${String(ran.crossed)})`,
    );
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
      ran.state === "handed-back" &&
        ran.reason.includes("cycle deadline") &&
        ran.reason.includes("reached at verify"),
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

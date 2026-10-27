#!/usr/bin/env bun
import { LENS_FIX_BOUND_ENV } from "../src/review-budget.ts";
/**
 * #1798 — WHICH dispatch of a multi-failure lens-fix window the bound verdict
 * reads, and WHICH cap it is allowed to answer. Companion to
 * `test-work-driver-lens-fix-kill-cause.ts`, which pins the chain that gets the
 * fact from the clock to the handoff; this file pins the two remaining
 * questions, and they are the ones a fix loop actually poses:
 *
 * The step re-dispatches. A window can therefore hold TWO (or more)
 * `dispatch-failed` events between one `step-started` and the
 * `step-failed:lens-fix` cap, and the cap explains ONE of them. The rule this
 * file pins is the rule the module documents:
 *
 *   the LAST failed dispatch before the cap is the dispatch that failed the
 *   step, so it is the one the cap explains — for cause, source and line.
 *
 * Why LAST, and not first: the router halts on the tail (`failureEventOf` reads
 * the last event of the step, and `failureOf`'s `failedDispatchBefore` scans
 * BACKWARD from the cap). A transient retry appends another dispatch after the
 * first; whichever ended the step is what the operator's cap is about. Reading
 * the FIRST instead lets an earlier round's `fixerBoundSource` and kill clause
 * license a later, sourceless host kill — a bound verdict for a child pi-rukas
 * never killed at a bound — while the same log's `failureOf` names the other
 * dispatch, so the handoff's cause and its evidence disagree by construction.
 *
 * Both orders are pinned, and both are pinned against `failureOf`: a rule that
 * makes the two reads select different dispatches is the defect, whichever way
 * it points.
 *
 * And the cap itself is pinned (#1798 round 4): the verdict answers the cap the
 * cycle STANDS on, not any cap the caller names. A lens-fix kill followed by a
 * later develop cap must give NO verdict for the develop cap.
 */
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import { lensFixBoundKillVerdict } from "../src/work-driver-lens-fix-kill-cause.ts";
import {
  boundKillTail,
  byKind,
  completedRound,
  failFor,
  failedDispatches,
  killed,
  lensFixWindow,
  MIN,
  NOW,
  plainKill,
} from "./lib/lens-fix-kill-cause-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    exit = 1;
    return;
  }
  console.log(`✓ ${msg}`);
}

// A bound kill armed by the step (the fixer's own ceiling) and a sourceless
// kill the driver ended for a reason that is not a time bound.
const armed = killed({ fixerBoundSource: "fixer-bound" });
const sourceless = plainKill();

/** The dispatches a window recorded, as the fixtures see them. */
function tails(state: Awaited<ReturnType<typeof lensFixWindow>>): (string | undefined)[] {
  return failedDispatches(state).map((e) => (e as { errorTail?: string }).errorTail);
}

{
  // The shape the developer's probe reported, written through the real writers:
  // two lens-fix dispatches in ONE step window, then the cap. The armed kill is
  // the LAST thing that ran, so it is the dispatch the cap explains.
  const state = await lensFixWindow([sourceless, armed], [undefined, "fixer-bound"]);
  assert(
    byKind(state, "step-started", "lens-fix").length === 1 &&
      byKind(state, "cap-hit").length === 1 &&
      failedDispatches(state).length === 2,
    "one step window, two lens-fix dispatch failures, then the cap",
  );
  assert(
    tails(state)[1]?.includes(LENS_FIX_BOUND_ENV) === true &&
      tails(state)[0]?.includes(LENS_FIX_BOUND_ENV) === false,
    "the last dispatch of the window is the armed bound kill",
  );

  const v = lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798);
  assert(
    v?.causeClass === "pi-rukas" &&
      (v.causeReason ?? "").includes("killed at 45m") &&
      (v.causeEvidence[0] ?? "").includes(LENS_FIX_BOUND_ENV),
    `the LAST failure — the one that failed the step — supplies cause, source and line (got ${JSON.stringify(v?.causeReason)})`,
  );
  // The two reads of the same window must name the SAME dispatch. `failureOf`
  // scans backward and lands on the armed kill; the verdict now agrees with it,
  // so the handoff's cause and its evidence cannot come from different children.
  const f = failFor(state);
  assert(
    f?.killCause === "timeout" && (f.errorTail ?? "").includes(LENS_FIX_BOUND_ENV),
    `failureOf reads the same dispatch the verdict did (got ${JSON.stringify(f?.killCause)})`,
  );
  const viaClass = causeVerdictOf(state, "step-failed:lens-fix", f);
  assert(
    viaClass?.causeClass === "pi-rukas",
    `and the classifier reaches the same verdict through the failure projection (got ${viaClass?.causeClass})`,
  );
}

{
  // The mirror image: the armed kill ran FIRST and a sourceless kill ended the
  // step. The cap explains the sourceless one, so the verdict abstains and the
  // generic entry answers — an earlier round's bound is not this round's cause.
  const state = await lensFixWindow([armed, sourceless], ["fixer-bound", undefined]);
  const v = lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798);
  assert(v === undefined, "the first round's bound does not license the round that ended the step");
  const f = failFor(state);
  assert(
    f?.killCause === "no-progress",
    `failureOf names the sourceless dispatch, and the verdict abstains on exactly the dispatch it names (got ${JSON.stringify(f?.killCause)})`,
  );
  const generic = causeVerdictOf(state, "step-failed:lens-fix", f);
  assert(
    generic?.causeClass === "environment",
    `so the operator gets the generic entry, not a knob to raise (got ${generic?.causeClass})`,
  );
}

{
  // A completed round in FRONT of the killed one contributes nothing: the
  // source and the clause come from the killed dispatch alone.
  const state = await lensFixWindow([completedRound(), armed], [undefined, "fixer-bound"]);
  const v = lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798);
  assert(
    v?.causeClass === "pi-rukas" && (v.causeEvidence[0] ?? "").includes(LENS_FIX_BOUND_ENV),
    `a completed round cannot supply facts the killed child did not record (got ${JSON.stringify(v?.causeClass)})`,
  );
}

{
  // #1798 round 3 — the MIRROR: a completed round BEHIND an earlier bound kill
  // means that kill was retried and the step recovered from it, so its source
  // is history. The walk stops at a `dispatch-completed` of this step, which is
  // the same #386 rule `isSystemicFailure` applies to the queue: a failure a
  // later success answered is not the failure that ended the step. Without the
  // stop, the sourceless kill that really did end the step would be given the
  // recovered round's knob to raise.
  const state = await lensFixWindow(
    [armed, completedRound(), sourceless],
    ["fixer-bound", undefined, undefined],
  );
  assert(
    byKind(state, "dispatch-completed", "lens-fix").length === 1,
    "the window holds a recovered round between the bound kill and the kill that ended the step",
  );
  assert(
    lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798) === undefined,
    "a bound kill that the step recovered from does not license the later kill",
  );
  const generic = causeVerdictOf(state, "step-failed:lens-fix", failFor(state));
  assert(
    generic?.causeClass === "environment",
    `…and the operator gets the generic entry (got ${generic?.causeClass})`,
  );
}

{
  // Three dispatches, bound in the middle: the LAST one still wins, so a
  // window's size cannot smuggle an earlier round's knob into the handoff.
  const state = await lensFixWindow(
    [armed, killed({ fixerBoundSource: "review-clock" }), sourceless],
    ["fixer-bound", "review-clock", undefined],
  );
  assert(
    lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798) === undefined,
    "the last of three wins even when two earlier rounds were both armed",
  );
  const last = await lensFixWindow(
    [sourceless, killed({ fixerBoundSource: "review-clock" })],
    [undefined, "review-clock"],
  );
  const v = lensFixBoundKillVerdict(last, "step-failed:lens-fix", undefined, 1798);
  assert(
    v?.causeClass === "pi-rukas" && (v.userAction ?? "").includes("PI_ENSEMBLE_REVIEW_WALL_CLOCK"),
    `and the LAST round's own source picks the knob (got ${JSON.stringify(v?.userAction)?.slice(0, 90)})`,
  );
}

console.log("\n#1798 lens-fix bound kill window rule: all assertions passed");

{
  // #1798 round 4 — THE CAP MUST MATCH. `lastCapIndex` finds the cap the cycle
  // stands on; it never checked that cap's IDENTITY against the `cap` the
  // caller passed (the cap-hit event carries no `step`, so nothing compared
  // them). A cycle whose lens-fix step died at a bound and whose LAST cap
  // belongs to a later develop round therefore got the lens-fix verdict for
  // the DEVELOP cap: "raise the fixer's bound and re-run", for a step pi-rukas
  // never killed at a bound — advice that cannot move the failure in front of
  // the operator.
  const capped = await lensFixWindow([armed], ["fixer-bound"]);
  const log = [...capped.eventLog];
  assert(
    log.at(-1)?.kind === "cap-hit",
    "the fixture ends on the lens-fix cap, with an armed bound kill below it",
  );
  log.push(
    { kind: "step-started", step: "develop", at: NOW + 2 * MIN } as WorkEvent,
    {
      kind: "dispatch-failed",
      step: "develop",
      role: "developer",
      jobId: "develop:x:2:1",
      label: "developer",
      ms: MIN,
      at: NOW + 3 * MIN,
      exitCode: 1,
      errorTail: "develop child exited 1",
    } as WorkEvent,
    {
      kind: "cap-hit",
      cap: "step-failed:develop",
      at: NOW + 3 * MIN,
      reviewRound: 0,
      nextStep: "handoff",
    } as WorkEvent,
  );
  const state = { ...capped, eventLog: log } as WorkState;
  assert(
    lensFixBoundKillVerdict(state, "step-failed:develop", undefined, 1798) === undefined,
    "a lens-fix kill does not answer a LATER develop cap — the cap must be the one the cycle stands on",
  );
  assert(
    lensFixBoundKillVerdict(capped, "step-failed:lens-fix", undefined, 1798)?.causeClass ===
      "pi-rukas",
    "asked the RIGHT question, the same window still gets its bound verdict — the guard refuses a mismatch, it does not disable the rule",
  );

  // …and the cap's EVIDENCE fallback reads the same cap index rather than
  // `lastCapHit`'s reverse scan: a pre-#1798 state file (no source on the
  // event, the clause only in the tail) still resolves from the cap the caller
  // named, never from some other cap-hit that happens to sit later in the log.
  const legacy = await lensFixWindow([killed()], [undefined], [boundKillTail]);
  assert(
    lensFixBoundKillVerdict(legacy, "step-failed:lens-fix", undefined, 1798)?.causeClass ===
      "pi-rukas",
    "the text fallback resolves a pre-#1798 state file from that cap's own evidence",
  );
}

process.exit(exit);

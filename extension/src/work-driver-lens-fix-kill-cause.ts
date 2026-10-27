/**
 * work-driver-lens-fix-kill-cause — #1798: a lens-fix killed at a bound
 * pi-rukas armed is not an environment fault.
 *
 * The field shape, three cycles on v0.14.27: the lens-fix developer was killed
 * at its own bound (twice at the 45-minute `PI_ENSEMBLE_LENS_FIX_BOUND_MS`
 * ceiling, once at the caller's cycle deadline), still producing output seconds
 * before the kill, and the cycle ended with
 * `Cause: environment — the step failed and the driver recorded no structured
 * cause for it` / `What you can do: clear the environment fault the evidence
 * names (the provider, the host or the deadline), then re-run /work N`. Nothing
 * in the environment had failed; the "deadline" named was a pi-rukas default.
 * An operator who followed it restarted the cycle and burned the same hours.
 *
 * The reading is structural, not prose: `step-failed:lens-fix` plus a
 * `fixerBoundSource` on the dispatch the cap explains. The source is written by
 * the step that ARMED the bound (`work-driver-lens-fix-arming.ts`) and carried
 * through the completion event, so the classifier never re-derives a bound from
 * the environment and cannot disagree with the dispatch.
 *
 * What still classifies as before, deliberately:
 *  - a provider error-stop, and any dispatch whose source is absent (a role
 *    backstop kill, a per-child run bound, a PM dispatch) — the generic
 *    kind-driven `environment` entry stays, with its host advice;
 *  - a kill at pi-rukas's own bound that is ALSO a caller-deadline kill keeps
 *    `cycle-deadline` as its source and gets the deadline knob, not the host;
 *  - every other step. This verdict is lens-fix-only: the develop step's
 *    timeouts have their own caps (`spawn-backstop`, `child-timeout:*`) and
 *    #1769 owns the adversarial fix pass.
 */

import type { CauseVerdict } from "./work-driver-cause-class.ts";
import type { FixerBoundSource } from "./work-driver-fixer-bound.ts";
import { lensFixBoundKillAction } from "./work-driver-fixer-bound.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
// `CauseVerdict` is the shape every classifier returns; the class itself comes
// from the shared table so this module cannot invent a vocabulary.
import type { WorkState } from "./workflow-state.ts";

/** The one step this verdict claims. Anything else falls through to the table. */
const LENS_FIX_STEP = "lens-fix";

/** Is this cap the lens-fix step's generic failure cap? Module-private: the
 *  verdict below is this module's only export that matters, and tests reach
 *  this rule through it. */
function isLensFixStepCap(cap: string): boolean {
  return cap === `step-failed:${LENS_FIX_STEP}`;
}

/** The bound source of the kill this cap explains, or `undefined` when the
 *  dispatch left no such record. Module-private: the only reader is this
 *  module's verdict, which tests reach through `lensFixBoundKillVerdict`. */
function lensFixKillBoundSource(
  state: WorkState,
  cap: string,
): FixerBoundSource | undefined {
  // The dispatch the cap explains, read the way `failureOf`'s
  // `failedDispatchBefore` reads it: the LAST `dispatch-failed` between the
  // start of the step's last run and the cap. One rule for cause, source and
  // line (`killCauseOf` / `providerAtKillOf` / `killLine` below all share it),
  // so the verdict can never describe a round other than the one the cap fired
  // on. The earlier scans here looked BACKWARD from the cap and forward from 0
  // and could therefore stop at a completed round or read a killed one.
  const dispatch = failedLensFixDispatch(state, cap);
  if (dispatch === undefined) return undefined;
  // A source recorded by the step that ARMED the bound is authoritative and
  // does not fall through to text scanning.
  if (dispatch.fixerBoundSource !== undefined) return dispatch.fixerBoundSource;
  // A state file written before #1798 records no source on the event, so the
  // kill's own text is all that is left — read for the ONE clause the builder
  // writes (`fixerBoundClause`), never for free prose.
  const fromTail = boundSourceFromText(dispatch.errorTail ?? "");
  if (fromTail !== undefined) return fromTail;
  return boundSourceFromText(lastCapHit(state, cap)?.evidence ?? "");
}

/** The clause `fixerBoundClause` writes, read back. A keyword appears only in
 *  the clause the driver itself produced, so this never invents a source out of
 *  a child's or a provider's words. Module-private for the same reason as
 *  `isLensFixStepCap`. */
function boundSourceFromText(text: string): FixerBoundSource | undefined {
  if (text.includes("cycle-deadline bound")) return "cycle-deadline";
  if (text.includes("review-clock bound")) return "review-clock";
  if (text.includes("fixer-bound bound")) return "fixer-bound";
  return undefined;
}

/** The minutes named by the kill's own clause, for the reason line. */
function boundMinutesFromText(text: string): number | undefined {
  const minutes = Number.parseInt(/bound of (\d+)m/.exec(text)?.[1] ?? "", 10);
  return Number.isFinite(minutes) ? minutes : undefined;
}

/** The dispatch the cap explains: the LAST `dispatch-failed` between the start
 *  of the stopped step's last run and the cap — the window
 *  `headless/failure.ts`'s `failedDispatchBefore` uses, restated here so this
 *  module stays a leaf of the cause table. `undefined` when the window holds no
 *  lens-fix failure (another step's dispatch, or no dispatch at all). */
function failedLensFixDispatch(state: WorkState, cap: string) {
  const capIdx = state.eventLog.findIndex((e) => e.kind === "cap-hit" && e.cap === cap);
  let start = capIdx < 0 ? 0 : capIdx;
  for (let i = start - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "step-started" && e.step === LENS_FIX_STEP) {
      start = i;
      break;
    }
  }
  for (let i = capIdx - 1; i >= start; i--) {
    const e = state.eventLog[i];
    if (e?.kind !== "dispatch-failed") continue;
    // The LAST dispatch-failed in the window, as `failureOf` reads it: the
    // dispatch the cap explains.
    return e.step === LENS_FIX_STEP ? e : undefined;
  }
  return undefined;
}

/**
 * The kill cause of the dispatch this cap explains, read from the EVENT rather
 * than from `ResultFailure`: `failureOf` does not carry `killCause`, so a
 * caller that reads it there always gets `undefined` and this verdict silently
 * abstains on every real cycle.
 */
function killCauseOf(state: WorkState, cap: string): string | undefined {
  return failedLensFixDispatch(state, cap)?.killCause;
}

/**
 * Whether the dispatch this cap explains came back on a provider error-stop as
 * well as a kill. The mirror of `killCauseOf` for the guard below: it reads the
 * EVENT, so it sees the fact `buildCompletionEvent` now carries on a killed
 * dispatch (`providerMessage`) rather than only the projection `failureOf`
 * builds — which sets that field for a `dispatch-failed` today but would not
 * have if a future read widened the kill branch's kind handling.
 */
function providerAtKillOf(state: WorkState, cap: string): boolean {
  return failedLensFixDispatch(state, cap)?.providerMessage !== undefined;
}

/** The kill's own line, which carries the source, the minutes and the knob —
 *  from the same dispatch the cause and the source came from. Falls back to the
 *  cap-hit's own evidence when the window holds no dispatch to read. */
function killLine(state: WorkState, cap: string): string {
  const dispatch = failedLensFixDispatch(state, cap);
  if (dispatch !== undefined) return dispatch.errorTail ?? "";
  return lastCapHit(state, cap)?.evidence ?? "";
}

/**
 * The verdict for `step-failed:lens-fix` when pi-rukas's own bound killed the
 * fixer. `undefined` for every other shape — a provider fault, a sourceless
 * kill, a different step — so the caller keeps the generic entry verbatim.
 */
export function lensFixBoundKillVerdict(
  state: WorkState,
  cap: string,
  failure: { kind?: string; providerMessage?: string; killCause?: string } | undefined,
  issue: number,
): CauseVerdict | undefined {
  if (!isLensFixStepCap(cap)) return undefined;
  // Only a kill whose OWN cause is a bound is a bound kill: `timeout` is the
  // wall-clock bound, `child-bound` the child-supervision bound. An inactivity,
  // loop or abort kill is a different mechanism with different knobs, so the
  // kill's cause is checked BEFORE anything is read (and before the provider
  // short-circuit, because `failureOf` carries no `killCause` at all — its
  // `kind` is the projection of the event's, and reading a field it does not
  // set would abstain on every cycle).
  const cause = killCauseOf(state, cap);
  if (cause !== "timeout" && cause !== "child-bound") return undefined;
  // A provider error-stop is the fault it was: the endpoint severed the stream
  // and no bound is the reason. Read from the EVENT SIDE, the same way
  // `killCauseOf` reads the cause, and NOT from `failure.providerMessage`:
  // `failureOf` sets that field only on a `dispatch-failed-provider`, and a
  // dispatch that is both killed at its bound and error-stopped is recorded as
  // a `dispatch-failed` (`buildCompletionEvent`'s kill branch wins the event),
  // so the field-on-the-failure read was unreachable and an outage got the
  // "raise the bound" advice. `failure.providerMessage` is still honoured for
  // a caller that reads the failure rather than the log.
  if (failure?.providerMessage !== undefined) return undefined;
  if (providerAtKillOf(state, cap)) return undefined;
  const source = lensFixKillBoundSource(state, cap);
  if (source === undefined) return undefined;
  const line = killLine(state, cap);
  const minutes = boundMinutesFromText(line);
  // No minutes in the kill's clause (a state file whose tail was clipped, an
  // older builder) still names the clock and the knob — but never "0m", which
  // reads as a bound of zero rather than as "the number is unknown".
  const at = minutes === undefined ? "a bound" : `${Math.round(minutes)}m`;
  return {
    causeClass: "pi-rukas",
    causeReason: `the lens-fix developer was killed at ${at} by pi-rukas's own time bound — the child was working, the provider and the host were not at fault`,
    causeEvidence: [line],
    userAction: lensFixBoundKillAction(source, issue),
  };
}

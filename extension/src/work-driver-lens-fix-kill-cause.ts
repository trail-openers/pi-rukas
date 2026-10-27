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

/** Is this cap the lens-fix step's generic failure cap? */
export function isLensFixStepCap(cap: string): boolean {
  return cap === `step-failed:${LENS_FIX_STEP}`;
}

/**
 * The bound source of the kill this cap explains, or `undefined` when the
 * dispatch left no such record.
 *
 * Read from the failed `dispatch-failed` the cap follows — the same event
 * `failureOf` reads for kind and tail — falling back to the cap-hit's own
 * evidence only for a state file whose event predates the field. Never
 * inferred from a duration: that is how a 45-minute fixer bound and a 45-minute
 * host kill looked alike.
 */
export function lensFixKillBoundSource(
  state: WorkState,
  cap: string,
): FixerBoundSource | undefined {
  const capIdx = state.eventLog.findIndex((e) => e.kind === "cap-hit" && e.cap === cap);
  const start = capIdx < 0 ? 0 : capIdx;
  for (let i = start - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind !== "dispatch-failed") continue;
    if (e.step !== LENS_FIX_STEP) return undefined;
    return e.fixerBoundSource;
  }
  // A state file written before #1798 records no source, so the cap's own
  // evidence is all that is left — and it is read for the ONE clause the kill
  // line writes, not for free prose.
  const evidence = lastCapHit(state, cap)?.evidence ?? "";
  return boundSourceFromText(evidence);
}

/** The clause `fixerBoundClause` writes, read back. A keyword appears only in
 *  the clause the driver itself produced, so this never invents a source out of
 *  a child's or a provider's words. */
export function boundSourceFromText(text: string): FixerBoundSource | undefined {
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

/** The kill's own line, which carries the source, the minutes and the knob. */
function killLine(state: WorkState, cap: string): string {
  const capIdx = state.eventLog.findIndex((e) => e.kind === "cap-hit" && e.cap === cap);
  const start = capIdx < 0 ? 0 : capIdx;
  for (let i = start - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "dispatch-failed" && e.step === LENS_FIX_STEP) {
      return e.errorTail ?? "";
    }
  }
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
  failure: { kind?: string; providerMessage?: string } | undefined,
  issue: number,
): CauseVerdict | undefined {
  if (!isLensFixStepCap(cap)) return undefined;
  // A provider error-stop is the fault it was: the endpoint severed the stream
  // and no bound is the reason. That dispatch has no killCause and no source,
  // and the check is kept explicit so a future producer that stamps both cannot
  // quietly re-badge an outage as a knob.
  if (failure?.providerMessage !== undefined) return undefined;
  const source = lensFixKillBoundSource(state, cap);
  if (source === undefined) return undefined;
  const line = killLine(state, cap);
  const minutes = boundMinutesFromText(line);
  return {
    causeClass: "pi-rukas",
    causeReason: `the lens-fix developer was killed at ${Math.round(
      minutes ?? 0,
    )}m by pi-rukas's own time bound — the child was working, the provider and the host were not at fault`,
    causeEvidence: [line],
    userAction: lensFixBoundKillAction(source, issue),
  };
}

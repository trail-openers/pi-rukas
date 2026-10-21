/**
 * work-driver-explain-repeat — what the renderers say about a park that
 * repeats (#1743).
 *
 * Two pieces, one seam. `repeatParkNote` is the sentence every park handoff
 * opens with when an earlier cycle already reported this same park; three caps
 * can park twice on an unchanged issue (`intent-park`, `plan-spec-mismatch`,
 * `existing-pr-detected`) and each has its own explain module, so the line
 * lives here rather than in three copies. `explainRepeatPark` explains the
 * cap the PRE-LOOP guard raises when a further identical start arrives.
 *
 * Both are honest about the two handoff channels: a forge repeat points at the
 * earlier comment, a host-channel repeat has no comment to point at — the body
 * went to the host in the `--json` result — and the sentence says so instead of
 * printing the word `undefined` where a URL would have been.
 *
 * The refusal sentence is written from the guard's STRUCTURED verdict, not
 * from a cap-hit: the refusal happens before any step runs and the driver
 * persists no state, so a `cap-hit` for `repeat-park` is never written and
 * reading one would always fall through to a guess.
 */

import { isRefusableParkCap } from "./work-driver-park-memory.ts";
import type { WorkState } from "./workflow-state.ts";

/** The repeat prefix for a handoff explanation, or "" when this park is the first of its kind. */
export function repeatParkNote(state: WorkState): string {
  const emitted = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
  if (emitted?.kind !== "handoff-emitted" || !emitted.repeatOf) return "";
  const mins = Math.max(0, Math.round((emitted.at - emitted.repeatOf.at) / 60_000));
  const clause = emitted.repeatOf.commentUrl
    ? `(${emitted.repeatOf.commentUrl}), so no second comment was posted`
    : "(no comment — the earlier park went to the host through the headless result), so nothing was re-posted";
  // The count is printed only when the record actually published one. `?? 2`
  // used to claim "REPEAT #2" for a park the record never counted, which is
  // the same invented-number failure mode as #404's invented park reason.
  const head = emitted.repeat
    ? `REPEAT #${emitted.repeat.count} of the park`
    : "A REPEAT of the park";
  // Only the deterministic parks can refuse a start (see REFUSABLE_PARK_CAPS).
  // The plan gate is a model's judgement, so promising a refusal there would be
  // the driver overstating a verdict it cannot compute twice — and the advice
  // to re-run is genuinely correct for it.
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit")?.cap;
  const refuses = isRefusableParkCap(cap);
  const outlook = refuses
    ? "Two cycles have now said the same thing about this issue body — a further start is refused until the body changes (or PI_ENSEMBLE_REPEAT_PARK=0)."
    : "Two cycles have now said the same thing about this issue body. This gate is a model's judgement, so a re-run may genuinely come back different — try again, and revise the body if it parks a third time.";
  return `${head} first reported ${mins} min ago ${clause}: this cycle ran the same gate again against the same issue text and reached the same verdict. ${outlook}\n\n`;
}

/**
 * The `repeat-park` cap: a start the pre-loop guard refused before any step
 * ran. NO verdict parameter: the guard runs before any step and the driver
 * persists no state for a refused start, so no renderer downstream of
 * `explainCap(cap, state)` can have a verdict to hand in — the one place that
 * holds it (`refuseRepeatPark`, and the headless projector that reads it) builds
 * its own sentence from the record fields. This is the generic sentence for a
 * cap seen without one, and it says only what it actually knows.
 */
export function explainRepeatPark(): string {
  return "this start was refused before any step ran: an earlier cycle already parked this issue for the same reason, against the same issue text, and reported it. The park is not stale, it is UNCHANGED — a third report of the same verdict says nothing the second did. Two ways forward: revise the issue body (the guard fingerprints the title and body, so any substantive edit clears it and the next park reports in full), or run once with PI_ENSEMBLE_REPEAT_PARK=0 to report it regardless. Nothing was dispatched, no worktree was touched, and no state file was written";
}

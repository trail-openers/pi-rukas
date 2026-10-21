/**
 * work-driver-explain-repeat — what the renderers say about a park that
 * repeats (#1743).
 *
 * Two pieces, one seam. `repeatParkNote` is the sentence every park handoff
 * opens with when an earlier cycle already reported this same park; three caps
 * can park twice on an unchanged issue (`intent-park`, `plan-spec-mismatch`,
 * `existing-pr-detected`) and each has its own explain module, so the line
 * lives here rather than in three copies. `explainRepeatPark` explains the
 * cap the PRE-LOOP guard raises when a third identical start arrives.
 *
 * Both are honest about the two handoff channels: a forge repeat points at the
 * earlier comment, a host-channel repeat has no comment to point at — the body
 * went to the host in the `--json` result — and the sentence says so instead of
 * printing the word `undefined` where a URL would have been.
 */

import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/** The repeat prefix for a handoff explanation, or "" when this park is the first of its kind. */
export function repeatParkNote(state: WorkState): string {
  const emitted = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
  if (emitted?.kind !== "handoff-emitted" || !emitted.repeatOf) return "";
  const mins = Math.max(0, Math.round((emitted.at - emitted.repeatOf.at) / 60_000));
  const times = emitted.repeat?.count ?? 2;
  const clause = emitted.repeatOf.commentUrl
    ? `(${emitted.repeatOf.commentUrl}), so no second comment was posted`
    : "(no comment — the earlier park went to the host through the headless result), so nothing was re-posted";
  return `REPEAT #${times} of the park first reported ${mins} min ago ${clause}: this cycle ran the same gate again against the same issue text and reached the same verdict. Two cycles have now said the same thing about this issue body — a third start is refused until the body changes (or PI_ENSEMBLE_REPEAT_PARK=0).\n\n`;
}

/** The `repeat-park` cap: a start the pre-loop guard refused before any step ran. */
export function explainRepeatPark(state: WorkState): string {
  const hit = lastCapHit(state, "repeat-park");
  const detail =
    hit?.evidence ??
    "two earlier cycles parked this issue for the same reason, against the same issue text";
  return `this start was refused before any step ran: ${detail}. The park is not stale, it is UNCHANGED — a third report of the same verdict says nothing the second did. Two ways forward: revise the issue body (the guard fingerprints the title and body, so any substantive edit clears it and the next park reports in full), or run once with PI_ENSEMBLE_REPEAT_PARK=0 to report it regardless. Nothing was dispatched, no worktree was touched, and no state file was written`;
}

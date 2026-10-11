/**
 * work-driver-handoff-fanout — the second-failure view of a develop fan-out,
 * shared by both handoff renderers (#1016).
 *
 * The label is derived per workstream from its own attempts in the current
 * develop step (branch-completed events since the last step-started):
 *   - two or more attempts → "ok after retry" / "FAIL after retry";
 *   - a green with no completion this step → "kept (ok)": it was preserved
 *     from an interrupted attempt and never re-ran;
 *   - any other green → "ok" (it ran this step, first try).
 */
import { type VerdictLine, developVerdictLines } from "./work-develop-verdict-source.ts";
import type { WorkState } from "./workflow-state.ts";

/** Verdict lines for the handoff, annotated with the retry wording. */
export function fanoutVerdictLines(state: WorkState): VerdictLine[] {
  return developVerdictLines(state).map((l) => {
    if (l.attempts >= 2) {
      if (l.ok) return { ...l, text: `${l.id}: ok after retry` };
      const why = l.reason ? ` \u2014 ${l.reason}` : "";
      return { ...l, text: `${l.id}: FAIL after retry${why}` };
    }
    if (!l.ok) return l;
    return l.attempts === 0 ? { ...l, text: `${l.id}: kept (ok)` } : l;
  });
}

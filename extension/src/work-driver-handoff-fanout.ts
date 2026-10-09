/**
 * work-driver-handoff-fanout — the second-failure view of a develop fan-out,
 * shared by both handoff renderers (#1016).
 *
 * The label is derived per workstream from its own attempts in the current
 * develop step (branch-completed events since the last step-started):
 *   - two or more attempts → "ok after retry" / "FAIL after retry";
 *   - a green with no completion this step → "kept (ok)": it was preserved
 *     from an interrupted attempt and never re-ran;
 *   - a green with one completion, while another workstream was retried in
 *     the same step → "kept (ok)": it ran first and was kept as the retry ran;
 *   - any other green → "ok" (a first-try green with no retry anywhere).
 */
import { type VerdictLine, developVerdictLines } from "./work-develop-verdict-source.ts";
import type { WorkState } from "./workflow-state.ts";

/** Verdict lines for the handoff, annotated with the retry wording. */
export function fanoutVerdictLines(state: WorkState): VerdictLine[] {
  const lines = developVerdictLines(state);
  const anyRetried = lines.some((l) => l.attempts >= 2);
  return lines.map((l) => {
    if (l.attempts >= 2) {
      if (l.ok) return { ...l, text: `${l.id}: ok after retry` };
      const why = l.reason ? ` \u2014 ${l.reason}` : "";
      return { ...l, text: `${l.id}: FAIL after retry${why}` };
    }
    if (!l.ok) return l;
    const kept = l.attempts === 0 || (anyRetried && l.attempts === 1);
    return kept ? { ...l, text: `${l.id}: kept (ok)` } : l;
  });
}

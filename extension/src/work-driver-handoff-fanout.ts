/**
 * work-driver-handoff-fanout — the second-failure view of a develop fan-out,
 * shared by both handoff renderers (#1016).
 *
 * When a develop fan-out is re-dispatched for its failed workstreams, the
 * handoff must say which work was preserved and which failed after the retry.
 * The structured verdict (id, ok, reason, attempts) comes from
 * developVerdictLines; attempts counts branch-completed events within the
 * current develop step only. With no retried workstream the lines are returned
 * unchanged. Once one workstream was retried, a green workstream that was not
 * itself retried reads "kept (ok)" (it was preserved while another re-ran), a
 * retried green reads "ok after retry", and a retried failure "FAIL after retry".
 */
import { type VerdictLine, developVerdictLines } from "./work-develop-verdict-source.ts";
import type { WorkState } from "./workflow-state.ts";

/** Verdict lines for the handoff, annotated with the retry wording. */
export function fanoutVerdictLines(state: WorkState): VerdictLine[] {
  const lines = developVerdictLines(state);
  if (!lines.some((l) => l.attempts >= 2)) return lines;
  return lines.map((l) => {
    if (l.attempts >= 2) {
      if (l.ok) return { ...l, text: `${l.id}: ok after retry` };
      const why = l.reason ? ` \u2014 ${l.reason}` : "";
      return { ...l, text: `${l.id}: FAIL after retry${why}` };
    }
    return l.ok ? { ...l, text: `${l.id}: kept (ok)` } : l;
  });
}

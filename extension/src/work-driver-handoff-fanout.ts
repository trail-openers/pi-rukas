/**
 * work-driver-handoff-fanout — the second-failure view of a develop fan-out,
 * shared by both handoff renderers (#1016).
 *
 * The label is derived per workstream from its own attempts in the current
 * develop step (branch-completed events since the last step-started):
 *   - two or more attempts → "ok after retry" / "FAIL after retry";
 *   - a green re-recorded with `resumed: true` → "kept (ok)": it was preserved
 *     from an interrupted attempt and never re-ran;
 *   - any other green → "ok" (it ran this step, first try).
 */
import { eventsSinceDevelopStart } from "./work-develop-greens.ts";
import { type VerdictLine, developVerdictLines } from "./work-develop-verdict-source.ts";
import type { WorkState } from "./workflow-state.ts";

/** Verdict lines for the handoff, annotated with the retry wording. */
export function fanoutVerdictLines(state: WorkState): VerdictLine[] {
  // #1016 — only a green re-recorded with `resumed: true` (crash-resume) was
  // kept from an earlier attempt. A fresh green with no completion event (N=1)
  // ran this step and is plain "ok".
  const kept = new Set(
    eventsSinceDevelopStart(state).flatMap((e) =>
      e.kind === "branch-completed" && e.resumed === true ? [e.workstreamId] : [],
    ),
  );
  return developVerdictLines(state).map((l) => {
    if (l.attempts >= 2) {
      if (l.ok) return { ...l, text: `${l.id}: ok after retry` };
      const why = l.reason ? ` \u2014 ${l.reason}` : "";
      return { ...l, text: `${l.id}: FAIL after retry${why}` };
    }
    if (!l.ok) return l;
    return kept.has(l.id) ? { ...l, text: `${l.id}: kept (ok)` } : l;
  });
}

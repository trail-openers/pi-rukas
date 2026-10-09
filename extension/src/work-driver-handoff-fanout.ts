/**
 * work-driver-handoff-fanout — the second-failure view of a develop fan-out,
 * shared by both handoff renderers (#1016).
 *
 * When a develop fan-out is re-dispatched for its failed workstreams and a
 * workstream fails AGAIN, the handoff must say which work was preserved and
 * which failed after the retry. The signal is the event log itself: a
 * workstream with two or more branch-completed events was retried. A green
 * workstream renders as "kept (ok)"; a failed retried one as "FAIL after
 * retry". With no retried-and-failed workstream the verdict lines are returned
 * unchanged, so the first-failure rendering is untouched.
 *
 * Built on developVerdictLines so the presence rule and the verdict source
 * stay the single #848 source; this module only annotates its lines.
 */
import { type VerdictLine, developVerdictLines } from "./work-develop-verdict-source.ts";
import type { WorkState } from "./workflow-state.ts";

/** Verdict lines for the handoff, annotated with the second-failure wording. */
export function fanoutVerdictLines(state: WorkState): VerdictLine[] {
  const lines = developVerdictLines(state);
  const attempts = new Map<string, number>();
  for (const e of state.eventLog) {
    if (e.kind === "branch-completed") {
      attempts.set(e.workstreamId, (attempts.get(e.workstreamId) ?? 0) + 1);
    }
  }
  const idOf = (line: VerdictLine): string => line.text.slice(0, line.text.indexOf(": "));
  const retriedAndFailed = lines.some((l) => !l.ok && (attempts.get(idOf(l)) ?? 0) >= 2);
  if (!retriedAndFailed) return lines;
  return lines.map((l) => {
    const id = idOf(l);
    if (l.ok) return { ok: true, text: `${id}: kept (ok)` };
    if ((attempts.get(id) ?? 0) < 2) return l;
    // The "FAIL…" tail after `id: ` keeps its reason verbatim.
    const rest = l.text.slice(id.length + 2);
    return { ok: false, text: `${id}: FAIL after retry${rest.slice("FAIL".length)}` };
  });
}

/**
 * work-develop-verdict-source — #848: the ONE place the two handoff
 * renderers read their per-workstream verdicts from.
 *
 * Before this module the surfaces disagreed on BOTH the source and the
 * presence rule: renderHandoffMarkdown read the raw branch-completed
 * events (`e.ok ? "ok" : "FAIL"`, the developer's own verdict — blind to
 * the #814 fence flips) while renderHandoffUserMessage read the last
 * branches-converged of ANY step and dropped the `reason` field.
 *
 * The rule: the handoff verdict section is about the DEVELOP fanout, so
 * the source is the last `branches-converged` with step "develop" — the
 * same event replaceDevelopConvergedVerdicts (work-develop-fence-verdicts.ts)
 * replaces with the fence-flipped verdicts. When no such event exists
 * (a fan-out that died before convergence — the branches-fanned-out
 * without branches-converged shape), fall back to the branch-completed
 * events, preserving today's behaviour for that shape. Both renderers
 * share the result, so the section renders or omits identically.
 *
 * The flipped `reason` wording stays in work-develop-fence-verdicts.ts
 * (applyFenceVerdicts) — this module only renders it, never builds it.
 */
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** One line of the handoff's "Workstream verdicts" section. */
export interface VerdictLine {
  /** The workstream id (converged `verdicts[].id` or branch-completed `workstreamId`). */
  id: string;
  /** True when the verdict is "ok"; false when it is a "FAIL …" line. */
  ok: boolean;
  /** The failure attribution (e.g. the #814 fence reason) for a FAIL line; undefined for ok. */
  reason?: string;
  /**
   * The verdict text shared by both handoff surfaces, without any list
   * prefix or indentation — the markdown renderer renders it as a list
   * item (`- ${text}`), the chat renderer as an indented section line
   * (`  ${text}`): `task-a: ok` or `task-a: FAIL — fence violation: src/main.rs (declared by task-d)`.
   */
  text: string;
}

function renderVerdictLine(id: string, ok: boolean, reason?: string): string {
  if (ok) return `${id}: ok`;
  return reason ? `${id}: FAIL — ${reason}` : `${id}: FAIL`;
}

/**
 * The handoff renderers' shared verdict source. Returns the verdict lines
 * (possibly empty — both renderers must render/omit the section off this
 * single array, so the presence rule lives here and cannot diverge).
 *
 * Order: the last `branches-converged` with step "develop", else the
 * `branch-completed` events (chronological log order).
 */
export function developVerdictLines(state: WorkState): VerdictLine[] {
  const lastConverged = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged" && e.step === "develop",
    ) as Extract<WorkEvent, { kind: "branches-converged" }> | undefined;
  if (lastConverged && lastConverged.verdicts.length > 0) {
    return lastConverged.verdicts.map((v) => ({
      id: v.id,
      ok: v.ok,
      reason: v.reason,
      text: renderVerdictLine(v.id, v.ok, v.reason),
    }));
  }
  return state.eventLog
    .filter(
      (e): e is Extract<WorkEvent, { kind: "branch-completed" }> => e.kind === "branch-completed",
    )
    .map((e) => {
      // branch-completed carries no structured `reason` field — its `error`
      // tail (truncated at the event) is the fallback attribution.
      const reason = e.ok ? undefined : e.error;
      return {
        id: e.workstreamId,
        ok: e.ok,
        reason,
        text: renderVerdictLine(e.workstreamId, e.ok, reason),
      };
    });
}

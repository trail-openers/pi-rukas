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
  /** True when the verdict is "ok"; false when it is a "FAIL …" line. */
  ok: boolean;
  /**
   * The verdict text shared by both handoff surfaces, without any list
   * prefix or indentation — the markdown renderer renders it as a list
   * item (`- ${text}`), the chat renderer as an indented section line
   * (`  ${text}`): `task-a: ok` or `task-a: FAIL — fence violation: src/main.rs (declared by task-d)`.
   */
  text: string;
  /** The workstream id (structured — renderers must not parse `text`). */
  id: string;
  /** The failure reason, when the verdict carries one. */
  reason?: string;
  /** branch-completed events for this workstream in the current develop step (#1016). */
  attempts: number;
}

/** One raw verdict before the id/ok/reason → line-text mapping. */
interface RawVerdict {
  id: string;
  ok: boolean;
  reason?: string;
}

/** Plain rendering of one verdict (no retry annotation). */
export function verdictLine(v: RawVerdict, attempts = 0): VerdictLine {
  const { id, ok, reason } = v;
  return {
    ok,
    id,
    reason,
    attempts,
    text: ok ? `${id}: ok` : reason ? `${id}: FAIL — ${reason}` : `${id}: FAIL`,
  };
}

/** #1016 — branch-completed count per workstream since the last develop step-started. */
function developAttemptCounts(state: WorkState): Map<string, number> {
  let start = 0;
  state.eventLog.forEach((e, i) => {
    if (e.kind === "step-started" && e.step === "develop") start = i + 1;
  });
  const counts = new Map<string, number>();
  for (const e of state.eventLog.slice(start)) {
    if (e.kind === "branch-completed") {
      counts.set(e.workstreamId, (counts.get(e.workstreamId) ?? 0) + 1);
    }
  }
  return counts;
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
  // One `{id, ok, reason}[]` source for both shapes, one mapping — the
  // branches-converged source wins only when it is non-empty.
  const lastConverged = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged" && e.step === "develop",
    );
  const raw: RawVerdict[] =
    lastConverged && lastConverged.verdicts.length > 0
      ? lastConverged.verdicts
      : state.eventLog
          .filter(
            (e): e is Extract<WorkEvent, { kind: "branch-completed" }> =>
              e.kind === "branch-completed",
          )
          // branch-completed carries no structured `reason` field — its `error`
          // tail (truncated at the event) is the fallback attribution.
          .map((e) => ({ id: e.workstreamId, ok: e.ok, reason: e.ok ? undefined : e.error }));
  const attempts = developAttemptCounts(state);
  return raw.map((v) => verdictLine(v, attempts.get(v.id) ?? 0));
}

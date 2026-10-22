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
import { eventsSinceDevelopStart } from "./work-develop-greens.ts";
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

/** #1774 — one workstream's IN-FLIGHT verdict: the shape both develop
 *  phases settle on, before the attempts/text mapping. The #1644 budget
 *  refusal carries `noRetry` so the fan-out settles it like a refused reset. */
export type WorkstreamVerdict = {
  id: string;
  ok: boolean;
  reason?: string;
  noRetry?: true;
  /** #1768 — the pass's OWN commits ahead of base, read by the classify seam
   *  with the driver's safety-net recovery commits discounted. The green rule
   *  reads this instead of asking git after the net has already committed the
   *  pass's leftovers. */
  ownCommits?: import("./work-develop-unfinished-facts.ts").OwnCommitCheck;
};

/** #753 — the optional fields a `branch-completed` record may carry beyond the
 *  required ones, so a caller can build one without naming the required fields.
 *  Lives with the other verdict-record shapes rather than with the dispatch
 *  closure that once owned it. */
export type BranchCompletedExtra = Partial<Extract<WorkEvent, { kind: "branch-completed" }>>;

/** One raw verdict before the id/ok/reason → line-text mapping. */
export interface RawVerdict {
  id: string;
  ok: boolean;
  reason?: string;
  /** #1016 — the developer CLAIMED green, even when no commit backed it: the
   *  develop gate must run to say so. Set only by the fan-out's green check. */
  claimed?: true;
  /** #1774 — the failure is DETERMINISTIC: re-running it produces the same
   *  refusal (the #1644 budget check is the carrier today). The fan-out
   *  settles it where it stands — like a refused reset, never into the retry
   *  set — because a reset would first destroy work the pass never made.
   *  #1768 — an unfinished pass carries it for the same reason: the corrective
   *  round must resume from the child's uncommitted work, which the fan-out's
   *  retry reset would discard. */
  noRetry?: true;
  /** #1768 — carried through from the in-flight verdict (see
   *  `WorkstreamVerdict.ownCommits`); the green rule reads it. */
  ownCommits?: import("./work-develop-unfinished-facts.ts").OwnCommitCheck;
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
  const counts = new Map<string, number>();
  for (const e of eventsSinceDevelopStart(state)) {
    // A downgrade rewrites its attempt's verdict, and a resumed green re-records
    // an earlier attempt: neither is a new attempt.
    if (e.kind !== "branch-completed" || e.resumed === true) continue;
    const rewrite = !e.ok && e.downgrade === true;
    if (!rewrite) {
      counts.set(e.workstreamId, (counts.get(e.workstreamId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * #1016 — one verdict per workstream: its LATEST branch-completed. The log is
 * append-only, so a retry or a downgrade adds an event that supersedes the
 * earlier one; the first-seen order is kept.
 */
function latestCompletionPerWorkstream(state: WorkState): RawVerdict[] {
  const latest = new Map<string, RawVerdict>();
  for (const e of state.eventLog) {
    if (e.kind !== "branch-completed") continue;
    // branch-completed carries no structured `reason` field — its `error`
    // tail (truncated at the event) is the fallback attribution.
    latest.set(e.workstreamId, {
      id: e.workstreamId,
      ok: e.ok,
      reason: e.ok ? undefined : e.error,
    });
  }
  return [...latest.values()];
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
      : latestCompletionPerWorkstream(state);
  const attempts = developAttemptCounts(state);
  return raw.map((v) => verdictLine(v, attempts.get(v.id) ?? 0));
}

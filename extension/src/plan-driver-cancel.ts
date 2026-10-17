/**
 * plan-driver-cancel — the cancellation halt for a killed /plan run (#1541).
 *
 * Since #1044 the plan pipeline runs in a background job, and since #1541 the
 * job's AbortSignal reaches the pipeline, so `dispatch_kill` and session
 * shutdown stop it between phases. This module owns what such a run *returns*:
 * a `PlanResult` carrying `cancelled`, which plan-tool.ts's renderer turns into
 * a `PLAN CANCELLED` headline instead of letting a half-built draft reach the
 * operator under a "PLAN FILED" / "PLAN DRY-RUN" head the run never earned.
 *
 * Split out of plan-driver.ts at the AGENTS.md §12 size cap.
 */
import { haltResult } from "./plan-driver-halt.ts";
import {
  type PlanDriverInput,
  type PlanPhaseTiming,
  type PlanResult,
  classifyPlanType,
  planTitle,
} from "./plan-types.ts";
import { sessionShutdownReason } from "./session-shutdown.ts";

/** Who asked for the kill. Session teardown aborts every job at once, so an
 *  aborted session is the far likelier cause than an operator's dispatch_kill —
 *  and the two want different follow-ups (nothing to re-do vs re-run the plan). */
export function killedBy(signal: AbortSignal | undefined): string {
  if (sessionShutdownReason() !== undefined) return "session shutdown";
  return signal?.aborted ? "dispatch_kill (or session shutdown)" : "the harness";
}

/**
 * The early-return halt for a kill observed at a phase boundary. `phase` is
 * the phase that had just completed — the report names it so the operator
 * knows how far the run got and what it paid for before the kill landed.
 */
export function cancelledResult(
  signal: AbortSignal | undefined,
  input: PlanDriverInput,
  phase: string,
  priorContext: { source: string; fact: string }[],
  timings: PlanPhaseTiming[],
): PlanResult {
  const type = classifyPlanType(input.descriptor, input.type);
  return {
    ...haltResult({
      type,
      title: planTitle(input.descriptor, type),
      spec: "(spec not drafted — the run was killed before it completed)",
      priorContext,
      failure: { reason: "cancelled", detail: `killed during the ${phase} phase` },
      timings,
    }),
    cancelled: { by: killedBy(signal), phase },
  };
}

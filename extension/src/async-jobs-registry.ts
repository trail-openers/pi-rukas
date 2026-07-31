/**
 * Job-state registry for async dispatch jobs — the module-level `jobs` and
 * `childHandles` maps plus the orchestrator active-child helpers that
 * dispatch_peek / dispatch_steer use to resolve a jobId to live state.
 */
import type { Writable } from "node:stream";

export type JobKind = "single" | "batch-member" | "batch-orchestrator";

export interface SingleJobState {
  kind: "single";
  jobId: string;
  role: string;
  label: string;
  startedAt: number;
  abort: AbortController;
  /**
   * Who consumes the eventual result.
   *
   *   "pm" (default) — the parent PM session. On completion we push a
   *   formatted report to PM via `pi.sendUserMessage(report, { deliverAs:
   *   "steer" })` so the next PM turn picks it up as `[ensemble:async] …`.
   *   This is the contract every dispatch tool (dispatch_specialist,
   *   dispatch_parallel, adversarial_loop, dispatch_lens_review) relies on.
   *
   *   "driver" — the in-process work-driver (PR1 of the workflow-graph
   *   compilation). The driver awaits the `completion` promise returned by
   *   `startJob` directly. We MUST NOT also send the steer report — that
   *   would inject an `[ensemble:async]` user message PM didn't ask for and
   *   confuse the next turn. Driver-owned jobs are 100% in-process; the
   *   completion promise IS the contract.
   *
   * This single field is the integration seam that lets PM-tool dispatch
   * and driver dispatch coexist on the same async-jobs primitive without a
   * second consumer racing for the result.
   */
  ownerKind: "pm" | "driver";
  /**
   * True when this job is an orchestrator that spawns its OWN inner children
   * sequentially (adversarial_loop + future orchestrators). Set at
   * work-function entry via `markOrchestrator`. Independent of whether a
   * child is active right now — so `dispatch_peek` / `dispatch_steer` can
   * still recognise the job as orchestrator-shape and return the
   * "between rounds" status when activeChild is undefined.
   */
  isOrchestrator?: boolean;
  /**
   * For orchestrator-shaped jobs — pointer to whichever inner child is
   * running right now. Updated by the orchestrator's work function via
   * `setOrchestratorActiveChild`. Read by `dispatch_peek` (to surface the
   * active child's last text) and `dispatch_steer` (to route stdin writes
   * to the currently-running inner child). Cleared between rounds →
   * undefined when the orchestrator is idle between phases.
   */
  activeChild?: {
    role: string;
    label: string;
    /** Dispatch-deck key for the active inner spawn (`${runId}/${tag}`). */
    deckKey: string;
    /** Stdin handle for the active inner Pi --mode rpc child. */
    stdin: Writable;
    startedAt: number;
  };
}

export interface BatchMemberJobState {
  kind: "batch-member";
  jobId: string;
  role: string;
  label: string;
  startedAt: number;
  abort: AbortController;
  batchId: string;
}

export interface BatchOrchestratorJobState {
  kind: "batch-orchestrator";
  jobId: string;
  role: string; // synthetic, describes the batch ("dispatch_parallel", "lens_review")
  label: string;
  startedAt: number;
  abort: AbortController;
  size: number;
  completed: number;
}

export type JobState = SingleJobState | BatchMemberJobState | BatchOrchestratorJobState;

// Hard cap on concurrent jobs. Realistic upper bound: a six-pass lens review
// (1 orchestrator + 6 members) plus a parallel batch (1 + ≤8 members) plus a
// few outstanding singles ≈ 25. 50 leaves comfortable headroom; pathological
// dispatch-without-settle scenarios (e.g., a bug in a settle path) are caught
// before the map grows unbounded. Members count against the same cap as
// orchestrators because they share the same memory profile and abort tree.
export const MAX_JOBS = 50;
export const jobs = new Map<string, JobState>();

export function newJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Per-job child handle — exposes the child's stdin so dispatch_steer (#153)
 * can write `{ type: "steer", message }` RPC commands to a running child.
 * Lives in `childHandles` for the duration of the job; cleared on settle.
 */
export interface ChildHandle {
  stdin: Writable;
  label: string;
  role: string;
}

export const childHandles = new Map<string, ChildHandle>();

/** Look up a running child's stdin + label by jobId. Used by dispatch_steer.
 *  Returns undefined when the job has already settled (stdin handle cleaned up). */
export function getChildHandle(jobId: string): ChildHandle | undefined {
  return childHandles.get(jobId);
}

/**
 * Orchestrator active-child registry — used by adversarial_loop (and any
 * future orchestrator that fans out internally) to publish "which inner
 * child is running right now" so `dispatch_peek` and `dispatch_steer` can
 * resolve an orchestrator jobId to the active inner child transparently.
 *
 * Pass `null` to clear (between rounds, or after the orchestrator settles).
 * Pass a child descriptor when starting a new inner phase. The descriptor
 * carries the inner spawn's deck key (for peek to look up live state) and
 * stdin handle (for steer to write into).
 */
export function setOrchestratorActiveChild(
  jobId: string,
  child: { role: string; label: string; deckKey: string; stdin: Writable } | null,
): void {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return;
  if (child === null) {
    state.activeChild = undefined;
  } else {
    state.activeChild = { ...child, startedAt: Date.now() };
  }
}

/**
 * Look up the orchestrator's active inner child. Returns undefined when the
 * jobId isn't an orchestrator, or when the orchestrator is between rounds
 * (no active inner child right now). Used by `dispatch_peek` to surface the
 * active child's live state, and by `dispatch_steer` to route the steer.
 */
export function getOrchestratorActiveChild(
  jobId: string,
):
  | { role: string; label: string; deckKey: string; stdin: Writable; startedAt: number }
  | undefined {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return undefined;
  return state.activeChild;
}

/**
 * Mark a job as orchestrator-shaped — called by the orchestrator's work
 * function at entry, BEFORE the first inner round. Tells `dispatch_peek`
 * and `dispatch_steer` to use the active-child resolution path instead of
 * the regular deck snapshot lookup. Idempotent.
 */
export function markOrchestrator(jobId: string): void {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return;
  state.isOrchestrator = true;
}

/**
 * Probe: is this jobId orchestrator-shaped? True if its work function
 * called `markOrchestrator`. Independent of whether an inner child is
 * currently active — so peek/steer can recognise the job between rounds
 * and return the explicit "between rounds" status.
 */
export function isOrchestratorJob(jobId: string): boolean {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return false;
  return state.isOrchestrator === true;
}

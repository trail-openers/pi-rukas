/**
 * Top-level /work state-file shape (`WorkState`). Split out of
 * `workflow-state-schema.ts` for the 500-line gate (AGENTS.md §12); the
 * schema module re-exports it so existing importers keep their path.
 */

import type { WorkEvent } from "./workflow-state-events.ts";
import type { PipelineState, WORK_STATE_SCHEMA_VERSION } from "./workflow-state-schema.ts";

/**
 * Top-level state-file shape. The schemaVersion field is at the top so
 * future readers can sanity-check before parsing the rest.
 */
export interface WorkState {
  /** Schema version; MANDATORY. Mismatched versions are rejected loudly. */
  schemaVersion: typeof WORK_STATE_SCHEMA_VERSION;
  /**
   * Whether this state file carries enough information to resume from.
   *
   * #382 — this was `false` as a LITERAL TYPE, so it could never be anything
   * else, and no code wrote it. It is now a real boolean: `true` once a
   * dispatch write-ahead has happened, meaning `inFlightJobIds` and `owner`
   * can be trusted. State files written by older versions read `false` and
   * are treated as pre-resume, which is the honest answer for them.
   */
  resumable: boolean;
  /**
   * #382 — which process owns this cycle, and since when.
   *
   * A file that says `status: "running"` is either a live driver's or a
   * corpse's, and those need opposite responses: resume the corpse, refuse
   * the live one. Without this the driver could not tell them apart, so it
   * did neither.
   */
  owner?: { pid: number; at: number };
  /**
   * Primary issue number — anchors the state-file path (`.pi/work-state/
   * <issue>.json`) + branch name. PR10: first of `issues` (the full list
   * passed to `/work N M P`); readers fall back to `[issue]` (pre-PR10).
   */
  issue: number;
  issues?: number[];
  /**
   * #1090 — the protected paths the operator granted the current invocation
   * (`--allow-protected`). A record for the handoff and PR body, rewritten on
   * every entry; the gate never reads it (see work-driver-protected-grant.ts).
   */
  protectedGrant?: string[];
  /** Epoch ms when the cycle started. */
  startedAt: number;
  /** Latest write; for "did the user just nudge this?" UX heuristics. */
  updatedAt: number;
  /**
   * Pointers to other GitHub artefacts (plan issue, parent PR). Reserved for
   * inter-command composition; the v1 driver does not read these.
   */
  upstreamRefs?: Array<{ kind: "plan-issue" | "parent-pr" | "other"; ref: string }>;
  pipelineState: PipelineState;
  eventLog: WorkEvent[];
}

/**
 * #1454 — the ONE terminal-status notion. A cycle that reached one of these
 * is finished: it will not write again, so nothing it holds (a path claim, a
 * worktree) may still be treated as a live reservation.
 *
 * `interrupted` is deliberately NOT here — it is a SIGTERM/SIGINT snapshot of
 * a cycle that is resumable (`reenterInterrupted`), so an interrupted owner
 * still owns its claim until its pid is gone.
 *
 * This predicate, not a re-derived status string per call site, is what
 * `isClaimStale` reads. Keeping the list in exactly one place is the point:
 * the claims gate and the worktree sweep must not disagree about what
 * "finished" means.
 */
export const TERMINAL_STATUSES: readonly string[] = ["merged", "handoff", "aborted"];

/** Whether this state file describes a cycle that has finished. */
export function isTerminalState(state: WorkState | undefined): boolean {
  return state !== undefined && TERMINAL_STATUSES.includes(state.pipelineState.status);
}

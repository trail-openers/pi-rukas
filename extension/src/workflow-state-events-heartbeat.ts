/**
 * /work workflow state — dispatch-heartbeat event fragment.
 *
 * Issue #799 (task-a) — the per-dispatch heartbeat. The 2026-09-21 cycle on
 * #782 ran a lens-fix dispatch whose completion landed 17.6 minutes after
 * `dispatch-started` with zero events in between, and the cycle's 137-minute
 * adversarial fan-out span was silent for the same reason: nothing wrote
 * between `dispatch-started` and `dispatch-completed`, so "working" was
 * indistinguishable from "wedged" — in the moment and in post-mortem.
 *
 * The heartbeat is the observability half of that fix (the per-step notice
 * is task-b). It rides the single-dispatch seam (`runSingleDispatch`,
 * work-driver-merged.ts), which covers branch / commit-pr / lens-fix /
 * step-back / ci / merged fallback. Fan-out children (develop / adversarial)
 * do NOT go through that seam; they get their bounded end-of-branch record
 * from `branch-completed` and their in-flight visibility from the dispatch
 * deck (dispatch_peek), which already surfaces turns / last tool / elapsed /
 * tokens. This member is the durable, post-hoc counterpart for the
 * single-dispatch path.
 *
 * The payload mirrors `dispatch_peek`'s bounded-by-design contract
 * (#299/#21) exactly: elapsed, turn count, last tool name, cumulative token
 * count. NO transcript content, NO lastText, NO tool arguments. The deck's
 * `lastText` (truncated child output) and `lastToolHint` (truncated tool
 * arguments) stay in the in-memory deck only — they are the two fields the
 * ticket names as "never the child's output". Bounding the payload to four
 * small scalar/string fields is what keeps an append-only, re-read state
 * file proportionate: a 15-minute interval on a 3-hour dispatch is 12
 * events, each ~120 bytes.
 *
 * Interval rationale (15 minutes): the ticket fixes "15–30 minutes is
 * proportionate to a 36-minute median cycle"; 15 is the lower bound because
 * the incident's shape — a single dispatch with no signal — is the case the
 * operator most wants to be able to answer "is it alive?" about, and 15
 * keeps that answer at most 15 minutes stale while costing nothing for the
 * common case (a dispatch that finishes in under 15 minutes emits zero
 * heartbeat events — see `shouldEmitHeartbeat`).
 *
 * Same fragment pattern as the sibling workflow-state-events-*.ts modules:
 * a pure event type composed into the closed `WorkEvent` union in
 * workflow-state-events.ts by name, so the union stays exhaustive and
 * additive (older readers ignore the kind; the schema validator knows it).
 */

import type { WorkStep } from "./workflow-state-events.ts";

/**
 * One bounded snapshot of an in-flight single dispatch, taken by the
 * driver (not by the child) at the heartbeat interval.
 *
 * Deliberately the same field set as the `dispatch_peek` row minus
 * `lastText` / `lastToolHint` / `model`: the peek is an in-memory,
 * in-session rendering aid and can carry a 200-char text hint; the
 * heartbeat is persisted to the state file and re-read on every
 * `/work-status`, so it stays to the scalars.
 */
export type DispatchHeartbeatEvent = {
  kind: "dispatch-heartbeat";
  at: number;
  step: WorkStep;
  role: string;
  jobId: string;
  label: string;
  /** Elapsed ms since this dispatch's `dispatch-started` (not the cycle). */
  elapsedMs: number;
  /** Assistant turns the child has completed so far (deck RunningState). */
  turns: number;
  /** The child's most recent tool call's name — or absent when the child
   * has not called a tool yet. */
  /**
   * The child's most recent tool call's name (deck RunningState), or absent
   * when the deck entry had no snapshot to draw from — including the not-yet-
   * populated case the `zeroState` flag names. "No tool yet" and "we could
   * not tell" are two different states; absence is the second. (The
   * `zeroState` flag distinguishes them for readers; the field itself stays
   * simple.)
   */
  lastToolName?: string;
  /**
   * The child's cumulative tokens (input+output+cacheRead+cacheWrite),
   * the same sum the token-budget cap (#543 F6) measures — so the
   * heartbeat row and the budget kill row are comparable numbers.
   */
  totalTokens: number;
  /**
   * True when the driver took the snapshot but the child's deck entry had
   * no `RunningState` to draw from (no spawn reported a turn yet, or the
   * child was skipped from the deck): the numeric fields are zero by
   * definition, and the flag is what stops a reader — the operator reading
   * the state file raw — from reading "0 turns, 0 tokens" as "the child did
   * nothing". Absent when the deck had a real snapshot.
   */
  zeroState?: boolean;
};

/**
 * #799 — the heartbeat interval. 15 minutes: the low end of the ticket's
 * "15–30 minutes" band, chosen because the incident's defect was a long
 * single dispatch with no signal, and 15 is the coarsest interval that
 * still answers "is it alive?" within a time the operator can actually
 * wait. Overridden by PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS for tests and for
 * operators who want a coarser log.
 *
 * `<= 0` disables heartbeats entirely (the escape hatch — same shape as
 * PI_ENSEMBLE_* zero-disables elsewhere in the driver).
 */
export function heartbeatIntervalMs(): number {
  const v = process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS;
  if (!v) return 15 * 60_000; // unset (or empty) → the 15-minute default
  const raw = Number(v);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 15 * 60_000;
}

/**
 * work-driver-heartbeat — the dispatch-side seam for the #799 task-a
 * heartbeat: the pure predicate + the pure payload builder + the one
 * in-memory deck-read that `runSingleDispatch` calls between the two
 * awaits of a long single dispatch.
 *
 * Why a dedicated module (not inline in work-driver-merged.ts): the seam
 * needs three things — (1) a decision that stays honest under an
 * injectable clock, (2) a payload builder that stays bounded (no
 * transcript, ever), and (3) the single place that reaches into the
 * dispatch deck's in-memory entries. Keeping all three here means
 * `runSingleDispatch`'s diff is one wrapped await (see the seam comment
 * in work-driver-merged.ts) and the test file exercises each of the
 * three independently, without a driver run.
 *
 * Scope note (task-a vs task-b): this module is PER-DISPATCH. The
 * per-STEP notice (a step whose children are each healthy but which
 * collectively runs two hours — the incident's actual shape) is task-b's
 * `work-driver-step-notice.ts`; the two deliberately share nothing,
 * because their trigger conditions and their delivery mechanisms
 * (event log vs PI_ENSEMBLE_NOTIFY_CMD) are different.
 *
 * No wall-clock kill anywhere in this path. The heartbeat writes an
 * event and, at most, a trace line; it never touches the child process
 * (no signal, no timeout, no killCause — the #799 out-of-scope clause).
 */

import { snapshot } from "./dispatch-deck.ts";
import type { RunningState } from "./progress.ts";
import { trace } from "./trace.ts";
import type { DispatchHeartbeatEvent } from "./workflow-state-events-heartbeat.ts";
import { heartbeatIntervalMs } from "./workflow-state-events-heartbeat.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The bounded, driver-side view of the in-flight snapshot. Exactly the
 * four fields the `dispatch-heartbeat` event carries — never `lastText`,
 * never `lastToolHint` (the deck's two fields that hold child output),
 * never `model`. Mirrors `dispatch_peek`'s bounded contract by
 * construction: a field that is not on this type cannot ride in the
 * event, which is what "preserves dispatch_peek's bounded contract"
 * means mechanically (as opposed to a comment promising it).
 */
export type BoundedInflight =
  | { zero: true; turns: 0; lastToolName: undefined; totalTokens: 0 }
  | { zero: false; turns: number; lastToolName?: string; totalTokens: number };

/**
 * Decision. `shouldEmit` is true when the dispatch has been in flight
 * for at least one full heartbeat interval; `dueAt` is the epoch-ms at
 * which the NEXT heartbeat is due (interval + a whole number of
 * intervals after `startedAt`), so the caller can `sleep(dueAt - now)`
 * without recomputing the arithmetic (and without the drift that
 * `while (now - startedAt >= interval) sleep` would accumulate).
 *
 * `now` / `startedAt` are injectable epoch-ms, not `Date.now()` reads —
 * the offline test crosses the interval by feeding a larger `now`,
 * exactly as `capKillGraceMs`'s injectable time lets
 * `test-spawn-bounds.ts` assert kill behaviour without wall-clock
 * (AGENTS.md §1: the offline suite carries no wall-clock hazard).
 *
 * `intervalMs <= 0` (PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS=0) → `enabled`
 * false: no sleep, no event. Zero-disables, the shape every
 * PI_ENSEMBLE_* escape hatch in this codebase uses.
 */
export function shouldEmitHeartbeat(
  startedAt: number,
  now: number,
  intervalMs: number = heartbeatIntervalMs(),
): { enabled: boolean; due: boolean; dueAt: number } {
  if (intervalMs <= 0) return { enabled: false, due: false, dueAt: 0 };
  const elapsed = now - startedAt;
  if (elapsed < intervalMs) return { enabled: true, due: false, dueAt: startedAt + intervalMs };
  const periods = Math.floor(elapsed / intervalMs);
  return { enabled: true, due: true, dueAt: startedAt + (periods + 1) * intervalMs };
}

/**
 * One wait + one emission, expressed as a pure step the caller runs in a
 * loop: the caller sleeps until `dueAt` and then calls
 * `heartbeatEventFor` if the dispatch is still in flight (it may have
 * completed during the sleep — the caller's `inflightRef` closes that
 * case; see the seam in work-driver-merged.ts).
 */
/**
 * The event payload for one heartbeat tick.
 *
 * `state` is read ONLY for its `eventLog` tail (see `stateIsStale`): the
 * caller passes the in-memory state it holds at the seam, and the check
 * guards the crash-resume shape in which the on-disk file was written by
 * the PREVIOUS driver's final `writeState` (with the dispatch already
 * cleared) before this driver's write-ahead landed. Appending a heartbeat
 * in that window would put an in-flight marker in the log that no
 * dispatch-started is followed by — which the #382 resume logic would
 * read as a crash mid-dispatch and "resume" a dispatch that, from this
 * driver's view, was the one it was just about to await. One
 * `dispatch-completed`/`dispatch-failed` with a matching `jobId` after
 * the latest `dispatch-started` (or no `dispatch-started` at all) is
 * the condition that makes the tick stale.
 */
export function heartbeatEventFor(opts: {
  step: WorkState["pipelineState"]["currentStep"];
  role: string;
  label: string;
  jobId: string;
  startedAt: number;
  now: number;
  state: WorkState;
}): DispatchHeartbeatEvent | null {
  if (stateIsStale(opts.state, opts.jobId)) return null;
  const deck = deckStateFor(opts.jobId);
  const inflight: BoundedInflight = deck
    ? {
        zero: false,
        turns: deck.turns,
        ...(deck.lastToolName ? { lastToolName: deck.lastToolName } : {}),
        totalTokens: deck.totalTokens,
      }
    : { zero: true, turns: 0, lastToolName: undefined, totalTokens: 0 };
  const ev: DispatchHeartbeatEvent = {
    kind: "dispatch-heartbeat",
    at: opts.now,
    step: opts.step,
    role: opts.role,
    jobId: opts.jobId,
    label: opts.label,
    elapsedMs: Math.max(0, opts.now - opts.startedAt),
    turns: inflight.turns,
    totalTokens: inflight.totalTokens,
    ...(inflight.lastToolName ? { lastToolName: inflight.lastToolName } : {}),
    ...(inflight.zero ? { zeroState: true } : {}),
  };
  trace(
    `work-driver: heartbeat ${opts.step}/${opts.label} ${Math.round(ev.elapsedMs / 1000)}s` +
      ` (turns=${ev.turns}${inflight.lastToolName ? `, last=${inflight.lastToolName}` : ""}, ` +
      `tok=${ev.totalTokens})`,
  );
  return ev;
}

/**
 * The single place in the driver tree that reads the dispatch deck's
 * in-memory entries. `snapshot()` is the module's one exported read and
 * returns full entry copies (the renderer's shape); for one key that is
 * the cost we accept — copying N small objects to read one is cheaper
 * than a new deck-module export (out of scope: dispatch-deck.ts belongs
 * to no workstream here), and the copy is safe (the deck may update its
 * entry between the read and the event write; we snapshot, we don't
 * alias).
 *
 * Returns undefined for: a key never registered, a key already cleared
 * (child finished before the tick fired — the caller still emits, with
 * the `zeroState` flag naming that shape), and a child spawned with
 * `skipDeck` (same shape — the deck is a rendering aid; the heartbeat
 * must not depend on it being present, which is exactly why the
 * `zeroState` field exists rather than a "deck missing" error).
 */
function deckStateFor(jobId: string): RunningState | undefined {
  const entry = snapshot().find((e) => e.key === jobId);
  return entry ? entry.state : undefined;
}

/**
 * `stateIsStale` — the resume-window guard described on
 * `heartbeatEventFor`. The scan is bounded the same way as
 * `failureEventOf` in work-driver-step-router.ts (bounded by the
 * relevant marker) so it cannot reach back into a previous step.
 */
function stateIsStale(state: WorkState, jobId: string): boolean {
  const log = state.eventLog;
  // Find THIS dispatch's own `dispatch-started` (the most recent one that
  // matches `jobId`). A reverse scan that stops at the FIRST
  // `dispatch-started` would anchor on a SIBLING's start (two concurrent
  // single-dispatch steps are not possible in the driver — a step is one
  // dispatch — but a fanned-out step emits multiple `dispatch-started`
  // events in sequence, and a heartbeat must not be suppressed by a
  // sibling's marker).
  let idx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "dispatch-started" && e.jobId === jobId) {
      idx = i;
      break;
    }
  }
  // No matching dispatch-started in the visible log: nothing in flight in
  // this state's view for THIS jobId → stale (the write-ahead's own event
  // will appear as a later append by the caller; the tick must not preempt
  // it). A sibling's `dispatch-started` does not count: it names a
  // different jobId, and this dispatch's own marker has not landed yet.
  if (idx === -1) return true;
  const started = log[idx];
  if (!started || started.kind !== "dispatch-started") return true;
  if (started.jobId !== jobId) return true;
  for (let i = log.length - 1; i > idx; i--) {
    const e = log[i];
    if (!e) continue;
    if (
      (e.kind === "dispatch-completed" ||
        e.kind === "dispatch-failed" ||
        e.kind === "dispatch-failed-provider") &&
      (e as Extract<WorkEvent, { jobId: string }>).jobId === jobId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * slow-notice — #799 (operator decision 2026-09-24): the slow-run watch that
 * prompts someone instead of killing.
 *
 * One slow-watch at the one layer that sees progress for EVERY dispatch —
 * `startJob` (PM jobs), `startBatch` members, and the driver's `dispatchCore`
 * children all feed their child's `RunningState` updates through
 * `watchSlowDispatch` below. Lens children and adversarial round children are
 * not startJob children (they manage their own deck entries via
 * `spawnSpecialist`), so they register a handle directly against their deck
 * key and are watched by the same mechanism.
 *
 * On a threshold crossing — ONE level per watch: `level` counts the levels
 * already fired (0 initially) and the NEXT fire happens when ANY dimension
 * meets `base·2^level` (level 0: 20 min / 150 turns / 20M tokens; level 1:
 * 40 min / 300 turns / 40M; and so on). After a fire, `level` jumps to the
 * highest level any dimension has now reached, and every dimension re-arms
 * together at `base·2^level`:
 *
 *   1. The PM is notified via `notifyAgent` (always `deliverAs: "steer"`)
 *      with the same fields `dispatch_peek` shows — role, label, turns,
 *      tokens, elapsed, last tool, a short snippet of the last assistant
 *      text, and the job id the PM can pass to `dispatch_peek` /
 *      `dispatch_steer`. Driver-owned children (ownerKind "driver") notify
 *      the PM too — the operator wants to be prompted for those.
 *   2. The child receives ONE automatic steer through `steerChild` (the
 *      lifecycle-logged core the driver's caps already use), demanding a
 *      ≤3-line status report. It never kills.
 *
 * Neither half exists as a kill or cap: `PI_ENSEMBLE_AUTO_STEER=0` keeps the
 * notice, `PI_ENSEMBLE_SLOW_NOTICE=0` disables both. The driver additionally
 * persists a `dispatch-slow` event through the `onSlow` callback it threads
 * into `dispatchCore` (see workflow-state-events-slow.ts for the event).
 *
 * Threshold state lives in a module-level Map keyed by the watch id — one
 * entry per live child, bounded by MAX_JOBS, deleted on settle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyAgent } from "./agent-message.ts";
import { getParentExtensionApi } from "./async-jobs-registry.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { steerChild } from "./dispatch-steer.ts";
import type { RunningState } from "./progress.ts";
import { formatElapsed, formatTokens } from "./progress.ts";
import { trace } from "./trace.ts";
import type { WorkEvent, WorkStep } from "./workflow-state.ts";

/** The one place the driver's dispatch-slow events get appended: threaded
 * through `dispatchCore`'s opts (work-driver-event seam). Absent for PM
 * jobs (their notice is PM-only). */
export type OnSlowCallback = (info: {
  step: string;
  role: string;
  jobId: string;
  label: string;
  elapsedMs: number;
  turns: number;
  tokens: number;
  at: number;
}) => void;

export interface SlowWatchInput {
  /** Deck key / job id the PM sees (what dispatch_peek shows). */
  id: string;
  role: string;
  label: string;
  /** Injectable pi — the notifyAgent target. Defaults to the parent
   * extension api (async-jobs-registry) so children spawned without a pi in
   * scope (lens, adversarial) still notify the PM. Undefined in the suite →
   * the notice is skipped, never thrown. */
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  /** Injectable steer core — tests record instead of writing to a real
   * stdin. Defaults to `steerChild`. */
  steerFn?: (jobId: string, text: string, source: SteerSource) => unknown;
  /** Injectable clock — the elapsed dimension is computed from it (tests
   * drive it deterministically). */
  now?: () => number;
  /** Injectable scheduler for the elapsed check — tests arm/tick without
   * waiting on a 20-minute wall. Returns the matching cancel. Defaults to an
   * unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  onSlow?: OnSlowCallback;
}

/** The thresholds at level n: `base·2^n` per dimension. Level 0 is the
 * first crossing (20 min / 150 turns / 20M tokens, whichever comes first);
 * level 1 is 40 / 300 / 40M, and so on. ONE level per watch: a feed or
 * timer tick fires when ANY dimension meets level n+1's threshold, and the
 * watch's level then jumps to the highest level any dimension has now
 * reached, so all dimensions re-arm together at the next level. #884
 * replaces the per-dimension re-arming that let one run crossing all three
 * dimensions minutes apart fire three notices. Env overrides:
 * PI_ENSEMBLE_SLOW_NOTICE_MS / _TURNS / _TOKENS set the BASE (level 0);
 * a disabled dimension (PI_ENSEMBLE_SLOW_NOTICE=0 or a 0 override) stays
 * Infinity at every level. `watchSlowDispatch` reads these overrides ONCE
 * and snapshots them onto the watch as `base`; per-level thresholds (feed,
 * tick, re-arm) are then pure arithmetic on `base·2^level` with no env
 * reads, so an env change after arming never moves that watch. The exported
 * helpers remain env-reading, used only at arm time (and by the tests). */
export function levelThresholds(level: number): { ms: number; turns: number; tokens: number } {
  const v = process.env.PI_ENSEMBLE_SLOW_NOTICE;
  const disabled = v === "0";
  return {
    ms: envDimension("PI_ENSEMBLE_SLOW_NOTICE_MS", 20 * 60_000, level, disabled),
    turns: envDimension("PI_ENSEMBLE_SLOW_NOTICE_TURNS", 150, level, disabled),
    tokens: envDimension("PI_ENSEMBLE_SLOW_NOTICE_TOKENS", 20_000_000, level, disabled),
  };
}

/** #799 — the doubling schedule, level 0 (the first crossing). */
export function slowThresholds(): { ms: number; turns: number; tokens: number } {
  return levelThresholds(0);
}

function envDimension(key: string, base: number, level: number, disabled: boolean): number {
  if (disabled) return Number.POSITIVE_INFINITY;
  const raw = process.env[key];
  const n = raw === undefined || raw === "" ? base : Number(raw.replace(/_/g, ""));
  if (!Number.isFinite(n) || n <= 0) return base;
  return n * 2 ** Math.max(0, level);
}

export function autoSteerEnabled(): boolean {
  return process.env.PI_ENSEMBLE_AUTO_STEER !== "0";
}

interface Watch {
  id: string;
  role: string;
  label: string;
  startedAt: number;
  /** The number of levels already fired (0 initially). The next fire
   * happens when ANY dimension meets `base·2^level`; on a fire the level
   * jumps to the highest level any dimension has NOW reached (so a
   * simultaneous or overshooting crossing fires once, with no catch-up
   * burst) and every dimension re-arms together at `base·2^level`. The
   * elapsed timer is absolute from the watch start.
   * #884 — replaces the per-dimension re-arming that fired three notices. */
  level: number;
  /** Injectable scheduler for the elapsed check (injectable in tests). */
  schedule: (fn: () => void, ms: number) => () => void;
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  steerFn?: SlowWatchInput["steerFn"];
  now: () => number;
  onSlow?: OnSlowCallback;
  /** Last delivered snapshot — the timer ticks with nothing new to say (the
   * child is silent), so a timer-driven evaluation replays the latest
   * snapshot rather than a stale one. */
  lastState: RunningState | undefined;
  /** Set once the first progress event has been fed; a timer tick with no
   * snapshot has nothing to notice about. */
  seenProgress: boolean;
  /** The pending elapsed-check timer (unref'd in production). */
  timer?: () => void;
  /** #884 — level-0 bases snapshotted ONCE at arm time. */
  base: { ms: number; turns: number; tokens: number };
}

const watches = new Map<string, Watch>();

function dimThreshold(base: number, level: number): number {
  return Number.isFinite(base) ? base * 2 ** Math.max(0, level) : Number.POSITIVE_INFINITY;
}

/** The highest level a dimension has reached: 0 below `base`, else the
 * largest k with value ≥ base·2^(k-1). Integer doubling, so exact powers
 * stay exact. */
export function levelReached(value: number, base: number): number {
  if (base <= 0 || !Number.isFinite(value)) return 0;
  let k = 1;
  let t = base;
  while (value >= t * 2) {
    t *= 2;
    k++;
  }
  return value >= base ? k : 0;
}

/** Format `150 turns` / `20.0M tokens` / `42.0m` for the notice + steer text. */
function fmtSlow(elapsedMs: number, turns: number, tokens: number): string {
  return `${formatElapsed(elapsedMs)} · ${turns} turns · ${formatTokens(tokens)} tokens`;
}

function noticeText(w: Watch, s: RunningState, triggered: string[]): string {
  const snippet = s.lastText
    ? ` Last said: "${s.lastText.replaceAll("\n", " ").slice(0, 200)}"`
    : "";
  const trigger = triggered.length > 0 ? ` triggered by: ${triggered.join(", ")}.` : "";
  return [
    `[ensemble:slow] ${w.label} (${w.id}) has been running past a slow-run threshold (level ${w.level})${trigger} ${fmtSlow(s.elapsedMs, s.turns, s.totalTokens)}.`,
    s.lastToolName ? `Last tool: ${s.lastToolName}` : "",
    snippet,
    `Use dispatch_peek ${w.id} to inspect it or dispatch_steer ${w.id} to course-correct it.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The exact operator-mandated steer text (#799 scope 2). */
export function slowSteerText(elapsedMs: number, turns: number): string {
  return `You have been running for ${formatElapsed(elapsedMs)} / ${turns} turns. Report status in ≤3 lines (done / remaining / blocked), then CONTINUE the task — this is not a stop signal. Only if you are re-running or re-scanning the same checks without progress: stop re-scanning, use the gate's exit code, commit, and finish.`;
}

function deliver(w: Watch, s: RunningState, triggered: string[]): void {
  const elapsed = s.elapsedMs > 0 ? s.elapsedMs : Math.max(0, w.now() - w.startedAt);
  // 1 — PM notice (notifyAgent, always deliverAs "steer"). A rejection of the
  // send must never be an unhandled rejection. `input.pi` is absent for
  // lens/adversarial children (they spawn without a pi in scope) — the parent
  // api registered at extension load stands in, so those children notify too.
  const pi = w.pi ?? getParentExtensionApi();
  if (pi) {
    try {
      notifyAgent(pi, noticeText(w, { ...s, elapsedMs: elapsed }, triggered));
    } catch (err) {
      trace(`slow-notice: PM notice for ${w.id} failed: ${(err as Error).message}`);
    }
  }
  // 2 — the one automatic steer, lifecycle-logged through the steer core.
  if (autoSteerEnabled()) {
    let r: unknown;
    try {
      r = (w.steerFn ?? ((id, t, src) => steerChild(id, t, src)))(
        w.id,
        slowSteerText(elapsed, s.turns),
        "driver-slow-notice",
      );
    } catch (err) {
      // A throwing steer core (or a rejected async one) must never abort the
      // notice — the PM notice above already went out, and the onSlow record
      // below must still land.
      trace(`slow-notice: auto-steer for ${w.id} threw: ${(err as Error).message}`);
    }
    if (r instanceof Promise) {
      // The steer seam is sync in production, but a rejected promise is still
      // an unhandled rejection if nobody attaches — the trace is enough.
      r.catch((err: unknown) =>
        trace(`slow-notice: auto-steer for ${w.id} rejected: ${(err as Error).message}`),
      );
    }
    if (r && typeof r === "object" && "delivered" in r && !r.delivered) {
      trace(
        `slow-notice: auto-steer for ${w.id} not delivered: ${(r as { reason?: string }).reason ?? "unknown"}`,
      );
    }
  }
  // 3 — the driver's persistent record.
  try {
    w.onSlow?.({
      step: w.label,
      role: w.role,
      jobId: w.id,
      label: w.label,
      elapsedMs: elapsed,
      turns: s.turns,
      tokens: s.totalTokens,
      at: w.now(),
    });
  } catch (err) {
    trace(`slow-notice: onSlow for ${w.id} failed: ${(err as Error).message}`);
  }
  trace(
    `slow-notice: ${w.label} (${w.id}) level ${w.level} crossed${triggered.length > 0 ? ` by ${triggered.join(", ")}` : ""} — ${fmtSlow(elapsed, s.turns, s.totalTokens)}`,
  );
}

function scheduleElapsedCheck(w: Watch, ms: number): void {
  // #799 — the cancel may be absent (a test scheduler that returns an
  // object): a null guard keeps the stop function from throwing mid-settle.
  w.timer =
    w.schedule(() => {
      const cur = watches.get(w.id);
      if (cur === w) tickElapsed(w);
    }, ms) ?? (() => {});
}

/**
 * The ONE level-jump rule, shared by `feedSlowProgress` and `tickElapsed`
 * (they must never diverge): the dimensions that now meet the NEXT level's
 * threshold (`base·2^level` from the snapshotted base — no env reads), and
 * the level each crossed dimension has REACHED within its own scale (0 for
 * an un-crossed one). The caller adds the highest reached to the current
 * level, so an overshoot jumps straight to its top level, no catch-up burst.
 */
function advanceLevel(
  w: Watch,
  values: { elapsed: number; turns: number; tokens: number },
): {
  crossedMs: boolean;
  crossedTurns: boolean;
  crossedTokens: boolean;
  reachedMs: number;
  reachedTurns: number;
  reachedTokens: number;
} {
  const thMs = dimThreshold(w.base.ms, w.level);
  const thTurns = dimThreshold(w.base.turns, w.level);
  const thTokens = dimThreshold(w.base.tokens, w.level);
  const crossedMs = Number.isFinite(thMs) && values.elapsed >= thMs;
  const crossedTurns = Number.isFinite(thTurns) && values.turns >= thTurns;
  const crossedTokens = Number.isFinite(thTokens) && values.tokens >= thTokens;
  return {
    crossedMs,
    crossedTurns,
    crossedTokens,
    // Within this dimension's own scale (starting at 1 at the threshold):
    // 0 unless it crossed.
    reachedMs: crossedMs ? levelReached(values.elapsed, thMs) : 0,
    reachedTurns: crossedTurns ? levelReached(values.turns, thTurns) : 0,
    reachedTokens: crossedTokens ? levelReached(values.tokens, thTokens) : 0,
  };
}

/**
 * The ELAPSED dimension evaluated without a progress event. A child silent
 * for 20+ minutes (a long build, a hung CI wait) otherwise crosses only when
 * its next event arrives — or never. The timer fires with the latest fed
 * snapshot (or nothing, until one has been fed), delivers on a crossing, and
 * re-arms at the next doubling.
 */
function tickElapsed(w: Watch): void {
  const s = w.lastState;
  if (!w.seenProgress || !s) return;
  const elapsed = Math.max(0, w.now() - w.startedAt);
  // Only elapsed can be evaluated from the clock — the snapshot's turns and
  // tokens are unchanged since the last feed (which already evaluated them),
  // so -1 (below every finite threshold) keeps them inert here.
  const crossed = advanceLevel(w, { elapsed, turns: -1, tokens: -1 });
  if (crossed.crossedMs) {
    w.level += crossed.reachedMs;
    deliver(w, { ...s, elapsedMs: elapsed }, ["elapsed"]);
  }
  // The elapsed timer is absolute from the watch start: re-arm for
  // `start + msBase·2^level` minus now (Infinity → no timer).
  const nextMs = dimThreshold(w.base.ms, w.level);
  if (Number.isFinite(nextMs)) {
    scheduleElapsedCheck(w, Math.max(0, nextMs - elapsed));
  }
}

/** Arm the watch. Returns a stop function the caller MUST invoke when the
 * child settles (success or failure): it deletes the state entry, so a
 * finished child can never notice again and the map stays bounded.
 */
export function watchSlowDispatch(input: SlowWatchInput): () => void {
  const base = levelThresholds(0);
  const now = input.now ?? Date.now;
  const rawSchedule =
    input.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
  // #799 — the parent pi, threaded through `input.pi` so lens/adversarial
  // children — spawned without a pi in scope — still deliver the PM notice.
  // `w.pi` (set below from `input.pi`) wins per watch; the parent api the
  // watch falls back to is the one the extension registered ONCE at load
  // (index.ts) — `deliver` reads it via `getParentExtensionApi()`, and this
  // function deliberately never calls `setParentExtensionApi` (the single
  // writer is the load; a per-watch set would race a sibling cycle's watch).
  // Absent in the suite → the notice is skipped, never thrown.
  const w: Watch = {
    id: input.id,
    role: input.role,
    label: input.label,
    startedAt: now(),
    // #799 — the timer cancel must be a real function: a test scheduler may
    // return an object, and a missing/invalid cancel would make the stop
    // function throw mid-settle (the section-2b hang shape).
    schedule: (fn, ms) => {
      const c = rawSchedule(fn, ms);
      return typeof c === "function" ? c : () => {};
    },
    ...(input.pi ? { pi: input.pi } : {}),
    ...(input.steerFn ? { steerFn: input.steerFn } : {}),
    now,
    ...(input.onSlow ? { onSlow: input.onSlow } : {}),
    level: 0,
    lastState: undefined,
    seenProgress: false,
    // #884 — the env overrides are read ONCE here; from this point the watch
    // is pure arithmetic on `base` (see dimThreshold / advanceLevel).
    base,
  };
  watches.set(input.id, w);
  // Arm the first elapsed check (no-op when the dimension is disabled).
  if (Number.isFinite(base.ms)) scheduleElapsedCheck(w, base.ms);
  return () => {
    if (w.timer) {
      try {
        w.timer();
      } catch {
        // A malformed scheduler cancel must not abort the settle path.
      }
    }
    watches.delete(input.id);
  };
}

/**
 * Feed a progress update. Fires when ANY dimension meets the NEXT level's
 * threshold, delivering ONE notice+steer+onSlow for the level and naming the
 * triggering dimension(s); the level then jumps to the HIGHEST level any
 * dimension has now reached (an overshoot fires once, no catch-up burst);
 * disabled (Infinity) dimensions stay inert. 149→151→160 turns: only the 151
 * feed fires; the other dimensions' first crossings are covered by the
 * level-1 fire and fire again only at 40 min / 300 turns / 40M.
 */
export function feedSlowProgress(id: string, s: RunningState): void {
  const w = watches.get(id);
  if (!w) return;
  w.lastState = s;
  w.seenProgress = true;
  const elapsed = s.elapsedMs > 0 ? s.elapsedMs : Math.max(0, w.now() - w.startedAt);
  const crossed = advanceLevel(w, { elapsed, turns: s.turns, tokens: s.totalTokens });
  if (!crossed.crossedMs && !crossed.crossedTurns && !crossed.crossedTokens) return;
  // Set the level to the HIGHEST level any dimension has now reached, so a
  // simultaneous or overshooting crossing fires once. `reached*` is within
  // the dimension's own scale (1 at the threshold); add `w.level` for the
  // absolute level: tokens 45M vs threshold 40M (level 1) → absolute 2.
  const prev = w.level;
  w.level = prev + 1;
  if (crossed.crossedMs) w.level = Math.max(w.level, prev + crossed.reachedMs);
  if (crossed.crossedTurns) w.level = Math.max(w.level, prev + crossed.reachedTurns);
  if (crossed.crossedTokens) w.level = Math.max(w.level, prev + crossed.reachedTokens);
  // Re-arm the elapsed timer ABSOLUTELY from the watch start (Infinity →
  // no timer): its next fire is at start + msBase·2^level.
  const nextMs = dimThreshold(w.base.ms, w.level);
  if (Number.isFinite(nextMs)) scheduleElapsedCheck(w, Math.max(0, nextMs - elapsed));
  const triggered = [
    crossed.crossedMs && "elapsed",
    crossed.crossedTurns && "turns",
    crossed.crossedTokens && "tokens",
  ].filter((x): x is string => typeof x === "string");
  deliver(w, s, triggered);
}

/** Test-only: empty the pending buffer (all cycles). */
export { clearSlowEventsForTesting } from "./slow-events.ts";

/** Test-only: clear all watch state (the module-level map is a singleton
 * across the test process, and the suite shares one module graph). */
export function clearSlowWatchesForTesting(): void {
  watches.clear();
}

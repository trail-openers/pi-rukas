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
 * Infinity at every level. */
export function levelThresholds(level: number): { ms: number; turns: number; tokens: number } {
  const v = process.env.PI_ENSEMBLE_SLOW_NOTICE;
  const disabled = v === "0";
  return {
    ms: envNum("PI_ENSEMBLE_SLOW_NOTICE_MS", 20 * 60_000, level, disabled),
    turns: envNum("PI_ENSEMBLE_SLOW_NOTICE_TURNS", 150, level, disabled),
    tokens: envNum("PI_ENSEMBLE_SLOW_NOTICE_TOKENS", 20_000_000, level, disabled),
  };
}

/** #799 — the doubling schedule, level 0 (the first crossing). */
export function slowThresholds(): { ms: number; turns: number; tokens: number } {
  return levelThresholds(0);
}

/** One dimension's threshold at level n: the env override (if set) or the
 * built-in base, then scaled by 2^level. The override sets the BASE (level
 * 0), so every level doubles it — exactly as the default does. */
function envDimension(key: string, base: number, level: number, disabled: boolean): number {
  if (disabled) return Number.POSITIVE_INFINITY;
  const raw = process.env[key];
  const n = raw === undefined || raw === "" ? base : Number(raw.replace(/_/g, ""));
  if (!Number.isFinite(n) || n <= 0) return base;
  return n * 2 ** Math.max(0, level);
}

function envNum(key: string, base: number, level: number, disabled: boolean): number {
  return envDimension(key, base, level, disabled);
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
   * #884 — replaces the per-dimension re-arming, which let one run crossing
   * all three dimensions minutes apart fire three notices. */
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
}

const watches = new Map<string, Watch>();

/** The highest level a dimension has reached: 0 below `base`, else the
 * largest k with value ≥ base·2^(k-1) (value ≥ base → 1, ≥ 2·base → 2, …).
 * Integer doubling, not floating log, so exact powers stay exact. */
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
  return `You have been running for ${formatElapsed(elapsedMs)} / ${turns} turns. Report status in ≤3 lines (done / remaining / blocked). If you are re-running or re-scanning checks, stop: use the gate's exit code, commit, and write your final report.`;
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
  const th = levelThresholds(w.level);
  if (Number.isFinite(th.ms) && elapsed >= th.ms) {
    // Same rule as feedSlowProgress: jump to the highest level elapsed has
    // now reached (no catch-up burst if the tick is delayed).
    w.level += levelReached(elapsed, th.ms);
    deliver(w, { ...s, elapsedMs: elapsed }, ["elapsed"]);
  }
  // The elapsed timer is absolute from the watch start: re-arm for
  // `start + msBase·2^level` minus now (Infinity → no timer).
  const nextMs = levelThresholds(w.level).ms;
  if (Number.isFinite(nextMs)) {
    scheduleElapsedCheck(w, Math.max(0, nextMs - elapsed));
  }
}

/**
 * Arm the watch. Returns a stop function the caller MUST invoke when the
 * child settles (success or failure): it deletes the state entry, so a
 * finished child can never notice again and the map stays bounded.
 */
export function watchSlowDispatch(input: SlowWatchInput): () => void {
  const th = slowThresholds();
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
  };
  watches.set(input.id, w);
  // Arm the first elapsed check (no-op when the dimension is disabled).
  if (Number.isFinite(th.ms)) scheduleElapsedCheck(w, th.ms);
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
 * threshold (`base·2^(level+1)`), delivering ONE notice+steer+onSlow for the
 * level and naming the triggering dimension(s). The level then jumps to the
 * HIGHEST level any dimension has now reached (an overshoot fires once, with
 * no catch-up burst); disabled (Infinity) dimensions stay inert at every
 * level. 149→151→160 turns: only the 151 feed fires; after it, the other
 * dimensions' first crossings (20 min / 20M tokens) are covered by the
 * level-1 fire and fire again only at 40 min / 300 turns / 40M.
 */
export function feedSlowProgress(id: string, s: RunningState): void {
  const w = watches.get(id);
  if (!w) return;
  w.lastState = s;
  w.seenProgress = true;
  const elapsed = s.elapsedMs > 0 ? s.elapsedMs : Math.max(0, w.now() - w.startedAt);
  const th = levelThresholds(w.level);
  const crossedMs = Number.isFinite(th.ms) && elapsed >= th.ms;
  const crossedTurns = Number.isFinite(th.turns) && s.turns >= th.turns;
  const crossedTokens = Number.isFinite(th.tokens) && s.totalTokens >= th.tokens;
  if (!crossedMs && !crossedTurns && !crossedTokens) return;
  // Set the level to the HIGHEST level any dimension has now reached, so a
  // simultaneous or overshooting crossing fires once and the next fire is
  // at base·2^level from there.
  // `th` is base·2^level per dimension, so levelReached(value, th) returns
  // the level WITHIN this dimension's own scale starting at 1. Add `w.level`
  // to get the absolute level: e.g. tokens 45M vs th.tokens = 40M (level 1)
  // → levelReached = 1 (45M ≥ 40M) → absolute = 1 + 1 = 2 (≥ 40M, < 80M).
  const prev = w.level;
  w.level = prev + 1;
  if (crossedMs && th.ms > 0) w.level = Math.max(w.level, prev + levelReached(elapsed, th.ms));
  if (crossedTurns && th.turns > 0)
    w.level = Math.max(w.level, prev + levelReached(s.turns, th.turns));
  if (crossedTokens && th.tokens > 0)
    w.level = Math.max(w.level, prev + levelReached(s.totalTokens, th.tokens));
  // Re-arm the elapsed timer ABSOLUTELY from the watch start (Infinity →
  // no timer): its next fire is at start + msBase·2^level.
  const nextMs = levelThresholds(w.level).ms;
  if (Number.isFinite(nextMs)) scheduleElapsedCheck(w, nextMs - elapsed);
  const triggered = [
    crossedMs && "elapsed",
    crossedTurns && "turns",
    crossedTokens && "tokens",
  ].filter((x): x is string => typeof x === "string");
  deliver(w, s, triggered);
}

/**
 * #799 — the driver's pending slow-event buffer, keyed by the cycle's
 * primary issue. The per-step `onSlow` recorder (via `slowRecorder`) pushes
 * each crossing into ITS cycle's list INSTEAD of folding into a per-site
 * state ref: the list is drained into the cycle's state at the driver's
 * single step-boundary persistence point (work-driver-step-router.ts
 * `routeStepOutcome`, before its first `writeState`), so one crossing lands
 * exactly once in the durable log regardless of which step recorded it (the
 * two broken shapes it fixes: a plan-time recorder that folded into a
 * throwaway ref, and an adversarial fan-out whose ref was never read back).
 *
 * The key is load-bearing, not decorative: up to
 * MAX_PARALLEL_GROUPS_DEFAULT (3) groups run concurrently in one process, and
 * a single shared buffer let cycle A's routeStepOutcome drain cycle B's
 * crossings into A's event log. The registry (work-driver-registry.ts) keys
 * cycles by the primary issue, which is what identifies a cycle uniquely.
 * Each entry is dropped on drain (no unbounded growth) and on cycle end —
 * the handoff step is the terminal step every /work cycle ends in (success
 * goes through it, and the merged step has no dispatch of its own), so
 * `dropSlowEvents` there covers every leftover.
 */
const pendingSlowEvents = new Map<number, WorkEvent[]>();

/** The driver's per-step slow recorder: the `onSlow` callback the driver
 * threads into `dispatchCore`. `issue` is the cycle's primary issue — the
 * buffer key (see above). Pushes the crossing into that cycle's list;
 * persistence is the driver's single drain point (see above). Sync + never
 * throws (the watch also catches, but the contract is sync so the event
 * log stays append-only). */
export function slowRecorder(issue: number, step: WorkStep): OnSlowCallback {
  return (info) => {
    const list = pendingSlowEvents.get(issue) ?? [];
    list.push({
      kind: "dispatch-slow",
      step,
      role: info.role,
      jobId: info.jobId,
      label: info.label,
      elapsedMs: info.elapsedMs,
      turns: info.turns,
      tokens: info.tokens,
      at: info.at,
    });
    pendingSlowEvents.set(issue, list);
  };
}

/** Drain one cycle's pending list (returns it, deletes the entry — an empty
 * or unknown list gives `[]` without touching anything). Called at the
 * driver's step-boundary persistence point, just before `writeState`, so
 * slow events land in the durable log together with the step's own events
 * — and only in THAT cycle's log (a sibling cycle's list is untouched).
 * The events carry their own `at`, so it is acceptable that they land after
 * the step's completion event. */
export function drainSlowEvents(issue: number): WorkEvent[] {
  const list = pendingSlowEvents.get(issue);
  if (!list || list.length === 0) {
    if (list) pendingSlowEvents.delete(issue);
    return [];
  }
  pendingSlowEvents.delete(issue);
  return list;
}

/** Drop one cycle's leftover list without returning it. Called at the
 * handoff step — the terminal step every /work cycle ends in — so a cycle
 * that recorded a crossing no step boundary drained (e.g. a child that
 * outlived the handoff ops bound) cannot leak its events into a later cycle
 * of the same issue. */
export function dropSlowEvents(issue: number): void {
  pendingSlowEvents.delete(issue);
}

/** Test-only: empty the pending buffer (all cycles). */
export function clearSlowEventsForTesting(): void {
  pendingSlowEvents.clear();
}

/** Test-only: clear all watch state (the module-level map is a singleton
 * across the test process, and the suite shares one module graph). */
export function clearSlowWatchesForTesting(): void {
  watches.clear();
}

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
 * On a threshold crossing (20 min / 150 turns / 20M tokens, whichever comes
 * first; then again at each doubling of the crossed dimension(s)):
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
import type { SteerSource } from "./dispatch-steer.ts";
import { steerChild } from "./dispatch-steer.ts";
import type { RunningState } from "./progress.ts";
import { formatElapsed, formatTokens } from "./progress.ts";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent, writeState } from "./workflow-state.ts";

/** The one place the driver's dispatch-slow events get appended: threaded
 * through `dispatchCore`'s opts (work-driver-event seam), persisted there via
 * `writeState`. When absent (PM-owned jobs) the notice is PM-only. */
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
  /** Injectable pi — the notifyAgent target (undefined in the suite → the
   * notice is skipped, never thrown). */
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  /** Injectable steer core — tests record instead of writing to a real
   * stdin. Defaults to `steerChild`. */
  steerFn?: (jobId: string, text: string, source: SteerSource) => unknown;
  /** Injectable clock — the elapsed dimension is computed from it (tests
   * drive it deterministically). */
  now?: () => number;
  onSlow?: OnSlowCallback;
}

/** #799 — the doubling schedule. First crossing at 20 min / 150 turns /
 * 20M tokens, whichever comes first; after that, each crossed dimension
 * re-arms at its own doubling (40 / 300 / 40M, …). Env overrides:
 * PI_ENSEMBLE_SLOW_NOTICE_MS / _TURNS / _TOKENS. */
export function slowThresholds(): { ms: number; turns: number; tokens: number } {
  const v = process.env.PI_ENSEMBLE_SLOW_NOTICE;
  return {
    ms: envMs("PI_ENSEMBLE_SLOW_NOTICE_MS", 20 * 60_000, v === "0"),
    turns: envNum("PI_ENSEMBLE_SLOW_NOTICE_TURNS", 150, v === "0"),
    tokens: envNum("PI_ENSEMBLE_SLOW_NOTICE_TOKENS", 20_000_000, v === "0"),
  };
}

function envMs(key: string, def: number, disabled: boolean): number {
  if (disabled) return Number.POSITIVE_INFINITY;
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw.replace(/_/g, ""));
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envNum(key: string, def: number, disabled: boolean): number {
  if (disabled) return Number.POSITIVE_INFINITY;
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw.replace(/_/g, ""));
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function autoSteerEnabled(): boolean {
  return process.env.PI_ENSEMBLE_AUTO_STEER !== "0";
}

interface Thresholds {
  ms: number;
  turns: number;
  tokens: number;
}

interface Watch {
  id: string;
  role: string;
  label: string;
  startedAt: number;
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  steerFn?: SlowWatchInput["steerFn"];
  now: () => number;
  onSlow?: OnSlowCallback;
  /** Next crossing per dimension. A finite value means the dimension is
   * armed; Infinity means the dimension has never crossed (its threshold is
   * still the first one) or it was never configured. */
  armed: Thresholds;
  /** A crossing was processed this feed() call — prevents double-fires when
   * several dimensions cross in the same update. */
  firedThisCall: boolean;
}

const watches = new Map<string, Watch>();

function thresholdValue(base: number, level: number): number {
  return base * 2 ** Math.max(0, level);
}

/** Format `150 turns` / `20.0M tokens` / `42.0m` for the notice + steer text. */
function fmtSlow(elapsedMs: number, turns: number, tokens: number): string {
  return `${formatElapsed(elapsedMs)} · ${turns} turns · ${formatTokens(tokens)} tokens`;
}

function noticeText(w: Watch, s: RunningState): string {
  const snippet = s.lastText
    ? ` Last said: "${s.lastText.replaceAll("\n", " ").slice(0, 200)}"`
    : "";
  return [
    `[ensemble:slow] ${w.label} (${w.id}) has been running past a slow-run threshold: ${fmtSlow(s.elapsedMs, s.turns, s.totalTokens)}.`,
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

function deliver(w: Watch, s: RunningState): void {
  const elapsed = s.elapsedMs > 0 ? s.elapsedMs : Math.max(0, w.now() - w.startedAt);
  // 1 — PM notice (notifyAgent, always deliverAs "steer"). A rejection of the
  // send must never be an unhandled rejection.
  if (w.pi) {
    try {
      notifyAgent(w.pi, noticeText(w, { ...s, elapsedMs: elapsed }));
    } catch (err) {
      trace(`slow-notice: PM notice for ${w.id} failed: ${(err as Error).message}`);
    }
  }
  // 2 — the one automatic steer, lifecycle-logged through the steer core.
  if (autoSteerEnabled()) {
    const r = (w.steerFn ?? ((id, t, src) => steerChild(id, t, src)))(
      w.id,
      slowSteerText(elapsed, s.turns),
      "driver-slow-notice",
    );
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
  trace(`slow-notice: ${w.label} (${w.id}) crossed — ${fmtSlow(elapsed, s.turns, s.totalTokens)}`);
}

/**
 * Arm the watch. Returns a stop function the caller MUST invoke when the
 * child settles (success or failure): it deletes the state entry, so a
 * finished child can never notice again and the map stays bounded.
 */
export function watchSlowDispatch(input: SlowWatchInput): () => void {
  const th = slowThresholds();
  const now = input.now ?? Date.now;
  const w: Watch = {
    id: input.id,
    role: input.role,
    label: input.label,
    startedAt: now(),
    ...(input.pi ? { pi: input.pi } : {}),
    ...(input.steerFn ? { steerFn: input.steerFn } : {}),
    now,
    ...(input.onSlow ? { onSlow: input.onSlow } : {}),
    armed: { ms: th.ms, turns: th.turns, tokens: th.tokens },
    firedThisCall: false,
  };
  watches.set(input.id, w);
  return () => {
    watches.delete(input.id);
  };
}

/**
 * Feed a progress update. Each dimension that has crossed its armed level
 * fires the notice+steer ONCE and re-arms at its next doubling; dimensions
 * that have not crossed yet still compare against the first threshold. A
 * single feed can therefore fire at most once (the dimensions cross
 * together or separately, but the crossing is a monotone event per feed
 * call). 149→151→160 turns: only the 151 feed fires.
 */
export function feedSlowProgress(id: string, s: RunningState): void {
  const w = watches.get(id);
  if (!w) return;
  w.firedThisCall = false;
  const elapsed = s.elapsedMs > 0 ? s.elapsedMs : Math.max(0, w.now() - w.startedAt);
  const crossed =
    (w.armed.ms !== Number.POSITIVE_INFINITY && elapsed >= w.armed.ms) ||
    (w.armed.turns !== Number.POSITIVE_INFINITY && s.turns >= w.armed.turns) ||
    (w.armed.tokens !== Number.POSITIVE_INFINITY && s.totalTokens >= w.armed.tokens);
  if (!crossed) return;
  // Re-arm each crossed dimension at its next doubling; untouched dimensions
  // keep their current arm (an untouched dimension's next crossing is still
  // its own next level — the level is derived from its own armed value).
  const th = slowThresholds();
  if (w.armed.ms !== Number.POSITIVE_INFINITY && elapsed >= w.armed.ms) {
    w.armed.ms = thresholdValue(th.ms, nextLevel(w.armed.ms, th.ms));
  }
  if (w.armed.turns !== Number.POSITIVE_INFINITY && s.turns >= w.armed.turns) {
    w.armed.turns = thresholdValue(th.turns, nextLevel(w.armed.turns, th.turns));
  }
  if (w.armed.tokens !== Number.POSITIVE_INFINITY && s.totalTokens >= w.armed.tokens) {
    w.armed.tokens = thresholdValue(th.tokens, nextLevel(w.armed.tokens, th.tokens));
  }
  w.firedThisCall = true;
  deliver(w, s);
}

function nextLevel(current: number, base: number): number {
  // The armed value is base * 2^n for n >= 0; the next level is n+1.
  for (let n = 0; n < 64; n++) {
    if (base * 2 ** n === current) return n + 1;
  }
  return 1;
}

/**
 * The driver's per-step slow recorder: append a `dispatch-slow` event to the
 * cycle's state and persist. Shared by every driver dispatch site so the
 * event shape + the persist-on-failure contract live in one place. The
 * returned callback is sync + never throws (the watch also catches, but the
 * contract is sync so the event log stays append-only).
 */
export function slowRecorder(
  repoRoot: string,
  step: WorkState["pipelineState"]["currentStep"],
  stateRef: { current: WorkState },
): OnSlowCallback {
  return (info) => {
    stateRef.current = appendEvent(stateRef.current, {
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
    void writeState(repoRoot, stateRef.current).catch((err) =>
      trace(`slow-notice: dispatch-slow persist failed: ${(err as Error).message}`),
    );
  };
}

/** Test-only: clear all watch state (the module-level map is a singleton
 * across the test process, and the suite shares one module graph). */
export function clearSlowWatchesForTesting(): void {
  watches.clear();
}

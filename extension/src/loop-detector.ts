/**
 * F1 loop detector (#543) — streak-based repeated tool-call detection over a
 * child Pi's `message_end` event stream.
 *
 * Measured 2026-08-25: long-dispatch cost concentrates in LOOP runs, not long
 * work. Three pathology transcripts — a 692-turn developer re-running `sh -n`
 * across drifting paths, a 507-turn lens running `grep X | grep -v X` (always
 * empty) 223 times, and a 106-turn explore repeating one `git show` 19x — all
 * silent-on-stdout, so the inactivity watchdog (which watches stdout bytes
 * only) provably never fires. Healthy runs finish in ≤119 turns.
 *
 * Design constraints, each load-bearing:
 *
 *   - **Streak counter, not sliding window.** The 223-grep cluster had ~286
 *     silent turns BETWEEN repeats; a sliding window would never see 10
 *     in-frame. A since-last-distinct streak does.
 *   - **Full block list per `message_end`.** A single assistant turn can
 *     carry two identical toolCall blocks; EACH counts (the two-blocks
 *     multiplier — one 5-block turn can cross both thresholds in a single
 *     observe). `progress.ts`'s `latestToolName` is overwritten per block
 *     and cannot be used.
 *   - **Ops-role children are EXEMPT.** ops runs deterministic git/gh;
 *     capping them manufactures partial-state incidents. The caller (spawn.ts)
 *     skips creating the detector for role === "ops".
 *   - **Path-redaction via first-seen registry.** Each distinct absolute
 *     path the detector has seen is assigned its own placeholder token in
 *     first-seen order (`<P1>`, `<P2>`, …). This is the literal reading of
 *     the spec: "each distinct absolute path → a single placeholder token".
 *     It makes fixture (d) pass: `ls /a/b` x10 → `ls <P1>` x10; `ls /c/d`
 *     x10 → `ls <P2>` x10 — different fingerprints, streak resets, NO
 *     trigger. The 692-run shape (`sh -n /tmp/x/v1.sh` then `sh -n
 *     /tmp/x/v2.sh`) produces two different tokens and does NOT trigger
 *     under this normalization — see the Open Question "Var-substitution /
 *     similarity in normalization" in the issue for the deferred follow-up
 *     that closes this gap. The PRIMARY pathology (223-grep, identical
 *     args) is caught by exact-match on the redacted fingerprint.
 *   - **Streaks are counted, not timed.** The grace window for the kill
 *     lives in the caller (spawn.ts) because it is wall-clock; this module
 *     is a pure function so fixtures can inject time.
 *
 * The caller feeds the detector via `observe()` (wired into
 * `progress.ts ingestEvent`, which sees every assistant `message_end` with
 * the FULL content block list) and consults `current()` for the structured
 * evidence to attach to the kill.
 */

import type { PiContentBlock } from "./pi-event-shapes.ts";

/** Steer the child when the streak reaches this (first steer only). */
export const LOOP_STEER_AT = 5;
/** Kill the child when the streak reaches this. */
export const LOOP_KILL_AT = 10;

/**
 * Kill grace window — the kill is deferred up to this long while no new
 * `message_end` has arrived since trigger. Rationale: the same
 * false-positive shape killed #296's per-role wall-clock caps, a cap
 * firing mid-long-tool-call discards in-progress work. The window is
 * wall-clock, so the caller (spawn.ts via spawn-caps.ts) is responsible for
 * honouring it; this module only tracks when the last `message_end`
 * arrived.
 *
 * The single definition lives in `spawn-support.ts` (`capKillGraceMs`,
 * override `PI_ENSEMBLE_CAP_KILL_GRACE_MS`, 0 disables). This module once
 * carried its own copy — deleted in #544 because the two copies could drift
 * and the detector's was dead (never imported).
 */

/**
 * Master switch — `PI_ENSEMBLE_DISPATCH_CAPS=0` disables F1/F6/F3a-reattach
 * together (per the #543 acceptance criteria). F1 alone can be disabled with
 * `PI_ENSEMBLE_LOOP_DETECTOR=0`. Default: on.
 */
export function loopDetectorEnabled(): boolean {
  if (process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0") return false;
  return process.env.PI_ENSEMBLE_LOOP_DETECTOR !== "0";
}

export interface LoopEvidence {
  tool: string;
  fingerprint: string;
  /** Current streak length (count of consecutive identical calls). */
  count: number;
  /** Turn range of the streak [start, end] (0-indexed). */
  turnRange: [number, number];
}

/**
 * The exact text the child reads when the detector steers it. Per the issue,
 * this does NOT claim in-flight work is complete — per `progress.ts`'s #299
 * note the assistant turn carrying a toolCall completes BEFORE the tool
 * executes, so the "result" the child would compare is not the one that ran.
 */
export function loopSteerText(tool: string, count: number): string {
  return `you appear to be repeating the same ${tool} call with identical arguments after normalization (${count} times); if the result is not changing, change approach or stop, and when you finish write your status (done / remaining / current state) to your final report.`;
}

/** Match absolute POSIX paths (Unix-style; Pi children run on Unix). */
const ABS_PATH_RE = /(?:\/[\w.\-]+){2,}/g;

/**
 * Normalize a toolCall's arguments to a streak-comparison fingerprint.
 *
 * Rules:
 *   - Trim + collapse all whitespace runs to a single space (so multi-line
 *     bash scripts with reflowed indentation still match).
 *   - Replace each absolute POSIX path with a placeholder token from a
 *     first-seen registry (`<P1>`, `<P2>`, …). The registry is passed in so
 *     the same path maps to the same token across calls, while different
 *     paths get different tokens. This makes `ls /a/b` x10 → `ls /c/d` x10
 *     reset the streak (different tokens), which is the spec's fixture (d).
 *   - JSON args are stringified with stable key order so structural
 *     equality holds regardless of object literal ordering.
 */
export function normalizeFingerprint(
  tool: string,
  args: unknown,
  pathRegistry: Map<string, number>,
): string {
  const raw = argsToJsonString(args);
  const redacted = raw.replace(ABS_PATH_RE, (match) => {
    let idx = pathRegistry.get(match);
    if (idx === undefined) {
      idx = pathRegistry.size + 1;
      pathRegistry.set(match, idx);
    }
    return `<P${idx}>`;
  });
  return `${tool} ${redacted}`.trim();
}

/** Canonical JSON: stable key order, no undefined. */
function argsToJsonString(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  try {
    return JSON.stringify(args, (_key, val) => {
      if (val === undefined) return undefined;
      return val;
    });
  } catch {
    return String(args);
  }
}

export type LoopDetectionEvent =
  | { kind: "steer"; tool: string; count: number; text: string }
  | { kind: "kill"; tool: string; count: number; fingerprint: string };

export interface LoopDetector {
  /**
   * Feed one assistant `message_end`'s content blocks. Returns a detection
   * event when the streak crosses a threshold for the first time. The caller
   * should steer on `steer` and schedule the kill on `kill` (grace-window
   * handled by the caller — see `capKillGraceMs`).
   *
   * Multiple toolCall blocks in one message are each counted: a single
   * turn with two identical bash calls increments the streak by 2.
   */
  observe(blocks: PiContentBlock[], turnIndex: number): LoopDetectionEvent | null;
  /** The current streak's evidence (null when no tool call observed yet). */
  current(): LoopEvidence | null;
  /** True once the kill threshold has been reached (idempotent). */
  killTriggered(): boolean;
  /** True once the steer threshold has been reached (idempotent). */
  steerTriggered(): boolean;
}

export function createLoopDetector(): LoopDetector {
  const pathRegistry = new Map<string, number>();
  let currentFp: string | null = null;
  let currentTool: string | null = null;
  let streakCount = 0;
  let streakStartTurn = 0;
  let lastTurn = -1;
  let steered = false;
  let killed = false;

  function observe(blocks: PiContentBlock[], turnIndex: number): LoopDetectionEvent | null {
    let event: LoopDetectionEvent | null = null;
    lastTurn = turnIndex;
    for (const block of blocks) {
      if (block.type !== "toolCall" || !block.name) continue;
      const fp = normalizeFingerprint(block.name, block.arguments, pathRegistry);
      if (fp === currentFp) {
        streakCount += 1;
      } else {
        currentFp = fp;
        currentTool = block.name;
        streakCount = 1;
        streakStartTurn = turnIndex;
      }
      if (streakCount >= LOOP_KILL_AT && !killed) {
        killed = true;
        event = {
          kind: "kill",
          tool: currentTool ?? "unknown",
          count: streakCount,
          fingerprint: currentFp ?? "",
        };
      } else if (streakCount >= LOOP_STEER_AT && !steered && !killed) {
        steered = true;
        event = {
          kind: "steer",
          tool: currentTool ?? "unknown",
          count: streakCount,
          text: loopSteerText(currentTool ?? "unknown", streakCount),
        };
      }
    }
    return event;
  }

  function current(): LoopEvidence | null {
    if (!currentFp || !currentTool || streakCount < 1) return null;
    return {
      tool: currentTool,
      fingerprint: currentFp,
      count: streakCount,
      turnRange: [streakStartTurn, lastTurn],
    };
  }

  return {
    observe,
    current,
    killTriggered: () => killed,
    steerTriggered: () => steered,
  };
}

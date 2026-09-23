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
 * #772 (2026-09-17/18) added the third incident shape: an agent re-issuing an
 * identical command that ALREADY SUCCEEDED, with intervening distinct calls
 * (2361 turns / 390M tokens) — a shape that defeats the streak counter (any
 * intervening distinct fingerprint resets it) AND defeats any guard that
 * cannot see the tool's RESULT (`message_end` fires before the tool runs).
 * The fix is the success-keyed repetition counter in
 * `loop-detector-success.ts` — non-adjacent, fed by `toolResult` events,
 * reset only on a state change (an errored result, a CHANGED output, or a
 * state-mutation call).
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
 * #772 — the success-keyed counter's own constraints:
 *   - **Success-keyed, non-adjacent.** Fed the tool RESULT (`toolResult`
 *     events); accumulates identical successful re-runs with no state
 *     mutation between. "Identical output" = "nothing changed". An
 *     intervening DISTINCT toolCall does NOT reset (the #753 shape).
 *   - **Resets only on state change.** An errored result, a CHANGED output,
 *     or a state-mutation call (write/edit/multiedit, or bash matching
 *     `BASH_MUTATION_RE`) — all clear ALL fingerprints.
 *   - **Approximate mutation detection.** `bash`-issued mutations are
 *     detected PATTERN-BASED: `observe()` inspects a `bash` toolCall's
 *     command against `BASH_MUTATION_RE` and, on a hit, the reset fires in
 *     `observeToolResult` (when the command's result is consumed). A
 *     mutation that does not match (or one performed by a script) can still
 *     let a content-independent green command accumulate; the escape hatch
 *     is `PI_ENSEMBLE_LOOP_DETECTOR=0` / `PI_ENSEMBLE_DISPATCH_CAPS=0`.
 *
 * The caller feeds the detector via `observe()` (wired into
 * `progress.ts ingestEvent`, which sees every assistant `message_end` with
 * the FULL content block list) and consults `current()` for the structured
 * evidence to attach to the kill.
 * #772 also feeds `observeToolResult()` (wired into the `toolResult` branch)
 * for the success-keyed counter.
 */

import {
  SUCCESS_KILL_AT,
  SUCCESS_STEER_AT,
  bashMutation,
  createSuccessCounters,
  successSteerText,
} from "./loop-detector-success.ts";
import type { PiContentBlock } from "./pi-event-shapes.ts";

/** Steer the child when the streak reaches this (first steer only). */
export const LOOP_STEER_AT = 5;
/** Kill the child when the streak reaches this. */
export const LOOP_KILL_AT = 10;

/**
 * #772 — the callId→fingerprint map's bound in `createLoopDetector`. A
 * child killed mid-call leaves its toolCallId unmapped forever (its
 * toolResult never arrives to consume the entry), so the map can grow
 * without limit over a long dispatch; past the cap the OLDEST mapping is
 * evicted (the same 200 as the success counter's bound — a distinct
 * concern, same order of magnitude). */
const CALL_ID_TO_FP_CAP = 200;

/**
 * #772 — re-exported for callers that import from this module (the
 * canonical definitions and rationale live in loop-detector-success.ts).
 */
export { SUCCESS_STEER_AT, SUCCESS_KILL_AT } from "./loop-detector-success.ts";

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
 *
 * #772 — the master switch covers BOTH counters (the success-keyed counter
 * shares `PI_ENSEMBLE_LOOP_DETECTOR=0` / `PI_ENSEMBLE_DISPATCH_CAPS=0`).
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
  /** #772 — which counter produced this evidence: "streak" is the #543
   * strict-adjacent streak counter, "success" is the #772 success-keyed
   * repetition counter (identical already-successful command re-issued with
   * identical output, non-adjacent repetition). The dispatch report uses
   * this to label the kill as "repeated an already-successful command"
   * rather than the generic "repeated the same tool call" — the ticket's
   * AC: "the kill cause is typed and distinguishable in the dispatch
   * report". */
  kind: "streak" | "success";
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

/** #772 — steer text for the success-keyed counter (re-exported from
 * `loop-detector-success.ts`; it CAN name the result, because the counter
 * is fed by the tool RESULT, which has already happened). */
export { successSteerText } from "./loop-detector-success.ts";

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
  | { kind: "steer"; tool: string; count: number; text: string; successKeyed: boolean }
  | { kind: "kill"; tool: string; count: number; fingerprint: string; successKeyed: boolean };

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
  /**
   * #772 — feed one toolResult event. Non-adjacent repetition is exactly
   * what this counter catches: an intervening DISTINCT toolCall does NOT
   * reset (the #753 shape). Resets only on state change: an errored
   * result, a CHANGED output, or a state-mutation call (write/edit/
   * multiedit, or bash matching `BASH_MUTATION_RE`) — all clear ALL
   * fingerprints. Returns a steer/kill event on threshold crossing.
   */
  observeToolResult(
    toolName: string,
    toolCallId: string,
    resultText: string,
    isError: boolean,
  ): LoopDetectionEvent | null;
  /** The current streak's evidence (null when no tool call observed yet). */
  current(): LoopEvidence | null;
  /** True once the kill threshold has been reached (idempotent). */
  killTriggered(): boolean;
  /** True once the steer threshold has been reached (idempotent). */
  steerTriggered(): boolean;
  /** #772 lens-review — normalise a (tool, args) pair with the detector's
   * OWN path-redaction registry (the same registry `observe` uses), so a
   * fingerprint compared against an earlier one stays comparable (same
   * path → same token on both sides). Callers (spawn-caps.ts's grace-window
   * re-key) must use this instead of building a second registry. */
  fingerprintOf(name: string, args: unknown): string;
}

export function createLoopDetector(): LoopDetector {
  // The detector's OWN path-redaction registry. Shared with `fingerprintOf`
  // (below) so callers that must normalise a block the SAME way the detector
  // does (the grace-window re-key in spawn-caps.ts) reuse it — the same path
  // must map to the same token across both sides or the distinct-fingerprint
  // comparison is apples-to-oranges.
  const pathRegistry = new Map<string, number>();
  let currentFp: string | null = null;
  let currentTool: string | null = null;
  let streakCount = 0;
  let streakStartTurn = 0;
  let lastTurn = -1;
  let steered = false;
  let killed = false;
  // #772 — single source of truth for "a success-keyed kill fired", so
  // killTriggered() reads one flag instead of re-scanning the counter
  // entries. Set by the success counter's onKill callback below.
  let successKilled = false;

  // #772 — success-keyed counter state, shared with the success counters so
  // the detector's OWN path registry is the one used to build fingerprints.
  // Maps toolCallId → fingerprint (set by observe() so observeToolResult can
  // look up which fingerprint the result belongs to). Pi's toolResult message
  // carries `toolCallId` but not the tool name/args, so the detector must
  // have seen the assistant message that ISSUED the call.
  const callIdToFp = new Map<string, string>();
  // #772 lens-review — fingerprints of bash commands that matched
  // BASH_MUTATION_RE (recorded at observe, consumed at observeToolResult).
  // The reset is per-fingerprint and fires when the mutation command's own
  // result is consumed — not at observe() time (which would incorrectly
  // reset for read-only commands that happen to be interleaved).
  const mutationFps = new Set<string>();
  const success = createSuccessCounters(() => lastTurn);

  function observe(blocks: PiContentBlock[], turnIndex: number): LoopDetectionEvent | null {
    let event: LoopDetectionEvent | null = null;
    lastTurn = turnIndex;
    for (const block of blocks) {
      if (block.type !== "toolCall" || !block.name) continue;
      const fp = normalizeFingerprint(block.name, block.arguments, pathRegistry);

      // #772 — record the callId → fingerprint mapping so observeToolResult
      // can look up which fingerprint this result belongs to. The toolCall
      // block carries `id` (the toolCallId Pi's toolResult message echoes).
      if (block.id) {
        callIdToFp.set(block.id, fp);
        // #772 — bounded: a child killed mid-call leaves its toolCallId
        // unmapped forever (its toolResult never arrives to consume the
        // entry), and a pathological child re-issues a new command every
        // turn; past the cap the OLDEST mapping is evicted (Map iteration
        // order is insertion order).
        if (callIdToFp.size > CALL_ID_TO_FP_CAP) {
          const oldest = callIdToFp.keys().next().value;
          if (oldest !== undefined) callIdToFp.delete(oldest);
        }
      }

      // #772 — a state-mutation call (write/edit/multiedit) means the
      // state HAS changed; reset ALL success counters. A re-run of a
      // previously-green test AFTER an edit is legitimate and must not
      // count. (The streak counter is unaffected — it tracks the current
      // streak, not history.)
      //
      // #772 lens-review — bash-issued mutations: a bash command that
      // matches BASH_MUTATION_RE is recorded as a mutation; the reset
      // fires in observeToolResult (when the command's result is consumed)
      // rather than at observe() time. Rationale: the ticket's test (t)
      // asserts that a read-only `cat` between green re-runs does NOT
      // reset — but `cat` does not match BASH_MUTATION_RE, so recording
      // it as a mutation would incorrectly clear the counter. By deferring
      // the reset to result-consumption time, the pattern is a precise
      // per-fingerprint gate: only the result of a matching command
      // triggers the reset, and only for that command's fingerprint.
      // #772 — the bash mutation check lives in loop-detector-success.ts
      // (BASH_MUTATION_RE); the write/edit/multiedit arms are inline here
      // because they reset immediately (the call IS the mutation) rather
      // than being deferred to result-consumption like bash.
      const isMutation =
        block.name === "write" ||
        block.name === "edit" ||
        block.name === "multiedit" ||
        (block.name === "bash" && bashMutation(block.arguments));
      if (isMutation) {
        // write/edit/multiedit: the state HAS changed at the point the
        // call is ISSUED (the tool call is the mutation) — clear immediately.
        // bash mutation: the command may or may not have written state by
        // the time observe() runs (the command hasn't executed yet); the
        // reset is deferred to observeToolResult (the result is the signal
        // that the command ran). Record the fingerprint for that purpose.
        if (block.name === "bash") {
          mutationFps.add(fp);
        } else {
          success.recordFileMutation();
        }
      }

      // Streak logic (F1, #543) — unchanged.
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
          successKeyed: false,
        };
      } else if (streakCount >= LOOP_STEER_AT && !steered && !killed) {
        steered = true;
        event = {
          kind: "steer",
          tool: currentTool ?? "unknown",
          count: streakCount,
          text: loopSteerText(currentTool ?? "unknown", streakCount),
          successKeyed: false,
        };
      }
    }
    return event;
  }

  function observeToolResult(
    toolName: string,
    toolCallId: string,
    resultText: string,
    isError: boolean,
  ): LoopDetectionEvent | null {
    // Look up the fingerprint for this toolCallId. If the assistant
    // message that issued this call was not seen (e.g. the detector was
    // created mid-stream), we cannot attribute the result — return null.
    // #772 lens-review — the mapping is one-shot (a toolCallId is never
    // re-fed); delete the entry once consumed so the map stays bounded.
    // #772 — the map itself is bounded past CALL_ID_TO_FP_CAP: a child
    // killed mid-call leaves its toolCallId unmapped forever (its
    // toolResult never arrives to consume the entry), and a pathological
    // child re-issues a new command every turn, so the OLDEST mapping is
    // evicted first (Map iteration order is insertion order).
    const fp = callIdToFp.get(toolCallId);
    callIdToFp.delete(toolCallId);
    if (!fp) return null;

    // #772 lens-review — bash mutation: the command matched BASH_MUTATION_RE
    // at observe() time; its result is now consumed. The state HAS changed
    // (the command ran) — clear ALL success counters (a re-run of any
    // previously-green command after a commit/install/etc. is no longer a
    // pure re-run). The reset is per-command: only the result of a matching
    // command triggers it, so a read-only `cat` interleaved between green
    // re-runs does NOT clear the counter.
    if (mutationFps.has(fp)) {
      mutationFps.delete(fp);
      success.recordFileMutation();
      return null;
    }

    return success.observeResult(fp, toolName, resultText, isError, () => {
      successKilled = true;
    });
  }

  function current(): LoopEvidence | null {
    // #772 — prefer the success-keyed evidence (it is more specific:
    // "repeated an already-successful command" vs the generic "repeated
    // the same tool call"). Fall back to the streak evidence.
    // #772 — `firedEvidence` returns the MOST SEVERE fired entry
    // deterministically: a killed entry (highest count among kills) wins
    // over a mere steer, so a kill is never masked by a concurrent steer
    // (the rule is documented in loop-detector-success.ts).
    // #772 lens-review — a fired fingerprint whose output later CHANGED (or
    // errored) is deleted and re-seeded fresh at count=1; a stale
    // `kind:"success"` must not be reported from that re-seeded count-1
    // entry. Only an entry that BOTH (a) is steered/killed and (b) still
    // holds count >= SUCCESS_STEER_AT qualifies; anything else falls
    // through to the streak evidence.
    const successEvidence = success.firedEvidence();
    if (successEvidence && successEvidence.count >= SUCCESS_STEER_AT) {
      // Extract the tool name from the fingerprint (first token).
      const tool = successEvidence.fingerprint.split(" ")[0] ?? "unknown";
      return {
        tool,
        fingerprint: successEvidence.fingerprint,
        count: successEvidence.count,
        turnRange: [successEvidence.firstTurn, lastTurn],
        kind: "success",
      };
    }
    if (!currentFp || !currentTool || streakCount < 1) return null;
    return {
      tool: currentTool,
      fingerprint: currentFp,
      count: streakCount,
      turnRange: [streakStartTurn, lastTurn],
      kind: "streak",
    };
  }

  return {
    observe,
    observeToolResult,
    current,
    // #772 — `successKilled` is set by the counter's onKill callback and
    // persists even if the counter entry is later deleted (output changed /
    // errored), so the dispatch still reports the kill.
    killTriggered: () => killed || successKilled,

    // #772 — the steer flag lives per-entry (it is not sticky across
    // deletion), so steerTriggered scans the live entries.
    steerTriggered: () => steered || [...success.entries()].some((e) => e.steered),
    // #772 lens-review — single-path registry: normalise a block through
    // the detector's own path-redaction registry (see `pathRegistry` above).
    fingerprintOf: (name: string, args: unknown): string =>
      normalizeFingerprint(name, args, pathRegistry),
  };
}

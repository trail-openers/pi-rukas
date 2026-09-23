/**
 * #772 — success-keyed repetition counter (extracted from
 * `loop-detector.ts` into its own module so the F1 streak detector file
 * keeps its origin/main documentation intact).
 *
 * Catches the #772 shape the streak counter structurally cannot: an agent
 * re-issuing an identical command that ALREADY SUCCEEDED, with intervening
 * distinct calls (the 2361-turn / 390M-token incident, 2026-09-17/18). Any
 * intervening distinct fingerprint resets the streak counter, and
 * `message_end` fires before the tool runs, so the counter is fed by the
 * tool RESULT instead (`observeResult`, called from
 * `loop-detector.ts`'s `observeToolResult`).
 *
 * Semantics (see the module header in `loop-detector.ts` for the full
 * design constraints and the `PI_ENSEMBLE_LOOP_DETECTOR=0` /
 * `PI_ENSEMBLE_DISPATCH_CAPS=0` escape hatches):
 *   - Non-adjacent: an intervening DISTINCT toolCall does NOT reset.
 *   - Resets only on state change: an errored result, a CHANGED output, or
 *     a state-mutation call (write/edit/multiedit, or bash matching
 *     `BASH_MUTATION_RE`) — all clear ALL fingerprints.
 *   - Per-fingerprint counters: each command has its own count/steered/
 *     killed state, so one loop cannot mask another.
 *
 * Known false-positive class (accepted by the ticket): a child that
 * re-reads a STABLE file or re-runs a STABLE command whose result is
 * byte-identical can accumulate the success-keyed counter if a state
 * mutation happens IN BETWEEN that `BASH_MUTATION_RE` does not recognise
 * (heredocs — `cat <<EOF > f`, `tee`, `python -c '…write…'`, or a script
 * that writes on its own). "Identical output" is the "nothing changed"
 * signal, and an unrecognised mutation lets a changed world report
 * unchanged. The escape hatch is `PI_ENSEMBLE_LOOP_DETECTOR=0` (or
 * `PI_ENSEMBLE_DISPATCH_CAPS=0`).
 */

/**
 * #772 — the success-keyed repetition counter's thresholds. Deliberately
 * higher than the streak detector's: steer at 3 identical successful
 * re-runs (two is a plausible "run, glance, re-run" habit; three is where
 * "checking that nothing changed" stops being a strategy), kill at 6
 * (2x the steer threshold, same ratio as LOOP_STEER_AT/LOOP_KILL_AT — gives
 * the child one full re-steer + report window; also where a `gh pr checks`
 * poll green 6 cycles in a row with zero output change is either done or
 * stuck). The fingerprint is the SAME `normalizeFingerprint` the streak
 * counter uses, so the two counters cannot drift on "identical".
 */
export const SUCCESS_STEER_AT = 3;
export const SUCCESS_KILL_AT = 6;

/** #772 — steer text for the success-keyed counter (re-exported from here
 * by loop-detector.ts). Unlike `loopSteerText`, this CAN name the result —
 * the counter is fed by the tool RESULT, which has already happened, so
 * "nothing has changed between runs" is literally true. */
export function successSteerText(tool: string, count: number): string {
  return `you have re-run the same ${tool} call ${count} times, each returning the same successful output — nothing has changed between runs. Stop re-running it, finish your current step, and write your status (done / remaining / current state) to your final report now.`;
}

/** #772 — per-fingerprint state (independent counter per command). */
export interface SuccessCounterEntry {
  /** The fingerprint this entry belongs to. */
  fingerprint: string;
  /** Last successful result text for this fingerprint (the "output" to
   * compare the next re-run against). */
  lastResultText: string;
  /** Count of consecutive identical successful re-runs. */
  count: number;
  /** True once the steer threshold has been reached for this fingerprint. */
  steered: boolean;
  /** True once the kill threshold has been reached for this fingerprint. */
  killed: boolean;
  /** The turn the fingerprint was first recorded (for turnRange). */
  firstTurn: number;
}

/**
 * #772 lens-review — conservative bash mutation detection (pattern-based;
 * see the module header in `loop-detector.ts` for the escape hatches). A
 * matching command's result clearing the counters is the "state HAS
 * changed" signal.
 *
 * The redirection branch is deliberately NOT anchored to the start of the
 * command or to a preceding `;`/`&`/`|` (the v1 shape only matched
 * `>` there, so `echo x > out.txt` and `cmd >> log` were NOT detected —
 * defect fixed here). Instead it matches an output redirection to a FILE
 * anywhere in the command (` > path`, ` >> path`, `>path`), with two
 * exclusions:
 *   - fd duplication (`2>&1`, `>&2`) is not a file write, so `>&` followed
 *     by a digit is never a match (the guard `[^0-9&]` sits AFTER the `&`,
 *     which is how `2>&1` is rejected while `2> file` still matches).
 *   - `/dev/null` targets are not state changes — writing to a throwaway
 *     sink changes nothing, so a `>` whose target starts with `/dev/null`
 *     is excluded.
 *
 * Everything else is pattern-based and approximate: a mutation that does
 * not match (or one performed by a script) can still let a
 * content-independent green command accumulate. That is accepted by the
 * ticket; the escape hatch is `PI_ENSEMBLE_LOOP_DETECTOR=0` /
 * `PI_ENSEMBLE_DISPATCH_CAPS=0`.
 */
export const BASH_MUTATION_RE =
  /git\s+(?:commit|add|checkout|reset|merge|rebase|apply|stash)\b|\b(?:npm|bun|pnpm|yarn)\s+(?:install|add|remove)\b|>>?\s*(?!\/dev\/null)(?!\s*&?\d)\S|sed\s+-[\w-]*i|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b/;

/** Extract the `command` string from a bash toolCall's args. The canonical
 * shape is the JSON object `{command: "..."}` (the tool schema); read
 * `args.command` DIRECTLY — no stringify/regex round-trip, which used to
 * fail on embedded quotes. Tolerate a raw string too; fall back to
 * stringifying only when there is no string `command` property. */
function bashCommandString(args: unknown): string {
  if (typeof args === "string") return args;
  if (args == null) return "";
  if (typeof args === "object") {
    const command = (args as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  return String(args);
}

/** True when the bash command's args look like a state mutation. */
export function bashMutation(args: unknown): boolean {
  return BASH_MUTATION_RE.test(bashCommandString(args));
}

/** #772 — a steer/kill event as produced by the success counter (the
 * shape matches `LoopDetectionEvent` in loop-detector.ts, so the detector
 * can return the event directly). */
export type SuccessDetectionEvent =
  | { kind: "steer"; tool: string; count: number; text: string; successKeyed: true }
  | { kind: "kill"; tool: string; count: number; fingerprint: string; successKeyed: true };

/** #772 — the success-keyed counter state, closed over by
 * `createSuccessCounters`. The detector's `observe()` feeds mutation
 * signals here; the detector's `observeToolResult()` feeds results. The
 * bash mutation check is NOT part of this interface — the detector calls
 * `bashMutation()` directly (single definition, no indirection). */
export interface SuccessCounters {
  /** #772 — clear ALL success counters (a state mutation was observed). */
  recordFileMutation(): void;
  /** #772 — feed one tool result; returns a steer/kill event on threshold
   * crossing, null otherwise. */
  observeResult(
    fingerprint: string,
    toolName: string,
    resultText: string,
    isError: boolean,
    onKill: () => void,
  ): SuccessDetectionEvent | null;
  /** #772 — the most SEVERE fired entry, deterministically: a killed
   * entry wins (highest count among kills) over a mere steer (highest
   * count among steered non-killed entries), so a kill is never masked by
   * a concurrent steer and the evidence `loop-detector.ts`'s `current()`
   * reports is the worst thing the loop did. Null when nothing has fired
   * yet. */
  firedEvidence(): SuccessCounterEntry | null;
  /** #772 — iterate per-fingerprint state (for killTriggered/steerTriggered
   * OR-reduction in `loop-detector.ts`). */
  entries(): IterableIterator<SuccessCounterEntry>;
}

/** #772 — create the success-keyed counter state. `nowTurn` supplies the
 * current turn index (injected so fixtures control time, matching the F1
 * module's "pure function" constraint). */
export function createSuccessCounters(nowTurn: () => number): SuccessCounters {
  // Maps fingerprint → per-fingerprint counter state. The key is the
  // normalised fingerprint (tool + args), so the same command repeated
  // non-adjacently accumulates in the same entry.
  const successCounters = new Map<string, SuccessCounterEntry>();
  // #772 lens-review — bounded: a pathological child re-issues a
  // near-distinct command forever (a timestamp in the args survives path
  // redaction) and would otherwise grow the map without limit; past the
  // cap the OLDEST insertion is evicted (a long-dead fingerprint is the
  // cheapest thing to forget — Map iteration order is insertion order).
  const SUCCESS_COUNTER_CAP = 200;

  function observeResult(
    fingerprint: string,
    toolName: string,
    resultText: string,
    isError: boolean,
    onKill: () => void,
  ): SuccessDetectionEvent | null {
    // #772 — an errored result does NOT count as a successful re-run.
    // The success-keyed counter is keyed on repetition of a SUCCEEDING
    // call; a failing result is a different shape (the flaky-test retry
    // theory the ticket explicitly distinguishes).
    if (isError) {
      // An error on this fingerprint resets the counter for it: the
      // output CHANGED (from success to error), so a re-run is no longer
      // a pure re-run.
      successCounters.delete(fingerprint);
      return null;
    }

    const entry = successCounters.get(fingerprint);
    if (entry) {
      // This fingerprint has been seen before. If the result is
      // IDENTICAL to the last successful result, increment the counter
      // (nothing changed between invocations). If the result DIFFERS,
      // the state changed — reset the counter for this fingerprint.
      if (entry.lastResultText === resultText) {
        entry.count += 1;
        // Check thresholds (per-fingerprint, not global — each
        // fingerprint has its own steer/kill state).
        if (entry.count >= SUCCESS_KILL_AT && !entry.killed) {
          entry.killed = true;
          onKill();
          return {
            kind: "kill",
            tool: toolName,
            count: entry.count,
            fingerprint,
            successKeyed: true,
          };
        }
        if (entry.count >= SUCCESS_STEER_AT && !entry.steered && !entry.killed) {
          entry.steered = true;
          return {
            kind: "steer",
            tool: toolName,
            count: entry.count,
            text: successSteerText(toolName, entry.count),
            successKeyed: true,
          };
        }
      } else {
        // Output changed — reset the counter for this fingerprint.
        successCounters.delete(fingerprint);
      }
    } else {
      // First successful result for this fingerprint — record it.
      successCounters.set(fingerprint, {
        fingerprint,
        lastResultText: resultText,
        count: 1,
        steered: false,
        killed: false,
        firstTurn: nowTurn(),
      });
      // #772 lens-review — bounded: evict the OLDEST insertion past the cap.
      if (successCounters.size > SUCCESS_COUNTER_CAP) {
        const oldest = successCounters.keys().next().value as string | undefined;
        if (oldest !== undefined) successCounters.delete(oldest);
      }
    }
    return null;
  }

  return {
    recordFileMutation: (): void => {
      successCounters.clear();
    },
    observeResult,
    firedEvidence: (): SuccessCounterEntry | null => {
      // Most-severe-first: prefer the killed entry (highest count among
      // kills), else the steered entry with the highest count. A kill is
      // the worst thing the loop did — reporting a concurrent steer
      // instead would understate it. `loop-detector.ts`'s `current()`
      // does the stale-evidence check (count >= SUCCESS_STEER_AT) on top.
      let worstKill: SuccessCounterEntry | null = null;
      let worstSteer: SuccessCounterEntry | null = null;
      for (const entry of successCounters.values()) {
        if (entry.killed) {
          if (!worstKill || entry.count > worstKill.count) worstKill = entry;
        } else if (entry.steered) {
          if (!worstSteer || entry.count > worstSteer.count) worstSteer = entry;
        }
      }
      return worstKill ?? worstSteer ?? null;
    },
    entries: (): IterableIterator<SuccessCounterEntry> => successCounters.values(),
  };
}

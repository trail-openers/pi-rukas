/**
 * #546 AC4 — the opt-in soft turn-count nudge (~80 turns).
 *
 * Three long-dispatch subagents died mid-stream during the 2026-08-25/26
 * session (issue #546), each recoverable only from on-disk state. Recovery
 * worked every time (survey the worktree + resume dispatch with the full
 * contract), but it costs a full re-dispatch and depends on the PM noticing
 * a report that looks like partial success. The nudge is the cheap half of
 * the fix: at the turn count where a mid-stream death stops being surprising,
 * remind the child to keep its status current so the resume has something to
 * pick up.
 *
 * Calibration (module constants per the AC, not magic numbers):
 *   - `TURN_NUDGE_AT = 80` — every corpus death was far longer (95-min silent
 *     reviewer, 159-turn fix developer, 231-turn lens-mediums fix developer);
 *     every healthy short run in the same corpus ended with a structured
 *     summary well below 80 turns. 80 sits below the smallest observed death
 *     with margin, so the nudge is a no-op for the runs that were never at
 *     risk and lands before the first turn a death would have needed.
 *
 * Semantics — steer-only, by design:
 *   - It NEVER kills, never sets a `killCause`, and never arms a grace
 *     window: it is a reminder, not a bound, so it is exempt from the #543
 *     `capsOn` gating (master switch, ops-role exemption) entirely. A long
 *     ops run is where a status line is cheapest to write, so ops children
 *     get it too.
 *   - One steer per dispatch, at the FIRST turn ≥ the threshold — not once
 *     per threshold crossing, not on every turn after. The threshold is read
 *     per-call (like `loopDetectorEnabled`), so the env can change between
 *     construction and the turn that crosses it.
 *   - Delivery rides the existing #543 F2 `onSteer` seam (the same seam the
 *     F1 loop detector and F6 token budget use), tagged
 *     `"driver-turn-nudge"` so the scrollback line shows WHY the child was
 *     nudged. Callers without a job (lens / adversarial children bypass the
 *     registry) pass no `onSteer`, which makes the nudge a no-op there.
 *
 * Shipped DEFAULT-OFF: `PI_ENSEMBLE_TURN_NUDGE` unset/`0`/garbage → inert;
 * `1` → on at `TURN_NUDGE_AT`; an explicit number (e.g. `50`) → on at that
 * turn count (operator tuning without a code change).
 */

/**
 * The default nudge threshold in assistant turns.
 *
 * #546 calibration: every corpus mid-stream death (95-min silent solo
 * reviewer, 159-turn round-1 fix developer, 231-turn lens-mediums fix
 * developer) ran far longer than this; every healthy short run in the same
 * corpus ended with a structured summary well below it. 80 sits below the
 * smallest observed death with margin. Module constant per the AC — not a
 * magic number buried in the spawn path.
 */
export const TURN_NUDGE_AT = 80;

/**
 * The nudge threshold for a spawn, read per-call so tests can override the
 * env after module init.
 *
 *   - unset / `"0"` / non-numeric (other than `"1"`) → `0` = OFF (default).
 *   - `"1"` → `TURN_NUDGE_AT` (the calibrated default).
 *   - any other positive number → that many turns (operator tuning).
 */
export function turnNudgeAt(): number {
  const env = process.env.PI_ENSEMBLE_TURN_NUDGE;
  if (env === undefined || env === "0") return 0;
  if (env === "1") return TURN_NUDGE_AT;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The nudge threshold, read directly from `process.env` at call time.
 * Exported for the `spawn-caps.ts` closure, which must not call
 * `turnNudgeAt()` (its `process.env` read can be hoisted by Bun's TS
 * transpiler into a module-scope snapshot captured at construction time).
 * Same logic as `turnNudgeAt()` — this exists only to give the closure a
 * fresh read each turn.
 */
export function turnNudgeThreshold(): number {
  const env = process.env.PI_ENSEMBLE_TURN_NUDGE;
  if (env === undefined || env === "0") return 0;
  if (env === "1") return TURN_NUDGE_AT;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** True when the nudge is armed for a spawn (threshold > 0). */
export function turnNudgeEnabled(): boolean {
  return turnNudgeThreshold() > 0;
}

/**
 * The exact text the child reads at the threshold. Soft by construction:
 * it asks for a status write NOW (so a mid-stream death leaves something on
 * disk to resume from) but does not tell the child to stop working — that
 * is the F6 budget steer's message — and does not claim the work is complete
 * (per progress.ts's #299 note the assistant turn carrying a toolCall
 * completes BEFORE the tool executes, so "close to done" is the honest shape).
 */
export function turnNudgeText(turn: number): string {
  return `you have completed ${turn} turns. If you are close to done, write your status now (done / remaining / current state) so a resume can pick up from disk — keep going otherwise. This is a reminder, not a stop instruction.`;
}

/**
 * Spawn token-budget cap — the cumulative-token budget state for
 * `spawnSpecialist` (#543 F6, #952). Moved verbatim (comments included)
 * from spawn-support.ts to keep that module under the module-size
 * guideline (AGENTS.md §12); spawn-support.ts re-exports every symbol so
 * existing import sites are untouched.
 */

import type { SteerSource } from "./dispatch-steer.ts";
import { budgetSteerText } from "./progress.ts";

/**
 * #543 F6 — per-role cumulative token budget, read per-call so tests can
 * override. `PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>` where `<ROLE>` is the upper-cased
 * role name (e.g. `PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER`). Value is a TOTAL token
 * count (input + output + cacheRead + cacheWrite, accumulated per `message_end`
 * — the same sum `progress.ts` tracks). `0` / unset / non-numeric = OFF.
 *
 * EVERY ROLE SHIPS DEFAULT-OFF. #952 gave code-review-specialist a measured
 * default of 8 000 000 tokens (p95 = 4 104 877 over 1 073 lens children,
 * transcripts 2026-09-27…2026-10-01, 2× p95 rounded to 0.5 M). The operator
 * decision of 2026-10-20 (epic #1642) removed it, and it stays off for every
 * role. Three reasons, all measured:
 *
 * 1. **The sum is dominated by cache reads**, which a model re-bills on every
 *    turn of a long context. A lens that reads the same files forty times
 *    accrues tens of millions of tokens without doing anything wrong, so the
 *    number bounds the model's caching behaviour far more than its work.
 * 2. **The right number depends on the model AND the repository size** — qwen
 *    lens children measured 20–40 M tokens, mostly cache reads, and a large
 *    codebase moves the whole distribution up. A single constant is wrong for
 *    one of those combinations, and the measured p95 was one repo on one lineup.
 * 3. **A kill does not save the tokens it bounds.** A killed lens makes the
 *    six-pass review incomplete, which the driver reports as `review-incomplete`
 *    and the cycle re-runs: the capped spend is paid twice, plus the wall clock.
 *    The cap cost more than the thing it was meant to limit.
 *
 * A non-zero budget therefore remains an EXPLICIT opt-in ceiling — set
 * `PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>=<n>` to arm one, `0` / unset for none. The
 * budget is a secondary cost bound either way: the loop-detector (F1) is the
 * primary time/money stop, and it plus the inactivity watchdog stay untouched
 * because a STUCK reviewer is bounded regardless of what the ceiling is. When
 * the cumulative total does cross an armed budget, spawn steers the child to
 * wrap up, then kills after the grace window (see capKillGraceMs) with killCause
 * "token-budget". A child that exits cleanly inside the window is attributed
 * "token-budget" too (#1569, capKillAttribution): it stopped on the steer, not
 * because its assignment was done.
 */

/**
 * #952 — the env key for a role's token budget override, shared by
 * `tokenBudgetFor` (which reads it) and the token-budget kill attribution in
 * spawn-caps.ts (which names it in the operator-facing message). Hyphens in
 * the role name (code-review-specialist) map to underscores in the env key
 * (CODE_REVIEW_SPECIALIST) — a hyphenated name is not settable in the shell.
 */
export function tokenBudgetEnvKey(role: string): string {
  return `PI_ENSEMBLE_TOKEN_BUDGET_${role.toUpperCase().replaceAll("-", "_")}`;
}

export function tokenBudgetFor(role: string): number {
  const env = process.env[tokenBudgetEnvKey(role)];
  if (env === undefined) return 0;
  // Explicit value: "0" = off, and a non-numeric value is off rather than NaN.
  const n = Number(env);
  if (env.trim() === "" || !Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * #543 F1/F6 — grace window between a cap TRIGGER and the actual kill.
 *
 * A cap firing mid-long-tool-call discards in-progress work — the same
 * false-positive shape that killed #296's per-role wall-clock caps. The kill
 * is deferred while no new `message_end` arrives for up to this window (0
 * disables the deferral). Time-injectable in tests so the offline suite carries
 * no wall-clock hazard. `PI_ENSEMBLE_CAP_KILL_GRACE_MS`.
 */
export function capKillGraceMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 5 * 60_000;
}

/**
 * #543 F6 — per-spawn token-budget state, extracted from spawn.ts to keep it
 * under the module-size guideline. Holds the trigger/kill/steer state for the
 * cumulative-token cap. spawn.ts calls `check()` on every assistant
 * `message_end` and reads `killed` for kill-cause attribution.
 */
export class TokenBudgetTracker {
  private triggered = false;
  private killArmed = false;
  private steered = false;
  killed = false;
  /** When the kill was ARMED. The grace window is measured from HERE, not
   * from the last `message_end` — see `poll()`. */
  private killArmedAt = 0;
  private readonly budget: number;
  /** #544 — the grace window the tracker was armed with, snapshotted at
   * construction. Reading `capKillGraceMs()` again on every poll would let a
   * mid-spawn env mutation desync the token-budget window from the loop
   * detector's (createCapSession reads it once and passes it to both). */
  private readonly capKillGraceMs: number;
  private readonly onSteer?: (msg: string, source: SteerSource) => void;
  private readonly kill: () => void;
  private readonly tokens: () => number;

  constructor(
    role: string,
    onSteer: ((msg: string, source: SteerSource) => void) | undefined,
    kill: () => void,
    tokens: () => number,
    graceMs: number = capKillGraceMs(),
  ) {
    this.budget = tokenBudgetFor(role);
    this.onSteer = onSteer;
    this.kill = kill;
    this.tokens = tokens;
    this.capKillGraceMs = graceMs;
  }

  /** The budget the tracker was constructed with — the number its kill fired
   * on. Attribution (spawn-caps.ts capKillAttribution) must record THIS, not
   * a re-read of the env, which can differ if the env was mutated mid-spawn. */
  get budgetTokens(): number {
    return this.budget;
  }

  /**
   * #1569 — the budget was crossed, whether or not the kill landed. A child
   * that crosses it, gets the wrap-up steer and ends on its own inside the
   * grace window exits 0 before `poll()` can kill it; and tokens counted from
   * toolResult usage can cross it with no `message_end` left to call
   * `check()`. Either way the dispatch did not complete its assignment, so
   * attribution reads this rather than `killed` alone.
   */
  get exceeded(): boolean {
    return this.budget > 0 && (this.triggered || this.tokens() >= this.budget);
  }

  /** Called on every assistant message_end. Triggers the budget cap once. */
  check(now: number): void {
    if (this.budget <= 0 || this.triggered || this.killed) return;
    if (this.tokens() < this.budget) return;
    this.triggered = true;
    // One courtesy steer per dispatch per cap. Routes through the caller's
    // onSteer (dispatchCore wires it to steerChild → lifecycle 'steered').
    if (!this.steered && this.onSteer) {
      this.steered = true;
      try {
        this.onSteer(budgetSteerText(this.tokens(), this.budget), "driver-budget");
      } catch {
        /* child already gone — the kill below still fires */
      }
    }
    if (this.capKillGraceMs > 0) {
      this.killArmed = true;
      this.killArmedAt = now;
    } else {
      this.killed = true;
      this.kill();
    }
  }

  /**
   * Grace-window poll: kill once `capKillGraceMs` has elapsed since the budget
   * was crossed. The window is ABSOLUTE from the trigger — `message_end`
   * traffic does not defer it.
   *
   * The earlier shape deferred on the last `message_end`, and the spawn path
   * calls `onMessageEnd()` on every assistant turn — so a child that kept
   * producing turns reset the clock on every turn and the kill could never
   * fire. A budget-exceeded child is by definition chatty (each turn costs
   * tokens), which meant the ONLY child this cap was built to stop was the one
   * child it could not stop: the steer landed, the kill never did, and only
   * the 2 h backstop ended the run. Deferral made sense for the LOOP detector,
   * where new work means the loop may have ended and killing discards it; here
   * new turns ARE the violation, so there is nothing to preserve.
   */
  poll(): void {
    if (!this.killArmed || this.killed) return;
    if (Date.now() - this.killArmedAt >= this.capKillGraceMs) {
      this.killed = true;
      this.kill();
    }
  }
}

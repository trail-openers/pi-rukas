/**
 * Spawn token-budget cap — the cumulative-token budget state for
 * `spawnSpecialist` (#543 F6, #952). Moved verbatim (comments included)
 * from spawn-support.ts to keep that module under the module-size
 * guideline (AGENTS.md §12); spawn-support.ts re-exports every symbol so
 * existing import sites are untouched.
 */

import type { SteerSource } from "./dispatch-steer.ts";
import { budgetSteerText } from "./progress.ts";
import { CODE_REVIEW_SPECIALIST_ROLE } from "./roles.ts";

/**
 * #543 F6 — per-role cumulative token budget, read per-call so tests can
 * override. `PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>` where `<ROLE>` is the upper-cased
 * role name (e.g. `PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER`). Value is a TOTAL token
 * count (input + output + cacheRead + cacheWrite, accumulated per `message_end`
 * — the same sum `progress.ts` tracks). `0` / unset / non-numeric = OFF.
 *
 * #952 — code-review-specialist ships with a measured default of 8 000 000
 * tokens. Measurement: 1 073 lens children (≤150 turns) from
 * ~/.pi/agent/ensemble-runs transcripts dated 2026-09-27…2026-10-01,
 * p95 = 4 104 877 tokens; 2× p95 rounded to 0.5 M = 8 000 000.
 * The env override wins; `PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST=0`
 * disables it.
 *
 * All other roles ship DEFAULT-OFF (all 0 at ship). The budget is a secondary
 * cost bound: the loop-detector (F1) is the primary time/money stop. When the
 * cumulative total crosses the budget, spawn steers the child to wrap up, then
 * kills after the grace window (see capKillGraceMs) with killCause
 * "token-budget".
 */
const CODE_REVIEW_SPECIALIST_DEFAULT_BUDGET = 8_000_000;

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
  const envKey = tokenBudgetEnvKey(role);
  const env = process.env[envKey];
  // Set explicitly (including "0" = off, which must beat the default) or
  // non-numeric (off, never NaN): the env value wins.
  if (env !== undefined) {
    const n = Number(env);
    if (env.trim() === "" || !Number.isFinite(n) || n <= 0) return 0;
    return n;
  }
  if (role === CODE_REVIEW_SPECIALIST_ROLE) return CODE_REVIEW_SPECIALIST_DEFAULT_BUDGET;
  return 0;
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
  private lastMessageEndAt = 0;
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

  /** Called on every assistant message_end. Triggers the budget cap once. */
  check(now: number): void {
    if (this.budget <= 0 || this.triggered || this.killed) return;
    if (this.tokens() < this.budget) return;
    this.triggered = true;
    this.lastMessageEndAt = now;
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
    } else {
      this.killed = true;
      this.kill();
    }
  }

  /** Grace-window poll: kill once grace ms elapse with no new message_end. */
  poll(): void {
    if (!this.killArmed || this.killed) return;
    if (Date.now() - this.lastMessageEndAt >= this.capKillGraceMs) {
      this.killed = true;
      this.kill();
    }
  }

  /** A new turn while armed resets the grace clock. */
  onMessageEnd(now: number): void {
    if (this.triggered && !this.killed) this.lastMessageEndAt = now;
  }
}

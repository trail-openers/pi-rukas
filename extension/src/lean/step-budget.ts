/**
 * lean/step-budget — make a `.pi/work.json` budget real.
 *
 * One per-state ceiling becomes the three levers a dispatch has: **minutes** →
 * `childBoundMs`, whose kill arrives as `killCause: "child-bound"` and which
 * {@link armBudget}'s reader reports as the time limit, not as infrastructure;
 * **turns / tokens** → an `AbortController` armed off the child's progress stream,
 * so a runaway stops at a turn boundary. A breach is a VERDICT — the child worked
 * and the ceiling stopped it — so the step returns `{kind: "budget"}` to be routed,
 * asking {@link readDispatched} BEFORE its infra throw or the verdict becomes a
 * throw.
 */

import type { LensRunResult } from "../lens-review-types.ts";
import type { RunningState } from "../progress.ts";
import { capsEnabled } from "../spawn-child-bound.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchUsage } from "../types.ts";
import type { Budget, WorkConfig } from "./config.ts";
import { DISPATCHES_MAX_ROWS } from "./state-dispatches.ts";
import type { LeanState, Outcome } from "./state.ts";

/** Which ceiling was crossed, with what it was and what the child used. */
export interface BudgetFired {
  limit: "minutes" | "turns" | "tokens";
  value: number;
  used: number;
}

/**
 * The arms a dispatch accepts, a subset of `SpawnOptions`. `budgetTurns` is the turns ceiling
 * in its OWN field, not just an effect of the abort: `armChildBounds` reads it as the
 * denominator of the budget-progress steer, so the child is told "turn 20 of 40" and can close
 * out before the `signal` below ends it.
 */
export interface BudgetOpts {
  childBoundMs?: number;
  signal?: AbortSignal;
  onProgress?: (s: RunningState) => void;
  budgetTurns?: number;
}

/**
 * The cost of one dispatch, as the dispatching steps record it. `usage` is the child's own
 * report; `role`/`ms`/`ok` are what the step observed. Declared here, beside the budget arms a
 * dispatch already carries, so the row builders and the fold in `usage-sum.ts` read ONE type.
 */
export interface DispatchUsageRow {
  role: string;
  ms: number;
  ok: boolean;
  usage: DispatchUsage;
  /**
   * The disposable tree a fixer worked in, when this row IS a fixer's. An explicit optional
   * field, validated alongside `ms`: smuggling it by overwriting `ms` with a 13-digit epoch
   * cost the row its only duration, let the loader drop it as unmeasurable, and made the row
   * cap able to evict the very row carrying the id.
   */
  runId?: FixRunId;
}

/**
 * A fixer row's tree identity: decimal epoch milliseconds, as data. A string of digits rather
 * than a number, because a number is what `Number()` turns a malformed id into `NaN` on the way
 * into the durable record. Validated by `isRunId` in `state-outcome.ts`.
 */
export type FixRunId = string & { readonly __fixRunId: unique symbol };

/** `spawn-child-bound.ts` stamps this on a child the wall clock ended. */
const CHILD_BOUND_CAUSE = "child-bound";

/**
 * The one proof a seam hands back INSTEAD of a `DispatchResult` when the step's ceiling ended
 * the child. A module-private symbol, not a boolean field: data a child produces is forgeable,
 * so a replayed child result carrying a `leanBudgetStop: true` field became this step's budget
 * verdict. A symbol is reachable only through {@link budgetStop}.
 */
const STOP: unique symbol = Symbol("lean.budgetStop");

/** What a seam hands back: a child result, or the verdict built by {@link budgetStop}. */
export type BudgetStop = { readonly [STOP]: BudgetFired };

/** The only way to make a stop. Every seam builds its stop through this. */
export function budgetStop(fired: BudgetFired): BudgetStop {
  return { [STOP]: fired };
}

/**
 * What came back: the verdict, or the child's result. One reader for the two questions a step
 * asks of its seam — a pair of readers let a caller answer one and act on the other. `STOP in
 * r` is the discrimination and needs no cast.
 */
export function readDispatched(
  r: DispatchResult | BudgetStop,
): { stop: BudgetFired } | { result: DispatchResult } {
  if (STOP in r) return { stop: r[STOP] };
  return { result: r };
}

/** Elapsed minutes a wall-clock kill reports: at least one, never short. */
function minutesUsed(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * The typed trio a budget outcome must carry before any caller states it: `limit` named,
 * `value` and `used` numbers — or `undefined`, which is what a half-record reads as. Every
 * reader of a recorded breach goes through this one check.
 */
export function budgetTrio(oc: Outcome | undefined): BudgetFired | undefined {
  if (oc?.kind !== "budget") return undefined;
  const { limit, value, used } = oc;
  if (limit === undefined || typeof value !== "number" || typeof used !== "number")
    return undefined;
  return { limit, value, used };
}

/**
 * One budget line, the same words for all three levers. Every surface that prints a breach
 * reads it from here, so they cannot disagree about which lever fired. The trace sink is not
 * ours to trust, so the write is caught: a breach whose trace line throws still routes.
 */
function traceBreach(fired: BudgetFired, phrase: string): void {
  try {
    traceWarn(
      `lean budget: ${fired.limit} ${String(fired.value)} exceeded (used ${String(fired.used)}); ${phrase}`,
    );
  } catch {
    // A sink we cannot write to cannot be written to; nothing to say about it.
  }
}

/** The arms a step hands its dispatch seam: what the child gets, and the reader. */
export type BudgetArms = {
  opts: BudgetOpts;
  /**
   * The verdict this arm saw, or `undefined`. The turns/tokens hit the progress
   * hook froze, else the minutes lever inferred from a `child-bound` kill cause.
   */
  fired: (result: DispatchResult) => BudgetFired | undefined;
  /**
   * Set when {@link armBudget} armed a wall clock the runtime will not enforce (the caps
   * master switch is off), so the step can tell the operator rather than let a minutes budget
   * read as a bound that never fires.
   */
  warning?: string;
};

/**
 * Arm the three levers of one state's budget, or nothing when it has none.
 *
 * The `minutes` lever is `childBoundMs`, enforced by `spawn-child-bound.ts` — so the kill
 * lands AFTER that module's child-bound grace period and the child's reported `ms`
 * overshoots the ceiling. {@link minutesUsed} rounds that up.
 */
export function armBudget(b: Budget | undefined): BudgetArms {
  const minutes = b?.minutes ?? 0;
  const turns = b?.turns ?? 0;
  const tokens = b?.tokens ?? 0;
  const boundMs = minutes > 0 ? minutes * 60_000 : undefined;
  // Which limit ended the child, frozen at the FIRST breach: a later tick from the same child
  // must not rewrite which one it was.
  let hit: BudgetFired | undefined;
  let minutesTraced = false;
  const minutesBreach = (result: DispatchResult): BudgetFired => {
    const breach: BudgetFired = {
      limit: "minutes",
      value: minutes,
      used: minutesUsed(result.ms ?? 0),
    };
    // The one lever with no hook to trace it, so the reader says it out loud (all three steps
    // build their verdict from this reader). The flag is the dedupe.
    if (!minutesTraced) {
      minutesTraced = true;
      traceBreach(breach, "the child stopped at its bound");
    }
    return breach;
  };
  const fired = (result: DispatchResult): BudgetFired | undefined => {
    // A turns / tokens breach the hook already measured outranks anything the cause could be
    // read from: the hook froze which lever fired at the moment it fired.
    if (hit !== undefined) return hit;
    if (result.killCause !== CHILD_BOUND_CAUSE) return undefined;
    // The minutes lever, inferred from the cause `applyChildBound` stamps — or, when no wall
    // clock was armed, named by the turns / tokens signal.
    if (boundMs === undefined) {
      if (turns <= 0 && tokens <= 0) return undefined;
      return turns > 0
        ? { limit: "turns", value: turns, used: 0 }
        : { limit: "tokens", value: tokens, used: 0 };
    }
    return minutesBreach(result);
  };
  // The minutes lever is enforced by `armChildBound`, which returns early under
  // `PI_ENSEMBLE_DISPATCH_CAPS=0` — arming it there buys nothing, and reporting a budget stop
  // would describe a bound that was never live.
  const inert =
    boundMs !== undefined && !capsEnabled()
      ? `${String(minutes)}-minute budget is inert: PI_ENSEMBLE_DISPATCH_CAPS=0`
      : undefined;
  if (turns <= 0 && tokens <= 0) {
    return {
      opts: boundMs === undefined ? {} : { childBoundMs: boundMs },
      fired,
      ...(inert === undefined ? {} : { warning: inert }),
    };
  }
  const controller = new AbortController();
  // The trace lines are printed once per ARM, not per tick: the hook runs once per child turn,
  // so a broken snapshot would otherwise print hundreds of identical lines. Per arm rather
  // than per process, because a second dispatch is a different child and its hook failing is
  // news.
  let hookFailureTraced = false;
  // The trace sink is not ours to trust, and it sits on BOTH arms of this hook: a `traceWarn`
  // called from inside a `catch` escapes that `catch`, so every write goes through one
  // catcher. The record of a failure is worth less than the dispatch a throwing hook would cost.
  const traceOnce = (msg: string): void => {
    try {
      traceWarn(msg);
    } catch {
      // A sink we cannot write to cannot be written to; nothing to say about it.
    }
  };
  const traceHookFailureOnce = (err: unknown): void => {
    if (hookFailureTraced) return;
    hookFailureTraced = true;
    traceOnce(`lean budget: progress hook failed: ${(err as Error).message}`);
  };
  // `spawn.ts` calls this from its stdout handler, on the same tick it parses a child line: an
  // exception thrown here lands in the read loop and costs the dispatch. So nothing may escape
  // the body, and the ABORT comes BEFORE the trace. Only the reads of `s` are wrapped.
  const onProgress = (s: RunningState): void => {
    let breach: BudgetFired | undefined;
    try {
      if (hit !== undefined) return;
      if (turns > 0 && s.turns > turns) breach = { limit: "turns", value: turns, used: s.turns };
      else if (tokens > 0 && s.totalTokens > tokens)
        breach = { limit: "tokens", value: tokens, used: s.totalTokens };
    } catch (err) {
      traceHookFailureOnce(err);
      return;
    }
    if (breach === undefined) return;
    hit = breach;
    controller.abort();
    traceBreach(breach, "stopping the child");
  };
  return {
    opts: {
      ...(boundMs === undefined ? {} : { childBoundMs: boundMs }),
      signal: controller.signal,
      onProgress,
      // The steer's denominator, present only when a turns ceiling exists: a tokens-only
      // budget has no turns to count down to, and `armChildBounds` reads `<= 0` as no lever.
      ...(turns > 0 ? { budgetTurns: turns } : {}),
    },
    fired,
    ...(inert === undefined ? {} : { warning: inert }),
  };
}

/** The state's budget for this run, or `undefined` when it has none. */
export function budgetFor(cfg: WorkConfig, state: LeanState): Budget | undefined {
  return cfg.budgets[state];
}

/**
 * The one row a dispatching step records for one child it paid for. Every lean dispatch
 * becomes a row — the child that finished, the one the budget stopped, and the one whose
 * transport died all spent tokens before anybody knew. `ms` and `usage` are what the child
 * reported (a child that never started reports neither, which reads as zero cost — the
 * truth); `ok` is the step's own judgement: a child that exited 0 with a kill cause or a
 * provider error did not succeed.
 */
export function dispatchUsageRow(result: DispatchResult): DispatchUsageRow {
  return {
    role: result.role,
    ms: result.ms ?? 0,
    ok: result.ok && result.killCause === undefined && result.errorStop === undefined,
    usage: result.usage ?? zeroDispatchUsage(),
  };
}

/** A child that reported nothing cost nothing that anybody observed. */
function zeroDispatchUsage(): DispatchUsageRow["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * The role the six lens children report under, and the fixer's role. Both live here, beside
 * the row that carries them, because the row's `role` is what `leanUsage` folds `byRole` on
 * and a role spelled at a write site and again at a reader is how the two engines start
 * disagreeing about who paid for what.
 */
export const LENS_ROLE = "code-review-specialist";
export const FIXER_ROLE = "developer";

/**
 * One six-lens round's cost, as one row per lens child that ran — NOT one synthetic row for
 * the round. A round collapsed to one row loses five children's wall clock and halves the
 * child count a host compares against the frozen driver's per-lens events. A lens that
 * reported no usage is billed a zero row rather than dropped.
 */
export function lensRows(lenses: LensRunResult[]): DispatchUsageRow[] {
  return lenses.map((lens) => ({
    role: LENS_ROLE,
    // `ms` is what the lens took; a child that died mid-spawn reported none, and zero is the
    // honest "nobody measured it".
    ms: lens.ms,
    // `blocked` is a lens that never ran; `killCause` is the dispatch-cap kill. Neither is a
    // review that happened, and a cost record that said otherwise priced the next run wrong.
    ok: lens.ok && lens.blocked !== true && lens.killCause === undefined,
    usage: lens.usage ?? zeroDispatchUsage(),
  }));
}

/**
 * The one budget sentence, rendered from the typed trio. Every surface that prints a breach
 * reads it from here: the verdict's `reason`, `lean/handback.ts`'s cause, and the headless
 * result's `failure.message`.
 */
export function budgetSentence(state: LeanState, fired: BudgetFired): string {
  return `${state} stopped: ${fired.limit} budget ${String(fired.value)} exceeded (used ${String(fired.used)})`;
}

/**
 * The verdict for a step that ran out of budget, not out of ideas. Callers ask
 * {@link readDispatched} before their infra throw, or this never gets to route.
 */
function budgetVerdict(state: LeanState, fired: BudgetFired): Outcome {
  return {
    kind: "budget",
    limit: fired.limit,
    value: fired.value,
    used: fired.used,
    reason: budgetSentence(state, fired),
  };
}

/**
 * The budget verdict carrying the rows of every dispatch the step paid for.
 *
 * Same sentence as {@link budgetVerdict}, with the cost rows attached, so a stopped round's
 * tokens reach the host instead of vanishing with the child.
 *
 * Clipped to the validator's own cap keeping the NEWEST. The bound belongs HERE and not at
 * the caller: `dispatchesProblem` refuses the whole array over the cap, so an unbounded verdict
 * is not a clipped record but no record — the run would report a stopped round that cost
 * nothing.
 */
export function budgetVerdictWithRows(
  state: LeanState,
  fired: BudgetFired,
  rows: DispatchUsageRow[],
): Outcome {
  const verdict = budgetVerdict(state, fired);
  return rows.length === 0 ? verdict : { ...verdict, dispatches: rows.slice(-DISPATCHES_MAX_ROWS) };
}

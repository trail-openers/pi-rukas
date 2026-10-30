/**
 * lean/step-budget — make a `.pi/work.json` budget real (#1883).
 *
 * `WorkConfig.budgets` carried per-state ceilings and nothing read it. One
 * becomes the three levers a dispatch has: **minutes** → `childBoundMs`, whose
 * kill arrives as `killCause: "child-bound"` and which {@link armBudget}'s
 * reader reports as the time limit, not as infrastructure; **turns / tokens** →
 * an `AbortController` armed off the child's progress stream, so a runaway stops
 * at a turn boundary. A breach is a VERDICT — the child worked and the ceiling
 * stopped it, like `exhausted` — so the step returns `{kind: "budget"}` to be
 * routed, asking {@link readDispatched} BEFORE its infra throw or the verdict
 * becomes a throw.
 */

import type { RunningState } from "../progress.ts";
import { capsEnabled } from "../spawn-child-bound.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import type { Budget, WorkConfig } from "./config.ts";
import type { LeanState, Outcome } from "./state.ts";

/** Which ceiling was crossed, with what it was and what the child used. */
export interface BudgetFired {
  limit: "minutes" | "turns" | "tokens";
  value: number;
  used: number;
}

/** The three arms a dispatch accepts, a subset of `SpawnOptions`. */
export interface BudgetOpts {
  childBoundMs?: number;
  signal?: AbortSignal;
  onProgress?: (s: RunningState) => void;
}

/** `spawn-child-bound.ts` stamps this on a child the wall clock ended. */
const CHILD_BOUND_CAUSE = "child-bound";

/**
 * The one proof a seam hands back INSTEAD of a `DispatchResult` when the step's
 * ceiling ended the child.
 *
 * A module-private symbol, not a boolean field: a field — `leanBudgetStop: true`
 * in the first version of this seam — is data, and data a child produces is
 * forgeable. A dispatch seam returns whatever its `dispatch` function hands it,
 * so a JSON payload or a replayed child result that happened to carry the field
 * became this step's budget verdict and routed the run to handback for a ceiling
 * that never fired. A symbol is reachable only through {@link budgetStop}, which
 * nobody outside this module can call: `JSON.parse` cannot mint one and neither
 * can a child.
 */
const STOP: unique symbol = Symbol("lean.budgetStop");

/** What a seam hands back: a child result, or the verdict built by {@link budgetStop}. */
export type BudgetStop = { readonly [STOP]: BudgetFired };

/** The only way to make a stop. Every seam builds its stop through this. */
export function budgetStop(fired: BudgetFired): BudgetStop {
  return { [STOP]: fired };
}

/**
 * What came back: the verdict, or the child's result.
 *
 * One reader for the two questions a step asks of its seam — the pair it
 * replaces (`budgetStopOf` then `toolUsesOf`) let a caller answer one and act on
 * the other, and the `as` casts both needed were exactly where a forged `fired`
 * slipped through. `STOP in r` is the discrimination and needs no cast: an object
 * that did not come from {@link budgetStop} is a result, whatever it carries.
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

/** The arms a step hands its dispatch seam: what the child gets, and the reader. */
export type BudgetArms = {
  opts: BudgetOpts;
  /**
   * The verdict this arm saw, or `undefined`. The turns/tokens hit the progress
   * hook froze, else the minutes lever inferred from a `child-bound` kill cause.
   */
  fired: (result: DispatchResult) => BudgetFired | undefined;
  /**
   * Set when {@link armBudget} armed a wall clock that the runtime will not
   * enforce (the caps master switch is off), so the step can tell the operator
   * rather than let a minutes budget read as a bound that never fires.
   */
  warning?: string;
};

/**
 * Arm the three levers of one state's budget, or nothing when it has none.
 *
 * The `minutes` lever is `childBoundMs`, enforced by `spawn-child-bound.ts` — which means the kill lands AFTER that module's child-bound grace period, so the
 * child's reported `ms` overshoots the ceiling by the grace and by whatever the
 * OS took to tear the tree down. {@link minutesUsed} rounds that up: a bound of
 * 20 minutes never reports a child killed at 19:59 as having used 19.
 */
/**
 * The trace line of a hook failure is printed once per process, not per tick (the
 * hook is called once per child turn, so a broken snapshot would otherwise print
 * hundreds of identical lines into the child's stderr).
 */
let hookFailureTraced = false;
function traceHookFailureOnce(err: unknown): void {
  if (hookFailureTraced) return;
  hookFailureTraced = true;
  traceWarn(`lean budget: progress hook failed: ${(err as Error).message}`);
}

/**
 * Arm the three levers of one state's budget, or nothing when it has none.
 *
 * The `minutes` lever is `childBoundMs`, enforced by `spawn-child-bound.ts` — so
 * the kill lands AFTER that module's child-bound grace period (`childBoundGraceMs`)
 * and the child's reported `ms` overshoots the ceiling by that grace plus whatever
 * the OS took to tear the tree down. {@link minutesUsed} rounds that up: a
 * 20-minute bound never reports a child killed at 19:59 as having used 19.
 */
export function armBudget(b: Budget | undefined): BudgetArms {
  const minutes = b?.minutes ?? 0;
  const turns = b?.turns ?? 0;
  const tokens = b?.tokens ?? 0;
  const boundMs = minutes > 0 ? minutes * 60_000 : undefined;
  // Which limit ended the child, frozen at the FIRST breach: a later tick from
  // the same child must not rewrite which one it was.
  let hit: BudgetFired | undefined;
  const fired = (result: DispatchResult): BudgetFired | undefined =>
    hit ??
    (boundMs !== undefined && result.killCause === CHILD_BOUND_CAUSE
      ? { limit: "minutes", value: minutes, used: minutesUsed(result.ms ?? 0) }
      : undefined);
  // The minutes lever is enforced by `armChildBound`, which returns early under
  // `PI_ENSEMBLE_DISPATCH_CAPS=0` — so arming it there buys nothing, and a step
  // that reports "the 20-minute budget stopped it" would be describing a bound
  // that was never live. Say so instead of staying quiet.
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
  // `spawn.ts` calls this from its stdout handler, on the same tick it parses a
  // child line: an exception thrown here lands in the read loop, not in the step,
  // and costs the dispatch. So the body is wrapped — a budget that cannot report
  // itself must never take the child down with it — and the failure is traced once
  // (`traceHookFailureOnce`) rather than once per tick. The breach itself is traced
  // AT THE BREACH: a stopped child whose log says nothing about why leaves the next
  // reader guessing whether the budget or the harness ended it.
  const onProgress = (s: RunningState): void => {
    try {
      if (hit !== undefined) return;
      if (turns > 0 && s.turns > turns) hit = { limit: "turns", value: turns, used: s.turns };
      else if (tokens > 0 && s.totalTokens > tokens)
        hit = { limit: "tokens", value: tokens, used: s.totalTokens };
      if (hit === undefined) return;
      traceWarn(
        `lean budget: ${hit.limit} ${String(hit.value)} exceeded (used ${String(hit.used)}); stopping the child`,
      );
      controller.abort();
    } catch (err) {
      traceHookFailureOnce(err);
    }
  };
  return {
    opts: {
      ...(boundMs === undefined ? {} : { childBoundMs: boundMs }),
      signal: controller.signal,
      onProgress,
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
 * The verdict for a step that ran out of budget, not out of ideas. Callers ask
 * {@link readDispatched} before their infra throw, or this never gets to route.
 */
export function budgetVerdict(state: LeanState, fired: BudgetFired): Outcome {
  return {
    kind: "budget",
    limit: fired.limit,
    value: fired.value,
    used: fired.used,
    reason: `${state} stopped: ${fired.limit} budget ${fired.value} exceeded (used ${fired.used})`,
  };
}

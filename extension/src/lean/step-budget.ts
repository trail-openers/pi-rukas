/**
 * lean/step-budget — make a `.pi/work.json` budget real (#1883).
 *
 * `WorkConfig.budgets` carried per-state ceilings and nothing read it. One
 * becomes the three levers a dispatch has: **minutes** → `childBoundMs`, whose
 * kill arrives as `killCause: "child-bound"` and which `fired()` reads as the
 * time limit, not as infrastructure; **turns / tokens** → an `AbortController`
 * armed off the child's progress stream, so a runaway stops at a turn boundary.
 * A breach is a VERDICT — the child worked and the ceiling stopped it, like
 * `exhausted` — so the step returns `{kind: "budget"}` to be routed, asking
 * {@link budgetStopOf} BEFORE its infra throw or the verdict becomes a throw.
 */

import type { RunningState } from "../progress.ts";
import type { DispatchResult } from "../types.ts";
import type { Budget, WorkConfig } from "./config.ts";
import type { Outcome } from "./state.ts";

/** Which ceiling was crossed, with what it was and what the child used. */
export interface BudgetFired {
  limit: "minutes" | "turns" | "tokens";
  value: number;
  used: number;
}

/** `spawn-child-bound.ts` stamps this on a child the wall clock ended. */
const CHILD_BOUND_CAUSE = "child-bound";

/** The three arms a dispatch accepts, a subset of `SpawnOptions`. */
export interface BudgetOpts {
  childBoundMs?: number;
  signal?: AbortSignal;
  onProgress?: (s: RunningState) => void;
}

/** The arms a step hands its dispatch seam: what the child gets, and the reader. */
export type BudgetArms = {
  opts: BudgetOpts;
  fired: (result: DispatchResult) => BudgetFired | undefined;
  /**
   * Set when {@link armBudget} armed a wall clock that the runtime will not
   * enforce (the caps master switch is off), so the step can tell the operator
   * rather than let a minutes budget read as a bound that never fires.
   */
  warning?: string;
};

/** The state's budget for this run, or `undefined` when it has none. */
export function budgetFor(cfg: WorkConfig, state: string): Budget | undefined {
  return cfg.budgets[state];
}

/** The options that enforce `b`, plus the reader for what happened. */
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
      ? { limit: "minutes", value: minutes, used: Math.round((result.ms ?? 0) / 60_000) }
      : undefined);
  // The minutes lever is enforced by `armChildBound`, which returns early under
  // `PI_ENSEMBLE_DISPATCH_CAPS=0` — so arming it there buys nothing, and a step
  // that reports "the 20-minute budget stopped it" would be describing a bound
  // that was never live. Say so instead of staying quiet.
  const inert =
    boundMs !== undefined && process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0"
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
  return {
    opts: {
      ...(boundMs === undefined ? {} : { childBoundMs: boundMs }),
      signal: controller.signal,
      onProgress: (s: RunningState) => {
        if (hit !== undefined) return;
        if (turns > 0 && s.turns > turns) hit = { limit: "turns", value: turns, used: s.turns };
        else if (tokens > 0 && s.totalTokens > tokens)
          hit = { limit: "tokens", value: tokens, used: s.totalTokens };
        if (hit !== undefined) controller.abort();
      },
    },
    fired,
    ...(inert === undefined ? {} : { warning: inert }),
  };
}

/**
 * What a seam returns INSTEAD of a `DispatchResult` when the step's ceiling ended
 * the child. The tag is what makes the two distinguishable at RUNTIME: the seams
 * build it as `{ fired, leanBudgetStop: true }`, and {@link budgetStopOf} reads a
 * stop only on `leanBudgetStop === true`. The compile-time distinction alone is
 * not enough — a dispatch seam returns whatever its `dispatch` function hands it,
 * so a child result that happens to carry a `fired` key would otherwise be read
 * as this step's budget verdict and routed as one.
 */
export type BudgetStop = { readonly fired: BudgetFired } & {
  readonly leanBudgetStop: true;
};

/**
 * Did the step's own ceiling end this child? Only a positively tagged stop
 * answers; a child result carrying `fired` is not one and reads as `undefined`.
 */
export function budgetStopOf(result: Dispatched): BudgetFired | undefined {
  const stop = result as BudgetStop | undefined;
  return stop?.leanBudgetStop === true ? stop.fired : undefined;
}

/** What a seam hands back: a child result, or the verdict. */
export type Dispatched = DispatchResult | BudgetStop | { readonly toolUses?: unknown[] };

/** The child's tool-use log, once a breach is ruled out; two steps read it. */
export function toolUsesOf(result: Dispatched): unknown[] {
  return (result as DispatchResult).toolUses ?? [];
}

/**
 * The verdict for a step that ran out of budget, not out of ideas. Callers ask
 * {@link budgetStopOf} before their infra throw, or this never gets to route.
 */
export function budgetVerdict(state: string, fired: BudgetFired): Outcome {
  return {
    kind: "budget",
    limit: fired.limit,
    value: fired.value,
    used: fired.used,
    reason: `${state} stopped: ${fired.limit} budget ${fired.value} exceeded (used ${fired.used})`,
  };
}

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
import type { DispatchResult, DispatchUsage } from "../types.ts";
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

/**
 * The cost of one dispatch, as the dispatching steps record it (#1920 A).
 *
 * `usage` is the child's own report — `DispatchUsage`, the same shape the
 * headless result sums — and `role`/`ms`/`ok` are what the step observed about
 * the dispatch. Declared here, beside the budget arms a dispatch already
 * carries, so the three sites that build a row and the fold in `usage-sum.ts`
 * read ONE type: `state.ts` cannot import this module (its budget trio lives
 * here) and a duplicated shape in two files is how the two engines start
 * disagreeing about what "cost" means.
 */
export interface DispatchUsageRow {
  role: string;
  ms: number;
  ok: boolean;
  usage: DispatchUsage;
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

/**
 * The typed trio a budget outcome must carry before any caller states it.
 *
 * `limit` named, `value` and `used` numbers — or `undefined`, which is what a
 * half-record reads as. Every reader of a recorded breach (the handback's cause,
 * the publish body's challenge line) goes through this one check, so a record
 * that one of them would print is one they all would.
 */
export function budgetTrio(oc: Outcome | undefined): BudgetFired | undefined {
  if (oc?.kind !== "budget") return undefined;
  const { limit, value, used } = oc;
  if (limit === undefined || typeof value !== "number" || typeof used !== "number")
    return undefined;
  return { limit, value, used };
}

/**
 * One budget line, the same words for all three levers.
 *
 * The turns/tokens breach traces itself from inside the progress hook — the only
 * place that sees it live ("stopping the child") — and the minutes breach is
 * traced by the reader in {@link armBudget}, which is where the inferred stop
 * first becomes a verdict, after the child has already stopped ("the child
 * stopped at its bound"). Before #1883-followed the minutes path printed nothing,
 * so a wall-clock stop was indistinguishable in a child log from any other way a
 * round ended. Callers must already be past their abort; the sink is not ours to
 * trust, so the write is caught: a breach whose trace line throws still routes.
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
   * Set when {@link armBudget} armed a wall clock that the runtime will not
   * enforce (the caps master switch is off), so the step can tell the operator
   * rather than let a minutes budget read as a bound that never fires.
   */
  warning?: string;
};

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
  let minutesTraced = false;
  const fired = (result: DispatchResult): BudgetFired | undefined => {
    if (hit !== undefined) return hit;
    if (boundMs === undefined || result.killCause !== CHILD_BOUND_CAUSE) return undefined;
    // The inferred minutes breach — the one lever with no hook to trace it, so
    // the reader says it out loud (the three steps all build their verdict from
    // this reader, so one line here covers specify, build and challenge). The
    // flag is the dedupe: one stop is one line, however often a step re-reads
    // the same child.
    const breach: BudgetFired = {
      limit: "minutes",
      value: minutes,
      used: minutesUsed(result.ms ?? 0),
    };
    if (!minutesTraced) {
      minutesTraced = true;
      traceBreach(breach, "the child stopped at its bound");
    }
    return breach;
  };
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
  // The trace lines are printed once per ARM, not per tick: the hook runs once
  // per child turn, so a broken snapshot would otherwise print hundreds of
  // identical lines into the child's stderr. Per arm rather than per process,
  // because a second dispatch is a different child and its hook failing is news.
  let hookFailureTraced = false;
  // The trace sink is not ours to trust, and it sits on BOTH arms of this hook: a
  // breach traces itself, and a hook failure is reported by tracing. Left as-is
  // that is a throw path with no catcher — a `traceWarn` called from inside a
  // `catch` escapes that `catch`, because a catch block's own throws are not
  // caught by it (measured: the throw left `onProgress` and landed in `spawn.ts`'s
  // stdout handler, costing the dispatch). So every write goes through one catcher.
  // A failure to trace leaves no line, which is the right trade against a hook that
  // can cost the child: the record of a failure is worth less than the dispatch
  // destroying it would cost, and the abort — what the hook exists to do — has
  // already landed by then.
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
  // `spawn.ts` calls this from its stdout handler, on the same tick it parses a
  // child line: an exception thrown here lands in the read loop, not in the step,
  // and costs the dispatch. So nothing may escape the body, and the ABORT comes
  // BEFORE the trace — the log line is the nice-to-have, and a breach whose trace
  // throws must still stop the child. Only the reads of `s` are wrapped, so a
  // malformed snapshot is reported and returns without claiming a breach it never
  // measured (and without aborting a child that is inside its ceiling).
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
 * The one row a dispatching step records for one child it paid for.
 *
 * Every lean dispatch becomes a row — the child that finished, the child the
 * budget stopped, and the child whose transport died all spent tokens before
 * anybody knew, so the step that owns the dispatch builds its row through here
 * rather than three sites inventing three shapes. `ms` and `usage` are what the
 * child reported (a killed child still reports both, and a child that never
 * started reports neither, which reads as zero cost — the truth); `ok` is the
 * step's own judgement, and is deliberately NOT `result.ok` alone: a child that
 * exited 0 with a kill cause or a provider error did not succeed.
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

/**
 * The budget verdict carrying the rows of every dispatch the step paid for.
 *
 * Same sentence as {@link budgetVerdict} — the reason text is what the operator
 * is taught to read — with the cost rows attached, so a stopped round's tokens
 * reach the host instead of vanishing with the child.
 */
export function budgetVerdictWithRows(
  state: LeanState,
  fired: BudgetFired,
  rows: DispatchUsageRow[],
): Outcome {
  const verdict = budgetVerdict(state, fired);
  return rows.length === 0 ? verdict : { ...verdict, dispatches: rows };
}

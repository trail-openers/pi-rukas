/**
 * lean/step-budget — make a `.pi/work.json` budget real.
 *
 * A per-state ceiling becomes four levers: **minutes** → `childBoundMs`, whose kill arrives as
 * `killCause: "child-bound"`; **turns / tokens / stall** → one `AbortController` off the progress stream.
 * A breach is
 * a VERDICT — the child worked and the ceiling stopped it — so the step returns `{kind: "budget"}` to be
 * routed by the table. Only a turns / tokens breach may be named from a `child-bound` cause, and never
 * the stall lever: that abort is measured in the stream, frozen in {@link BudgetArms.fired} at the tick
 * it happened, and a cause the wall clock stamped is not a stall this arm observed. Callers ask {@link readDispatched} BEFORE their infra throw: a stop read as an infra
 * failure never reaches the routing and the run loses the cause the ceiling produced.
 */

import type { LensRunResult } from "../lens-review-types.ts";
import type { RunningState } from "../progress.ts";
import {
  type BudgetLimit,
  type StallArms,
  type StallOpts,
  type StreamSilence,
  requestStallUnarmed,
  stallLever,
  stallMinutes,
} from "../request-stall-policy.ts";
import { capsEnabled } from "../spawn-child-bound.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchUsage } from "../types.ts";
import type { Budget, WorkConfig } from "./config.ts";
import { DISPATCHES_MAX_ROWS } from "./state-dispatches.ts";
import type { LeanState, Outcome } from "./state.ts";

/** Which ceiling was crossed, with what it was and what the child used. */
export interface BudgetFired {
  limit: BudgetLimit;
  value: number;
  used: number;
}

/**
 * The arms a dispatch accepts, a subset of `SpawnOptions`. `budgetTurns` is the turns ceiling in its own
 * field: `armChildBounds` reads it as the denominator of the budget-progress steer.
 */
export interface BudgetOpts {
  childBoundMs?: number;
  signal?: AbortSignal;
  onProgress?: (s: RunningState) => void;
  budgetTurns?: number;
  /** #2644: quiet this long with nothing in flight is a hung request (#951). */
  stall?: StallOpts;
}

/**
 * The cost of one dispatch, as the dispatching steps record it. `usage` is the child's report;
 * `role`/`ms`/`ok` are what the step observed.
 *
 * `stopReason` is the child's OWN last-turn stop reason, so a record shows a cut child after the
 * session file is gone: a review fixer that ran out of output tokens is otherwise indistinguishable
 * in the step log from one that finished its work and chose not to edit. Recording is not behaviour —
 * it is NOT behind the truncation-reask switch, so the field is present on both arms of that knob.
 */
export interface DispatchUsageRow {
  role: string;
  ms: number;
  ok: boolean;
  usage: DispatchUsage;
  /** The disposable tree a fixer worked in, when this row IS a fixer's. */
  runId?: FixRunId;
  /** The last assistant turn's stop reason, as the child's replay recorded it. Absent when nobody
   *  recorded one — which is not the same fact as the turn having ended cleanly. */
  stopReason?: string;
}

/**
 * A fixer row's tree identity: decimal epoch milliseconds, as DATA — a number is what `Number()` turns a
 * malformed id into `NaN` before it reaches the durable record. Validated by `isRunId`.
 */
export type FixRunId = string & { readonly __fixRunId: unique symbol };

/** `spawn-child-bound.ts` stamps this on a child the wall clock ended. */
const CHILD_BOUND_CAUSE = "child-bound";

/**
 * The proof a seam hands back INSTEAD of a `DispatchResult` when the ceiling ended the child. A
 * module-private symbol, not a boolean field: a replayed child result carrying a boolean marker would
 * become the step's verdict.
 */
const STOP: unique symbol = Symbol("lean.budgetStop");

/** What a seam hands back: a child result, or the verdict built by {@link budgetStop}. */
export type BudgetStop = { readonly [STOP]: BudgetFired };

/** The only way to make a stop. Every seam builds its stop through this. */
export function budgetStop(fired: BudgetFired): BudgetStop {
  return { [STOP]: fired };
}

/** What came back: the verdict, or the child's result. One reader for both questions. */
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

/** The typed trio a budget outcome must carry before any caller states it. */
export function budgetTrio(oc: Outcome | undefined): BudgetFired | undefined {
  if (oc?.kind !== "budget") return undefined;
  const { limit, value, used } = oc;
  if (limit === undefined || typeof value !== "number" || typeof used !== "number")
    return undefined;
  return { limit, value, used };
}

/** One budget line, the same words for all three levers. The trace sink is caught: not ours to trust. */
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
   * The verdict this arm saw: the turns/tokens the progress hook froze, else the minutes lever inferred
   * from a `child-bound` kill cause. A `child-bound` cause names a wall clock, so it never names the
   * stall lever — that one is only ever what `onProgress` froze in `hit`. See {@link stallWindowMinutes}
   * for what a sibling child's own bound reports under a stall-only arm.
   */
  fired: (result: DispatchResult) => BudgetFired | undefined;
  /** Set when a wall clock was armed that the runtime will not enforce (`PI_ENSEMBLE_DISPATCH_CAPS=0`). */
  warning?: string;
  /** #2644 — the frozen window of the stall lever THIS arm armed, in the whole minutes its verdict
   *  prints; `undefined` when it armed none. The value `opts.stall.windowMinutes` already carries, on
   *  the type the dispatch seams destructure (`BudgetOpts` has no such field), so a sibling child the
   *  wall clock ended under a stall-only arm can name its own bound instead of reading back a stall
   *  the step's `fired()` never measured — see `runFixer` in `review-fix-child.ts`. */
  stallWindowMinutes?: number;
};

/**
 * Arm the levers of one state's budget, or nothing when it has none.
 *
 * The `minutes` lever is `childBoundMs`, enforced by `spawn-child-bound.ts` — the kill lands AFTER its
 * grace period and the reported `ms` overshoots, so {@link minutesUsed} rounds up. The `stall` lever
 * aborts through the same controller as turns / tokens and reads back as a `budget` verdict, so a
 * hung request is never a user cancel.
 */
export function armBudget(b: Budget | undefined, stall?: StallArms): BudgetArms {
  const minutes = b?.minutes ?? 0;
  const turns = b?.turns ?? 0;
  const tokens = b?.tokens ?? 0;
  const boundMs = minutes > 0 ? minutes * 60_000 : undefined;
  // Frozen HERE: a running child's bound must not move with a later clock read.
  const stallOpts = stallLever(stall?.windowMs, stall?.silence);
  // Which limit ended the child, frozen at the FIRST breach: a later tick must not rewrite it.
  let hit: BudgetFired | undefined;
  let minutesTraced = false;
  const minutesBreach = (result: DispatchResult): BudgetFired => {
    const breach: BudgetFired = {
      limit: "minutes",
      value: minutes,
      used: minutesUsed(result.ms ?? 0),
    };
    // The one lever with no hook to trace it, so the reader says it out loud. The flag dedupes.
    if (!minutesTraced) {
      minutesTraced = true;
      traceBreach(breach, "the child stopped at its bound");
    }
    return breach;
  };
  const fired = (result: DispatchResult): BudgetFired | undefined => {
    // A turns / tokens / stall breach the hook measured outranks anything read from the cause.
    if (hit !== undefined) return hit;
    if (result.killCause !== CHILD_BOUND_CAUSE) return undefined;
    // The minutes lever, inferred from the cause `applyChildBound` stamps — or, when no wall clock was
    // armed, named by a lever's own signal. The stall lever's abort rides the SAME controller as turns
    // / tokens, so it is NOT one of those signals: a `child-bound` cause is a wall clock that killed
    // the child (this arm's bound, a sibling bound tighter than it, or the stub `adversarial-phase.ts`
    // leaves on a child it refused to buy). The lever measured its own breach in `onProgress` and froze
    // it in `hit`, which `hit !== undefined` above already returned; reading a bound kill as a stall
    // would print a verdict this code never measured.
    if (boundMs === undefined) {
      if (turns <= 0 && tokens <= 0) return undefined;
      return turns > 0
        ? { limit: "turns", value: turns, used: 0 }
        : { limit: "tokens", value: tokens, used: 0 };
    }
    return minutesBreach(result);
  };
  // `armChildBound` returns early under `PI_ENSEMBLE_DISPATCH_CAPS=0` — arming it there buys nothing.
  // The stall lever's inertness rides the SAME warning instead of going quiet per step.
  const inert =
    [
      ...(boundMs !== undefined && !capsEnabled()
        ? [`${String(minutes)}-minute budget is inert: PI_ENSEMBLE_DISPATCH_CAPS=0`]
        : []),
      ...(stall?.deadlineMs === undefined || stall.now === undefined
        ? []
        : [requestStallUnarmed(stall.deadlineMs, stall.now) ?? ""]),
    ]
      .filter(Boolean)
      .join("; ") || undefined;
  if (turns <= 0 && tokens <= 0 && stallOpts === undefined) {
    return {
      opts: boundMs === undefined ? {} : { childBoundMs: boundMs },
      fired,
      ...(inert === undefined ? {} : { warning: inert }),
    };
  }
  const controller = new AbortController();
  // The trace lines print once per ARM, not per tick: the hook runs once per child turn.
  let hookFailureTraced = false;
  // The sink sits on BOTH arms of this hook, so every write goes through one catcher.
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
  // `spawn.ts` calls this from its stdout handler on the same tick it parses a child line: an exception
  // here costs the dispatch. Nothing may escape, and the ABORT comes BEFORE the trace.
  const onProgress = (s: RunningState): void => {
    let breach: BudgetFired | undefined;
    try {
      if (hit !== undefined) return;
      if (turns > 0 && s.turns > turns) breach = { limit: "turns", value: turns, used: s.turns };
      else if (tokens > 0 && s.totalTokens > tokens)
        breach = { limit: "tokens", value: tokens, used: s.totalTokens };
      // The stall lever, on the SAME tick: a tool in flight is work, not silence, so it is never a
      // stall (#951); the window rides in the minutes the verdict prints so the two cannot disagree.
      else if (stallOpts !== undefined) {
        const quiet = stallOpts.silence();
        if (!quiet.toolInFlight && quiet.sinceMs >= stallOpts.windowMinutes * 60_000)
          breach = {
            limit: "stall",
            value: stallOpts.windowMinutes,
            used: stallMinutes(quiet.sinceMs),
          };
      }
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
      // The steer's denominator, present only when a turns ceiling exists.
      ...(turns > 0 ? { budgetTurns: turns } : {}),
      ...(stallOpts === undefined ? {} : { stall: stallOpts }),
    },
    fired,
    ...(stallOpts === undefined ? {} : { stallWindowMinutes: stallOpts.windowMinutes }),
    ...(inert === undefined ? {} : { warning: inert }),
  };
}

/** The state's budget for this run, or `undefined` when it has none. */
export function budgetFor(cfg: WorkConfig, state: LeanState): Budget | undefined {
  return cfg.budgets[state];
}

/**
 * The one row a dispatching step records for one child it paid for. A child that never started reports no
 * cost, which is the truth; `ok` is the step's own judgement.
 */
export function dispatchUsageRow(result: DispatchResult): DispatchUsageRow {
  return {
    role: result.role,
    ms: result.ms ?? 0,
    ok: result.ok && result.killCause === undefined && result.errorStop === undefined,
    usage: result.usage ?? zeroDispatchUsage(),
    ...(typeof result.stopReason === "string" ? { stopReason: result.stopReason } : {}),
  };
}

/** A child that reported nothing cost nothing that anybody observed. */
function zeroDispatchUsage(): DispatchUsageRow["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
  };
}

/** The lens children's role and the fixer's role — the values `leanUsage` folds `byRole` on. */
export const LENS_ROLE = "code-review-specialist";
export const FIXER_ROLE = "developer";

/**
 * One six-lens round's cost, as one row per lens child that ran — NOT one synthetic row for the round,
 * which would lose five children's wall clock and halve the child count a host compares against.
 */
export function lensRows(lenses: LensRunResult[]): DispatchUsageRow[] {
  return lenses.map((lens) => ({
    role: LENS_ROLE,
    ms: lens.ms,
    // `blocked` is a lens that never ran; `killCause` is the dispatch-cap kill.
    ok: lens.ok && lens.blocked !== true && lens.killCause === undefined,
    usage: lens.usage ?? zeroDispatchUsage(),
  }));
}

/** The one budget sentence, rendered from the typed trio. Every surface prints it from here. */
export function budgetSentence(state: LeanState, fired: BudgetFired): string {
  return `${state} stopped: ${fired.limit} budget ${String(fired.value)} exceeded (used ${String(fired.used)})`;
}

/**
 * The verdict for a step that ran out of budget, not out of ideas.
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
 * The budget verdict carrying the rows of every dispatch the step paid for, so a stopped round's tokens
 * reach the host. Clipped HERE to the validator's cap, keeping the newest.
 */
export function budgetVerdictWithRows(
  state: LeanState,
  fired: BudgetFired,
  rows: DispatchUsageRow[],
): Outcome {
  const verdict = budgetVerdict(state, fired);
  return rows.length === 0 ? verdict : { ...verdict, dispatches: rows.slice(-DISPATCHES_MAX_ROWS) };
}

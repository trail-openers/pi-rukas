/**
 * spawn-inactivity-poll — the child-supervision timer: the dual-budget silence watchdog, the
 * opt-in no-progress arm, and #2644's hung-request lever, all on ONE tick.
 *
 * Split from `spawn-inflight.ts` (AGENTS.md §12): the in-flight tracking and the stdout pump are
 * the stream's own concerns, and this is the supervisor's — one setInterval whose body is the
 * whole policy of when a child is ended and under which cause. The two modules share `InFlightTools`
 * and `spanEdges` rather than each re-deriving them.
 *
 * #951 — ONE poll, two budgets: while the in-flight set is non-empty the silence belongs to a
 * running tool, so the TOOL-inactivity bound applies (a long bash — the full offline gate, a CI
 * watch — is the NORMAL shape); when the set is empty the model-silence bound applies (a stalled
 * provider turn). Exactly one budget is armed at any poll, so there is no both-expired race.
 *
 * The poll period takes the smaller positive budget (a tighter budget is the tighter poll) so a
 * test-shortened tool budget still fires promptly; production clamps both to 30s.
 * `toolInactivityKilled` / `inactivityKilled` are exclusive by construction.
 *
 * The same tick carries the opt-in no-progress arm (`ChildProgress.stall`,
 * PI_ENSEMBLE_PROGRESS_SILENCE_MS): a child that still emits lines but makes no progress. Silence
 * is checked first, so a silent child keeps its silence cause; with the knob unset the arm never
 * fires and the poll is unchanged.
 *
 * #2644 — the same tick is ALSO the only place the caller's hung-request lever can be read: a
 * request that hangs emits no line at all, so a check on the stream's own cadence is a check that
 * never runs on exactly the shape the lever exists for. `stall` is the step's armed window and the
 * caller's `check` (the abort); the poll fires it on a timer tick, after its own budgets, so a
 * silence the poll itself ends keeps its own cause.
 *
 * `tick` is exposed next to `stop` because the decision is the timer's, and a case must be able to
 * take one pass without depending on a host's timer cadence. A caller whose child is bounded only
 * by the lever says so with `budgets`, so the poll cannot reach a cause it was never asked to own.
 */

import type { ChildProcess } from "node:child_process";
import type { ChildProgress } from "./child-progress.ts";
import { progressSilenceMs } from "./child-progress.ts";
import type { SpawnOptions } from "./pi-event-shapes.ts";
import type { StallOpts } from "./request-stall-policy.ts";
import { stallBreach } from "./request-stall-policy.ts";
import type { InFlightTools } from "./spawn-inflight.ts";
import { killProcessTree } from "./spawn-kill.ts";
import { inactivityTimeoutMs, toolInactivityTimeoutMs } from "./spawn-support.ts";
import { traceWarn } from "./trace.ts";

/** The cause the poll's own budgets name; `stall` is the caller's lever, fired on the same tick. */
export type PollKillCause = "inactivity" | "tool-inactivity" | "no-progress" | "stall";

/**
 * #951 — the dual-budget inactivity watchdog. ONE poll, two budgets: while
 * the in-flight set (above) is non-empty the silence belongs to a running
 * tool, so the TOOL-inactivity bound applies (a long bash — the full offline
 * gate, a CI watch — is the NORMAL shape); when the set is empty the
 * model-silence bound applies (a stalled provider turn). Exactly one budget
 * is armed at any poll, so there is no both-expired race.
 *
 * The poll period takes the smaller positive budget (a tighter budget is
 * the tighter poll) so a test-shortened tool budget still fires promptly;
 * production clamps both to 30s. `toolInactivityKilled` / `inactivityKilled`
 * are exclusive by construction.
 *
 * The same tick carries the opt-in no-progress arm (`ChildProgress.stall`,
 * PI_ENSEMBLE_PROGRESS_SILENCE_MS): a child that still emits lines but makes
 * no progress. Silence is checked first, so a silent child keeps its silence
 * cause; with the knob unset the arm never fires and the poll is unchanged.
 *
 * #2644 — the same tick is ALSO the only place the caller's hung-request lever is evaluated: a
 * request that hangs emits no line at all, so a check on the stream's own cadence is a check that
 * never runs on exactly the shape the lever exists for. `stall` is the step's armed window and the
 * reader of its stream; the poll asks it on a timer tick, after its own budgets, so a silence the
 * poll itself ends keeps its own cause. The poll contributes the reading, the cadence and the
 * guarded kill, and hands the breach to the caller's `fire` — which freezes the verdict and owns
 * the abort; nothing on this path reads the child's turns or tokens.
 */
export interface InactivityPoll {
  /** Stop the timer. */
  stop: () => void;
  /** One supervision pass, the body the timer runs. */
  tick: () => void;
}

export function createInactivityPoll(opts: {
  /** Headless S4 (#1024): the child leads its own process group (spawn-kill.ts). */
  child: ChildProcess;
  inFlightTools: InFlightTools;
  lastActivityAt: () => number;
  childProgress: ChildProgress;
  onKill: (cause: PollKillCause, budgetMs: number, toolNames: string[]) => void;
  /** #2644 — the caller's hung-request lever: the enforced window in ms, the reader of THIS
   *  child's stream (which the poll asks on its own tick), and the caller's `fire` for the breach. Absent means no stall arm, which is
   *  every caller that bounds its child some other way. */
  stall?: StallOpts;
  /** The two silence budgets, in the shape the operator's knobs arrive in. The spawn passes none and
   *  gets `PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS` / `PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS`; a case that
   *  supervises a child the lever alone must end says so here, so the poll cannot reach a cause it
   *  was never asked to own. Read per tick, because the knobs are read at CALL time everywhere in
   *  this stack. */
  budgets?: () => { inactivityMs: number; toolInactivityMs: number };
}): InactivityPoll {
  const { child, inFlightTools, lastActivityAt, childProgress, onKill, stall } = opts;
  const budgets =
    opts.budgets ??
    (() => ({
      inactivityMs: inactivityTimeoutMs(),
      toolInactivityMs: toolInactivityTimeoutMs(),
    }));
  const armedBudget = () => {
    const { inactivityMs, toolInactivityMs } = budgets();
    return inFlightTools.active
      ? { ms: toolInactivityMs, cause: "tool-inactivity" as const }
      : { ms: inactivityMs, cause: "inactivity" as const };
  };
  /** The tick cadence: half the tightest bound that can end this child, floored so a case with a
   *  one-minute budget still ticks, and capped so a child with only a wide lever is still watched. */
  const pollBudgetMs = () =>
    Math.min(
      (() => {
        const b = budgets();
        return b.inactivityMs > 0 ? b.inactivityMs : Number.POSITIVE_INFINITY;
      })(),
      (() => {
        const b = budgets();
        return b.toolInactivityMs > 0 ? b.toolInactivityMs : Number.POSITIVE_INFINITY;
      })(),
      progressSilenceMs(false) || Number.POSITIVE_INFINITY,
      stall !== undefined && stall.windowMs > 0 ? stall.windowMs : Number.POSITIVE_INFINITY,
    );
  const period = pollBudgetMs();
  if (period === Number.POSITIVE_INFINITY) return { stop: () => undefined, tick: () => undefined };
  let stopped = false;
  /** One supervision pass: the poll's own budgets first, then the caller's lever. The timer below
   *  is the production driver; it is also the seam a case calls when a host's timer cadence cannot
   *  be relied on to land a verdict inside the case's wait — and once this poll has stopped, that
   *  seam decides nothing, which is the half of the one-shot the timer alone cannot carry. */
  const tick = (): void => {
    if (stopped) return;
    const armed = armedBudget();
    const now = Date.now();
    // A disabled budget (ms <= 0) never fires; the other is checked in its own branch.
    const budget =
      armed.ms > 0 && now - lastActivityAt() >= armed.ms
        ? armed
        : childProgress.stall(now, inFlightTools.active);
    if (budget) {
      onKill(budget.cause, budget.ms, inFlightTools.toolNames());
      // #1510 — this runs on its OWN setInterval, so a throw here is an
      // uncaught exception at timer level: it aborts the parent and takes
      // down every sibling child still in flight, exactly the shape the
      // budget kill guards. `onKill` has already recorded the cause, so the
      // kill is attributed even when the signal cannot land — the failure is
      // reported at default log level, never swallowed.
      try {
        killProcessTree(child);
      } catch (err) {
        traceWarn(`inactivity killProcessTree failed: ${String(err)}`);
      }
      return;
    }
    // #2644 — the caller's hung-request lever, on this tick and nowhere else: a hung request
    // emits nothing, so nothing else ticks, and a turn tick must not evaluate it — the tracker has
    // not yet seen the line that just arrived, so the first message back (which can carry a tool
    // call) would be judged on stale silence. The caller owns the abort, so the poll contributes
    // the reading, the cadence and the kill; the breach itself is the caller's, frozen once.
    if (stall !== undefined) {
      const breach = stallBreach(stall);
      // The caller's abort is one-shot, so the arm stands itself down after it fires: the poll
      // has no reason to keep reading a stream whose child is already being ended, and every
      // later pass would re-read the silence and re-kill a process that is already gone. The
      // `stop()` below runs BEFORE the firing rather than a bare `clearInterval` after it, and the
      // order is the whole of the stand-down: the caller's `fire` aborts synchronously, and a caller
      // that watches that abort can tear this poll down inside the call — after which a
      // `clearInterval` from this pass would be a no-op on an already-cleared timer and this pass's
      // own continuation would still run. `stopped` also makes the tick seam inert once stopped, so
      // a pass that races the teardown decides nothing either.
      if (breach !== undefined) {
        stop();
        stall.fire?.(breach);
        onKill("stall", stall.windowMs, inFlightTools.toolNames());
        try {
          killProcessTree(child);
        } catch (err) {
          traceWarn(`stall killProcessTree failed: ${String(err)}`);
        }
      }
    }
  };
  const interval = setInterval(tick, Math.min(30_000, Math.max(250, Math.floor(period / 2))));
  interval.unref();
  const stop = (): void => {
    stopped = true;
    clearInterval(interval);
  };
  return { stop, tick };
}

export function stallLever(
  opts: SpawnOptions,
  childProgress: ChildProgress,
  inFlightTools: InFlightTools,
): StallOpts | undefined {
  if (opts.stall === undefined) return undefined;
  const windowMs = opts.stall.windowMs ?? opts.stall.windowMinutes * 60_000;
  return {
    windowMinutes: opts.stall.windowMinutes,
    // The enforced threshold rides through the spawn so the poll measures the same window the
    // step froze; a caller that forwards only the whole minutes (`runLensChild`, the adversarial
    // phase) gets those minutes as the threshold, which is the coarser of the two.
    windowMs,
    silence: () => ({
      sinceMs: Date.now() - childProgress.lastProgressAt,
      toolInFlight: inFlightTools.active,
    }),
    // The step's own freezing of the verdict, when a step armed the lever. The spawn never decides
    // what a breach means, and a caller with no hook (a lens child, the adversarial reviewer) has
    // no verdict to freeze beyond the named kill cause the poll itself stamps.
    ...(opts.stall.fire === undefined ? {} : { fire: opts.stall.fire }),
  };
}

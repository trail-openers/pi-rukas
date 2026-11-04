/**
 * budget-progress — tell a child where it stands against its own bound (#1991).
 *
 * A child has never seen its budget. Lean children carry real turn and minute
 * bounds that abort them, and a hand-managed developer is handed a prose
 * time-box in its brief, but nothing ever said "you are at half of it". So
 * children overrun: a build child killed at 401/400 turns with nothing
 * committed; time-boxed developers that ran 80 and 90 minutes on a 60- and a
 * 75-minute brief and never mentioned their own elapsed time; lens children
 * that spent twenty minutes on a 20-line diff. The cheapest half of that fix
 * is the number itself, on the screen of the only agent that can act on it.
 *
 * Semantics — an ADVISORY steer, the same shape as every sibling one (the turn
 * nudge, the slow-run notice, the child-bound wrap-up): it rides the caller's
 * `onSteer` seam, writes the RPC envelope to `stdin` when the caller has no
 * seam (a lens or adversarial child has none, and those are the
 * motivating overrunners), never kills, sets no `killCause`, and swallows a
 * throwing seam — this runs on the child's hot stdout path, where an escaping
 * throw costs the whole dispatch.
 *
 * Two levers — turns against `maxTurns`, wall clock against the minutes bound —
 * and TWO latches, one per fraction, SHARED across the levers: a stage fires
 * when ANY armed lever crosses its fraction and the line reports the lever
 * closest to its limit. At 50% the child is told where it stands; at 80% it is
 * told to close out — commit, if it is a child that commits, otherwise report.
 * Never more than the two, because there are only two latches: the count is a
 * property of the stage pair, not of any counter that has to remember it. A
 * child with neither lever armed gets nothing, which is what makes the absent
 * bound distinguishable from a bound it has not yet crossed.
 *
 * `turnNudge` (turn-nudge.ts) is the sibling for a child with NO armed bound:
 * it fires once at an operator-set turn count and asks for a status write.
 * When a bound is armed this steer replaces it — a child that is being paced
 * needs its position, not a reminder to write a status line — and the spawn
 * that wires both passes a getter that suppresses the nudge (#1827 ordering:
 * one steer seam, one instruction per moment).
 *
 * The stand-down is `boundArmed` — a DIFFERENT killing bound (the reviewer
 * skill re-read kill, the post-verdict stop) having decided how this child
 * ends. The child's own run bound is never that signal; if it were, arming
 * `maxMinutes` would silence the very steer it exists to deliver.
 */

import type { Writable } from "node:stream";
import { type SteerDelivery, type SteerSource, steerChild } from "./dispatch-steer.ts";

/** Fraction of a bound at which the child is told where it stands. */
export const BUDGET_PROGRESS_HALF = 0.5;
/** Fraction at which it is told to close out: commit, or report. */
export const BUDGET_PROGRESS_CLOSE_OUT = 0.8;

/** The steer source naming this progress line for the operator's scrollback. */
export const BUDGET_PROGRESS_STEER_SOURCE: SteerSource = "driver-budget-progress";

/** A bound a caller may hand a child. `undefined`/`<= 0` means that lever is off. */
export interface BudgetProgressLevers {
  /** Assistant turns the child may run. */
  turns?: number;
  /** Wall-clock ms the child may run — the same number `childBoundMs` carries. */
  boundMs?: number;
}

/**
 * The spawn-time minutes schedule, in absolute epoch ms. Produced ONCE from
 * `childBoundSchedule` (whose `wrapAtMs`/`killAtMs` are ms-from-`now`) so every
 * later read subtracts against the anchor the kill will actually use —
 * re-running the schedule per turn would drift, and a clamped deadline must be
 * the number the child sees, or the steer promises time the cycle will not
 * grant.
 */
export interface BudgetProgressClock {
  /** Epoch ms of the spawn's schedule anchor. */
  readonly anchorAtMs: number;
  /** Epoch ms the child must stop starting new work. */
  readonly wrapAtMs: number;
  /** Epoch ms the child is ended, absent when the cycle deadline owns the kill. */
  readonly killAtMs?: number;
}

/** Build the schedule once, at spawn time, from a bound's relative schedule. */
export function budgetProgressClock(
  schedule: { wrapAtMs: number; killAtMs?: number },
  anchorAtMs: number,
): BudgetProgressClock {
  return {
    anchorAtMs,
    wrapAtMs: anchorAtMs + schedule.wrapAtMs,
    ...(schedule.killAtMs === undefined ? {} : { killAtMs: anchorAtMs + schedule.killAtMs }),
  };
}

/**
 * Minutes the child has left against its schedule: to the kill when the bound
 * owns it, else to the wrap-up steer — after which the child is told to finish
 * and report, so that is the time it actually has. Never negative.
 */
export function minutesLeft(clock: BudgetProgressClock, now: number): number {
  const end = clock.killAtMs ?? clock.wrapAtMs;
  return Math.max(0, end - now);
}

/** Minutes left, in the words the child reads. Under a minute is its own phrase. */
export function minutesLeftText(msLeft: number): string {
  return msLeft < 60_000 ? "under 1 min" : `${Math.floor(msLeft / 60_000)} min`;
}

/**
 * The 80% instruction, by what the child can actually do. A committing child
 * (a developer working in a tree of its own) loses uncommitted work at the
 * kill, so it is told to commit; every other role only reports, because
 * telling a reviewer to commit is an instruction it cannot act on.
 */
export function closeOutInstruction(commits: boolean): string {
  return commits
    ? "Commit your work now, then send your final report."
    : "Report your findings now, then end your turn.";
}

/**
 * The exact line the child reads. It states turns used of the limit, minutes
 * left of the total when a wall clock is armed, and — at close-out time — the
 * instruction. No token figure anywhere: tokens are not what this steer bounds,
 * and `budgetSteerText` (progress.ts) talks about a spend this feature does
 * not measure.
 */
export function budgetProgressText(o: {
  turnsUsed: number;
  turnsLimit?: number;
  minutesLeftMs?: number;
  minutesTotalMs?: number;
  closeOut: boolean;
  commits: boolean;
}): string {
  const parts: string[] = [];
  const turnPart =
    o.turnsLimit === undefined
      ? `turn ${String(o.turnsUsed)}`
      : `turn ${String(o.turnsUsed)} of ${String(o.turnsLimit)}`;
  parts.push(`Budget: ${turnPart}`);
  if (o.minutesLeftMs !== undefined && o.minutesTotalMs !== undefined) {
    parts.push(
      `about ${minutesLeftText(o.minutesLeftMs)} left of ${Math.floor(o.minutesTotalMs / 60_000)}`,
    );
  }
  const sentence = `${parts.join(", ")}.`;
  return o.closeOut ? `${sentence} ${closeOutInstruction(o.commits)}` : sentence;
}

/**
 * One lever's crossing rule: the first reading at or past `ceil(fraction ·
 * limit)`. A non-positive or absent limit is no limit at all, so a child with
 * no bound gets neither latch.
 */
export function budgetProgressReached(used: number, limit: number | undefined, f: number): boolean {
  if (limit === undefined || limit <= 0) return false;
  return used >= Math.ceil(f * limit);
}

/**
 * Which lever to speak of when both are armed: the larger used/limit fraction,
 * minutes winning a tie. The two levers have different units, so a fraction is
 * the only scale they share; the tie goes to the wall clock because that kill
 * is the one nearest in real time.
 */
export function closestBudgetLever(o: {
  turnsUsed: number;
  turnsLimit?: number;
  minutesUsedMs: number;
  minutesLimitMs?: number;
}): "turns" | "minutes" {
  const ratio = (used: number, limit: number | undefined): number =>
    limit === undefined || limit <= 0 ? 0 : used / limit;
  return ratio(o.minutesUsedMs, o.minutesLimitMs) >= ratio(o.turnsUsed, o.turnsLimit)
    ? "minutes"
    : "turns";
}

/**
 * The per-spawn progress steer. Build it once per spawn with the levers and
 * the spawn-time clock; call {@link BudgetProgressSteer.onAssistantTurn} from
 * the same per-assistant-turn seam the token-budget check and the turn nudge
 * sit on, and {@link BudgetProgressSteer.stop} in the spawn's `finally`.
 */
export interface BudgetProgressSteer {
  /** Drive both levers after an assistant turn completed. Never throws. */
  onAssistantTurn(turns: number, now?: number): void;
  /** Tear down the wall-clock timers (the spawn's `finally`). */
  stop(): void;
}

export interface BudgetProgressOpts extends BudgetProgressLevers {
  /** The role decides nothing here except through `commits`; kept so the two
   * delivery paths and the tests name the child they are pacing. */
  role: string;
  /** True when the child can commit (a developer with its own cwd) — decides
   * the 80% instruction, and nothing else. */
  commits: boolean;
  /** The spawn's minutes schedule, absolute (budgetProgressClock). */
  clock?: BudgetProgressClock;
  /** The driver's steer seam; without one the steer goes to `stdin`. An
   * explicit `false` means the line did not reach the child, which leaves the
   * stage open so the next turn retries it. */
  onSteer?: SteerDelivery;
  /** The child's stdin, for the no-seam path (a lens / adversarial child). */
  stdin?: Writable;
  /** A child steered through the registry rather than a job id (a lens child's
   * deck key). `steerChild` resolves it, so the lifecycle line still carries
   * the source tag on a caller that has no `onSteer` of its own. */
  deckKey?: string;
  /** #1827 ordering — a DIFFERENT killing bound has armed for this child, so
   * the advisory stands down. Never the child's own run bound. */
  boundArmed?: () => boolean;
  /** The child's exit has been observed: the steer is advice nobody will read,
   * so the write is skipped rather than attempted (the same liveness question
   * every other supervisor of a spawn asks — `childHasExited` at the call site). */
  exited?: () => boolean;
}

/** The child was ended before the steer could land; the advice is worth nothing. */
function gone(o: BudgetProgressOpts): boolean {
  if (o.exited?.() === true) return true;
  const stdin = o.stdin;
  if (!stdin) return true;
  return stdin.destroyed === true || stdin.writable === false || stdin.writableEnded === true;
}

/** Deliver one advisory line through the caller's seam, its registry entry, or
 * its stdin. Returns whether the child was reached — the caller settles a latch
 * on that answer and nothing else. */
function deliver(o: BudgetProgressOpts, text: string): boolean {
  const envelope = `${JSON.stringify({ type: "steer", message: text })}\n`;
  try {
    if (o.onSteer) {
      return o.onSteer(text, BUDGET_PROGRESS_STEER_SOURCE) !== false;
    }
    // The registry path resolves the id and emits the tagged lifecycle line, and
    // writes the envelope itself — but only for a child that is really there. An
    // unregistered key is what a lens child looks like after its round ended, and
    // the caller's stdin is then the same dead pipe, so the fall-through is
    // deliberately not taken: `steerChild` answered, and answering twice on a
    // closed pipe is the double write #932 exists to prevent.
    if (o.deckKey) {
      return steerChild(o.deckKey, text, BUDGET_PROGRESS_STEER_SOURCE).delivered;
    }
    if (gone(o)) return false;
    o.stdin?.write(envelope);
    return true;
  } catch {
    /* child already gone — advice it cannot read is not an error, just undelivered */
    return false;
  }
}

/** True when the advisory must not fire: some other bound already owns the end. */
function stoodDown(o: BudgetProgressOpts): boolean {
  return o.boundArmed?.() === true;
}

/**
 * How far a child has run against its minutes bound, as a fraction: elapsed
 * since the schedule's anchor over the total the schedule will actually grant
 * (the kill when the bound owns it, the wrap-up when the cycle deadline does).
 * 0 when the lever is not armed, so an unarmed lever can never look closest to
 * its limit.
 */
export function minutesFraction(
  clock: BudgetProgressClock | undefined,
  totalMs: number | undefined,
  now: number,
): number {
  if (!clock || totalMs === undefined || totalMs <= 0) return 0;
  // Clamped to [0,1] on BOTH ends: a child past its bound is not 1.4 of the way
  // through it, and every reader of this fraction is a threshold comparison.
  return Math.min(1, Math.max(0, now - clock.anchorAtMs) / totalMs);
}

/**
 * The total a minutes lever bounds the child to, ms: to the kill when the run
 * bound owns it, else to the wrap-up the cycle deadline leaves. Undefined when
 * no clock is armed. One definition, read by the inertness test, the latch
 * comparison and the renderer, because all three must agree on what "the
 * bound" is or a child is paced against one number and told another.
 */
export function minutesTotalMs(clock: BudgetProgressClock | undefined): number | undefined {
  if (!clock) return undefined;
  const total = (clock.killAtMs ?? clock.wrapAtMs) - clock.anchorAtMs;
  return total > 0 ? total : undefined;
}

/**
 * True when neither lever exists, so there is nothing to report. The minutes
 * lever is measured as a SPAN, never as `wrapAtMs > 0`: the schedule is absolute
 * epoch ms anchored at the spawn, so a relative reading is true for every real
 * child and the check would silently pass every clock through.
 */
function inert(o: BudgetProgressOpts): boolean {
  return (o.turns === undefined || o.turns <= 0) && minutesTotalMs(o.clock) === undefined;
}

export function createBudgetProgressSteer(o: BudgetProgressOpts): BudgetProgressSteer {
  if (inert(o)) return { onAssistantTurn: () => {}, stop: () => {} };

  const turnsLimit = o.turns !== undefined && o.turns > 0 ? o.turns : undefined;
  const minutesTotal = minutesTotalMs(o.clock);

  /**
   * The two latches, one per fraction, SHARED by both levers — not one per
   * lever, which is what let a child that crossed half on turns and half on
   * minutes (or close-out on both on one turn) be told the same thing twice.
   * Each turn asks BOTH levers (the spec's D4: thresholds evaluate per lever
   * independently) and one delivery reports the lever closest to its limit, so
   * the pair is the whole steer: once both stages have settled there is nothing
   * left to say, however far the child runs past the bound. That is what makes
   * "never more than two" a property of the latch pair rather than of any
   * counter that has to keep the tally.
   *
   * A latch is only settled when its line actually went out. `fire` reports
   * whether it delivered, and a line that could not land — the child was gone,
   * some other bound had already armed, or the caller's seam said `false` —
   * leaves the latch OPEN. Marking an undelivered 50% line as said is how a
   * child ends up never hearing the 80% instruction, which is the one part of
   * this steer it cannot recover from: the position line is nice to have, the
   * close-out is the point.
   */
  const settled = { half: false, closeOut: false };

  /** The one delivery point, shared by both levers and both fractions. Returns
   * whether the line reached the child, which is what settles a latch. */
  const fire = (closeOut: boolean, now: number, turns: number): boolean => {
    if (stoodDown(o) || gone(o)) return false;
    const minutesArmed = minutesTotal !== undefined;
    const turnsArmed = turnsLimit !== undefined;
    const minutesUsedMs = o.clock ? now - o.clock.anchorAtMs : 0;
    const speaksMinutes = closestBudgetLever({
      turnsUsed: turns,
      turnsLimit,
      minutesUsedMs,
      minutesLimitMs: minutesTotal,
    });
    // A lever that is not armed can never be the closest one, so the comparison
    // above only decides anything when BOTH levers exist. With one lever armed
    // it speaks, which is what keeps a turns-only child from printing a bogus
    // "0 min left" and a clock-only child from printing a bogus "turn 0 of 0".
    const reportMinutes = minutesArmed && (!turnsArmed || speaksMinutes === "minutes");
    if (
      !deliver(
        o,
        budgetProgressText({
          turnsUsed: turns,
          turnsLimit: reportMinutes ? undefined : turnsLimit,
          minutesLeftMs: reportMinutes && o.clock ? minutesLeft(o.clock, now) : undefined,
          minutesTotalMs: reportMinutes ? minutesTotal : undefined,
          closeOut,
          commits: o.commits,
        }),
      )
    ) {
      return false;
    }
    return true;
  };

  /**
   * Per-fraction evaluation on the turn that makes it true, with BOTH levers
   * asked: a fast child that burns its turns while its clock idles is paced on
   * the lever that is actually running out, and a child that idles on its clock
   * while its turns run is paced on that one instead. Crossing close-out on any
   * lever settles half with it — a child that skipped the half reading entirely
   * (a dispatch resumed at turn 30 of 40) gets the instruction, not a stale
   * position line followed by nothing — and a stage that delivered is settled,
   * while a stage whose line never landed stays open for the next turn.
   */
  const onTurn = (turns: number, now: number): void => {
    const minutesNow = minutesFraction(o.clock, minutesTotal, now);
    const crossingCloseOut =
      budgetProgressReached(turns, turnsLimit, BUDGET_PROGRESS_CLOSE_OUT) ||
      minutesNow >= BUDGET_PROGRESS_CLOSE_OUT;
    if (!settled.closeOut && crossingCloseOut && fire(true, now, turns)) {
      settled.closeOut = true;
      settled.half = true;
      return;
    }
    const crossingHalf =
      budgetProgressReached(turns, turnsLimit, BUDGET_PROGRESS_HALF) ||
      minutesNow >= BUDGET_PROGRESS_HALF;
    if (!settled.half && crossingHalf && fire(false, now, turns)) {
      settled.half = true;
    }
  };

  return {
    onAssistantTurn: (turns, now = Date.now()) => {
      try {
        onTurn(turns, now);
      } catch {
        /* the hot path owns this call; a broken steer never costs the child */
      }
    },
    // Nothing is scheduled: both levers are read on the per-assistant-turn seam
    // (the spec's D4 — "the minutes lever is also checked on the same per-turn
    // seam (no timer)"). A child that emits no turn is a child the inactivity
    // watchdog and `armChildBound`'s own wrap-up steer already own; a timer here
    // would fire advice into a child that is silent for a reason.
    stop: () => {},
  };
}

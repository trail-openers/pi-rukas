/**
 * work-driver-deadline — the caller-set whole-cycle deadline (#1238).
 *
 * The driver bounds steps (spawn backstop, inactivity, verify, handoff, the
 * 90-min review loop) but had no bound for the cycle as a whole, and no way
 * for the caller to give it one. An unattended caller has to bound the cycle
 * itself — an unattended host does it with a 6-hour `docker stop`, which lands MID-STEP:
 * aborted jobs, state left at `status: running`, no handoff, no comment
 * (three reports from the field).
 *
 * This is the driver-side half: the caller sets `PI_ENSEMBLE_CYCLE_DEADLINE`
 * (an absolute epoch ms) or `PI_ENSEMBLE_CYCLE_BUDGET_MS` (resolved to an
 * epoch once, then persisted in `pipelineState.cycleDeadlineMs`).
 *
 * Semantics: the deadline is where step work ends; only the handoff runs
 * after it. The caller sets it to its hard kill minus its handoff allowance
 * and passes that allowance as `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` (#1593, the
 * cross-repo contract with the caller), so the handoff has the allowance to itself.
 *
 * - Step work ends at `deadline − handoff grace`; what is left before that
 *   is the step's useful time. At each step boundary the driver parks with
 *   cap `deadline` (and routes to handoff) once no useful time is left.
 * - Partial fit (#1567 item 6, #1447/#1547): develop and lens-fix need at
 *   least 15 min of useful time, a lens round 10 min. With less, the step is
 *   not started and the cycle parks with cap `deadline:no-fit`, naming the
 *   step, the time left and the time it needed. With enough, the step is
 *   clamped to the time left rather than refused for not fitting its own
 *   (much longer) bound.
 * - A step already running does not run on: every child the cycle spawns is
 *   bounded by `deadline − now − grace`, and the handoff's child by the
 *   allowance after the deadline (cycle-deadline-clock.ts). Before #1593 such
 *   a step ran to its own backstop, into the caller's kill.
 * - A step that ends past the deadline does not get to name the cycle's
 *   terminal reason: the handoff boundary records `deadline` after its
 *   verdict (work-driver-terminal-reason.ts).
 * - The handoff step itself is never parked.
 * - No env var set → no deadline: the default behaviour is unchanged.
 */

import { notifyAgent } from "./agent-message.ts";
import { noteCycleDeadline, runWithCycleClock } from "./cycle-deadline-clock.ts";
import { trace, traceWarn } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
import { terminalReasonAtHandoff } from "./work-driver-terminal-reason.ts";
import {
  SWITCH,
  timeoutFlagPrecedenceEnabled,
} from "./work-driver-timeout-flag-precedence-switch.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

const MINUTE_MS = 60_000;

/**
 * #1742 — one lens round's floor, stated ONCE. `MIN_USEFUL_MS["lens-review"]`
 * and `lensRoundReserveMs()` (work-driver-lens-fix-budget.ts) both read it, so
 * the round's start gate and the reserve the fixer withholds cannot drift.
 */
export const LENS_REVIEW_MIN_USEFUL_MS = 10 * MINUTE_MS;

/**
 * #1567 item 6 — the least useful time (before `deadline − handoff grace`) a
 * step needs to be worth starting. A step not listed needs only some.
 */
export const MIN_USEFUL_MS: Partial<Record<WorkStep, number>> = {
  develop: 15 * MINUTE_MS,
  "lens-fix": 15 * MINUTE_MS,
  "lens-review": LENS_REVIEW_MIN_USEFUL_MS,
};

/** Below this an epoch is in seconds, not ms (1e12 ms is September 2001). */
const EPOCH_MS_FLOOR = 1e12;

/**
 * A duration in ms: the shape `PI_ENSEMBLE_CYCLE_BUDGET_MS` carries and the
 * shape the lean verb's `--timeout <minutes>` arrives as. The reader resolves it
 * to an epoch — it is never written to the environment, which is what keeps one
 * run's budget from becoming every later dispatch's deadline.
 */
export type CycleBudgetMs = number & { readonly __cycleBudgetMs: unique symbol };

/**
 * The caller's duration, branded for the reader. Minted HERE and nowhere else:
 * the one place a `--timeout` becomes an arm is the same place the shared reader
 * consumes it, so no caller can hand `resolveCycleDeadline` an ordinary number
 * that was never the host's word for how long the cycle may run.
 */
export function flagBudgetMs(timeoutMs: number | undefined): CycleBudgetMs | undefined {
  return timeoutMs === undefined ? undefined : (timeoutMs as CycleBudgetMs);
}

/** The two names the warning has to use verbatim: the flag is spelled as the caller typed
 *  it and the env arms as the operator exported them, so a reader can grep for either. */
const FLAG_NAME = "--timeout";
const BUDGET = "PI_ENSEMBLE_CYCLE_BUDGET_MS";
const ABSOLUTE = "PI_ENSEMBLE_CYCLE_DEADLINE";

/** The reader's answer for the operator-facing line: which arm won, and whether the run got
 *  the flag's own. `"flag"` can only be the answer when the switch let the flag through, so
 *  one test — `winner !== "flag"` — is "something the flag did not arm". */
export type PrecedenceWinner = "deadline" | "flag" | "budget";

/** What the reader honoured, in the shape the line reads. `flagArm` is the epoch the caller's
 *  `--timeout` armed at the SAME instant the winner was decided. `envWeighed` is the reader's
 *  own word that an env arm was in play (`undefined` when none was, which is what keeps a typo
 *  from being named as an arm the reader never weighed). `switchOn` is the switch state the
 *  reader saw when it chose `winner`, carried so the line is never built from a switch reading
 *  that differs from the one that armed the run. */
export interface PrecedenceVerdict {
  winner: PrecedenceWinner;
  resolved: number;
  flagArm: number;
  /** The instant both arms were struck — the same `now` the winner was decided at — carried so
   *  the line can compare the env arm's epoch `now + envWeighed` against the flag's own without
   *  re-reading the env. */
  now: number;
  envWeighed: number | undefined;
  switchOn: boolean;
}

/** The ladder's answer — the same shape one field narrower than `PrecedenceVerdict`, and
 *  `cycleDeadlineVerdict` adds only `resolved`/`flagArm`. `winner` is the arm whose duration the
 *  run got; `envWeighed` is the reader's own word that an env arm it HONOURED was in play beside
 *  the flag (`undefined` where none was — a typo, a non-positive budget, no budget at all, which
 *  is what keeps a value the reader threw away from ever being named as an arm it weighed). */
interface Precedence {
  winner: PrecedenceWinner;
  deadline: number;
  envWeighed: number | undefined;
  now: number;
  /** The switch state the reader saw when it chose `winner`. Carried through the verdict so
   *  the warning never reads `process.env` independently of the resolution that chose the arm. */
  switchOn: boolean;
}

/**
 * The ladder, in the one place it is written. `resolveCycleDeadline` acts on its answer and
 * the operator-facing line is built from the same call, so the line cannot disagree with the
 * run by re-reading the env or comparing epochs.
 *
 * `PI_ENSEMBLE_CYCLE_DEADLINE` first and unconditionally: it is absolute and its setter owns
 * the clock. Otherwise the exported budget decides, BY THE BASE READER'S OWN PREDICATE — a
 * finite positive duration — and the flag enters only where the two durations genuinely
 * contend and the switch is on. That is what makes `"0"` the pre-#2362 behaviour rather than a
 * re-derivation of it: a budget the reader rejects (`abc`, `-5`, `0`, `""`) is UNSET and the
 * flag arms the run on either arm, while `1e3` and `" 60000 "` are durations the reader honours
 * and so still win the off arm. `winner === "flag"` is therefore only ever reachable on the ON
 * arm, and it names the one case where the caller did NOT get the duration they asked for; where
 * the two durations are equal there is nothing to report (see `warnTimeoutFlagPrecedence`).
 */
function precedence(
  env: Record<string, string | undefined>,
  now: number,
  flag?: CycleBudgetMs,
): Precedence | undefined {
  // Read once, here: the warning is built from the same verdict the arm came from, so the
  // line can never describe a switch state different from the one that chose the winner.
  const switchOn = timeoutFlagPrecedenceEnabled();
  const abs = env.PI_ENSEMBLE_CYCLE_DEADLINE;
  if (abs !== undefined && abs !== "") {
    const v = Number(abs);
    if (Number.isFinite(v) && v >= EPOCH_MS_FLOOR)
      // The absolute arm outranks the flag with or without the switch, so its line is not a
      // switch row: the knob does not move it, and the remedy tail says exactly that.
      return { winner: "deadline", deadline: v, envWeighed: v, now, switchOn };
    trace(
      Number.isFinite(v) && v > 0
        ? `work-driver: ${ABSOLUTE}=${abs} looks like epoch SECONDS — it must be epoch ms; ignored`
        : `work-driver: ${ABSOLUTE}=${abs} is not a finite positive epoch ms — ignored`,
    );
    return undefined;
  }
  const raw = env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  if (raw === undefined || raw === "")
    return flag === undefined
      ? undefined
      : {
          winner: "flag",
          deadline: now + flag,
          envWeighed: undefined,
          now,
          switchOn,
        };
  const duration = Number(raw);
  if (!Number.isFinite(duration) || duration <= 0) {
    trace(`work-driver: ${BUDGET}=${raw} is not a finite positive duration — ignored`);
    // A malformed budget is UNSET, not zero: the base does not fall back to the flag here.
    // The flag arms a run only when there is no budget at all (`raw === undefined`), never
    // when one was set but rejected. Returning undefined keeps `resolveCycleDeadline` null.
    return undefined;
  }
  // Both durations real: at `"0"` this returns the base's answer — the budget's arm — and
  // `switchOn` false is what keeps the row silent.
  if (flag !== undefined && switchOn)
    return {
      winner: "flag",
      deadline: now + flag,
      envWeighed: duration,
      now,
      switchOn,
    };
  return {
    winner: "budget",
    deadline: now + duration,
    envWeighed: duration,
    now,
    switchOn,
  };
}

/**
 * The one line an overridden `--timeout` costs. `armed` is what `resolveCycleDeadline`
 * honoured for this run — the reader's own answer, never a second reading of the env — and
 * `what` names the run. `resolveCycleDeadline` stays pure, so the caller that PERSISTS the
 * answer is the one allowed to speak: the same disagreement re-read at ten step boundaries is
 * ten warnings.
 *
 * It fires only where an env arm the reader honoured beat the flag: with no env input, with an
 * env value the reader does not honour, or where the flag's arm and the env arm are one epoch
 * (the exported budget is the very duration `--timeout` carries, so nothing was overridden and
 * the remedy would change nothing), nothing is logged (#2362 R4). And it fires only on the ON
 * arm: at `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` the switch logs NOTHING, whatever the winner —
 * the switch's promise is the tree with no switch back, and that tree wrote no line for an
 * overridden flag, whichever arm it honoured.
 *
 * The `=0` tail says what the knob does to THIS row: on the budget rows it puts the exported
 * budget back above the flag; it never moves an absolute deadline, which outranks the flag on
 * the ON arm regardless, and the deadline's line says so rather than staying mute.
 */
export function warnTimeoutFlagPrecedence(
  armed: PrecedenceVerdict | undefined,
  flagBudgetMs: number | undefined,
  what: string,
): void {
  if (
    flagBudgetMs === undefined ||
    armed === undefined ||
    // No env arm the reader honoured stood against the flag, so the flag armed the run alone:
    // no budget at all, or a value the reader rejected (`abc`, `-5`, `0`), is "no
    // disagreement", and silent (R4). This is the reader's own decision, not an epoch
    // comparison the warning could get wrong.
    armed.envWeighed === undefined ||
    // The off arm logs nothing at all. `"0"` promises the tree with no switch back, and that
    // tree wrote no line for an overridden flag whichever arm it honoured — so the absolute
    // deadline's win is silent here too, even though the knob does not move that arm: on the
    // off arm the operator chose the env's order, and a line would be behaviour the promise
    // never made.
    !armed.switchOn ||
    // The env's arm IS the flag's arm. An exported budget carrying the very duration `--timeout`
    // does (`PI_ENSEMBLE_CYCLE_BUDGET_MS=9900000` with `--timeout 165`) resolves BOTH arms to one
    // epoch, so the run holds what the caller asked for and the `=0` remedy would put back a
    // budget already worth that arm. `envWeighed` alone cannot tell that from a real override, so
    // the test compares the two epochs this verdict struck at its one instant `now`.
    (armed.envWeighed !== undefined && armed.now + armed.envWeighed === armed.flagArm)
  )
    return;
  // Each arm is quoted in the unit its own docs row documents — the budget a DURATION, the
  // deadline an absolute epoch — so the operator reads back the number they set. `flagArm` is
  // the epoch the flag armed at the SAME instant the winner was decided, never a fresh reading.
  // A row whose budget the reader REJECTED (`abc`, `-5`, `0`) armed the flag on either arm, so
  // its OFF arm holds the flag's own epoch, and it is reported exactly as the reader saw it —
  // `envWeighed` undefined, so no line, on either arm.
  const loser =
    armed.winner === "deadline"
      ? `${ABSOLUTE}=${String(armed.envWeighed)}`
      : `${BUDGET}=${String(armed.envWeighed)}`;
  const won = armed.winner === "deadline" ? ABSOLUTE : armed.winner === "flag" ? FLAG_NAME : BUDGET;
  // Every line the reader can honour carries the knob and what it does to THIS row — the shape
  // is `SWITCH=0 <what it does>`, pinned by the fixture's `shapeOf`. `=0` is the switch's own
  // name and the only knob the operator has, so a line that reported a disagreement without
  // naming it would leave them without the one thing they can do: on the budget rows it puts
  // the exported budget back above the flag, and on an absolute deadline's row it says so
  // plainly — turning the knob does not move an absolute arm, which outranks the flag either
  // way — rather than staying mute about the knob the operator would reach for anyway.
  const remedy =
    armed.winner === "deadline"
      ? `; ${SWITCH}=0 does not move ${ABSOLUTE} above the flag`
      : `; ${SWITCH}=0 puts the exported budget back above the flag`;
  traceWarn(
    `${what}: ${FLAG_NAME}=${String(armed.flagArm)} against ${loser} — ${won} wins (the run's deadline is ${String(armed.resolved)})${remedy}`,
  );
}

/**
 * The deadline rules, applied to a caller's environment, the flag's arm, and the
 * one arm this run already persisted. `readCycleDeadline` is `work`'s entry point
 * (it reads the cycle state's field); `lean/deadline.ts` calls THIS one with the
 * record's own `deadlineMs` and the verb's `--timeout` duration, because a lean
 * run has no cycle state and minting a fake one to reach the rules would be a
 * second claim about a shape the writer owns — and because a caller that writes
 * the flag into the environment hands one run's budget to the whole process.
 *
 * Precedence, highest first: `PI_ENSEMBLE_CYCLE_DEADLINE` (an absolute epoch ms) always
 * outranks everything — it is what a host that owns the clock said. Then, while
 * `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE` is on (its shipped default), the `flagBudgetMs`
 * duration a caller passed explicitly: `--timeout` is the caller's word about THIS run and
 * the budget is the host's default for all of them. Then `PI_ENSEMBLE_CYCLE_BUDGET_MS`, a
 * duration; at `"0"` the pre-#2362 order stands and the exported budget outranks the flag.
 * Each of the two durations resolves to an epoch ONCE, with the persisted arm winning
 * while a duration is still set — re-resolving it at every boundary (or on resume)
 * restarts the clock and never parks. A cleared env var clears the deadline's env half:
 * no env input and no flag, no deadline.
 *
 * A malformed value — including an epoch in seconds — is UNSET, traced, never a
 * failure: the deadline is an operator affordance, not a correctness gate.
 */
export function resolveCycleDeadline(
  env: Record<string, string | undefined>,
  persisted: number | undefined,
  now: number,
  flagBudgetMs?: CycleBudgetMs,
): number | undefined {
  return cycleDeadlineVerdict(env, persisted, now, flagBudgetMs)?.resolved;
}

/**
 * What `resolveCycleDeadline` honoured, in the shape the operator-facing line reads — or
 * `undefined` where no arm applies. The ladder lives in `precedence` and is read by BOTH the
 * reader and the warning from this one call, so the line cannot disagree with the run by
 * re-reading the env or comparing epochs: `winner` is the arm the reader picked, `resolved`
 * the epoch the run holds, and `winner === "flag"` the reader's own word that the caller got
 * what they asked for — the only silence besides the switch itself.
 */
export function cycleDeadlineVerdict(
  env: Record<string, string | undefined>,
  persisted: number | undefined,
  now: number,
  flagBudgetMs?: CycleBudgetMs,
): PrecedenceVerdict | undefined {
  const armed = precedence(env, now, flagBudgetMs);
  if (armed === undefined) return undefined;
  // The persisted absolute wins while a duration is set: re-resolving it at
  // every boundary (or on resume) would restart the clock and never park. The record's arm is
  // not the flag's arm, so a resume has something to report only if the env said so.
  const keeps = typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0;
  return {
    winner: armed.winner,
    resolved: keeps ? persisted : armed.deadline,
    flagArm: flagBudgetMs === undefined ? armed.deadline : now + flagBudgetMs,
    envWeighed: armed.envWeighed,
    now: armed.now,
    switchOn: armed.switchOn,
  };
}

/**
 * Read the caller's deadline. `PI_ENSEMBLE_CYCLE_DEADLINE` is an absolute
 * epoch ms. `PI_ENSEMBLE_CYCLE_BUDGET_MS` is a duration resolved to an epoch
 * ONCE; the persisted `pipelineState.cycleDeadlineMs` is used only while the
 * budget is still set, so a resume keeps the budget's clock but a cleared
 * env var clears the deadline (no env var → no deadline, as standalone).
 *
 * Returns the absolute deadline, or undefined. A malformed value — including
 * an epoch in seconds — is treated as unset (traced, never a cycle failure):
 * the deadline is an operator affordance, not a correctness gate.
 */
export function readCycleDeadline(state: WorkState, now: number): number | undefined {
  return resolveCycleDeadline(process.env, state.pipelineState.cycleDeadlineMs, now);
}

/**
 * #1542 — the time left, signed in words: a negative "remained" read as time
 * still in hand, when the deadline had passed an hour earlier.
 */
function remainingText(remaining: number, grace: number): string {
  return remaining >= 0
    ? `${remaining}ms remained, within the ${grace}ms handoff grace`
    : `the deadline had already passed ${-remaining}ms earlier (overdue)`;
}

/**
 * #1542 — which step was refused, and after which one. A develop entered from
 * the adversarial gate is that round's fix pass, not the develop step (which
 * finished long before), and the step that actually ran last is the one the
 * operator should look at.
 */
function refusedStepText(state: WorkState, step: WorkStep): string {
  const log = state.eventLog;
  const fix = step === "develop" ? log[log.length - 1] : undefined;
  const what =
    fix?.kind === "adversarial-fix-requested"
      ? `the adversarial round ${fix.round} fix pass ("develop") not started`
      : `step "${step}" not started`;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && e.step !== "handoff") {
      return `${what}; the last step that ran was "${e.step}"`;
    }
  }
  return what;
}

/**
 * The pre-step boundary check (#1238). Parks with cap `deadline` (routing to
 * handoff) once `now + handoff grace >= deadline`, and with `deadline:no-fit`
 * when some useful time is left but less than the step's `MIN_USEFUL_MS`. A
 * step's own worst-case bound is not reserved: a step that fits is clamped to
 * the time left (cycle-deadline-clock.ts). Returns `{ parked, state, deadline }`; `state` carries the
 * resolved deadline (persisted so a budget resolves exactly once), or drops
 * a stale persisted one when no deadline applies any more.
 *
 * Never parks `handoff` (the comment is the whole point) or `merged` (its
 * in-process `gh` evidence is fast; parking a green PR would defeat it).
 */
export async function deadlineCheck(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
  now: number,
): Promise<{ parked: boolean; state: WorkState; deadline?: number }> {
  void ctx; // the caller persists the returned state; the check itself never writes
  const deadline = readCycleDeadline(state, now);
  // #1593 — the children this step spawns are bounded by what the deadline leaves.
  noteCycleDeadline(deadline, handoffDispatchTimeoutMs(), step);
  if (deadline === undefined) {
    const s = step === "handoff" ? terminalReasonAtHandoff(state, undefined, now) : state;
    if (s.pipelineState.cycleDeadlineMs === undefined) return { parked: false, state: s };
    const { cycleDeadlineMs: _stale, ...ps } = s.pipelineState;
    return { parked: false, state: { ...s, pipelineState: ps } };
  }
  const next =
    state.pipelineState.cycleDeadlineMs === deadline
      ? state
      : { ...state, pipelineState: { ...state.pipelineState, cycleDeadlineMs: deadline } };
  if (step === "handoff") {
    // #1593 — a step that ended past the deadline, or on a backstop kill, does
    // not leave its own verdict standing as the cycle's terminal reason.
    return {
      parked: false,
      state: terminalReasonAtHandoff(next, deadline, now, handoffDispatchTimeoutMs()),
      deadline,
    };
  }
  if (step === "merged") return { parked: false, state: next, deadline };
  const grace = handoffDispatchTimeoutMs();
  const remaining = deadline - now;
  const useful = remaining - grace;
  const need = MIN_USEFUL_MS[step] ?? 0;
  if (useful > 0 && useful >= need) return { parked: false, state: next, deadline };
  const noFit = useful > 0;
  trace(
    `work-driver: deadline park before ${step} — ${useful}ms useful (remaining ${remaining}ms − handoff grace ${grace}ms), step needs ${need}ms (deadline ${deadline})`,
  );
  const capped = appendEvent(next, {
    kind: "cap-hit",
    at: now,
    cap: noFit ? "deadline:no-fit" : "deadline",
    reviewRound: next.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: noFit
      ? `caller deadline ${deadline} (absolute epoch ms); ${useful}ms of useful time remained after the ${grace}ms handoff grace, and "${step}" needs at least ${need}ms — ${refusedStepText(next, step)}`
      : `caller deadline ${deadline} (absolute epoch ms); ${remainingText(remaining, grace)} — ${refusedStepText(next, step)}`,
  });
  return { parked: true, state: capped, deadline };
}

/**
 * The loop-side deadline boundary handler (#1238). Runs `deadlineCheck` and
 * returns the state the loop continues with. When the check parks, the
 * capped state is persisted with `currentStep: "handoff"` (so the comment
 * posts before the caller's kill) and the operator is notified; the caller
 * sees the step change and `continue`s. Otherwise the returned state carries
 * the resolved deadline (persisted once, when it first appears), so a budget
 * resolves exactly once per cycle.
 */
export async function parkAtDeadlineBoundary(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<WorkState> {
  const checked = await deadlineCheck(ctx, state, step, Date.now());
  if (!checked.parked) {
    if (checked.state !== state) await persistCycle(ctx, checked.state);
    return checked.state;
  }
  const last = checked.state.eventLog[checked.state.eventLog.length - 1];
  const why =
    last?.kind === "cap-hit" && last.cap === "deadline:no-fit"
      ? `too little time is left before the caller's deadline for ${step} to do useful work`
      : "the caller's deadline is within the handoff grace";
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} parked at the ${step} boundary — ${why}, so no new step starts. Routing to handoff so the comment posts before the deadline.`,
  );
  const toHandoff: WorkState = {
    ...checked.state,
    pipelineState: { ...checked.state.pipelineState, currentStep: "handoff" },
  };
  await persistCycle(ctx, toHandoff);
  return toHandoff;
}

/**
 * #1593 — run a cycle under its own deadline clock (cycle-deadline-clock.ts):
 * every child it spawns is then bounded by the deadline the boundary check
 * resolved, and the handoff's by the allowance after it.
 */
export function withCycleClock<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCycleClock(fn);
}

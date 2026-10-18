/**
 * work-driver-deadline — the caller-set whole-cycle deadline (#1238).
 *
 * The driver bounds steps (spawn backstop, inactivity, verify, handoff, the
 * 90-min review loop) but had no bound for the cycle as a whole, and no way
 * for the caller to give it one. An unattended caller has to bound the cycle
 * itself — orchard does it with a 6-hour `docker stop`, which lands MID-STEP:
 * aborted jobs, state left at `status: running`, no handoff, no comment
 * (example-owner/orchard#47/#61, #119).
 *
 * This is the driver-side half: the caller sets `PI_ENSEMBLE_CYCLE_DEADLINE`
 * (an absolute epoch ms) or `PI_ENSEMBLE_CYCLE_BUDGET_MS` (resolved to an
 * epoch once, then persisted in `pipelineState.cycleDeadlineMs`).
 *
 * Semantics: the deadline is where step work ends; only the handoff runs
 * after it. The caller sets it to its hard kill minus its handoff allowance
 * and passes that allowance as `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` (#1593, the
 * example-owner/orchard#355 contract), so the handoff has the allowance to itself.
 *
 * - At each step boundary the driver parks with cap `deadline` (and routes
 *   to handoff) once `now + handoff grace >= deadline`: a step that would
 *   have less than the grace to run is not started. A step's worst-case
 *   bound is not reserved — those bounds are backstops measured in hours.
 * - A step already running when the deadline arrives does not run on: every
 *   child the cycle spawns is bounded by what the deadline leaves, and the
 *   handoff's child by the allowance after it (cycle-deadline-clock.ts).
 *   Before #1593 such a step ran to its own backstop, into the caller's kill.
 * - A step that ends past the deadline does not get to name the cycle's
 *   terminal reason: the handoff boundary records `deadline` after its
 *   verdict (work-driver-terminal-reason.ts).
 * - The handoff step itself is never parked.
 * - No env var set → no deadline: the default behaviour is unchanged.
 */

import { notifyAgent } from "./agent-message.ts";
import { noteCycleDeadline, runWithCycleClock } from "./cycle-deadline-clock.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
import { terminalReasonAtHandoff } from "./work-driver-terminal-reason.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/** Below this an epoch is in seconds, not ms (1e12 ms is September 2001). */
const EPOCH_MS_FLOOR = 1e12;

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
  const abs = process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  if (abs !== undefined && abs !== "") {
    const v = Number(abs);
    if (Number.isFinite(v) && v >= EPOCH_MS_FLOOR) return v;
    trace(
      Number.isFinite(v) && v > 0
        ? `work-driver: PI_ENSEMBLE_CYCLE_DEADLINE=${abs} looks like epoch SECONDS — it must be epoch ms; ignored`
        : `work-driver: PI_ENSEMBLE_CYCLE_DEADLINE=${abs} is not a finite positive epoch ms — ignored`,
    );
    return undefined;
  }
  const budget = process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  if (budget === undefined || budget === "") return undefined;
  const v = Number(budget);
  if (!Number.isFinite(v) || v <= 0) {
    trace(
      `work-driver: PI_ENSEMBLE_CYCLE_BUDGET_MS=${budget} is not a finite positive duration — ignored`,
    );
    return undefined;
  }
  // The persisted absolute wins while the budget is set: re-resolving it at
  // every boundary (or on resume) would restart the clock and never park.
  const persisted = state.pipelineState.cycleDeadlineMs;
  if (typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0) {
    return persisted;
  }
  return now + v;
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
 * handoff) once `now + handoff grace >= deadline` — the deadline means "do
 * not start a new step after this point", so a step's own worst case is not
 * reserved. Returns `{ parked, state, deadline }`; `state` carries the
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
    return { parked: false, state: terminalReasonAtHandoff(next, deadline, now), deadline };
  }
  if (step === "merged") return { parked: false, state: next, deadline };
  const grace = handoffDispatchTimeoutMs();
  const remaining = deadline - now;
  if (now + grace < deadline) return { parked: false, state: next, deadline };
  trace(
    `work-driver: deadline park before ${step} — remaining ${remaining}ms <= handoff grace ${grace}ms (deadline ${deadline})`,
  );
  const capped = appendEvent(next, {
    kind: "cap-hit",
    at: now,
    cap: "deadline",
    reviewRound: next.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `caller deadline ${deadline} (absolute epoch ms); ${remainingText(remaining, grace)} — ${refusedStepText(next, step)}`,
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
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} parked at the ${step} boundary — the caller's deadline is within the handoff grace, so no new step starts. Routing to handoff so the comment posts before the deadline.`,
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

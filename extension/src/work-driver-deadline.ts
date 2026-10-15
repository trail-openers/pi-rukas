/**
 * work-driver-deadline — the caller-set whole-cycle deadline (#1238).
 *
 * The driver bounds steps (spawn backstop, inactivity, verify, handoff, the
 * 90-min review loop) but had no bound for the cycle as a whole, and no way
 * for the caller to give it one. An unattended caller has to bound the cycle
 * itself — tehas does it with a 6-hour `docker stop`, which lands MID-STEP:
 * aborted jobs, state left at `status: running`, no handoff, no comment
 * (janit/tehas#47/#61, #119).
 *
 * This is the driver-side half: the caller sets `PI_ENSEMBLE_CYCLE_DEADLINE`
 * (an absolute epoch ms) or `PI_ENSEMBLE_CYCLE_BUDGET_MS` (resolved to an
 * epoch once, then persisted in `pipelineState.cycleDeadlineMs`).
 *
 * Semantics: the deadline means "do not START a new step after this point".
 * At each step boundary the driver parks with cap `deadline` (and routes to
 * handoff) once `now + handoff grace >= deadline`. It does not reserve a
 * step's worst-case bound — those bounds are backstops measured in hours,
 * and reserving them would park a 6-hour cycle after 3. A step that started
 * before the deadline may finish past it; the caller picks the deadline with
 * its own margin (its hard kill minus its longest tolerable step).
 *
 * - NO mid-step hard kill: the check runs at the step boundary only.
 * - The handoff grace (`handoffDispatchTimeoutMs()`) is kept back so the
 *   park's handoff comment posts before the deadline. The handoff step
 *   itself runs with its full bound and is never parked.
 * - No env var set → no deadline: the default behaviour is unchanged.
 */

import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
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
  if (deadline === undefined) {
    if (state.pipelineState.cycleDeadlineMs === undefined) return { parked: false, state };
    const { cycleDeadlineMs: _stale, ...ps } = state.pipelineState;
    return { parked: false, state: { ...state, pipelineState: ps } };
  }
  const next =
    state.pipelineState.cycleDeadlineMs === deadline
      ? state
      : { ...state, pipelineState: { ...state.pipelineState, cycleDeadlineMs: deadline } };
  if (step === "handoff" || step === "merged") {
    return { parked: false, state: next, deadline };
  }
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
    evidence:
      `caller deadline ${deadline} (absolute epoch ms); ${remaining}ms remained, ` +
      `within the ${grace}ms handoff grace — step "${step}" not started`,
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

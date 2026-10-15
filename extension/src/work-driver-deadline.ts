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
 * (an absolute epoch ms, so it survives a resume) or `PI_ENSEMBLE_CYCLE_BUDGET_MS`
 * (resolved to an epoch once, at cycle start, then persisted in
 * `pipelineState.cycleDeadlineMs`). Before EACH step the driver asks
 * `deadlineCheck`: if the step cannot finish before the deadline (its own
 * bound + the handoff grace would cross it), the driver parks with cap
 * `deadline` and a handoff that says where the work is.
 *
 * Design constraints (see the issue):
 *
 * - The deadline is a FLOOR that parks, never a lower bound: every existing
 *   per-step bound still applies, unchanged.
 * - NO mid-step hard kill: the check runs at the step boundary only. A step
 *   that started before the deadline is allowed to run out its own bound;
 *   the boundary check parks the NEXT step.
 * - The handoff grace: `handoffDispatchTimeoutMs()` is kept back from the
 *   deadline, so the handoff comment is posted BEFORE the caller kills the
 *   process — the whole point of the feature (the tehas incident was a kill
 *   with no handoff, not a kill with a late one). `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`
 *   itself is never lowered: the grace is only the amount kept back, and
 *   the handoff step runs with its full bound.
 * - The check is a no-op when no deadline is set: the default behaviour is
 *   unchanged.
 */

import { notifyAgent } from "./agent-message.ts";
import { spawnBackstopMs } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import { type CycleContext, REVIEW_WALL_CLOCK_MS } from "./work-driver-context.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * The review loop's per-pass bound, used for the review/fix/re-adversarial
 * steps. The 90-minute wall clock is the loop's TOTAL, so a single pass
 * cannot spend more than that on itself — the conservative reading of
 * "the step's own bound" for those steps.
 */
const REVIEW_PASS_BOUND_MS = REVIEW_WALL_CLOCK_MS;

/** The verify command's own bound (0 when unset), for develop / ci. */
function verifyTimeoutMs(): number {
  const v = Number(process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The step's own bound, in ms. The dispatch steps are bounded by the spawn
 * backstop; develop and ci add the verify command's bound (the dispatch and
 * the verify run back to back). The lens / fix / re-adversarial passes are
 * bounded by the review loop's wall clock. `handoff` and `merged` are
 * special-cased by the caller (the grace / the in-process merge gate) and
 * are not consulted as a parking bound.
 */
function stepOwnBoundMs(step: WorkStep): number {
  switch (step) {
    case "develop":
    case "ci":
      return spawnBackstopMs() + verifyTimeoutMs();
    case "lens-review":
    case "lens-fix":
    case "adversarial":
      return REVIEW_PASS_BOUND_MS;
    default:
      // explore, plan, branch, commit-pr, step-back: a single dispatch
      // bounded by the spawn backstop (merged / handoff are never asked).
      return spawnBackstopMs();
  }
}

/**
 * Read the caller's deadline. `PI_ENSEMBLE_CYCLE_DEADLINE` is an absolute
 * epoch ms (survives resume by construction). `PI_ENSEMBLE_CYCLE_BUDGET_MS`
 * is a duration resolved to an epoch ONCE, then persisted in
 * `pipelineState.cycleDeadlineMs` so a resumed cycle keeps the same absolute
 * deadline (re-resolving the budget would restart the clock).
 *
 * Returns the absolute deadline, or undefined when nothing is set (no
 * deadline — the default, unchanged behaviour). A malformed value is
 * treated as unset (traced, never a cycle failure): the deadline is an
 * operator affordance, not a correctness gate.
 */
export function readCycleDeadline(state: WorkState, now: number): number | undefined {
  const abs = process.env.PI_ENSEMBLE_CYCLE_DEADLINE;
  if (abs !== undefined && abs !== "") {
    const v = Number(abs);
    if (Number.isFinite(v) && v > 0) return v;
    trace(
      `work-driver: PI_ENSEMBLE_CYCLE_DEADLINE=${abs} is not a finite positive epoch ms — ignored`,
    );
    return undefined;
  }
  const budget = process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  if (budget !== undefined && budget !== "") {
    const v = Number(budget);
    if (Number.isFinite(v) && v > 0) return now + v;
    trace(
      `work-driver: PI_ENSEMBLE_CYCLE_BUDGET_MS=${budget} is not a finite positive duration — ignored`,
    );
    return undefined;
  }
  const persisted = state.pipelineState.cycleDeadlineMs;
  return typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0
    ? persisted
    : undefined;
}

/**
 * The pre-step boundary check (#1238). Before each step the driver asks
 * whether that step can finish before the deadline: its own bound + the
 * handoff grace (the comment must post before the caller kills). When it
 * cannot, the cycle parks with cap `deadline` and routes to handoff.
 *
 * Returns `{ parked: true, state }` when the cycle must park (the caller
 * persists, notifies, and the loop routes to handoff via the cap-hit), or
 * `{ parked: false, state, deadline }` when the step may run (with the
 * resolved deadline persisted so a budget resolves exactly once).
 *
 * The check is a NO-OP for: no deadline set; the `handoff` step itself (the
 * grace IS the handoff's bound, and the comment is the whole point); the
 * `merged` step (its in-process `gh` evidence is fast, and parking a green
 * PR over a boundary race would defeat the caller's deadline).
 */
export async function deadlineCheck(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
  now: number,
): Promise<{ parked: boolean; state: WorkState; deadline?: number }> {
  void ctx; // the caller persists the returned state; the check itself never writes
  const deadline = readCycleDeadline(state, now);
  if (deadline === undefined) return { parked: false, state };
  // Persist the resolved deadline (budget → absolute) so a resume keeps it.
  const next =
    state.pipelineState.cycleDeadlineMs === deadline
      ? state
      : { ...state, pipelineState: { ...state.pipelineState, cycleDeadlineMs: deadline } };
  if (step === "handoff" || step === "merged") {
    return { parked: false, state: next, deadline };
  }
  const bound = stepOwnBoundMs(step);
  const grace = handoffDispatchTimeoutMs();
  const remaining = deadline - now;
  if (remaining < bound + grace) {
    trace(
      `work-driver: deadline park before ${step} — remaining ${remaining}ms < bound ${bound}ms + handoff grace ${grace}ms (deadline ${deadline})`,
    );
    const capped = appendEvent(next, {
      kind: "cap-hit",
      at: now,
      cap: "deadline",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence:
        `caller deadline ${deadline} (absolute epoch ms); ${remaining}ms remained; ` +
        `step "${step}" needs ~${bound}ms plus the ${grace}ms handoff grace`,
    });
    return { parked: true, state: capped, deadline };
  }
  return { parked: false, state: next, deadline };
}

/**
 * The loop-side deadline boundary handler (#1238). Runs `deadlineCheck` and,
 * when it parks, persists the capped state, notifies the operator, points the
 * loop at `handoff` (so the comment posts before the caller's kill), and
 * returns `true` — the caller `continue`s so the handoff runs before the
 * next boundary re-check. `false` means the step may proceed (the deadline,
 * if any, was persisted on the returned state via the check's output, which
 * the caller assigns before calling this for the parking case only — on the
 * non-park path the caller re-persists the same state on its normal boundary
 * write, so the deadline lands on disk either way).
 */
export async function parkAtDeadlineBoundary(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<boolean> {
  const checked = await deadlineCheck(ctx, state, step, Date.now());
  if (!checked.parked) return false;
  const capped = checked.state;
  await persistCycle(ctx, capped);
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} parked at the ${step} boundary — the caller's deadline left less than this step's bound plus the handoff grace. Routing to handoff so the comment posts before the deadline.`,
  );
  const toHandoff: WorkState = {
    ...capped,
    pipelineState: { ...capped.pipelineState, currentStep: "handoff" },
  };
  await persistCycle(ctx, toHandoff);
  return true;
}

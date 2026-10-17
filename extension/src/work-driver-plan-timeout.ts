/**
 * work-driver-plan-timeout — the plan step's own timing bound (#754) and the
 * corrective re-dispatch prompt both corrective paths compose.
 *
 * Split from work-driver-plan-helpers.ts for the AGENTS.md §12 500-line gate —
 * the same seam helpers.ts itself is to work-driver-plan.ts. helpers.ts had
 * accumulated the quality gate, every steer builder, the dropped-edge check,
 * the whole #754 corrective path and (with #819) the plan-to-spec gate's
 * helpers, and the additions pushed it past the cap. Content is byte-identical
 * to the former in-place definitions; work-driver-plan-helpers.ts re-exports
 * them so importers keep their paths.
 */

import path from "node:path";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import type { DriverHost } from "./work-driver-host.ts";
import { buildCompletionEvent, overrideEnvForKillCause } from "./work-driver-merged.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkEvent, type WorkState, type WorkStep, appendEvent } from "./workflow-state.ts";

// #754 — the steer for the corrective re-dispatch after a PRIMARY plan
// dispatch killed at the step's own bound. A timeout says nothing about
// decomposition, so it is deliberately a SEPARATE steer from
// correctivePlanSteer: steering a killed planner toward MORE workstreams is
// the forced-split pressure #819 measured as wrong-work. It re-states the
// single deliverable (one concise workstreams block covering the spec) and
// keeps the plan's scope intact.
export function correctivePlanTimeoutSteer(timeoutMs: number): string {
  return [
    "## Corrective re-dispatch (plan timeout)",
    "",
    `Your previous planning attempt exceeded its wall-clock bound (${Math.round(timeoutMs / 60_000)} min) and was killed; it produced no plan.`,
    "This is NOT a signal that the issue needs more or fewer workstreams.",
    "Re-plan now, working from the issue body and spec already in front of you.",
    "Return ONE concise '## Workstreams' block whose workstream(s) cover the spec's deliverables,",
    "and do not change WHAT is built. Then stop.",
  ].join("\n");
}

// #754 — the plan step's own wall-clock bound. The compiled /plan pipeline
// already bounds every planning child with PLAN_DISPATCH_TIMEOUT_MS (30 min,
// plan-investigate.ts) — the SAME activity in the SAME repo — but the work
// driver's plan step never adopted it: both the primary and corrective plan
// dispatches rode the 2-hour global spawn backstop, and on the #742 cycle a
// 266-turn planning loop burned 120 of the cycle's 140 minutes before the
// backstop killed it — for a corrective re-plan that then finished the same
// decomposition in 37 s. This bound is deliberately the same 30 minutes
// (in-repo precedent, not a fresh measurement): it leaves ~48x headroom over
// the observed legitimate planning duration while capping the pathological
// case at a quarter of its old cost.
//
// It applies to the PRIMARY plan dispatch only — the corrective re-dispatch
// is the recovery path this bound exists to feed, and bounding it too could
// kill the 37-second corrective and any legitimately longer re-plan. It is
// a DISTINCT env var from PI_ENSEMBLE_SPAWN_TIMEOUT_MS (which stays global
// and role-agnostic — test-spawn-bounds.ts asserts that), and the global
// backstop is untouched for every other step.
export function planDispatchTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_PLAN_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60_000;
}

/**
 * #754 — the DispatchResult the plan step emits when the primary dispatch was
 * killed at a wall-clock bound: the structured plan-timeout cause is derived
 * AT THE CALL SITE from the expired per-call timeoutMs, because
 * resolveKillCause has no input for "which per-call bound expired" and stays
 * a pure function of the child-process cap facts. The rewritten result flows
 * through buildCompletionEvent unchanged, so the dispatch-failed event
 * carries usage (turns + cache volume), killBudgetMs and the operator-facing
 * errorTail. A killed dispatch never produces a structured result — the
 * corrective re-dispatch is the recovery.
 */
export function planTimeoutKill(
  result: DispatchResult,
  opts: { timeoutMs?: number },
): DispatchResult | undefined {
  if (!result || result.killCause !== "timeout" || !opts.timeoutMs) return undefined;
  return {
    ...result,
    ok: false,
    killCause: "plan-timeout",
    killBudgetMs: opts.timeoutMs,
  };
}

/**
 * #754 — the structured cause `buildCompletionEvent` renders for a killed
 * dispatch, widened (from the primary's "the plan step's own bound") to any
 * kill cause, so the corrective's kill names the trigger that actually fired
 * (backstop / loop / token-budget / abort) instead of a misleading bound.
 */
export function planKillDetail(result: DispatchResult): string {
  const knob = overrideEnvForKillCause(result.killCause ?? "timeout");
  switch (result.killCause) {
    case "loop": {
      const ev = result.loopEvidence;
      const what = ev
        ? `${ev.tool} × ${ev.count} (normalised args)`
        : "the same tool call after normalisation";
      return `[pi-rukas] killed on loop — it kept re-issuing ${what} (override: ${knob})`;
    }
    case "token-budget": {
      const tb = result.tokenBudget;
      const budgetClause = tb
        ? `${Math.round(tb.used).toLocaleString()} of ${Math.round(tb.budget).toLocaleString()} tokens`
        : "its cumulative token budget";
      return `[pi-rukas] killed on token-budget — ${budgetClause} (override: ${knob})`;
    }
    case "abort":
      return "[pi-rukas] cancelled (abort signal)";
    case "plan-timeout":
      return `[pi-rukas] killed after ${result.killBudgetMs}ms — the plan step's own wall-clock bound expired (override: ${knob})`;
    default:
      return `[pi-rukas] killed after ${result.killBudgetMs}ms ${result.killCause} (override: ${knob})`;
  }
}

/**
 * #819 round-2 — the failure event a plan dispatch carries when it was KILLED
 * by one of the driver's own caps. `buildCompletionEvent` already turns a
 * `killCause` into a `dispatch-failed`, but it derives that event from the
 * result it is handed; the corrective path needs the same shape for causes the
 * plan bound did not set. Kept as a helper (rather than reusing
 * `buildCompletionEvent`) because the kill branch there keys its prose on
 * `killCause === "plan-timeout"` and this call site must name the ACTUAL
 * trigger — a loop kill must not be reported as the plan bound expiring.
 */
export function planKillFailureEvent(
  step: WorkStep,
  role: string,
  label: string,
  result: DispatchResult,
): Extract<WorkEvent, { kind: "dispatch-failed" }> {
  return withUsage(
    {
      kind: "dispatch-failed",
      step,
      role,
      jobId: result.transcriptPath ? path.basename(result.transcriptPath, ".json") : "unknown",
      label,
      ms: result.ms,
      at: Date.now(),
      exitCode: result.exitCode ?? null,
      errorTail: planKillDetail(result),
      killCause: result.killCause,
      ...(result.killCause === "loop" && result.loopEvidence
        ? { loopEvidence: result.loopEvidence }
        : {}),
      ...(result.killCause === "token-budget" && result.tokenBudget
        ? { tokenBudget: result.tokenBudget }
        : {}),
    },
    result.usage,
  );
}

/**
 * #754 — the one-shot corrective re-dispatch after a PRIMARY plan dispatch
 * killed at the step's own bound. A killed child has no structured output
 * (parseWorkstreams would return nothing), so the corrective is the recovery
 * path. It carries the timeout steer — NOT correctivePlanSteer: a timeout
 * says nothing about decomposition, and steering a killed planner toward
 * MORE workstreams is the forced-split pressure that produced the wrong-work
 * shape #819. The corrective is NEVER re-dispatched again: if it fails or is
 * killed itself, its dispatch-failed is the step's tail and the router's
 * `plan-timeout` cap halts to handoff. The caller applies the one-shot
 * corrective budget by skipping the #290 quality gate after this runs.
 */
export async function planTimeoutCorrective(
  ctx: CycleContext,
  pi: DriverHost,
  dispatch:
    | NonNullable<DriverContext["dispatchFn"]>
    | ((
        pi: DriverHost,
        spec: { role: string; prompt: string },
        opts: { label: string; timeoutMs?: number },
      ) => Promise<DispatchResult>),
  prompt: string,
  planKill: DispatchResult,
  workState: WorkState,
  parseWorkstreams: (
    text: string,
  ) => Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }>,
  planCorrectivePrompt: (prompt: string, steer: string) => string,
): Promise<{
  ok: boolean;
  state: WorkState;
  workstreams: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }>;
}> {
  let state = workState;
  trace(
    `work-driver: plan dispatch killed (${planKill.killCause ?? "unknown cause"}, bound ${planKill.killBudgetMs}ms) — corrective re-dispatch (timeout steer)`,
  );
  const steer = correctivePlanTimeoutSteer(planKill.killBudgetMs ?? 0);
  const correctivePrompt = planCorrectivePrompt(prompt, steer);
  const retry = await dispatch(
    pi,
    { role: "explore", prompt: correctivePrompt },
    { label: "plan:corrective" },
  ).catch(() => undefined);
  // #819 round-2 — a corrective that was KILLED (any structured cause) or
  // whose dispatch THREW must route like the PRIMARY's kill, not be judged as
  // a plan. `ok: false` alone is not enough: the quality and plan-to-spec
  // gates below used to run over `retry.text` regardless, so a killed
  // corrective — which by definition produced no structured output — was fed
  // to `planSpecMismatchReason` and capped as `plan-spec-mismatch` on the
  // silence of a child we killed mid-stream. That is the "silence is not a
  // wrong plan" rule (#378) inverted: the gate's rejection would be an
  // invention of the driver, not a finding about the planner. The step ends on
  // a `dispatch-failed` tail so the router's plan caps own it.
  if (retry?.killCause) {
    state = appendEvent(state, planKillFailureEvent("plan", "explore", "plan:corrective", retry));
    return { ok: false, state, workstreams: {} };
  }
  if (!retry) {
    state = appendEvent(state, {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: "unknown",
      label: "plan:corrective",
      ms: 0,
      at: Date.now(),
      exitCode: null,
      errorTail: "[pi-rukas] the one-shot corrective plan dispatch threw and produced no result",
    });
    return { ok: false, state, workstreams: {} };
  }
  {
    state = appendEvent(
      state,
      await buildCompletionEvent(ctx, "plan", "explore", "plan:corrective", retry),
    );
    const reparsed = parseWorkstreams(retry.text ?? "");
    const workstreams = Object.keys(reparsed).length > 0 ? reparsed : ({} as typeof reparsed);
    return { ok: true, state, workstreams };
  }
}

/**
 * #657 — the corrective plan re-dispatch prompt. The historical-context note
 * lives here (at the corrective call path, NOT inside the shared steer
 * builders) so it applies ONLY to corrective re-dispatches: a weak model in
 * the #657 post-mortem read a stale `cross-group-conflict` reference as a
 * live unsatisfiable precondition, re-verified it with two gh/git commands
 * 530+ times, and burned 73.5M cache tokens before the wall-clock kill —
 * twice.
 */
export function planCorrectivePrompt(prompt: string, steer: string): string {
  const historicalNote = [
    "NOTE: any prior-handoff or prior-conflict references in your context (e.g. an earlier",
    "`cross-group-conflict` or overlapping-paths finding from a previous cycle) are HISTORICAL",
    "records, not live preconditions. Do NOT re-verify them (no `gh issue view`, no `git",
    "merge-base` checks on them) and do NOT let them block your plan. If the referenced",
    "issue/commit is no longer relevant, simply proceed with your decomposition. Your job is",
    "the decomposition itself — emit your final report once it is complete and stop.",
  ].join(" ");
  return `${prompt}\n\n${steer}\n\n${historicalNote}`;
}

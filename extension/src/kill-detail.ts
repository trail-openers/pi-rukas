/**
 * kill-detail — say out loud that we killed the child.
 *
 * When a subagent is SIGTERM'd, `buildCompletionEvent` records the cause on
 * the `dispatch-failed` event: `killCause` ("timeout" | "inactivity" | "abort")
 * and an `errorTail` naming the budget and the override knob. Nothing rendered
 * either of them. `grep errorTail` across all three handoff surfaces returned
 * zero hits, so the operator was told only that a step "failed" and could not
 * distinguish a wall-clock kill from a crash, a 429, or a provider error
 * without opening the state file by hand.
 *
 * That is how nessie #686 and #693 — both killed at 31m08s having produced
 * nothing — arrived at their operator described as issue-quality problems,
 * inviting the editing of two perfectly good issues.
 *
 * The distinction matters because the three causes need different responses:
 * a `timeout` means the work is too large for one child, `inactivity` means
 * the child went genuinely silent, and `abort` means we cancelled it.
 */

import type { WorkEvent, WorkState } from "./workflow-state.ts";

type KillDetailEvent = {
  kind: "dispatch-failed";
  killCause?: string;
  loopEvidence?: { tool: string; count: number; kind?: "streak" | "success" };
};

const WHY: Record<string, string> = {
  timeout:
    "hit the wall-clock backstop — that only catches runaway loops, so this means the work needs splitting or manual takeover",
  inactivity:
    "produced no output at all for the watchdog window — a genuine hang, or a provider stall that outlasted every retry",
  abort: "was cancelled",
  // #543 — the F1 loop detector and F6 token budget are OUR caps, distinct
  // from a wall-clock timeout: a repeating call was detected structurally,
  // so "split the work" does not apply (re-issuing the same prompt loops again).
  loop: "was looped on — it repeated the same tool call after normalisation, so the harness killed it before it burned more budget; changing approach (not retrying) is the fix",
  // #772 — the success-keyed variant: a distinct incident (re-issuing an
  // already-green command with identical output, non-adjacent repetition the
  // streak counter cannot see). The WHY line must match the new report
  // headline so the operator is not sent after the wrong cause.
  "loop-success":
    "was looped on — it re-issued an already-successful command with identical output, so the harness killed it before it burned more budget; changing approach (not retrying) is the fix",
  "token-budget":
    "crossed its token budget — a cost cap, not a provider fault; the budget is PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>, not the inactivity knob",
  // #754 — the plan step's own 30-minute bound (the bound the compiled /plan
  // pipeline already adopts via PLAN_DISPATCH_TIMEOUT_MS) expired on the
  // primary plan dispatch. Distinct wording from the global backstop on
  // purpose: planning either converges quickly or is not converging, and the
  // operator must not be told the ISSUE is the problem (the observed
  // corrective re-plan on the incident cycle finished in 37 s).
  "plan-timeout":
    "hit the plan step's own wall-clock bound (PI_ENSEMBLE_PLAN_TIMEOUT_MS, default 30 min) — the bound is on planning, not on the issue: a decomposition either converges quickly or is not converging, and the corrective re-plan the driver attempted did not recover",
};

/**
 * Lines describing the most recent self-kill, or `[]` when nothing was killed.
 *
 * Returned as lines rather than a string so callers can indent them into
 * whichever surface they are building.
 */
export function killDetail(state: WorkState): string[] {
  const killed = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "dispatch-failed" }> =>
        e.kind === "dispatch-failed" && Boolean(e.killCause),
    );
  if (!killed?.killCause) return [];
  // #772 — a success-keyed loop kill gets its own WHY line (matching the
  // report headline), not the generic loop wording.
  const why =
    WHY[
      killed.killCause === "loop" && killed.loopEvidence?.kind === "success"
        ? "loop-success"
        : killed.killCause
    ] ?? "was killed by the harness";
  const tail = killed.errorTail?.trim();
  return [
    `# The ${killed.role ?? "subagent"} on step \`${killed.step}\` ${why}.`,
    ...(tail ? [`#   ${tail.split("\n")[0]?.slice(0, 200)}`] : []),
    "#   This is OUR kill, not a provider failure and not a bad issue.",
    "",
  ];
}

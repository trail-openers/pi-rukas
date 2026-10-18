/**
 * work-driver-continue-pr-commit — #1468: commit-pr's stops for
 * `--continue-pr`. The continued PR is refreshed in place or the cycle
 * stops: the ops fallback and `prCreate` would open a second PR.
 */

import type { CycleContext } from "./work-driver-context.ts";
import { continuePrDevelopProblems, continuedHeadMoved } from "./work-driver-continue-pr-guard.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

type Halt = { ok: false; terminal: true; reason: string; haltedAfter: WorkState };

function halt(state: WorkState, cap: WorkCapLiteral, reason: string): Halt {
  const haltedAfter = appendEvent(
    state,
    { kind: "plumb-report", at: Date.now(), step: "commit-pr", role: "driver", body: reason },
    {
      kind: "cap-hit",
      at: Date.now(),
      cap,
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence: reason,
    },
  );
  return { ok: false, terminal: true, reason, haltedAfter };
}

/** Refuse to push a worktree whose merge is unfinished or was rewritten. */
export async function continueCommitPrPrecheck(
  execFn: ExecFn,
  state: WorkState,
): Promise<Halt | undefined> {
  const cp = state.pipelineState.continuedPr;
  if (!cp) return undefined;
  const problems: string[] = [];
  for (const wt of Object.values(state.pipelineState.worktrees ?? {})) {
    problems.push(...(await continuePrDevelopProblems(execFn, wt, cp)));
  }
  if (problems.length === 0) return undefined;
  return halt(
    state,
    "continue-pr-unresolved",
    `Continue-PR #${cp.number} was not pushed: ${problems.join("; ")}.`,
  );
}

/**
 * A non-terminal commit-pr failure in continue mode. A moved head is
 * `continue-pr-head-moved`; anything else is `step-failed:commit-pr`.
 */
export async function continueCommitPrHalt(
  ctx: CycleContext,
  state: WorkState,
  reason: string,
  execFn: ExecFn,
): Promise<WorkState> {
  const moved = await continuedHeadMoved(execFn, ctx.repoRoot, state.pipelineState);
  const cap = moved ? "continue-pr-head-moved" : "step-failed:commit-pr";
  const why = moved ? `${moved}. ${reason}` : reason;
  return halt(state, cap, `Continue-PR commit-pr stopped without the ops fallback: ${why}`)
    .haltedAfter;
}

/** The belt before `prCreate`: a continued PR never gets a second one. */
export function continuePrCreateRefusal(state: WorkState): Halt {
  const n = state.pipelineState.continuedPr?.number;
  return halt(
    state,
    "step-failed:commit-pr",
    `Continue-PR #${n} reached PR creation; refused, a second PR is never opened.`,
  );
}

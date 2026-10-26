/**
 * work-driver-explain-deadline — the DEADLINE family of cap sentences, split out
 * of work-driver-explain.ts (AGENTS.md §12: a 500-line source file is split along
 * a natural seam rather than compressed).
 *
 * The family is the caps whose cause is the CALLER's clock rather than anything in
 * the cycle: `deadline` (#1238 / #1593), `deadline:no-fit` (#1567), and the
 * per-child run bound `child-timeout:*` (#1560). They share one recovery shape —
 * the handoff says where the work is and the operator re-runs with the deadline
 * raised or cleared — which is exactly why they belong in one file rather than
 * scattered through the switch: an operator reading any of them needs the same
 * three facts (what stopped, where the work is, what to change), and a fourth
 * deadline-shaped cap that forgets to say "nothing was destroyed" is the bug this
 * seam exists to keep from happening.
 *
 * The three variants of `deadline` are chosen on the cap's EVIDENCE rather than a
 * stored discriminator, and the wording differs for a reason: a step that was
 * stopped mid-flight judged unfinished work, a deadline that had already passed at
 * a step boundary, and a deadline within the handoff grace are three different
 * things to tell an operator, and collapsing them to one sentence would hide which
 * of the three happened. `child-timeout` names its own bound instead, because that
 * one is per-role and tunable.
 */

import { childBoundGraceMs } from "./spawn-child-bound.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/** `deadline` — the caller's whole-cycle deadline stopped the cycle (#1238, #1593). */
export function explainDeadline(state: WorkState): string {
  // #1238 — the deadline was within the handoff grace at a step boundary, so no
  // new step started; #1593 — or a step ran past it and its own verdict (named in
  // the evidence) is not why the cycle stopped.
  const ev = lastCapHit(state, "deadline")?.evidence ?? "(no detail recorded)";
  return ev.includes("passed while step")
    ? `the caller's whole-cycle deadline ended the cycle (${ev}). The step's children were stopped at the deadline, so its verdict judged unfinished work. The handoff below says where the work is — branch, PR, and the round reached — and runs inside the caller's handoff allowance (PI_ENSEMBLE_HANDOFF_TIMEOUT_MS), before its kill. Re-run \`/work <issue> --restart\` with the deadline raised or cleared`
    : ev.includes("(overdue)")
      ? `the caller's whole-cycle deadline (${ev}) had already passed when the driver reached a step boundary, so the driver started no new step and parked. The handoff below says where the work is — branch, PR, and the round reached — and runs inside the caller's handoff allowance (PI_ENSEMBLE_HANDOFF_TIMEOUT_MS). Re-run \`/work <issue> --restart\` with the deadline raised or cleared`
      : `the caller's whole-cycle deadline (${ev}) was within the handoff grace at a step boundary, so the driver started no new step and parked. The handoff below says where the work is — branch, PR, and the round reached — and posts before the deadline so a caller that kills the process at that point sees a handoff, not an aborted in-flight state. Re-run \`/work <issue> --restart\` with the deadline raised or cleared`;
}

/** `deadline:no-fit` — time remained, but less than the next step needs (#1567 item 6). */
export function explainDeadlineNoFit(state: WorkState): string {
  const ev = lastCapHit(state, "deadline:no-fit")?.evidence ?? "(no detail recorded)";
  return `too little time was left before the caller's whole-cycle deadline for the next step to do useful work (${ev}), so the driver did not start it and parked. Develop and lens-fix need at least 15 minutes, a lens round 10, before the deadline less the handoff grace. The handoff below says where the work is — branch, PR, and the round reached. Re-run \`/work <issue> --restart\` with the deadline raised or cleared`;
}

/** `child-timeout:<role>` — one child outlived its per-role run bound (#1560). */
export function explainChildTimeout(cap: string): string {
  return `the ${cap.slice("child-timeout:".length)} child outlived its per-child run bound — it was steered to wrap up at the bound and ended ${childBoundGraceMs() / 60_000} minute(s) later without having committed or finished its reply (PI_ENSEMBLE_DEVELOP_BOUND_MS / PI_ENSEMBLE_EXPLORE_BOUND_MS). Its work is left in the worktree; split the issue or raise the bound`;
}

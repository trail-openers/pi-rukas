/**
 * work-driver-handoff-recovery-plan — the plan-step handoff recipe (#819).
 *
 * Split from work-driver-handoff-recovery-caps.ts along the same seam
 * `work-driver-handoff-recovery-commit-pr.ts` already is: that module owns the
 * `commit-pr-incomplete-consolidation` steps and the parent calls it from its
 * `else if` chain. This owns the `plan-spec-mismatch` block, so the per-cap
 * recipe table stays under the 500-line cap with headroom for the next cap.
 *
 * Order is NOT load-bearing across cap blocks (unlike the worktree-aware
 * block at the top of the parent, which must fire first) — each block is
 * reached by its own `else if` on the cap literal.
 */

import type { ForgeType } from "./forge-detect.ts";
import { type RecoveryStep, forgeRecoveryLines } from "./work-driver-handoff-recovery.ts";
import { type CapHitEvent, lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #819 — the plan-to-spec gate halted BEFORE the branch step: no branch, no
 * worktree, no PR, nothing written. The recovery is a decision about the
 * SPEC, not about a diff — and the two readings lead to different commands,
 * so both are named: a stale spec (deliverable paths pointing at files that
 * no longer exist) rejects every honest plan, while a planner that drifted is
 * corrected by the gate re-judging a fresh plan.
 */
export function planSpecMismatchSteps(
  state: WorkState,
  issue: number,
  forge: ForgeType,
): RecoveryStep[] {
  const hit: CapHitEvent | undefined = lastCapHit(state, "plan-spec-mismatch");
  const evidence = hit?.evidence ?? "(no detail recorded)";
  return [
    {
      section: "plan-spec-mismatch",
      comment: [
        "1. Read what the gate refused (its evidence names the uncovered deliverables):",
        `   ${evidence.slice(0, 300)}`,
      ],
      lines: [`cat .pi/work-state/${issue}.json`, `ls .pi/work-state/${issue}/`],
    },
    {
      section: "plan-spec-mismatch",
      comment: [
        "2. If the spec's deliverable paths are stale (files renamed, or the work",
        "   already landed on main), revise the issue body — the gate compares the",
        "   plan against the spec, so a spec pointing at files that no longer exist",
        "   rejects every honest plan:",
      ],
      lines: forgeRecoveryLines(
        forge,
        [`/plan ${issue}    # or: gh issue edit ${issue}`],
        // `glab` has NO `issue edit` subcommand (unlike `gh`), so the line
        // that used to sit here was not a command anyone could run. The REST
        // form is what the forge adapter itself uses (forge-commands.ts
        // `issueEditCmd`).
        [
          `/plan ${issue}    # or: glab api -X PUT projects/:id/issues/${issue} -f "description=<revised body>"`,
        ],
      ),
    },
    {
      section: "plan-spec-mismatch",
      comment: [
        "3. Re-run — the gate re-judges the new plan, and this cycle wrote nothing",
        "   so a restart costs only the one planning dispatch it already spent:",
      ],
      lines: [`/work ${issue} --restart`],
    },
    {
      section: "plan-spec-mismatch",
      comment: [
        "4. Only if the gate itself is wrong (the deliverables DO name files this",
        "   issue is about, but the planner had no way to reach them): bypass the",
        "   plan-quality gates for one run — and fix the spec afterwards, because",
        "   the next cycle hits the same wall:",
      ],
      lines: [
        // #819 round-2 — two lines, not one. `PI_ENSEMBLE_PLAN_QUALITY=0 /work …`
        // is not a command: `/work` is a Pi slash command typed into the chat,
        // so a shell env prefix in front of it is pasted as literal text and
        // the command does not resolve. The variable has to be in the PI
        // PROCESS's environment before the session runs the slash command.
        "# set PI_ENSEMBLE_PLAN_QUALITY=0 in the pi process first (restart pi with it, or export it in the shell pi was started from)",
        `/work ${issue} --restart`,
      ],
    },
  ];
}

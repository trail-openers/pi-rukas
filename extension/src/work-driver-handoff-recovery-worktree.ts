/**
 * work-driver-handoff-recovery-worktree — the #674 worktree-aware recovery
 * steps, split from work-driver-handoff-recovery-caps.ts for the 500-line
 * gate (the same seam `work-driver-handoff-recovery-commit-pr.ts` is).
 *
 * ORDER IS LOAD-BEARING HERE: the parent calls this FIRST, before any per-cap
 * `else if`, because when committed work exists on detached-HEAD worktrees the
 * generic cap-specific block is provably wrong — the main checkout is empty and
 * the work is on the worktrees. The predicate, not the cap, decides.
 *
 * Content is byte-identical to the former in-line block in the parent.
 */

import type { ForgeType } from "./forge-detect.ts";
import { dependencyLeaves } from "./work-driver-cherry-pick.ts";
import { consolidatedMergeStep } from "./work-driver-handoff-merge-step.ts";
import type { RecoveryStep } from "./work-driver-handoff-recovery.ts";
import { stackPickRange } from "./work-driver-handoff-stack-pick.ts";
import { isConsolidatedPark } from "./work-driver-merge-subject.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * #674 — the worktree-aware recovery steps, or `[]` when the cycle has no
 * committed work on detached-HEAD worktrees (predicate: `committedWork`
 * non-empty AND a branch name to hang the commands on).
 */
export function worktreeAwareRecoverySteps(
  state: WorkState,
  forge: ForgeType,
  mergeSubject?: string,
): RecoveryStep[] {
  const ps = state.pipelineState;
  const issue = state.issue;
  const steps: RecoveryStep[] = [];
  const committedWork = ps.handoffSnapshot?.committedWork;
  if (!committedWork || committedWork.length === 0 || !ps.branchName) return steps;
  const consEvent = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "handoff-consolidated" }> =>
        e.kind === "handoff-consolidated",
    );
  if (consEvent) {
    // #968 — the driver restores repoRoot to the operator's original
    // checkout after consolidation (the branch is pushed by name, which
    // does not require a checkout). The worktrees it consolidated from are
    // torn down by the handoff teardown before this text renders, so no
    // recovery step may name them — the branch and the state file are
    // where the work and the record live now.
    steps.push(
      {
        section: "worktree-work-consolidated",
        comment: [
          "1. The work is committed on the local branch (the driver consolidated it before this handoff):",
        ],
        lines: [`git log --oneline ${ps.branchName}`],
      },
      {
        section: "worktree-work-consolidated",
        // `branchPushed` means "origin has a branch of this name" (true
        // after any earlier commit-pr push), so "not yet pushed" beside
        // "pushed to origin: yes" contradicted itself.
        comment: [
          ps.handoffSnapshot?.branchPushed
            ? `2. Push the branch (origin already has an EARLIER push of it; what the driver consolidated at handoff time is local only — if the push is rejected as non-fast-forward, compare \`git log ${ps.branchName} --not origin/${ps.branchName}\` (local commits origin lacks) before forcing anything):`
            : "2. Push the branch (the push works by branch name — the local branch was created at handoff time; it is not yet pushed):",
        ],
        lines: [`git push -u origin ${ps.branchName}`],
      },
      // #810 — the PR title threaded in by the caller; absent → no subject flag.
      consolidatedMergeStep(
        forge,
        ps.prNumber,
        isConsolidatedPark(state) ? mergeSubject : undefined,
      ),
      {
        section: "worktree-work-consolidated",
        comment: ["4. Or abandon the cycle and start over:"],
        lines: [`rm .pi/work-state/${issue}.json`, `/work ${issue} --restart`],
      },
    );
  } else {
    // #794 — dependsOn stack: pick only the DEPENDENCY LEAVES (worktrees
    // no other workstream builds on) so each commit lands exactly once.
    const leaves = dependencyLeaves(
      committedWork.map((w) => w.worktreeId),
      ps.workstreams
        ? Object.fromEntries(
            Object.entries(ps.workstreams).map(([id, ws]) => [id, ws.dependsOn ?? []]),
          )
        : undefined,
    );
    const map = new Map(committedWork.map((w) => [w.worktreeId, w]));
    const toPick = leaves
      .map((id) => map.get(id))
      .filter((w): w is (typeof committedWork)[number] => w !== undefined);
    const stacked = toPick.length < committedWork.length;
    const stackPick = stacked && toPick.length === 1 ? stackPickRange(state, toPick) : undefined;
    steps.push(
      {
        section: "worktree-work-fallback",
        comment: [
          "1. The work lives in these worktrees (detached HEADs, commits ahead of the base):",
        ],
        lines: committedWork.map(
          (w) =>
            `git -C ${w.path} log --oneline -5   # HEAD ${w.headSha.slice(0, 8)} · ${w.ahead} commit(s) ahead`,
        ),
      },
      {
        section: "worktree-work-fallback",
        comment: stacked
          ? [
              "2. Cherry-pick onto the feature branch — the workstreams are a dependsOn",
              "   stack, so only the worktree(s) NO other workstream builds on carry new",
              "   commits (each dependent's worktree already contains its ancestors' work).",
              "   Run from the main checkout:",
            ]
          : [
              "2. Cherry-pick each worktree's commits onto the feature branch (run from the main checkout):",
            ],
        lines: [
          `git checkout ${ps.branchName}`,
          ...(stackPick
            ? [
                `${stackPick}   # applies every commit of the stack in order (root base .. leaf tip)`,
              ]
            : toPick.flatMap((w) => [
                `git cherry-pick ${w.headSha}   # worktree: ${w.path} (HEAD ${w.headSha.slice(0, 8)})`,
              ])),
        ],
      },
      {
        section: "worktree-work-fallback",
        comment: ["3. Push the branch:"],
        lines: [`git push -u origin ${ps.branchName}`],
      },
      {
        section: "worktree-work-fallback",
        comment: ["4. Or abandon the cycle and start over (the worktrees are preserved):"],
        lines: [`rm .pi/work-state/${issue}.json`, `/work ${issue} --restart`],
      },
    );
  }
  return steps;
}

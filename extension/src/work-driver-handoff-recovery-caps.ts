/**
 * work-driver-handoff-recovery-caps — the per-cap RECOVERY RECIPE table,
 * extracted from work-driver-handoff-recovery.ts (AGENTS.md §12 file-size
 * limit). This module owns the cap → recovery-steps DECISION BODY:
 * `recoveryStepsForCap(state, forge)`, the if/else chain of per-cap literal
 * command sections (including the #674 worktree-aware block that precedes
 * the cap-keyed chain and short-circuits it), plus the `forgeLines` helper
 * that picks the github/gitlab spelling per forge.
 *
 * The shared types (`RecoverySection`, `RecoveryStep`) and
 * `CONSOLIDATE_APPLY` stay in the parent work-driver-handoff-recovery.ts;
 * the parent re-exports `recoveryStepsForCap` from here so the renderers,
 * the forge test and the smoke tests import it unchanged.
 *
 * Behaviour contract: the branch ORDER is load-bearing — the worktree-aware
 * block must fire before the if/else chain (it short-circuits the regular
 * caps when `committedWork` is non-empty), and no branch may be reordered
 * or re-worded without breaking test-handoff-rendering.ts.
 */

import type { ForgeType } from "./forge-detect.ts";
import { dependencyLeaves } from "./work-driver-cherry-pick.ts";
import { consolidatedMergeStep } from "./work-driver-handoff-merge-step.ts";
import {
  CONSOLIDATE_APPLY,
  type RecoverySection,
  type RecoveryStep,
} from "./work-driver-handoff-recovery.ts";
import { mergeHoldGrantAction } from "./work-driver-merge-authority.ts";
import { isConsolidatedPark } from "./work-driver-merge-subject.ts";
import { type CapHitEvent, lastCapHit } from "./workflow-state-cap.ts";
import {
  type WorkEvent,
  type WorkState,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/** #612 — forge-appropriate recovery commands: `github` byte-for-byte, `gitlab` glab equivalent, `unknown` falls back to github (advisory text). The git / rm / cat / `#` lines are forge-agnostic. */
function forgeLines(forge: ForgeType, github: string[], gitlab: string[]): string[] {
  return forge === "gitlab" ? gitlab : github;
}

// #810 — the step-3 recovery merge command (consolidatedMergeStep) is in
// work-driver-handoff-merge-step.ts; re-exported here for importers.

export function recoveryStepsForCap(
  state: WorkState,
  forge: ForgeType = "github",
  mergeSubject?: string,
): {
  cap: Cap | undefined;
  section: RecoverySection | undefined;
  steps: RecoveryStep[];
} {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e): e is CapHitEvent => e.kind === "cap-hit");
  const cap: Cap | undefined = capHit ? capHit.cap : undefined;
  const steps: RecoveryStep[] = [];

  // #674 — worktree-aware recovery. The predicate is the state
  // (`handoffSnapshot.committedWork` non-empty), NOT the cap. When
  // consolidation succeeded the branch contains the work; when it was
  // infeasible the per-worktree paths + HEAD SHAs + cherry-pick commands
  // are the honest recovery.
  const committedWork = ps.handoffSnapshot?.committedWork;
  if (cap !== undefined && committedWork && committedWork.length > 0 && ps.branchName) {
    const consEvent = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "handoff-consolidated" }> =>
          e.kind === "handoff-consolidated",
      );
    if (consEvent) {
      steps.push(
        {
          section: "worktree-work-consolidated",
          comment: [
            "1. The branch now contains the workstream work (consolidated by the driver before this handoff):",
          ],
          lines: [
            `git -C .worktrees/issue-${issue}-${committedWork[0]?.worktreeId ?? "?"} status --porcelain   # each worktree should be clean (its commits are on the branch now)`,
          ],
        },
        {
          section: "worktree-work-consolidated",
          comment: [
            "2. Push the branch (the local branch was created at handoff time; it is not yet pushed):",
          ],
          lines: [`git push -u origin ${ps.branchName}`],
        },
        // #810 — the subject is the PR title, read live by the caller
        // (mergeSubjectForState) and threaded in; for a parked cycle whose
        // consolidated branch holds a single commit, GitHub's squash would
        // otherwise use the driver's `chore(handoff):` commit subject.
        // Absent → the step degrades to the pre-#810 form (no subject flag).
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
      // #794 (task-b) — for a dependsOn STACK, picking every worktree's
      // HEAD replays each ancestor commit once per level of the stack
      // (the #775 shape: the printed instructions themselves reproduced
      // the failure when followed). In a stack each dependent's worktree
      // is based on its dependency's tip, so the DEPENDENCY LEAVES — the
      // worktrees no other workstream builds on — carry the union of the
      // stack's commits. Pick those once, in topological order, and the
      // branch lands every commit exactly once. With no `dependsOn`
      // declared, every worktree is its own leaf and the printed commands
      // are byte-identical to the pre-#794 per-worktree list (the
      // N-disjoint behaviour is unchanged).
      const leaves = dependencyLeaves(
        committedWork.map((w) => w.worktreeId),
        ps.workstreams
          ? Object.fromEntries(
              Object.entries(ps.workstreams).map(([id, ws]) => [id, ws.dependsOn ?? []]),
            )
          : undefined,
      );
      const byId = new Map(committedWork.map((w) => [w.worktreeId, w]));
      const toPick = leaves
        .map((id) => byId.get(id))
        .filter((w): w is (typeof committedWork)[number] => w !== undefined);
      const stacked = toPick.length < committedWork.length;
      const topOfStack = toPick.length > 0 && toPick.length === 1 ? toPick[0] : undefined;
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
            ...toPick.flatMap((w) => [
              `git cherry-pick ${w.headSha}   # worktree: ${w.path} (HEAD ${w.headSha.slice(0, 8)})${topOfStack ? "   # tip of the dependency chain — applies the whole stack in one pick" : ""}`,
            ]),
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
  }

  if (cap === "explore-already-complete") {
    steps.push(
      {
        section: "explore-already-complete",
        comment: ["1. Verify by reading the issue + the explore report:"],
        lines: forgeLines(
          forge,
          [`gh issue view ${issue}`, `cat tmp/issue-${issue}/handoff-comment.md`],
          [`glab issue view ${issue}`, `cat tmp/issue-${issue}/handoff-comment.md`],
        ),
      },
      {
        section: "explore-already-complete",
        comment: ["2. If you agree the issue is done, close it:"],
        lines: forgeLines(
          forge,
          [`gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`],
          [
            `glab api -f "body=Verified complete by /work — see prior PR" POST /projects/:id/issues/${issue}/notes`,
            `glab issue close ${issue}`,
          ],
        ),
      },
      {
        section: "explore-already-complete",
        comment: ["3. If you disagree, add context and re-run /work:"],
        lines: [
          ...(forgeLines(
            forge,
            [`gh issue comment ${issue} --body "Additional context: <what /work missed>"`],
            [
              `glab api -f "body=Additional context: <what /work missed>" POST /projects/:id/issues/${issue}/notes`,
            ],
          ) as string[]),
          `rm .pi/work-state/${issue}.json`,
          "# then restart Pi",
        ],
      },
      {
        section: "explore-already-complete",
        comment: ["4. Abandon the handoff entry (no code was written; safe to discard):"],
        lines: [`rm .pi/work-state/${issue}.json`],
      },
    );
  } else if (cap === "awaiting-human-merge") {
    const pr = ps.prNumber;
    steps.push(
      {
        section: "awaiting-human-merge",
        comment: ["1. See what the checks actually say:"],
        lines: forgeLines(
          forge,
          [`gh pr checks ${pr ?? "<pr>"}`],
          [
            `glab api "/projects/:id/merge_requests/${pr ?? "<n>"}/pipelines" --output json`,
            "glab ci view",
          ],
        ),
      },
      {
        section: "awaiting-human-merge",
        comment: [
          "2. Review the PR and remove whatever is holding the merge (grant, evidence, or checks):",
        ],
        lines: forgeLines(
          forge,
          [`gh pr view ${pr ?? "<pr>"} --web`],
          [`glab mr view ${pr ?? "<n>"} --web`],
        ),
      },
    );
    if (!ps.mergeHold?.authorityGranted) {
      steps.push({
        section: "awaiting-human-merge",
        // The grant sentence itself comes from mergeHoldGrantAction so all
        // three no-authority surfaces state it identically (single source,
        // #760); this block keeps its numbered-step framing.
        comment: [`3. ${mergeHoldGrantAction(pr ? `#${pr}` : "the PR")}:`],
        lines: [`/work ${issue} --merge`],
      });
    }
  } else if (cap === "existing-pr-detected") {
    const pr = ps.existingPr;
    const head = pr?.headRefName ?? "<branch>";
    steps.push(
      {
        section: "existing-pr-detected",
        comment: ["1. Look at what the open PR already contains:"],
        lines: forgeLines(
          forge,
          [`gh pr view ${pr?.number ?? "<pr>"} --json state,mergeable,files`],
          [`glab mr view ${pr?.number ?? "<n>"} --output json`],
        ),
      },
      {
        section: "existing-pr-detected",
        comment: ["2. Continue that PR instead of starting over (preferred):"],
        lines: ["git fetch origin", `git checkout ${head}`],
      },
      {
        section: "existing-pr-detected",
        comment: ["3. Or abandon it, then re-run — the pre-flight will pass once it is closed:"],
        lines: [
          ...(forgeLines(
            forge,
            [`gh pr close ${pr?.number ?? "<pr>"} --comment "Superseded; restarting via /work"`],
            [`glab mr cancel ${pr?.number ?? "<n>"}`],
          ) as string[]),
          `rm .pi/work-state/${issue}.json`,
          "# then restart Pi",
        ],
      },
      {
        section: "existing-pr-detected",
        comment: ["4. Or proceed anyway, accepting a second PR for this issue:"],
        lines: ["PI_ENSEMBLE_PR_PREFLIGHT=0 pi"],
      },
    );
  } else if (cap === "explore-needs-clarification") {
    // #830 — the explore reply is saved to .pi/work-state/${issue}/ when it exceeds 4 KiB;
    // otherwise it appears inline in the cap-hit's preceding dispatch event in .pi/work-state/${issue}.json.
    const evidence = lastCapHit(state, "explore-needs-clarification")?.evidence;
    steps.push(
      {
        section: "explore-needs-clarification",
        comment: [
          evidence
            ? `1. The driver recorded: ${evidence}. List the explore artifacts to confirm:`
            : "1. List the explore artifacts to see what the reply contained (the issue may be fine — the parser may have missed it):",
        ],
        lines: [`ls .pi/work-state/${issue}/`],
      },
      {
        section: "explore-needs-clarification",
        comment: ["2. If the issue is ambiguous or missing acceptance criteria, edit it first:"],
        lines: forgeLines(
          forge,
          [`gh issue edit ${issue}`],
          [`glab issue edit ${issue} --description "<revised body>"`],
        ),
      },
      {
        section: "explore-needs-clarification",
        comment: ["3. Re-run /work (the state file is discarded automatically on --restart):"],
        lines: [`/work ${issue} --restart`],
      },
      {
        section: "explore-needs-clarification",
        comment: ["4. Abandon the handoff entry:"],
        lines: [`rm .pi/work-state/${issue}.json`],
      },
    );
  } else if (cap === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const probeIssue = failed[0]?.issue ?? issue;
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    steps.push(
      {
        section: "explore-bodies-empty",
        comment: [
          "1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
        ],
        lines: forgeLines(
          forge,
          ["gh auth status", "gh --version"],
          ["glab auth status", "glab version"],
        ),
      },
      {
        section: "explore-bodies-empty",
        comment: ["2. Probe a failing issue via REST (works when `gh issue view` is broken):"],
        lines: forgeLines(
          forge,
          [`gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`],
          [`glab api "/projects/:id/issues/${probeIssue}" --output json | head`],
        ),
      },
      {
        section: "explore-bodies-empty",
        comment: ["3. If gh issue view is hijacked, check for a misbehaving gh extension:"],
        lines: forgeLines(forge, ["gh extension list"], ["glab version", "glab auth status"]),
      },
      {
        section: "explore-bodies-empty",
        comment: [
          `4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
        ],
        lines: [`rm .pi/work-state/${issue}.json`, "# then restart Pi"],
      },
    );
  } else if (cap === "step-back-revise-spec") {
    steps.push(
      {
        section: "step-back-revise-spec",
        comment: ["1. Read the proposed revision + handoff context:"],
        lines: [`cat tmp/issue-${issue}/handoff-comment.md`],
      },
      {
        section: "step-back-revise-spec",
        comment: ["2. Revise the issue body via /plan (or gh issue edit):"],
        lines: forgeLines(
          forge,
          [`/plan ${issue}    # or: gh issue edit ${issue}`],
          [`/plan ${issue}    # or: glab issue edit ${issue} --description "<revised body>"`],
        ),
      },
      {
        section: "step-back-revise-spec",
        comment: ["3. Restart /work from scratch against the revised spec:"],
        lines: [`/work ${issue} --restart`],
      },
      {
        section: "step-back-revise-spec",
        comment: ["4. Abandon this cycle entirely:"],
        lines: [`rm .pi/work-state/${issue}.json`],
      },
    );
  } else if (cap === "commit-pr-incomplete-consolidation") {
    const missing = missingWorkstreamsFromConsolidation(ps.incompleteConsolidation);
    steps.push(
      {
        section: "commit-pr-incomplete-consolidation",
        comment: ["1. Inspect each missing workstream's worktree:"],
        lines: missing.map((m) => `git -C .worktrees/issue-${issue}-${m.id} status --porcelain`),
      },
      {
        section: "commit-pr-incomplete-consolidation",
        comment: [
          "2. Apply each missing diff to the integration branch. Stage inside the",
          "   worktree FIRST — `git diff HEAD` alone silently omits untracked new",
          "   files — and use --3way, which resolves two workstreams touching",
          "   different regions of one file instead of rejecting the second:",
        ],
        lines: missing.flatMap((m) => [
          `git -C .worktrees/issue-${issue}-${m.id} add -A`,
          // #499 — the lossless recipe: stage first, diff the STAGED tree
          // (a bare `diff HEAD` omits untracked new files), apply --3way.
          `git -C .worktrees/issue-${issue}-${m.id} diff --cached --binary | ${CONSOLIDATE_APPLY}    # in the integration tree`,
        ]),
      },
      {
        section: "commit-pr-incomplete-consolidation",
        comment: ["3. Verify all workstreams' files now appear, then commit + push:"],
        lines: ["git diff --name-only --cached", "git commit -m '<concise>'", "git push"],
      },
      {
        section: "commit-pr-incomplete-consolidation",
        comment: ["4. Or: abandon + restart from scratch:"],
        lines: [`rm .pi/work-state/${issue}.json`, `/work ${issue} --restart`],
      },
    );
  } else if (cap === "intent-park") {
    steps.push(
      {
        section: "intent-park",
        comment: ["1. Do this: <park-action>"],
        lines: [],
      },
      {
        section: "intent-park",
        comment: ["2. Read the resolver's own reasoning before deciding:"],
        lines: [`cat .pi/work-state/${issue}/spec.txt`],
      },
      {
        section: "intent-park",
        comment: ["3. Then re-run — the state file is discarded automatically on --restart:"],
        lines: [`/work ${issue} --restart`],
      },
    );
  } else if (cap === "review-incomplete") {
    steps.push(
      {
        section: "review-incomplete",
        comment: ["1. Read what the completed lenses found (above) + the driver status file:"],
        lines: [`cat tmp/issue-${issue}/status-code-review-specialist.md`],
      },
      {
        section: "review-incomplete",
        comment: ["2. Re-run the review once the cause (looping lens / infra) is resolved:"],
        lines: [`/work ${issue} --restart`],
      },
      {
        section: "review-incomplete",
        comment: ["3. Or abandon the cycle:"],
        lines: [`rm .pi/work-state/${issue}.json`],
      },
    );
  } else if (cap === "develop-incomplete-deliverables") {
    // #741 — the converge gate capped: the verify gate passed (the code
    // builds) but a plan deliverable's declared paths are absent from the
    // end-of-develop diff even after the one-shot corrective re-dispatch.
    steps.push(
      {
        section: "develop-incomplete-deliverables",
        comment: [
          "1. Read the converge gate's per-deliverable classification (the cap's",
          "   evidence names the missing paths):",
        ],
        lines: [`jq .pipelineState.convergeEvidence .pi/work-state/${issue}.json`],
      },
      {
        section: "develop-incomplete-deliverables",
        comment: [
          "2. Implement the missing deliverable(s) on the branch (the work in the",
          "   worktrees is already committed) — or re-run /work to re-enter the",
          "   gate with a fresh one-shot corrective budget:",
        ],
        lines: [`/work ${issue} --restart`],
      },
      {
        section: "develop-incomplete-deliverables",
        comment: ["3. Or abandon the cycle:"],
        lines: [`rm .pi/work-state/${issue}.json`],
      },
    );
  }
  return { cap, section: steps[0]?.section, steps };
}

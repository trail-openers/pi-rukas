/**
 * work-driver-handoff-recovery — the SHARED cap → recovery DECISION,
 * consumed by BOTH handoff renderers (work-driver-handoff-recovery.chat.ts
 * and work-driver-handoff-recovery.md.ts).
 *
 * `recoveryStepsForCap(state)` returns the ordered recovery steps for the
 * state's most recent cap — the if/else CHAIN that used to be duplicated
 * across the two renderers (12+ branches). The decision is surface-AGNOSTIC:
 * each step names its `section` + `comment` (the `#`-prefixed intro lines)
 * + `lines` — the LITERAL command strings for the surface that has NO
 * path-dependent commands (the GitHub-body renderer, which posts from the
 * repo root). The chat presenter re-qualifies each line to its absolute
 * paths (repo-qualified `git -C <repoRoot>`, absolute scratch) via
 * `requalifyLine`; everything else is byte-identical, so the two surfaces
 * cannot drift apart on the WHICH-cap-yields-WHICH-step decision.
 *
 * The per-surface fragments that DO differ (cap-specific prose, the
 * consolidated-verdict interleaving, the branch-name-predicate fallbacks)
 * stay in the presenters — they are presentation, not decision.
 *
 * Split out of the two renderers (AGENTS.md §12 file-size limit).
 */

import type { ForgeType } from "./forge-detect.ts";
import {
  type WorkEvent,
  type WorkState,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

export type RecoverySection =
  | "explore-already-complete"
  | "awaiting-human-merge"
  | "existing-pr-detected"
  | "explore-needs-clarification"
  | "explore-bodies-empty"
  | "step-back-revise-spec"
  | "commit-pr-incomplete-consolidation"
  | "intent-park"
  | "review-incomplete"
  | "worktree-work-consolidated"
  | "worktree-work-fallback";

export interface RecoveryStep {
  /** The section this step belongs to (one of `RecoverySection`). */
  section: RecoverySection;
  /** The intro line(s) for the step (no `#` prefix, no indent). */
  comment: string[];
  /**
   * The LITERAL command lines for the markdown surface (cwd-relative
   * paths, `tmp/issue-<N>/` scratch). The chat presenter re-qualifies each
   * line to absolute paths; comment lines (`#`) and non-path commands pass
   * through untouched.
   */
  lines: string[];
}

/** #544 — the literal of the lossless consolidation recipe. Both renderers'
 * canaries (test-path-declaration-parsing.ts) read it off the markdown
 * surface; keeping it a named const here is what lets the shared decision
 * and the surface stay byte-identical by construction. */
export const CONSOLIDATE_APPLY = "git apply --3way --binary --index";

/**
 * #612 — forge-appropriate recovery commands. The shared decision renders
 * the LITERAL command strings the operator is expected to run; those strings
 * used to hard-code `gh`, which is the wrong CLI for a repo that lives on
 * GitLab. The builders below pick the spelling per forge:
 *
 *   - `github` — today's exact strings, byte-for-byte (the zero-regression
 *     path; every existing rendering test pins these verbatim).
 *   - `gitlab` — the glab equivalent of the same operator step.
 *
 * `unknown` deliberately falls back to the GitHub strings: the recovery
 * block is advisory text for a human, not an executed command, and an
 * operator on an unrecognised host is better served by the familiar spelling
 * (they already know their CLI may not match) than by a refusal. The git /
 * rm / cat / `#` lines are forge-agnostic and shared by both branches.
 */
function forgeLines(forge: ForgeType, github: string[], gitlab: string[]): string[] {
  return forge === "gitlab" ? gitlab : github;
}

export function recoveryStepsForCap(
  state: WorkState,
  forge: ForgeType = "github",
): {
  cap: Cap | undefined;
  section: RecoverySection | undefined;
  steps: RecoveryStep[];
} {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const cap: Cap | undefined = capHit ? capHit.cap : undefined;
  const steps: RecoveryStep[] = [];

  // #674 — worktree-aware recovery. When the cycle's work lives in
  // committed work on detached-HEAD worktrees (the shape of the five parked
  // cycles #645/#649/#659/#660/#664), the generic `git -C <repoRoot>
  // status` / `add -p` / `push` block is provably wrong: the main checkout
  // is empty, and the work is on the worktree detached HEADs. The predicate
  // is the state — `handoffSnapshot.committedWork` non-empty — NOT the cap
  // (the ticket explicitly scopes the fix to the handoff/recovery path, not
  // to routing develop-parks to a different cap). When consolidation
  // succeeded (the `handoff-consolidated` event is present), the branch
  // genuinely contains the work and the printed `push` becomes true; when
  // consolidation was infeasible, the per-worktree paths + HEAD SHAs +
  // working cherry-pick commands are the honest recovery.
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
        {
          section: "worktree-work-consolidated",
          comment: ["3. Or abandon the cycle and start over:"],
          lines: [`rm .pi/work-state/${issue}.json`, `/work ${issue} --restart`],
        },
      );
    } else {
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
          comment: [
            "2. Cherry-pick each worktree's commits onto the feature branch (run from the main checkout):",
          ],
          lines: [
            `git checkout ${ps.branchName}`,
            ...committedWork.flatMap((w) => [
              `git cherry-pick ${w.headSha}   # worktree: ${w.path} (HEAD ${w.headSha.slice(0, 8)}, ${w.ahead} ahead)`,
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
        comment: ["2. Review and merge it yourself:"],
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
        comment: [
          "3. Or grant the driver authority — either add an explicit line to AGENTS.md",
          '   (e.g. "LLMs are allowed to squash merge PRs"), or pass --merge:',
        ],
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
    steps.push(
      {
        section: "explore-needs-clarification",
        comment: ["1. Read what explore couldn't determine:"],
        lines: [`cat tmp/issue-${issue}/handoff-comment.md`],
      },
      {
        section: "explore-needs-clarification",
        comment: ["2. Edit the issue body to add the missing acceptance criteria / scope:"],
        lines: forgeLines(
          forge,
          [`gh issue edit ${issue}`],
          [`glab issue edit ${issue} --description "<revised body>"`],
        ),
      },
      {
        section: "explore-needs-clarification",
        comment: ["3. Re-run /work once the issue is clearer:"],
        lines: [`rm .pi/work-state/${issue}.json`, "# then restart Pi"],
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
  }
  return { cap, section: steps[0]?.section, steps };
}

/**
 * #544 — re-qualify a markdown-surface line to the CHAT surface (absolute
 * paths, `git -C <repoRoot>` prefix). Pure string rewriting over the shared
 * decision's literal lines, so the two surfaces agree on the command itself
 * and differ only in the path prefix:
 *
 *   - `git -C .worktrees/<x>` → `git -C <repoRoot>/.worktrees/<x>`
 *   - `git <cmd>` (no -C) → `git -C <repoRoot> <cmd>` (the integration tree)
 *   - `rm .pi/...` → `rm <repoRoot>/.pi/...`
 *   - `cat tmp/issue-N/...` → `cat <scratchAbs>/...`
 *   - `cat .pi/...` → `cat <repoRoot>/.pi/...`
 *   - `gh <args>` → `glab <args>` on a GitLab forge (binary rename only)
   - comments / non-path commands (`glab`, `/work`, `PI_...`) pass through
 */
export function requalifyLine(
  line: string,
  repoRoot: string,
  scratchDirAbs: string,
  forge: ForgeType = "github",
): string {
  if (line.startsWith("#")) return line;
  let l = line;
  if (forge === "gitlab" && l.startsWith("gh ")) l = `glab ${l.slice(3)}`;
  const wt = l.match(/^git -C \.worktrees\/(\S+)(.*)$/);
  if (wt) return `git -C ${repoRoot}/.worktrees/${wt[1]}${wt[2]}`;
  if (/^git /.test(l) && !/^git -C /.test(l)) return `git -C ${repoRoot} ${l.slice(4)}`;
  l = l.replace(/^rm \.pi\//, `rm ${repoRoot}/.pi/`);
  l = l.replace(/^cat tmp\//, `cat ${scratchDirAbs}/`);
  l = l.replace(/^cat \.pi\//, `cat ${repoRoot}/.pi/`);
  return l;
}

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
  | "review-incomplete";

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
 * The ordered recovery steps for the state's most recent cap. An EMPTY
 * `steps` array means "nothing cap-specific applies" (no cap recorded, or a
 * cap with no dedicated recipe) — the renderers then fall back to their
 * `!ps.branchName` / generic branches, which key on the STATE not the cap.
 */
export function recoveryStepsForCap(state: WorkState): {
  cap: Cap | undefined;
  section: RecoverySection | undefined;
  steps: RecoveryStep[];
} {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const cap: Cap | undefined = capHit ? capHit.cap : undefined;
  const steps: RecoveryStep[] = [];

  if (cap === "explore-already-complete") {
    steps.push(
      {
        section: "explore-already-complete",
        comment: ["1. Verify by reading the issue + the explore report:"],
        lines: [`gh issue view ${issue}`, `cat tmp/issue-${issue}/handoff-comment.md`],
      },
      {
        section: "explore-already-complete",
        comment: ["2. If you agree the issue is done, close it:"],
        lines: [`gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`],
      },
      {
        section: "explore-already-complete",
        comment: ["3. If you disagree, add context and re-run /work:"],
        lines: [
          `gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
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
        lines: [`gh pr checks ${pr ?? "<pr>"}`],
      },
      {
        section: "awaiting-human-merge",
        comment: ["2. Review and merge it yourself:"],
        lines: [`gh pr view ${pr ?? "<pr>"} --web`],
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
        lines: [`gh pr view ${pr?.number ?? "<pr>"} --json state,mergeable,files`],
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
          `gh pr close ${pr?.number ?? "<pr>"} --comment "Superseded; restarting via /work"`,
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
        lines: [`gh issue edit ${issue}`],
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
        lines: ["gh auth status", "gh --version"],
      },
      {
        section: "explore-bodies-empty",
        comment: ["2. Probe a failing issue via REST (works when `gh issue view` is broken):"],
        lines: [`gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`],
      },
      {
        section: "explore-bodies-empty",
        comment: ["3. If gh issue view is hijacked, check for a misbehaving gh extension:"],
        lines: ["gh extension list"],
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
        lines: [`/plan ${issue}    # or: gh issue edit ${issue}`],
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
 *   - comments / non-path commands (`gh`, `/work`, `PI_...`) pass through
 */
export function requalifyLine(line: string, repoRoot: string, scratchDirAbs: string): string {
  if (line.startsWith("#")) return line;
  let l = line;
  const wt = l.match(/^git -C \.worktrees\/(\S+)(.*)$/);
  if (wt) return `git -C ${repoRoot}/.worktrees/${wt[1]}${wt[2]}`;
  if (/^git /.test(l) && !/^git -C /.test(l)) return `git -C ${repoRoot} ${l.slice(4)}`;
  l = l.replace(/^rm \.pi\//, `rm ${repoRoot}/.pi/`);
  l = l.replace(/^cat tmp\//, `cat ${scratchDirAbs}/`);
  l = l.replace(/^cat \.pi\//, `cat ${repoRoot}/.pi/`);
  return l;
}

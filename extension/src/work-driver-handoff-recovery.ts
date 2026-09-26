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
 * The per-cap recipe table itself (`recoveryStepsForCap`) lives in
 * work-driver-handoff-recovery-caps.ts (the per-cap if/else bodies moved
 * there when this file approached the §12 500-line limit) and is
 * re-exported here so the renderers, the forge test and the smoke tests
 * keep importing it from this module.
 *
 * The per-surface fragments that DO differ (cap-specific prose, the
 * consolidated-verdict interleaving, the branch-name-predicate fallbacks)
 * stay in the presenters — they are presentation, not decision.
 *
 * Split out of the two renderers (AGENTS.md §12 file-size limit).
 */

import type { ForgeType } from "./forge-detect.ts";
import { recoveryStepsForCap } from "./work-driver-handoff-recovery-caps.ts";

// Re-export so the renderers, the forge test and the smoke tests import
// `recoveryStepsForCap` from this module unchanged.
export { recoveryStepsForCap };

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
  | "worktree-work-fallback"
  | "develop-incomplete-deliverables"
  | "integration-worktree-violation";

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

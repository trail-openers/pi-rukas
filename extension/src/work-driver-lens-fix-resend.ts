/**
 * work-driver-lens-fix-resend — the RE-DISPATCH arm of the lens-fix prompt.
 *
 * Split from `work-driver-lens-fix.ts` along the step’s own seam (AGENTS.md
 * §12 file-size limit), which is also where the prompts for this step already
 * live: `inlineLensFixPrompt` stayed with the dispatch that uses it, and this is
 * the arm whose rules were each dropped from it once.
 *
 * It is a second literal because the circumstances differ — the predecessor was
 * killed with its work uncommitted — but it is the SAME developer in the SAME
 * tree under the SAME fence, so every rule the ordinary prompt prints is printed
 * here from the same exported constant or renderer. That is the #1156 lesson and
 * the #1798 one: this array is where the test-scope rule and the commit clause
 * were each dropped once, so nothing in it may be a hand-typed copy.
 */

import { LENS_FIX_COMMIT_INSTRUCTION } from "./work-driver-lens-fix.ts";
import { FIXER_DECLINE_RULE, issuePromptBlockForReview } from "./work-driver-lens-issue.ts";
import { scratchHygieneSection } from "./work-driver-prompts-late.ts";
import { developTestScopeLine } from "./work-driver-verify-fast.ts";

export function lensFixResendPrompt(
  findings: string,
  scratchDirAbs: string,
  fixTree: string,
  issueBody: string | undefined,
  fenceLines?: readonly string[],
): string {
  return [
    `RE-DISPATCH — the previous lens-fix dispatch produced no committed fix: no commits ahead of the feature branch in the lens-fix worktree ${JSON.stringify(fixTree)}.`,
    // The issue first, exactly as the ordinary arm prints it: the re-dispatched
    // fixer judges each finding against what the ticket asked for, and needs the
    // decline rule for the same reason the first one did.
    issuePromptBlockForReview(issueBody).trim(),
    issuePromptBlockForReview(issueBody) === "" ? "" : FIXER_DECLINE_RULE,
    // #1798 — the re-dispatch IS the shape this clause exists for: the
    // predecessor was killed with its work uncommitted. Say what to commit
    // and when in the SAME constant the ordinary prompt prints, so the two
    // arms cannot drift apart (the #1156 lesson: this array is a second
    // literal and the rule got dropped from it once).
    LENS_FIX_COMMIT_INSTRUCTION,
    `Either the findings are already resolved in the committed diff (in which case say so with \`nothing-to-fix: <one-line reason>\` and make no changes), or the previous attempt left uncommitted work in that tree that it never committed. Inspect the tree — \`git -C ${fixTree} status\` — and commit any uncommitted fix work there: \`git add -A\` followed by \`git commit -m "<type>(scope): concise subject"\`. Do NOT push.`,
    "",
    // #1156 — the re-dispatch is the same developer in the same worktree
    // with the same gates to re-run, so it carries the same test-scope +
    // suite-bound rule as `inlineLensFixPrompt`. This branch is a separate
    // inline array built alongside that function, which is exactly where
    // the rule got dropped once.
    `  - ${developTestScopeLine()}`,
    "",
    "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
    "```json",
    findings,
    "```",
    // #1852 — the resend is a SECOND prompt literal built alongside the
    // function above, and it is the same developer in the same tree under
    // the same fence: printing the fence in one and not the other is how
    // the test-scope rule got dropped once (#1156).
    ...(fenceLines ?? []),
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

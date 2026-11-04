/**
 * work-driver-lens-issue — the issue block the /work review side prints.
 *
 * Both the six-lens pass (`runLens`'s context) and the lens-fix dispatches
 * (`inlineLensFixPrompt` and its re-dispatch literal) print the issue into a
 * child's brief, and all three read it through this one renderer, so the block
 * — its lead-in, its bound and the rule about what a finding against the spec
 * is — cannot drift between the round that raises findings and the fixer who
 * acts on them.
 *
 * The body is an issue author's text and it crosses into six reviewer briefs and
 * a developer brief. The branch's rule for a value crossing into a child's brief
 * is that it is DISARMED AT THE PRINT SITE: one `### heading` inside the body
 * would otherwise open a section of the prompt the driver never wrote, and a
 * ``` fence inside it would close a fence the prompt itself opened. The layer's
 * own fence renderer (`lean/text-fence.ts`, the `fenceText` the carried-findings
 * block already uses) is the one implementation of that rule, so it is the one
 * used here.
 *
 * ONE truncation marker: the fence is given a cap that cannot cut the body
 * before `boundedIssueBody`'s own `…(issue truncated)` marker has been printed,
 * so that marker is the only one a reader can ever see inside the block — a
 * second, differently worded "truncated" line in a prompt that already carries
 * one is a reader having to guess which cut it is looking at.
 *
 * An absent or blank body yields `""`: no block, and never the string
 * "undefined".
 */

import {
  ADVERSARIAL_FINDING_RULE,
  ISSUE_PROMPT_LEAD,
  MAX_ISSUE_CHARS,
  boundedIssueBody,
} from "./adversarial-prompts.ts";
import { fenceText } from "./lean/text-fence.ts";

/** The issue body, trimmed to `MAX_ISSUE_CHARS` with its own truncation marker,
 * then printed behind `fenceText` at a cap that keeps that marker whole. Shared
 * by the review-side block and the fixer's decline rule so the two cannot bound
 * the same text differently. */
export function fencedIssueBody(issueBody: string | undefined): string {
  const body = boundedIssueBody(issueBody);
  if (body === "") return "";
  // `MAX_ISSUE_CHARS` is the body's own bound, so a cap that also holds the
  // marker's own text (plus the newline it sits on) can never clip it.
  return fenceText(body, MAX_ISSUE_CHARS + ISSUE_TRUNCATION_MARKER.length + 1);
}

/** The fixed text of `boundedIssueBody`'s truncation marker — the one marker any
 * issue block may carry. Exported so the cap above and the test that asserts
 * exactly one marker both name it rather than re-typing it. */
export const ISSUE_TRUNCATION_MARKER = "\n…(issue truncated)";

/**
 * The issue block for a /work review-side prompt, or `""` when there is no
 * usable body. `issueBody` is the cached composite (title + body) the explore
 * step wrote — /work prints BOTH, because the title is the one line that says
 * which issue a six-lens round is being judged against. `undefined` for a
 * grouped cycle's non-primary issues.
 */
export function issuePromptBlockForReview(issueBody: string | undefined): string {
  const fenced = fencedIssueBody(issueBody);
  if (fenced === "") return "";
  return `\n\n${ISSUE_PROMPT_LEAD} ${ADVERSARIAL_FINDING_RULE}\n\n${fenced}`;
}

/** The fixed marker every declined finding's line starts with. One constant,
 * used by all three fixer briefs, so a reply can be grepped for it. Declared
 * before the rule that quotes it. */
export const ISSUE_DECLINE_MARKER = "DECLINED (contradicts the issue):";

/**
 * The rule a FIXER is held to, printed with the issue block by every fixer brief
 * in this repository (both /work lens-fix literals and lean's `fixPrompt`).
 *
 * Three claims, all load-bearing:
 *   - the decline is DECLINED-BY-CITATION: only a requirement printed in the
 *     issue block above justifies it, never the findings list or the gate's own
 *     prose (which is reviewer text, and a reviewer can be wrong);
 *   - a declined finding is written on its own line beginning with the fixed
 *     marker, so the operator and the next round can tell a refusal from silence;
 *   - the driver's handling is unchanged: a declined row is still a row, and a
 *     re-review that still holds it at the project's bar parks the cycle the way
 *     any unresolved row does.
 */
export const FIXER_DECLINE_RULE = `A finding you do not apply because it contradicts the issue must be stated in your reply on its own line beginning with the fixed marker \`${ISSUE_DECLINE_MARKER}\`, and you may decline only by citing a requirement printed in the issue block above — never a finding's own wording, and never the gate's prose. A declined finding is still an open finding: do not count it as fixed.`;

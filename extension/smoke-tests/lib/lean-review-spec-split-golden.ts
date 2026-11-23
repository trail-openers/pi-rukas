/**
 * lib/lean-review-spec-split-golden — the render the review seats fall back to
 * when a body carries no parsable contract.
 *
 * An issue with no readable `pi-spec v1` block gets no criteria section and its
 * raw bytes behind the shared `fencedIssuePromptBlock` — the shape that predates
 * the split, which the split must reproduce byte for byte for those bodies alone.
 * The goldens live here rather than beside the assertion because the module under
 * change is the one that decides whether to fall back: a golden that called it
 * could not catch a fallback that stopped happening.
 *
 * `rawBlockPayload` is the non-vacuity half of the same story: the JSON keys a
 * seat that strips nothing WOULD print, read off the raw render of the body under
 * test. A hand-picked key is an assertion about the fixture's spelling, and a body
 * that renames it passes on a seat that stripped nothing at all.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import {
  ADVERSARIAL_FINDING_RULE,
  fencedIssueBody,
  fencedIssuePromptBlock,
} from "../../src/adversarial-prompts.ts";
import { FIXER_DECLINE_RULE } from "../../src/work-driver-lens-issue.ts";

/** The lead-in `fixPrompt` prints with its issue block — named here so the golden
 * and the print site cite one string. */
export const FIXER_DECLINE_LEAD_IN =
  "A finding you cannot apply without contradicting it is declined, not implemented — how is stated below.";

/** The scope line `lensContext` prints first for a full-round, non-whole-branch
 * pass — the one part of the brief the split does not touch. */
export const FULL_SCOPE_LINE = "/work-lean issue #7, lens-review full review of the branch";

/** The lens brief for a body with no parsable block: the shared block, trimmed,
 * joined to the scope line the way `lensContext` joined it. */
export function goldenLensContext(issueBody: string | undefined): string {
  const block = fencedIssuePromptBlock(issueBody, ADVERSARIAL_FINDING_RULE, fencedIssueBody);
  return block === "" ? FULL_SCOPE_LINE : [FULL_SCOPE_LINE, block.trim()].join("\n\n");
}

/** The fixer's brief for a body with no parsable block, from its first newline to
 * the findings heading: the raw bounded block and the decline section after it —
 * the one brief shape in these suites the fallback still owns end to end. */
export function goldenFixIssueSection(issueBody: string | undefined): string {
  const issueBlock = fencedIssuePromptBlock(issueBody, FIXER_DECLINE_LEAD_IN, fencedIssueBody);
  return issueBlock === ""
    ? "\n"
    : `\n${issueBlock}\n## Declining a finding that contradicts the issue\n\n${FIXER_DECLINE_RULE}\n`;
}

/** A body's raw block as a seat that strips nothing prints it: `fencedIssueBody`
 * on the RAW bytes, which for a body under the cap is the block verbatim — every
 * criterion's JSON, quotes and all. The ON-arm cases read this as what a brief
 * must NOT contain, so the negative assertion is computed rather than hand-typed.
 */
export function rawBlockPayload(issueBody: string): string[] {
  const printed = fencedIssueBody(issueBody);
  const keys = ["problem", "criteria", "id", "text", "verify"];
  return keys.map((k) => `"${k}"`).filter((needle) => printed.includes(needle));
}

/**
 * lib/lean-review-spec-split-golden — today's renders, frozen before the split.
 *
 * The off arm's promise is that a lean review brief is BYTE-IDENTICAL to the
 * render the seats received before the split existed. That cannot be compared
 * against a live call in the module that changed: `fencedIssuePromptBlock` is
 * shared with classic /work, so the pre-change expression has to live somewhere
 * that keeps calling the shared renderer exactly as the off arm calls it — here.
 *
 * Each golden is the expression `review-deps.ts` and `adversarial-prompts.ts`
 * used at their print sites, over the fixture bodies in
 * `lib/lean-review-spec-fixture.ts`, and the off-arm case asserts `===` against
 * it. `test-lean-review-spec-split-off.ts` prints each golden's length and marker
 * count, so the file cannot go vacuously green on an empty constant.
 */

import {
  ADVERSARIAL_FINDING_RULE,
  fencedIssueBody,
  fencedIssuePromptBlock,
  ISSUE_PROMPT_LEAD,
} from "../../src/adversarial-prompts.ts";
import { FIXER_DECLINE_RULE } from "../../src/work-driver-lens-issue.ts";
import {
  MANY_CRITERIA_BODY,
  MEDIUM_SPEC_BODY,
  NO_SPEC_BODY,
  SMALL_SPEC_BODY,
  SPEC_BODY,
  UNTERMINATED_SPEC_BODY,
} from "./lean-review-spec-fixture.ts";
import { ISSUE_BODY, OVER_BODY } from "./ticket-issue-fixture.ts";

/** Every body a golden is taken over: small, over-cap, spec-bearing, and the
 * spec shapes that must degrade to today's plain bounded block. */
export const GOLDEN_BODIES: Record<string, string> = {
  issue: ISSUE_BODY,
  over: OVER_BODY,
  smallSpec: SMALL_SPEC_BODY,
  spec: SPEC_BODY,
  mediumSpec: MEDIUM_SPEC_BODY,
  noSpec: NO_SPEC_BODY,
  unterminated: UNTERMINATED_SPEC_BODY,
  manyCriteria: MANY_CRITERIA_BODY,
};

/** The bodies whose `pi-spec` block is the thing the bound competes with — the
 * ones the off arm is asserted to cut. */
export const CRITERIA_BEARING_BODIES = ["spec", "mediumSpec"] as const;

/** The lead-in `fixPrompt` prints with its issue block — named here so the
 * golden and the print site cite one string. */
export const FIXER_DECLINE_LEAD_IN =
  "A finding you cannot apply without contradicting it is declined, not implemented — how is stated below.";

/** The scope line `lensContext` prints first for a full-round, non-whole-branch
 * pass — the one part of the brief the split does not touch. */
export const FULL_SCOPE_LINE = "/work-lean issue #7, lens-review full review of the branch";

/** The lens brief as it renders today: the shared block, trimmed, joined to the
 * scope line the way `lensContext` joined it. */
export function goldenLensContext(issueBody: string | undefined): string {
  const block = fencedIssuePromptBlock(issueBody, ADVERSARIAL_FINDING_RULE, fencedIssueBody);
  return block === "" ? FULL_SCOPE_LINE : [FULL_SCOPE_LINE, block.trim()].join("\n\n");
}

/** The fixer's brief as it renders today, from its first newline to the findings
 * heading: the issue block and the decline section that follows it. */
export function goldenFixIssueSection(issueBody: string | undefined): string {
  const issueBlock = fencedIssuePromptBlock(issueBody, FIXER_DECLINE_LEAD_IN, fencedIssueBody);
  return issueBlock === ""
    ? "\n"
    : `\n${issueBlock}\n## Declining a finding that contradicts the issue\n\n${FIXER_DECLINE_RULE}\n`;
}

/** The adversarial reviewer's issue block as it renders today: the lead-in, the
 * loop's finding rule, and the bounded body. */
export function goldenAdversarialIssueBlock(issueBody: string | undefined): string {
  const body = fencedIssueBody(issueBody);
  if (body === "") return "";
  return `\n\n${ISSUE_PROMPT_LEAD} ${ADVERSARIAL_FINDING_RULE}\n\n${body}`;
}

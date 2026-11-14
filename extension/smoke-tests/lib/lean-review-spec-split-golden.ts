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
  ISSUE_PROMPT_LEAD,
  fencedIssueBody,
  fencedIssuePromptBlock,
} from "../../src/adversarial-prompts.ts";
import {
  LEAN_REVIEW_CRITERIA_HEADING,
  LEAN_REVIEW_CRITERIA_LEAD,
} from "../../src/lean/review-criteria.ts";
import { criteriaBlock } from "../../src/lean/spec-blocks.ts";
import { parsePiSpec } from "../../src/lean/spec.ts";
import { fenceText } from "../../src/lean/text-fence.ts";
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

/** The cap the criteria section is bounded at — the constant the renderer passes
 * to `fenceText`, restated here because a golden that read the module's own
 * constant could not catch the module changing it. */
const GOLDEN_CRITERIA_CAP = 20_000;

/** The same `fenceText` clip notice the live renderer substitutes its marker
 * for, built by concatenation so this file's own prose cannot be matched by it. */
const GOLDEN_FENCE_CLIP_NOTICE = new RegExp(`\\[truncated at \\d+ char${"acters"}\\]`);

/** The generic clip notice as a literal, for the assertion that says the section
 * never carries it. */
export const GOLDEN_CLIP_NOTICE = `[truncated at ${String(GOLDEN_CRITERIA_CAP)} char${"acters"}]`;

/** The statement's own cap — the bound its block is fenced at, restated here for
 * the same reason the criteria cap is. */
const GOLDEN_PROBLEM_CAP = 20_000;

/** What the statement's fence says when IT clipped — never the criteria marker,
 * because a seat weighing a cut statement and a cut list cannot otherwise tell
 * which half of its contract it lost. */
export const GOLDEN_PROBLEM_MARKER = "…(problem truncated)";

/** A statement long enough that the criteria section clips it on its own: a
 * review seat reads the statement ONLY through that section, so the statement's
 * own bound is an arm a body can reach without the list being long at all. */
export const OVER_PROBLEM_BODY: string = (() => {
  const problem = "The meter must refuse the draw once the quota is spent. ".repeat(
    Math.ceil(GOLDEN_PROBLEM_CAP / 56) + 60,
  );
  const json = JSON.stringify(
    {
      problem,
      criteria: [{ id: "AC1", text: "The meter refuses the draw.", verify: "test" }],
      size: "M",
    },
    null,
    2,
  );
  return `Add a quota check to the meter.\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
})();

/**
 * The criteria section as it renders today: the heading, the lead, and the
 * rendered criteria disarmed by `fenceText` — nothing above the list.
 *
 * This is the pre-`PI_ENSEMBLE_LEAN_REVIEW_PROBLEM` expression, written here
 * rather than imported so the off arm's `===` is checked against a copy the
 * module under change cannot move.
 */
export function goldenSpecCriteriaSection(rawBody: string | undefined): string {
  if (rawBody === undefined || rawBody.trim() === "") return "";
  const parsed = parsePiSpec(rawBody);
  if (!parsed.ok) return "";
  const block = criteriaBlock(parsed.spec);
  if (block.trim() === "") return "";
  const overCap = block.length > GOLDEN_CRITERIA_CAP;
  const disarmed = fenceText(block, GOLDEN_CRITERIA_CAP);
  return `${LEAN_REVIEW_CRITERIA_HEADING}\n\n${LEAN_REVIEW_CRITERIA_LEAD}\n\n${
    overCap ? disarmed.replace(GOLDEN_FENCE_CLIP_NOTICE, "…(criteria truncated)") : disarmed
  }`;
}

/** A criterion's bullet: the renderer's own shape, id and verify kind together —
 * the form a seat can only have read from the criteria section. */
export function criterionLine(id: string): RegExp {
  return new RegExp(`\\*\\*${id}\\*\\* \\[(test|command|manual)\\]`);
}

/** A criterion's row AS THE CRITERIA SECTION PRINTS IT, read out of the section
 * the renderer itself produced for `rawBody`: a seat that printed the RAW block
 * also carries the id, quoted, and a bare `includes` on the id cannot tell the
 * two apart. Computed rather than hand-typed, so a fixture that reworded a
 * criterion cannot quietly make the assertion vacuous. */
export function renderedCriterionLine(rawBody: string, id: string): string {
  const section = goldenSpecCriteriaSection(rawBody);
  const line = section
    .split("\n")
    .find((l) => l.includes(`**${id}**`) && criterionLine(id).test(l));
  if (line === undefined) {
    throw new Error(
      `renderedCriterionLine: ${id} is not a row of the criteria section for this body — the arm would be vacuous.`,
    );
  }
  return line;
}

/**
 * A body's raw block as a seat that strips nothing prints it: `fencedIssueBody`
 * on the RAW bytes, which for a body under the cap is the block verbatim — every
 * criterion's JSON, quotes and all. The ON-arm case reads this as what a brief
 * must NOT contain, so the negative assertion is computed rather than hand-typed:
 * hand-picked keys would be an assertion about the fixture's spelling, and a body
 * that renames a key would pass on a seat that strips nothing at all.
 */
export function rawBlockPayload(issueBody: string): string[] {
  const printed = fencedIssueBody(issueBody);
  const keys = ["problem", "criteria", "id", "text", "verify"];
  return keys.map((k) => `"${k}"`).filter((needle) => printed.includes(needle));
}

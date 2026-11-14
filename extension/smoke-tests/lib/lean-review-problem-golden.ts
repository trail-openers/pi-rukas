/**
 * lib/lean-review-problem-golden — the review seats' briefs as they rendered
 * BEFORE `PI_ENSEMBLE_LEAN_REVIEW_PROBLEM` put the spec's `problem` at the head of
 * the criteria section.
 *
 * `lib/lean-review-spec-split-golden.ts` freezes the pre-SPLIT renders and reads
 * the criteria section's heading and lead from `lean/review-criteria.ts`. This
 * change owns that module's wording, so a golden that read it from there would move
 * with the thing it exists to catch: the pre-statement section — heading, lead, and
 * both payloads' caps and markers — is restated here instead, and the clip notices
 * are built by concatenation so this file's prose, which names them, is not matched
 * by the substitutions it describes. What this file does NOT own — the shared
 * lead-in, each seat's rule sentence, the decline rule — is imported from its real
 * module, because a change that moves one of those is a defect to report, not one to
 * forgive.
 *
 * The three goldens below are the shapes the two print sites built before the
 * statement existed: the criteria section with nothing above the list, and the two
 * issue blocks that print it.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import {
  ADVERSARIAL_FINDING_RULE,
  ISSUE_PROMPT_LEAD,
} from "../../src/adversarial-prompts.ts";
import { FIXER_DECLINE_RULE } from "../../src/work-driver-lens-issue.ts";
import { criteriaBlock } from "../../src/lean/spec-blocks.ts";
import { parsePiSpec } from "../../src/lean/spec.ts";
import { fenceText } from "../../src/lean/text-fence.ts";
import { renderReviewProse, renderReviewIssueBlock } from "../../src/lean/review-spec-split.ts";
import { fixPrompt, lensContext } from "../../src/lean/review-deps.ts";
import { MAX_ISSUE_CHARS } from "../../src/adversarial-prompts.ts";
import {
  D3_COUNT,
  D3_CRITERION,
  D3_TEXT_WIDTH,
  SPEC_TAIL_CONSTRAINT,
} from "./lean-review-spec-fixture.ts";

/** The cap each of the section's two payloads is bounded at — restated rather than
 * imported, for the reason in the header. */
const GOLDEN_PAYLOAD_CAP = 20_000;

/** `fenceText`'s generic clip notice, which each payload swaps for a marker of its
 * own. Built by concatenation: a file whose prose names the notice must not have
 * that name matched by the substitution it describes. */
const GOLDEN_CLIP_NOTICE = new RegExp("\\[truncated at \\d+ char" + "acters]");

/** What each payload's fence says when IT clipped. Two markers and never one: a
 * seat weighing a cut statement against a cut list has to be able to tell which
 * half of its contract it lost. */
export const GOLDEN_PROBLEM_MARKER = ["…(problem", "truncated)"].join(" ");
const GOLDEN_CRITERIA_MARKER = ["…(criteria", "truncated)"].join(" ");

/** The section's heading and lead, restated for the same reason the caps are. */
const GOLDEN_CRITERIA_HEADING = "## The acceptance criteria" + " (pi-spec v1)";
const GOLDEN_CRITERIA_LEAD =
  "Every criterion below is a requirement of this issue, printed in full up to its" +
  " own cap, with its own marker when that cap cut it. A finding whose fix would" +
  " contradict one is not a finding.";

/** The clause the split's lead-in adds when a criteria section follows, and each
 * seat's own rule sentence — three print-site literals, spelled out here so a
 * golden cannot be moved by the module under change and cannot quietly disagree
 * with the brief it judges. */
const CRITERIA_CLAUSE =
  " Its acceptance criteria are printed in their own section below and are not" +
  " truncated by the issue's length.";
const LENS_RULE =
  "A finding whose fix would require contradicting an explicit requirement of this" +
  " issue is NOT a finding.";
const FIXER_RULE =
  "A finding you cannot apply without contradicting it is declined, not" +
  " implemented — how is stated below.";

/** The scope line `lensContext` prints first for a full-round pass. */
const FULL_SCOPE_LINE = "/work-lean issue #7, lens-review full review of the branch";

/** One payload: `fenceText`'s disarm at the cap, with the generic notice swapped
 * for the marker naming WHICH payload was cut. Substituted per payload, so a
 * criteria clip can never rewrite the statement's notice or the other way round —
 * the shape `BOTH_PAYLOADS_OVER_CAP_BODY` exists to make observable. */
function fencePayload(text: string, marker: string): string {
  const overCap = text.length > GOLDEN_PAYLOAD_CAP;
  const disarmed = fenceText(text, GOLDEN_PAYLOAD_CAP);
  return overCap ? disarmed.replace(GOLDEN_CLIP_NOTICE, marker) : disarmed;
}

/** The criteria section as it rendered with NO statement above the list: heading,
 * lead, and the rendered criteria — nothing else. */
export function preStatementCriteriaSection(rawBody: string | undefined): string {
  if (rawBody === undefined || rawBody.trim() === "") return "";
  const parsed = parsePiSpec(rawBody);
  if (!parsed.ok) return "";
  const block = criteriaBlock(parsed.spec);
  if (block.trim() === "") return "";
  return `${GOLDEN_CRITERIA_HEADING}\n\n${GOLDEN_CRITERIA_LEAD}\n\n${fencePayload(block, GOLDEN_CRITERIA_MARKER)}`;
}

/** The split's issue-block expression over a caller-supplied section. Each site
 * passes its own rule, and the rule is spelled above rather than read back from the
 * module: the statement switch owns neither sentence, and a golden that moved one
 * would forgive the very edit it is meant to catch. */
function issueBlockWithSection(body: string, rule: string, section: string): string {
  const prose = renderReviewProse(body);
  if (prose === "") return "";
  return `\n\n${ISSUE_PROMPT_LEAD} ${ADVERSARIAL_FINDING_RULE}${CRITERIA_CLAUSE} ${rule}\n\n${prose}\n\n${section}`;
}

/** The lens brief as the split rendered it without the statement: the scope line
 * and the issue block, joined the way `lensContext` joins them. `""` where the
 * body carries no section — that arm is the split's own golden's business. */
export function preStatementLensContext(body: string): string {
  const section = preStatementCriteriaSection(body);
  if (section === "") return "";
  const block = issueBlockWithSection(body, LENS_RULE, section);
  if (block === "") return "";
  return [FULL_SCOPE_LINE, block.trim()].join("\n\n");
}

/** The fixer brief's issue span as it rendered without the statement: the block
 * above the findings, plus the decline section the print site appends whenever there
 * is an issue block to cite. The span under test runs from the newline that ends
 * the brief's own preamble to the next heading, so the golden re-creates that line
 * ending and the decline section verbatim rather than assuming a trim. */
export function preStatementFixerIssueSection(body: string): string {
  const section = preStatementCriteriaSection(body);
  if (section === "") return "";
  const block = issueBlockWithSection(body, FIXER_RULE, section);
  if (block === "") return "";
  return `\n${block}\n## Declining a finding that contradicts the issue\n\n${FIXER_DECLINE_RULE}\n`;
}

/** Everything in a brief AFTER the criteria heading — the section a seat reads as
 * its contract, and the only place the statement may appear. */
export function criteriaSpanOf(brief: string): string {
  return brief.split(GOLDEN_CRITERIA_HEADING)[1] ?? "";
}

/** A criterion's bullet: the renderer's own shape, id and verify kind together —
 * the form a seat can only have read from the criteria section. */
export function criterionRow(id: string): RegExp {
  return new RegExp(`\\*\\*${id}\\*\\* \\[(test|command|manual)\\]`);
}

/** The character a fence is built from, as a string: counted with `split` rather
 * than a regex, where an escape for it reads as the literal's own terminator. */
export const FENCE_CHAR = "\u0060";

/** Count fence lines at the start of a line, so a brief's fences pair. */
export function fenceLines(text: string): number {
  return (text.match(/^```/gm) ?? []).length;
}

/** A key of the raw spec block as its JSON prints it. A brief that carried the
 * block verbatim would carry these, and no seat's brief is meant to. */
export const SPEC_JSON_KEYS = ['"problem"', '"criteria"'] as const;

/** The lens seat's issue block as the split printed it before the statement —
 * the block alone, not the whole brief: the case that pins the prose block's
 * presence beside the section compares one print site's output, not the join. */
export function preStatementLensIssueBlock(body: string): string {
  const section = preStatementCriteriaSection(body);
  return section === "" ? "" : issueBlockWithSection(body, LENS_RULE, section);
}

/** A criterion's row AS THE PRE-STATEMENT SECTION PRINTS IT, read out of the
 * section this file renders rather than the module's: a seat that printed the raw
 * block also carries the id quoted, so a bare `includes` on the id cannot tell the
 * two apart, and a fixture that reworded a criterion would otherwise make the
 * assertion vacuous. Throws so a body that carries no such row fails loudly. */
export function renderedCriterionRow(body: string, id: string): string {
  const line = preStatementCriteriaSection(body)
    .split("\n")
    .find((l) => l.includes(`**${id}**`) && criterionRow(id).test(l));
  if (line === undefined) {
    throw new Error(
      `renderedCriterionRow: ${id} is not a row of the criteria section for this body — the arm would be vacuous.`,
    );
  }
  return line;
}

/**
 * The five bodies the statement's four claims need, kept beside the goldens that
 * are read off them: each is a shape the ONE bound of the pre-statement render
 * decided differently, so a fixture that drifted would make an assertion vacuous
 * rather than wrong — which is why they are computed and self-checking here.
 */

/** The prose filler that makes a body itself pass the issue bound: with the prose
 * cut, the section's copy is the ONLY one a brief can carry. */
const PROSE_FILLER = SPEC_TAIL_CONSTRAINT.repeat(140);

/** One repeat of the statement, ~90 chars, so the lengths below are a property of
 * a count rather than of a hand-written paragraph. */
export const SENTENCE =
  "The meter must refuse the draw once the quota is spent, and say so in one fixed sentence. ";

/** A statement whose tail the prose bound cuts — the seat can read it ONLY through
 * the criteria section, which is the whole claim under test. */
export const PROBLEM_TAIL = `PROBLEM-TAIL-${"statement ".repeat(300)}`;

/** Three short criteria, so nothing but the statement can be what the section cut. */
const THREE_CRITERIA = [
  { id: "AC1", text: "The meter refuses the draw.", verify: "test" },
  { id: "AC2", text: "The refusal names the quota.", verify: "test" },
  { id: "AC3", text: "The counter never goes negative.", verify: "manual" },
];

function specBody(prose: string, spec: unknown): string {
  return `${prose}\n\n\`\`\`pi-spec v1\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`;
}

/** A `problem` over the prose bound, three short criteria, and a prose block long
 * enough that the bound's cut falls in the statement's tail: nothing else in any
 * brief carries that tail, so a brief that printed it printed the SECTION. */
export const OVER_PROBLEM_STATEMENT_BODY: string = (() => {
  const body = specBody(`Add a quota check to the meter.\n\n${PROSE_FILLER}`, {
    problem: `${SENTENCE}${PROBLEM_TAIL}`,
    criteria: THREE_CRITERIA,
    size: "M",
  });
  // The prose block's own tail must survive to make the section's copy the only
  // difference between the two arms: the prose is bounded, so the tail must sit
  // past the bound in the PROSE as well as in the statement.
  if (!body.trim().slice(0, MAX_ISSUE_CHARS).includes("quota")) {
    throw new Error(
      "OVER_PROBLEM_STATEMENT_BODY geometry: the prose block prints nothing, so the section proves nothing.",
    );
  }
  // The claim under test needs the tail GONE from the prose and PRESENT in the
  // section: assert the prose the seat actually reads does not carry it. `fenceText`
  // and `fencedIssueBody` bound the same bytes, so reading the bound off the prose
  // renderer is the geometry that matters, not the body's raw length.
  if (renderReviewProse(body).includes(PROBLEM_TAIL)) {
    throw new Error(
      "OVER_PROBLEM_STATEMENT_BODY geometry: the prose bound leaves the statement's tail whole, so the section proves nothing — the arm would be vacuous.",
    );
  }
  return body;
})();

/** A body whose prose, once its block is stripped, IS its `problem` — the shape
 * `/plan` files, and the reason the separate prose block must be dropped. */
export const PROBLEM_EQUALS_PROSE_BODY: string = specBody(
  "The meter must refuse the draw once the quota is spent,\n  and say so in one fixed sentence.",
  {
    problem: "The meter must refuse the draw once the quota is spent,\n  and say so in one fixed sentence.",
    criteria: [THREE_CRITERIA[0]],
    size: "S",
  },
);

/** A body whose prose differs from its `problem` even after whitespace collapses:
 * both blocks print and the dedupe must not fire. */
export const PROBLEM_DIFFERS_BODY: string = specBody(
  "Add a quota check to the meter, which is a ledger of draws.",
  {
    problem: "The meter must refuse the draw once the quota is spent.",
    criteria: [THREE_CRITERIA[0]],
    size: "S",
  },
);

/** A body that PARSES with `criteria: []` — the E1 case. `parsePiSpec` accepts an
 * empty list; `readiness()` is what refuses it on a real run. */
export const EMPTY_CRITERIA_BODY: string = specBody(
  `Add a quota check to the meter.\n\n${SPEC_TAIL_CONSTRAINT.repeat(150)}`,
  { problem: "The meter must refuse the draw once the quota is spent.", criteria: [], size: "S" },
);

/** A body over BOTH caps at once: a statement past the statement bound AND 40
 * criteria past the list bound. This is the only shape on which an UNANCHORED
 * marker substitution is visible — it would rewrite the wrong payload's notice. */
export const BOTH_PAYLOADS_OVER_CAP_BODY: string = (() => {
  const criteria = Array.from({ length: D3_COUNT }, (_, i) => ({
    id: `AC${String(i + 1)}`,
    text: `AC${String(i + 1)} ${D3_CRITERION.repeat(30).slice(0, D3_TEXT_WIDTH)}`,
    verify: "test" as const,
  }));
  const body = specBody(`Add a quota check to the meter.\n\n${PROSE_FILLER}`, {
    problem: `PROBLEM-STATEMENT-${"statement ".repeat(2000)}`,
    criteria,
    size: "M",
  });
  if (!body.includes("PROBLEM-STATEMENT-")) {
    throw new Error("BOTH_PAYLOADS_OVER_CAP_BODY geometry: the statement is not in the body.");
  }
  return body;
})();

/** The statement sub-block's own lead-in, named so the assertion that the seat is
 * TOLD what the statement is does not hard-code a sentence the renderer could
 * reword out from under it. */
export const PROBLEM_LEAD = "The statement of the problem this run is for";

/** One line of `MANY_CRITERIA_40_BODY`'s prose: its presence says the prose block
 * arrived WHOLE, which is what makes the absence of the prose's truncation marker
 * a fact about the split rather than about a body whose prose printed nothing. */
export const PROSE_HEAD_LINE = "Add a quota check to the meter.";

/** The fixer's args: nothing variable in them but the body, so two briefs that
 * must differ only in what the layer printed differ in exactly that. */
export function fixerArgs(issueBody: string | undefined): Record<string, unknown> {
  return {
    issue: 7,
    wave: "full",
    gate: "six-lens review (ISSUES_FOUND)",
    findings: "- [HIGH] SECURITY a.ts:1: reword the exception",
    worktree: "/repo/.worktrees/lean-7-fix-l-1-0-1793451347919",
    repoRoot: "/repo",
    branch: "lean/issue-7",
    base: "deadbeef",
    head: "cafebabe",
    frozenPaths: ["tests/AC1.test.ts"],
    budget: { opts: {}, fired: () => undefined },
    stop: {},
    issueBody,
  };
}

/** One seat's print, from the renderers and print sites under test. The goldens
 * above are built by the same helpers, so a brief and the brief it is compared
 * against cannot drift apart in their arguments. */
export function seats(body: string) {
  return {
    prose: renderReviewProse(body),
    criteria: renderSpecCriteriaSection(body),
    block: renderReviewIssueBlock(body, LENS_RULE),
    lens: lensContext(7, "full", { issueBody: body }),
    fix: fixPrompt(fixerArgs(body) as never),
  };
}

import { renderSpecCriteriaSection } from "../../src/lean/review-criteria.ts";

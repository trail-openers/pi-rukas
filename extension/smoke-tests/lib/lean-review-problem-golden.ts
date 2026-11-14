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
import { ADVERSARIAL_FINDING_RULE, ISSUE_PROMPT_LEAD } from "../../src/adversarial-prompts.ts";
import { MAX_ISSUE_CHARS } from "../../src/adversarial-prompts.ts";
import { fixPrompt, lensContext } from "../../src/lean/review-deps.ts";
import { renderReviewIssueBlock, renderReviewProse } from "../../src/lean/review-spec-split.ts";
import { criteriaBlock } from "../../src/lean/spec-blocks.ts";
import { parsePiSpec } from "../../src/lean/spec.ts";
import { fenceText } from "../../src/lean/text-fence.ts";
import { FIXER_DECLINE_RULE } from "../../src/work-driver-lens-issue.ts";
import {
  D3_COUNT,
  D3_CRITERION,
  D3_TEXT_WIDTH,
  SPEC_TAIL_CONSTRAINT,
} from "./lean-review-spec-fixture.ts";
// The section's payload constants are restated once, in `lean-review-problem-shape`,
// and re-exported here so the tests that read them from this file keep working and
// the quoting fixtures read the same copy the goldens judge the renderer against.
import {
  FENCE_CHAR,
  GOLDEN_CRITERIA_MARKER,
  GOLDEN_PAYLOAD_CAP,
  GOLDEN_PROBLEM_MARKER,
  PROSE_FILLER,
  THREE_CRITERIA,
  criteriaFenceOf,
  specBody,
  statementFenceOf,
} from "./lean-review-problem-shape.ts";
export * from "./lean-review-problem-shape.ts";
/** The clip line `fenceText` says when its caller named no marker — spelled out
 * here rather than reached for by rewriting the rendered fence, which is exactly
 * the mechanism that let one payload's quoted marker masquerade as the other's cut. */
const GOLDEN_CLIP_NOTICE = (cap: number): string =>
  `\n[truncated at ${String(cap)} char` + "acters]";

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

/** One payload: the cap's disarm at the tail with the clip line being the marker
 * that names WHICH payload was cut. Composed from `fenceText`'s parts rather than
 * by substituting into its output, so a payload that quotes the other payload's
 * marker cannot be reported as a cut that never happened. The shape
 * `BOTH_PAYLOADS_OVER_CAP_BODY` exists to make the two markers observable. */
function fencePayload(text: string, marker: string): string {
  const OPEN = "```text\n";
  const CLOSE = `\n\`\`\``;
  // `fenceText` is asked for its neutralised payload directly (notice ""), so the
  // golden composes the same bytes from the same parts instead of rewriting a
  // rendered notice: substitution hit the FIRST match, and issue-authored text can
  // quote a marker, which is how a payload came to be reported as a cut it never
  // took. `slice` drops the renderer's empty trailing notice line, nothing else.
  const body = fenceText(text, GOLDEN_PAYLOAD_CAP, "").slice(
    OPEN.length,
    -(CLOSE.length + (text.length > GOLDEN_PAYLOAD_CAP ? 1 : 0)),
  );
  return text.length <= GOLDEN_PAYLOAD_CAP
    ? `${OPEN}${body}${CLOSE}`
    : `${OPEN}${body}\n${marker}${CLOSE}`;
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


/** Count fence lines at the start of a line, so a brief's fences pair. */
export function fenceLines(text: string): number {
  return (text.match(/^```/gm) ?? []).length;
}

/** The characters the statement's fence KEPT — the payload of the first fenced
 * block in a section, which is the statement (the list is the second). Measured
 * rather than inferred: an assertion that the section "contains the marker" is
 * true for any cap, so only this number pins which cap was applied. */
export function keptStatementSpan(section: string): string {
  const OPEN = `${FENCE_CHAR.repeat(3)}text\n`;
  const open = section.indexOf(OPEN);
  const close = open < 0 ? -1 : section.indexOf(`\n${FENCE_CHAR.repeat(3)}`, open + OPEN.length);
  if (open < 0 || close < 0) {
    throw new Error(
      "keptStatementSpan: the section carries no fenced statement payload to measure.",
    );
  }
  return section.slice(open + OPEN.length, close);
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

/** One repeat of the statement, ~90 chars, so the lengths below are a property of
 * a count rather than of a hand-written paragraph. */
export const SENTENCE =
  "The meter must refuse the draw once the quota is spent, and say so in one fixed sentence. ";

/** A statement whose tail the prose bound cuts — the seat can read it ONLY through
 * the criteria section, which is the whole claim under test. */
export const PROBLEM_TAIL = `PROBLEM-TAIL-${"statement ".repeat(300)}`;

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

/** The count of characters the statement's own fence keeps when the statement
 * passes it — `fenceText`'s allowance plus the one-character ellipsis, since the
 * ellipsis is not charged to the bound. */
export const PROBLEM_CAP_KEEP = GOLDEN_PAYLOAD_CAP + 1;

/** The statement's truncation marker in full, so a test can state the kept span
 * as the cap plus its own marker rather than re-typing the words. */
export const PROBLEM_MARKER_FULL = GOLDEN_PROBLEM_MARKER;

/** How many repeats of `SENTENCE` put a statement past the statement cap with
 * room to spare — the geometry `STATEMENT_OVER_CAP_BODY` and the assertion that
 * measures its kept span both read, so neither can drift from the other. */
export const STATEMENT_OVER_CAP_REPS = Math.ceil(GOLDEN_PAYLOAD_CAP / SENTENCE.length) + 30;

/** The closing clause of `STATEMENT_OVER_CAP_BODY`'s statement, unique to it for
 * the reason `MID_PROBLEM_SENTINEL` gives: a statement built from one repeating
 * sentence has no tail a reader can point at. */
export const STATEMENT_OVER_CAP_SENTINEL = "OVER-CAP-TAIL the ledger keeps its own total.";

/** The exact payload the statement's fence must keep once its clip is marked:
 * `cap` characters, the ellipsis `fenceText` appends, and the marker naming which
 * payload was cut. Computed from the statement so the fixture cannot drift from
 * the number it measures. */
export function keptStatementSpanFor(statement: string): string {
  return `${statement.slice(0, GOLDEN_PAYLOAD_CAP)}\u2026\n${GOLDEN_PROBLEM_MARKER}`;
}

/** The statement `STATEMENT_OVER_CAP_BODY` carries — the value whose measured
 * kept span pins the cap. */
export const STATEMENT_OVER_CAP_STATEMENT = `${SENTENCE.repeat(
  STATEMENT_OVER_CAP_REPS,
)}${STATEMENT_OVER_CAP_SENTINEL}`;

/** A body whose statement passes its OWN cap while the prose block beside it
 * carries the WHOLE statement and prints no cut of its own: the shape that makes
 * the kept span a fact about the statement's bound alone. The statement is the
 * body's prose and its `problem` at once, but separated by the spec block the
 * strip takes away, so the dedupe does not fire — the seat reads the prose block
 * AND the section. Nothing but the statement's own cap can be what cut it here:
 * a cap lowered toward the prose's would cut the payload and print its marker on
 * a body whose prose says nothing was cut. */
export const STATEMENT_OVER_CAP_BODY: string = (() => {
  const statement = `${SENTENCE.repeat(STATEMENT_OVER_CAP_REPS)}${STATEMENT_OVER_CAP_SENTINEL}`;
  const body = specBody(`Add a quota check to the meter.\n\n${statement}`, {
    problem: statement,
    criteria: THREE_CRITERIA,
    size: "M",
  });
  if (statement.length <= GOLDEN_PAYLOAD_CAP) {
    throw new Error(
      `STATEMENT_OVER_CAP_BODY geometry: the statement is ${String(
        statement.length,
      )} chars, not past the ${String(GOLDEN_PAYLOAD_CAP)}-char statement cap — the arm would be vacuous.`,
    );
  }
  const section = renderSpecCriteriaSection(body);
  if (section.split(GOLDEN_PROBLEM_MARKER).length - 1 !== 1) {
    throw new Error(
      "STATEMENT_OVER_CAP_BODY geometry: the section carries no statement marker, so there is no kept span to measure.",
    );
  }
  const prose = renderReviewProse(body);
  if (prose === "") {
    throw new Error(
      "STATEMENT_OVER_CAP_BODY geometry: the prose block printed nothing, so the section's cut is not contrasted with a prose the seat also read.",
    );
  }
  if (!prose.includes(statement.slice(0, SENTENCE.length))) {
    throw new Error(
      "STATEMENT_OVER_CAP_BODY geometry: the prose block carries none of the statement, so the section proves nothing about a bound the prose never applied.",
    );
  }
  return body;
})();

/** The statement `MID_PROBLEM_BODY` carries: past the prose bound, under its own
 * cap — the arm that pins the cap from the side where nothing may be cut. Its
 * closing clause is unique to the statement (`MID_PROBLEM_SENTINEL`), so "the
 * statement's tail" is a string the prose block cannot contain by accident — the
 * sentence this statement is built from repeats, and a repeated sentence has no
 * distinguishable tail. */
export const MID_PROBLEM_SENTINEL = "MID-CAP-TAIL the counter never rolls over.";
export const MID_PROBLEM_STATEMENT = `${SENTENCE.repeat(180)}${MID_PROBLEM_SENTINEL}`;

/** The statement repeated enough times to pass `MAX_ISSUE_CHARS` while staying
 * well under its own cap — the arm that pins the cap from the other side: a
 * statement that long must reach the seat WHOLE, because nothing but a cap low
 * enough to be the prose's would cut it. */
export const MID_PROBLEM_BODY: string = (() => {
  // The statement leads the prose and a distinct clause trails it: with the body's
  // prose being the statement alone the dedupe would fire, the prose block would be
  // dropped, and the arm would stop measuring the prose bound at all. The trailing
  // clause keeps both blocks, so the cut the prose prints — and the section prints
  // nothing of — is the comparison that makes the whole payload a fact.
  const body = specBody(`${MID_PROBLEM_STATEMENT}\n\n${SPEC_TAIL_CONSTRAINT.repeat(30)}`, {
    problem: MID_PROBLEM_STATEMENT,
    criteria: THREE_CRITERIA,
    size: "M",
  });
  if (
    MID_PROBLEM_STATEMENT.length <= MAX_ISSUE_CHARS ||
    MID_PROBLEM_STATEMENT.length >= GOLDEN_PAYLOAD_CAP
  ) {
    throw new Error(
      `MID_PROBLEM_BODY geometry: the statement is ${String(
        MID_PROBLEM_STATEMENT.length,
      )} chars, not between the ${String(MAX_ISSUE_CHARS)}-char prose bound and the ${String(
        GOLDEN_PAYLOAD_CAP,
      )}-char statement cap — the arm would be vacuous.`,
    );
  }
  if (renderReviewProse(body).includes(MID_PROBLEM_SENTINEL)) {
    throw new Error(
      "MID_PROBLEM_BODY geometry: the prose block already carries the statement's tail, so the section proves nothing — the arm would be vacuous.",
    );
  }
  if (!renderReviewProse(body).includes("\u2026(issue truncated)")) {
    throw new Error(
      "MID_PROBLEM_BODY geometry: the prose block prints no cut of its own, so the section's silence about a cut is not contrasted with a prose that WAS cut.",
    );
  }
  const outsideSection = renderReviewIssueBlock(body, LENS_RULE).split(GOLDEN_CRITERIA_HEADING)[0];
  if (outsideSection.includes(MID_PROBLEM_SENTINEL)) {
    throw new Error(
      "MID_PROBLEM_BODY geometry: a block outside the criteria section already carries the statement's tail, so the section proves nothing.",
    );
  }
  return body;
})();

/** A body whose prose, once its block is stripped, IS its `problem` — the shape
 * `/plan` files, and the reason the separate prose block must be dropped. */
export const PROBLEM_EQUALS_PROSE_BODY: string = specBody(
  "The meter must refuse the draw once the quota is spent,\n  and say so in one fixed sentence.",
  {
    problem:
      "The meter must refuse the draw once the quota is spent,\n  and say so in one fixed sentence.",
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

/** Every phrase that sends a seat to look for the issue's prose in the brief
 * ABOVE this block. On the shape where the prose IS the statement — `/plan` files
 * — the dedupe drops that prose block, so a lead saying so sends a reader to
 * something the brief does not contain. A lead may say the prose is short, or that
 * it is omitted when it only restates; it may not assert the prose is there. */
export const PROBLEM_LEAD_ABOVE_CLAIMS = [
  "issue text above",
  "prose above",
  "text above",
  "prose block above",
  "body above",
] as const;

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

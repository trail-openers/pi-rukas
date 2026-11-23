/**
 * lib/lean-review-problem-golden — the review section's own shape, frozen apart
 * from the module that renders it.
 *
 * `test-lean-review-problem-statement-cap.ts` measures how much of the statement
 * a seat's fence keeps. A golden that read the section's caps and markers back
 * from `lean/review-criteria.ts` would move with the thing it exists to catch, so
 * they are restated here (`lean-review-problem-shape`) and the measured spans are
 * built from those numbers rather than from the render. The two bodies below each
 * carry their own geometry guards, so a fixture that drifted fails at load with
 * the reason instead of leaving an assertion vacuous.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import { MAX_ISSUE_CHARS } from "../../src/adversarial-prompts.ts";
import { renderReviewIssueBlock, renderReviewProse } from "../../src/lean/review-spec-split.ts";
import { renderSpecCriteriaSection } from "../../src/lean/review-criteria.ts";
import { SPEC_TAIL_CONSTRAINT } from "./lean-review-spec-fixture.ts";
import {
  FENCE_CHAR,
  GOLDEN_PAYLOAD_CAP,
  GOLDEN_PROBLEM_MARKER,
} from "./lean-review-problem-shape.ts";

/** Re-exported so a test reads every constant of the frozen section from this one
 * module, the one it judges the render against. */
export { GOLDEN_PROBLEM_MARKER } from "./lean-review-problem-shape.ts";

/** The section's heading, restated for the same reason the caps are. */
const GOLDEN_CRITERIA_HEADING = "## The acceptance criteria" + " (pi-spec v1)";

/** The rule sentence a lens seat's print site adds, spelled out rather than read
 * back from the print site, so a golden cannot quietly disagree with the brief it
 * judges. */
const LENS_RULE =
  "A finding whose fix would require contradicting an explicit requirement of this" +
  " issue is NOT a finding.";

/** One repeat of the statement, ~90 chars, so the lengths below are a property of
 * a count rather than of a hand-written paragraph. */
const SENTENCE =
  "The meter must refuse the draw once the quota is spent, and say so in one fixed sentence. ";

/** Three short criteria, so nothing but the statement can be what the section cut. */
const THREE_CRITERIA = [
  { id: "AC1", text: "The meter refuses the draw.", verify: "test" },
  { id: "AC2", text: "The refusal names the quota.", verify: "test" },
  { id: "AC3", text: "The counter never goes negative.", verify: "manual" },
];

/** A body with `prose` and one `pi-spec v1` block carrying `spec`. */
function specBody(prose: string, spec: unknown): string {
  return `${prose}\n\n\`\`\`pi-spec v1\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`;
}

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
const STATEMENT_OVER_CAP_REPS = Math.ceil(GOLDEN_PAYLOAD_CAP / SENTENCE.length) + 30;

/** The closing clause of `STATEMENT_OVER_CAP_BODY`'s statement, unique to it for
 * the reason `MID_PROBLEM_SENTINEL` gives: a statement built from one repeating
 * sentence has no tail a reader can point at. */
export const STATEMENT_OVER_CAP_SENTINEL = "OVER-CAP-TAIL the ledger keeps its own total.";

/** The statement `STATEMENT_OVER_CAP_BODY` carries — the value whose measured
 * kept span pins the cap. */
export const STATEMENT_OVER_CAP_STATEMENT = `${SENTENCE.repeat(
  STATEMENT_OVER_CAP_REPS,
)}${STATEMENT_OVER_CAP_SENTINEL}`;

/** The exact payload the statement's fence must keep once its clip is marked:
 * `cap` characters, the ellipsis `fenceText` appends, and the marker naming which
 * payload was cut. Computed from the statement so the fixture cannot drift from
 * the number it measures. */
export function keptStatementSpanFor(statement: string): string {
  return `${statement.slice(0, GOLDEN_PAYLOAD_CAP)}\u2026\n${GOLDEN_PROBLEM_MARKER}`;
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

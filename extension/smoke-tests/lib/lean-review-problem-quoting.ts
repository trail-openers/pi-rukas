/**
 * lib/lean-review-problem-quoting — the two bodies whose issue text QUOTES the
 * other payload's truncation marker.
 *
 * The review section is two payloads under two bounds, each saying which of the
 * two was cut (`…(problem truncated)` / `…(criteria truncated)`), so a child
 * weighing a cut contract can locate it. Issue text is the input to both payloads,
 * so a payload can quote the other's marker, and `fenceText` writes its clip
 * notice AFTER the backtick neutralisation and last — the one ordering in which a
 * quoted line can never become the line that says a payload was cut. A renderer
 * that clipped first and then substituted its marker into the finished fence with a
 * pattern over the whole string had no such guarantee: `String.replace(RegExp,
 * string)` takes the FIRST match, so the payload's quote and the real notice were
 * competing for one replacement. These two bodies make that a measured property:
 * each quotes the OTHER payload's marker inside its own kept window, and the
 * payload that stayed whole must not be reported as cut.
 *
 * Split from `lean-review-problem-golden.ts` (AGENTS.md §12): the goldens there
 * restate the pre-statement render, which is a different question from what a
 * quoting payload does to the notice, and the two share only the fixture helpers.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import { criteriaBlock } from "../../src/lean/spec-blocks.ts";
import { parsePiSpec } from "../../src/lean/spec.ts";
import {
  GOLDEN_CRITERIA_MARKER,
  GOLDEN_PAYLOAD_CAP,
  GOLDEN_PROBLEM_MARKER,
  PROSE_FILLER,
  THREE_CRITERIA,
  criteriaFenceOf,
  renderSpecCriteriaSection,
  specBody,
  statementFenceOf,
} from "./lean-review-problem-shape.ts";

/** A body whose criteria list is UNDER its cap while its `problem` is over its own
 * AND carries, inside the kept window, a line that reads as `fenceText`'s own clip
 * notice. A substitution over the finished fence took the first match, so a quote
 * placed before the real notice was rewritten to THIS payload's marker and the
 * whole list beside it was announced as cut. The list is short and never clipped,
 * so any criteria marker in its fence can only be a notice that was moved into it. */
export const PROBLEM_QUOTES_CRITERIA_MARKER_BODY: string = (() => {
  const QUOTED_NOTICE =
    "[truncated at " + String(GOLDEN_PAYLOAD_CAP) + " char" + "acters]";
  const statement = `The meter must refuse the draw once the quota is spent.`;
  const quotedCriterion = `The meter refuses the draw.\n${QUOTED_NOTICE}`;
  const body = specBody(`Add a quota check to the meter.\n\n${PROSE_FILLER}`, {
    problem: statement,
    criteria: [
      THREE_CRITERIA[0],
      { id: "AC2", text: quotedCriterion, verify: "test" },
    ],
    size: "M",
  });
  if (statement.length > GOLDEN_PAYLOAD_CAP) {
    throw new Error(
      "PROBLEM_QUOTES_CRITERIA_MARKER_BODY geometry: the statement is over its cap, so its own cut is not the only one in play — the arm would not isolate the substitution.",
    );
  }
  const parsed = parsePiSpec(body);
  if (!parsed.ok) {
    throw new Error("PROBLEM_QUOTES_CRITERIA_MARKER_BODY geometry: the spec does not parse.");
  }
  const block = criteriaBlock(parsed.spec);
  if (block.length > GOLDEN_PAYLOAD_CAP) {
    throw new Error(
      "PROBLEM_QUOTES_CRITERIA_MARKER_BODY geometry: the list is over its cap, so a criteria marker there would be a real cut, not a forged one.",
    );
  }
  if (!block.endsWith(QUOTED_NOTICE)) {
    throw new Error(
      "PROBLEM_QUOTES_CRITERIA_MARKER_BODY geometry: the quoted notice is not the block's tail, so the first match is not the real notice and the arm measures nothing.",
    );
  }
  // Asserted at load so the fixture cannot exist in the forged state: if a change
  // reintroduces the substitution, this file fails to load with the reason.
  const section = renderSpecCriteriaSection(body);
  if (criteriaFenceOf(section).includes(GOLDEN_CRITERIA_MARKER)) {
    throw new Error(
      "PROBLEM_QUOTES_CRITERIA_MARKER_BODY geometry: the criteria fence reports a cut for a list that is whole — the substitution defect is live and this fixture cannot pin its fix.",
    );
  }
  return body;
})();

/** The mirror: a criteria block that IS over its cap and whose kept window carries
 * a line that is exactly the PROBLEM marker, while the statement beside it is
 * nowhere near its cap. The quoted marker goes at the HEAD of its criterion because
 * a row is one line of the block — a marker at the end of a long criterion sits
 * past the clip and is never kept, which is the vacuous shape this avoids. */
export const CRITERIA_QUOTE_PROBLEM_MARKER_BODY: string = (() => {
  const quoted = `${"The reading surface states it once. ".repeat(380)}\n${GOLDEN_PROBLEM_MARKER}\n${"The reading surface states it once. ".repeat(500)}`;
  const criteria = [
    { id: "AC1", text: "The meter refuses the draw.", verify: "test" as const },
    { id: "AC2", text: quoted, verify: "test" as const },
  ];
  const body = specBody(`Add a quota check to the meter.\n\n${PROSE_FILLER}`, {
    problem: "The meter must refuse the draw once the quota is spent.",
    criteria,
    size: "M",
  });
  const parsed = parsePiSpec(body);
  if (!parsed.ok) {
    throw new Error("CRITERIA_QUOTE_PROBLEM_MARKER_BODY geometry: the spec does not parse.");
  }
  const block = criteriaBlock(parsed.spec);
  const markerAt = block.indexOf(`\n${GOLDEN_PROBLEM_MARKER}`);
  if (block.length <= GOLDEN_PAYLOAD_CAP) {
    throw new Error(
      `CRITERIA_QUOTE_PROBLEM_MARKER_BODY geometry: the list renders ${String(
        block.length,
      )} chars, not past the cap — the arm would be vacuous.`,
    );
  }
  if (markerAt < 0 || markerAt >= GOLDEN_PAYLOAD_CAP) {
    throw new Error(
      `CRITERIA_QUOTE_PROBLEM_MARKER_BODY geometry: the quoted marker sits at ${String(
        markerAt,
      )}, outside the kept window — nothing was quoted, so the arm would be vacuous.`,
    );
  }
  const section = renderSpecCriteriaSection(body);
  if (!section.includes("…(criteria truncated)")) {
    throw new Error(
      "CRITERIA_QUOTE_PROBLEM_MARKER_BODY geometry: the list was not cut, so there is no real clip to be stolen.",
    );
  }
  // The statement is one short sentence, so its fence must carry no clip line: the
  // mirror direction of the defect is the list's substitution reaching back and
  // rewriting it, which would tell every seat about a statement cut that never was.
  const statementFence = statementFenceOf(section);
  const forged = statementFence.split("\n").filter((l) => l.trim() === GOLDEN_PROBLEM_MARKER);
  if (forged.length !== 0) {
    throw new Error(
      `CRITERIA_QUOTE_PROBLEM_MARKER_BODY geometry: the statement's fence reports ${String(
        forged.length,
      )} cut(s) for a statement that is whole — a notice moved out of the list's fence is the defect this fixture exists to pin.`,
    );
  }
  return body;
})();

/**
 * lib/lean-review-problem-shape — the review section's payload constants, restated.
 *
 * `lean-review-problem-golden.ts` freezes the pre-statement render and must not
 * read a cap, a marker or a lead back from `lean/review-criteria.ts`: a golden that
 * did could not catch that module changing them. The same constants are needed by
 * `lean-review-problem-quoting.ts`, which measures what a payload that QUOTES a
 * marker does to the clip notice. They live here, restated rather than imported, so
 * both files judge the renderer against one copy the renderer cannot move.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import { criteriaBlock } from "../../src/lean/spec-blocks.ts";
import { parsePiSpec } from "../../src/lean/spec.ts";
import { renderSpecCriteriaSection } from "../../src/lean/review-criteria.ts";
import { SPEC_TAIL_CONSTRAINT } from "./lean-review-spec-fixture.ts";

/** The cap each of the section's two payloads is bounded at — restated, not read
 * from the module under change. */
export const GOLDEN_PAYLOAD_CAP = 20_000;

/** What each payload's fence says when IT clipped. Two markers and never one: a
 * seat weighing a cut statement against a cut list has to be able to tell which
 * half of its contract it lost. Built by concatenation so this file's own prose,
 * which names them, is not matched by anything that looks for them. */
export const GOLDEN_PROBLEM_MARKER = ["…(problem", "truncated)"].join(" ");
export const GOLDEN_CRITERIA_MARKER = ["…(criteria", "truncated)"].join(" ");

/** The character a fence is built from, as a string: counted with `split` rather
 * than a regex, where an escape for it reads as the literal's own terminator. */
export const FENCE_CHAR = "\u0060";

/** The section's two payloads, split on the fence opener the renderer uses. The
 * guards on the quoting fixtures must scope their marker count to ONE payload: the
 * other payload legitimately quotes the same marker as its own text, so a count over
 * the whole section cannot tell a quote from a notice that was moved. Returns `""`
 * when the section does not carry two fenced payloads, so a guard that reads it
 * fails loudly rather than passing on an unsplit string. */
export function payloadFences(section: string): [string, string] {
  const parts = section.split(`\n${FENCE_CHAR.repeat(3)}text\n`);
  return parts.length === 3 ? [parts[1] ?? "", parts[2] ?? ""] : ["", ""];
}

export function criteriaFenceOf(section: string): string {
  return payloadFences(section)[1];
}

export function statementFenceOf(section: string): string {
  return payloadFences(section)[0];
}

/** The prose filler that makes a body itself pass the issue bound: with the prose
 * cut, the section's copy is the ONLY one a brief can carry. */
export const PROSE_FILLER = SPEC_TAIL_CONSTRAINT.repeat(140);

/** Three short criteria, so nothing but the statement can be what the section cut. */
export const THREE_CRITERIA = [
  { id: "AC1", text: "The meter refuses the draw.", verify: "test" },
  { id: "AC2", text: "The refusal names the quota.", verify: "test" },
  { id: "AC3", text: "The counter never goes negative.", verify: "manual" },
];

/** A body with `prose` and one `pi-spec v1` block carrying `spec`. */
export function specBody(prose: string, spec: unknown): string {
  return `${prose}\n\n\`\`\`pi-spec v1\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`;
}

export { criteriaBlock, parsePiSpec, renderSpecCriteriaSection };

/**
 * lean/state-requirements — the validator and rebuilder for the `specify` step's
 * requirement-coverage record.
 *
 * Split from `state-outcome-maps.ts` along the seam the file already draws (the
 * 500-line gate, AGENTS.md §12): the maps beside it record what a gate EXECUTED,
 * this records what the adversary CLAIMED and what the step proved about it. The
 * shape is the step's own, so it lives with its own rules rather than beside the
 * verify tier's.
 *
 * A record that fails any rule is DROPPED whole, not repaired: the bench reads
 * counts and ids out of the durable state file to attribute a rejected run, so a
 * half-validated item — an id nobody wrote, a colour nobody ran — would be
 * attributed on evidence the step never held.
 */

import { REQUIREMENT_KINDS } from "./requirements.ts";
import type { RequirementKind, RequirementsRecord } from "./requirements.ts";

/** How many items one record may hold. A child that listed a hundred is not this run's contract. */
export const REQUIREMENTS_MAX_ITEMS = 60;
/** How long one item's text may run in the durable record. */
export const REQUIREMENT_TEXT_MAX = 400;
/** How many mapped test files one item may name in the record. */
export const REQUIREMENT_TESTS_MAX = 8;

/** Requirement ids are R1, R2, … — the same rule the extractor applies. */
const REQUIREMENT_ID = /^R\d+$/;
/** A path in the record is data, never a heading: no control characters, no absolute. */
const BAD_PATH = /^[/\\]|\p{Cc}|\.\./u;

/** The shape of the step's own refusal line — see {@link RequirementRecord.gap}. */
const GAP_FORM = /^requirement R\d+ has no red test: /;

/** Is this a count the step could have produced? */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Is this one of the kinds the lever admits? */
function isKind(value: unknown): value is RequirementKind {
  return REQUIREMENT_KINDS.some((k) => k === value);
}

/** Why one recorded item is not loadable, or `undefined` when it is. */
function itemProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "must be an object";
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !REQUIREMENT_ID.test(item.id))
    return "needs an id of the form R<n>";
  if (!isKind(item.kind)) return `kind must be one of ${REQUIREMENT_KINDS.join(" | ")}`;
  if (typeof item.text !== "string" || item.text.trim() === "") return "needs a text";
  if (item.text.length > REQUIREMENT_TEXT_MAX)
    return `text must be at most ${REQUIREMENT_TEXT_MAX} characters`;
  if (typeof item.covered !== "boolean") return "needs a boolean covered";
  if (!Array.isArray(item.tests) || item.tests.length > REQUIREMENT_TESTS_MAX)
    return `needs at most ${REQUIREMENT_TESTS_MAX} tests`;
  if (item.reason !== undefined && (typeof item.reason !== "string" || item.reason === ""))
    return "reason must be a non-empty string";
  if (item.reason !== undefined && item.reason.length > REQUIREMENT_TEXT_MAX)
    return `reason must be at most ${REQUIREMENT_TEXT_MAX} characters`;
  // The refusal line is the step's own text, never the child's, and it is
  // written by one function — so the shape is checked, not just the type.
  if (item.gap !== undefined && typeof item.gap !== "string") return "gap must be a string";
  if (item.gap !== undefined && !GAP_FORM.test(item.gap))
    return "gap must lead with `requirement <id> has no red test`";
  if (item.gap !== undefined && item.covered) return "a covered item carries no gap";
  if (item.gap !== undefined && item.kind === "preserved")
    return "a preserved item carries no gap — its gap is recorded, not refused";
  for (const t of item.tests) {
    if (typeof t !== "object" || t === null) return "each test must be an object";
    const test = t as Record<string, unknown>;
    if (typeof test.path !== "string" || test.path === "" || BAD_PATH.test(test.path))
      return "each test needs a relative path";
    for (const colour of ["red", "existing", "green"] as const) {
      if (test[colour] !== undefined && typeof test[colour] !== "boolean")
        return `test ${colour} must be a boolean`;
    }
  }
  return undefined;
}

/**
 * Why a step's requirement record is not a valid one, or `undefined`.
 *
 * The counts are checked against the items rather than trusted: `total`,
 * `covered` and `uncovered` are the numbers the bench tallies, and a record
 * whose counts disagree with its own items is a record nobody can attribute —
 * refused at load, exactly as a mis-shaped `frozen` hash is.
 */
export function requirementsProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "outcome requirements must be an object";
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.items) || rec.items.length === 0)
    return "outcome requirements needs items";
  if (rec.items.length > REQUIREMENTS_MAX_ITEMS)
    return `outcome requirements needs at most ${REQUIREMENTS_MAX_ITEMS} items`;
  if (!isCount(rec.total) || rec.total !== rec.items.length)
    return `outcome requirements total must equal the item count (got ${String(rec.total)})`;
  if (!Array.isArray(rec.covered) || !Array.isArray(rec.uncovered))
    return "outcome requirements needs covered and uncovered id lists";
  const ids = rec.items.map((i) => (i as { id?: unknown })?.id);
  if (new Set(ids).size !== ids.length) return "outcome requirements item ids must be unique";
  const covered = new Set(rec.covered as unknown[]);
  const uncovered = new Set(rec.uncovered as unknown[]);
  if (rec.covered.length !== covered.size || rec.uncovered.length !== uncovered.size)
    return "outcome requirements id lists must not repeat";
  for (const [list, want] of [
    [rec.covered, true],
    [rec.uncovered, false],
  ] as const) {
    for (const id of list as unknown[]) {
      if (typeof id !== "string" || !REQUIREMENT_ID.test(id))
        return `outcome requirements lists ${String(id)} which is not a requirement id`;
      const item = (rec.items as Record<string, unknown>[]).find((i) => i.id === id);
      if (item === undefined) return `outcome requirements lists ${id} which no item declares`;
      if (item.covered !== want) return `outcome requirements ${id} is in the wrong list`;
    }
  }
  if (rec.covered.length + rec.uncovered.length !== rec.items.length)
    return "outcome requirements must list every item as covered or uncovered";
  const byKind = rec.byKind as Record<string, unknown> | undefined;
  if (typeof byKind !== "object" || byKind === null)
    return "outcome requirements needs a byKind count per kind";
  let sum = 0;
  for (const kind of REQUIREMENT_KINDS) {
    if (!isCount(byKind[kind])) return `outcome requirements byKind.${kind} must be a count`;
    sum += byKind[kind] as number;
  }
  if (sum !== rec.items.length) return "outcome requirements byKind must sum to the item count";
  for (const item of rec.items) {
    const problem = itemProblem(item);
    if (problem !== undefined) return `outcome requirements item: ${problem}`;
  }
  return undefined;
}

/** The recorded test, rebuilt from the fields this module actually checked. */
function validatedTest(raw: unknown) {
  const test = raw as Record<string, unknown>;
  return {
    path: test.path as string,
    ...(test.red === true ? { red: true } : {}),
    ...(test.existing === true ? { existing: true } : {}),
    ...(test.green === true ? { green: true } : {}),
  };
}

/**
 * The requirement record, rebuilt field by field from entries this module
 * checked. Rebuilt rather than cast, for the reason `validatedBlockedBy` gives:
 * `buildOutcome`'s claim is that every field it returns was looked at.
 */
export function validatedRequirements(value: unknown): RequirementsRecord | undefined {
  if (requirementsProblem(value) !== undefined) return undefined;
  const rec = value as Record<string, unknown>;
  const byKind = rec.byKind as Record<string, number>;
  return {
    total: rec.total as number,
    byKind: {
      behaviour: byKind.behaviour ?? 0,
      edge: byKind.edge ?? 0,
      preserved: byKind.preserved ?? 0,
    },
    covered: [...(rec.covered as string[])],
    uncovered: [...(rec.uncovered as string[])],
    items: (rec.items as Record<string, unknown>[]).map((item) => ({
      id: item.id as string,
      kind: item.kind as RequirementKind,
      text: item.text as string,
      tests: (item.tests as unknown[]).map(validatedTest),
      covered: item.covered as boolean,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      ...(typeof item.gap === "string" ? { gap: item.gap } : {}),
    })),
  };
}

/**
 * preserved-record — the rules that let a `specify` outcome carry the criteria it PRESERVED.
 *
 * The list is what the handback comment and the PR body name, and what a resumed run keeps frozen as
 * must-pass, so every entry is a criterion id and the list is bounded like the other criterion-keyed
 * records. An EMPTY list is refused: nothing preserved is the ABSENCE of the field, and a step that
 * recorded `[]` would put a key saying "the field existed and named nothing" where the truth is that no
 * declaration was made — the same silence-is-never-a-pass rule every other record field here keeps.
 *
 * Both halves are here so reader and builder cannot drift apart about what one of these records is.
 */
import { CRITERION_ID } from "./lean/spec.ts";
import { RECORD_MAX_ENTRIES } from "./lean/state-outcome-maps.ts";

/** Why a `preserved` list is not a record this run may print, or undefined. */
export function preservedListProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "outcome preserved must be a string[]";
  if (value.length === 0) return "outcome preserved must be absent rather than empty";
  if (value.length > RECORD_MAX_ENTRIES)
    return `outcome preserved must hold at most ${RECORD_MAX_ENTRIES} criteria`;
  for (const id of value)
    if (typeof id !== "string" || !CRITERION_ID.test(id))
      return `outcome preserved entry ${JSON.stringify(id)} is not AC<n>`;
  return undefined;
}

/** The `preserved` list, rebuilt from the entries this module actually checked. */
export function validatedPreservedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (typeof id === "string" && CRITERION_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The record's problem for a `preserved` field, or undefined when the field is absent or well formed. */
export function preservedOutcomeProblem(oc: Record<string, unknown>): string | undefined {
  return oc.preserved === undefined ? undefined : preservedListProblem(oc.preserved);
}

/** The rebuilt field for `buildOutcome`: empty when the record declared nothing, one key when it did. */
export function preservedOutcomeField(oc: Record<string, unknown>): { preserved?: string[] } {
  return oc.preserved === undefined ? {} : { preserved: validatedPreservedList(oc.preserved) };
}

/**
 * plan-fence-array — #1862 (b): the ONE question a raw `outOfScope` entry asks
 * before the bound touches it — is this entry a JSON ARRAY of path strings that
 * the planner wrote as a single stringified value?
 *
 * The field is free-form text on the driver side (`outOfScope: string[]`), so
 * what arrives is whatever Pi's tool-argument coercion produced. In the field, a
 * planner emitting an array produced ONE entry that is the stringified array —
 * `'["docs/","tests/"]'` — and the fence bound then did the worst possible thing
 * with it: `splitFenceList` refuses to split it (its segments carry quotes and
 * brackets, so they fail the path grammar) and `clipFenceEntryOf` cuts it at
 * `WORKSTREAM_FENCE_MAX`. The result is a single fence entry that fences nothing
 * (no file is ever named `["docs/","tests/"]`) and says nothing.
 *
 * Splitting here — BEFORE the per-entry clip, and before `splitFenceList` — is
 * what makes the array mean what it says: its members become the entries.
 *
 * Two rules keep this from being a text-mangling exercise:
 *
 *   - EVERY member must pass the planner's own path grammar
 *     (`plannedPathProblem`), exactly as a comma-list segment must. An array
 *     with one prose member is a sentence inside brackets, and shredding it
 *     produces fragments a developer reads as separate exclusions.
 *   - Anything that is not an array of strings — a nested array, an object
 *     member, a number, malformed JSON, a bare word — is kept as ONE entry,
 *     unchanged, and clipped like any other long text. This bound never
 *     invents structure it cannot read.
 *
 * A single-member array `["docs/"]` splits too: one entry is one fence either
 * way, and the entry the developer reads is `docs/` rather than `["docs/"]`.
 *
 * Imported by `plan-fence-bound.ts`, which owns when it is asked.
 */

import { plannedPathProblem } from "./plan-path-shape.ts";
import { WORKSTREAM_LIST_MAX, WORKSTREAM_PATH_MAX } from "./plan-workstream-schema.ts";

/** The narrowest shape an entry can have and still be a candidate: `[` … `]`
 * with something inside. A prose sentence that merely starts with a bracket is
 * not a JSON array, and this test refuses the ones that plainly are not before
 * any parsing is attempted. */
function looksLikeArray(raw: string): boolean {
  const t = raw.trim();
  return t.length > 1 && t.startsWith("[") && t.endsWith("]");
}

/**
 * The entries an `outOfScope` value says, expanding any entry that is a
 * stringified JSON array of path strings into its members and leaving every
 * other entry exactly as it came.
 *
 * The expansion is FLAT and ORDER-PRESERVING — a split entry's members land
 * where the entry was — so the caller's cap accounting counts entries the
 * planner actually wrote, and an entry that is not an array is returned by
 * identity, not by a normalising rewrite (the bound owns every other
 * transformation; this one owns only this).
 */
export function expandFenceArrays(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const members = fenceArrayMembers(entry);
    if (members === undefined) out.push(entry);
    else out.push(...members);
  }
  return out;
}

/**
 * The members of a stringified array, or undefined when `raw` is not one the
 * bound should expand. Never throws: a `JSON.parse` failure is simply "not an
 * array", which is the answer the caller wants anyway.
 */
function fenceArrayMembers(raw: string): string[] | undefined {
  if (!looksLikeArray(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  if (parsed.length > WORKSTREAM_LIST_MAX) return undefined;
  const members: string[] = [];
  for (const value of parsed) {
    // A non-string member — a number, an object, a nested array — means this is
    // not a list of paths, and the whole value stays one entry.
    if (typeof value !== "string") return undefined;
    const member = value.trim();
    // An empty member is a malformed list, not an empty exclusion.
    if (member.length === 0) return undefined;
    if (member.length > WORKSTREAM_PATH_MAX) return undefined;
    if (plannedPathProblem(member) !== undefined) return undefined;
    members.push(member);
  }
  return members;
}

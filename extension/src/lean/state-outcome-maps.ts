/**
 * lean/state-outcome-maps — the two-entry-per-field map records an outcome may
 * carry, and the rules that let one into a durable record.
 *
 * Split from `state-outcome.ts`, which passed the size cap when `build` gained
 * its blocked report, along the same seam `state-dispatches.ts` drew: the
 * validators for self-contained `Record<string, string>` fields, which read
 * nothing else in the outcome. `state-outcome.ts` keeps `DISPATCH_STATES`, the
 * ownership table, and `outcomeProblem`; this file keeps what a map of paths or
 * criterion ids must look like.
 *
 * Each map is BOTH judged (a `*Problem` for the loader) and rebuilt (a
 * `validated*` for `buildOutcome`) from the same bounds, so the reader that
 * validates and the builder that rebuilds cannot drift apart: a field that
 * passes one was looked at by the other.
 *
 * `commandCriteria` and `commandNotRunnable` are `verify`'s account of the
 * spec's `command` criteria — what licenses `passed (command)` in the PR body,
 * and why the gate skipped the rest. `blockedBy` is `build`'s account of the
 * frozen tests it proved cannot all pass together, and is printed into the
 * handback comment; its KEYS are frozen test paths rather than criterion ids,
 * so it takes the frozen key rule (`frozenKeyProblem`) instead of `CRITERION_ID`
 * — a `\n` inside one would otherwise write a heading into a public comment, and
 * a non-normalised path could never have been a frozen record in the first place.
 */

import { CRITERION_ID } from "./spec.ts";
import { frozenKeyProblem } from "./state-outcome.ts";

/** The one value a recorded `command` criterion may carry: it held. */
const COMMAND_CRITERION_KIND = "passed";

/**
 * One why-a-command-was-not-run — or one stated frozen-test conflict — is prose;
 * the record must not grow without bound. Exported because the build step's
 * blocked report holds these values BEFORE they reach the record and must refuse
 * an entry it could not persist rather than spend a runner on it: two literals
 * for one number is how a widening lands on one side only.
 */
export const RECORD_REASON_MAX_CHARS = 300;

/**
 * How many entries any of these records may hold. Exported for the same reason
 * as {@link RECORD_REASON_MAX_CHARS}: the report tool caps at this and the
 * driver refuses the rest, so a map the step could never have written is a blob.
 */
export const RECORD_MAX_ENTRIES = 32;

/** Is this a map-shaped value at all? The three records share the answer. */
function notAMap(value: unknown): boolean {
  return typeof value !== "object" || value === null || Array.isArray(value);
}

/**
 * Why a `commandCriteria` map is not evidence this run may print, or undefined.
 *
 * The map is what licenses `passed (command)` in the PR body, so a value that is
 * not the word `passed` — or an id that is not a criterion id — is refused rather
 * than carried: it would read as evidence for a check the gate never made. The
 * entry bound is the tier's own (`COMMAND_CRITERION_MAX` in `verify-commands`):
 * a record with more entries than the gate can execute was not written by it.
 */
export function commandCriteriaProblem(value: unknown): string | undefined {
  if (notAMap(value)) return "outcome commandCriteria must be an object";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > RECORD_MAX_ENTRIES)
    return `outcome commandCriteria must hold at most ${RECORD_MAX_ENTRIES} criteria`;
  for (const [id, kind] of entries) {
    if (!CRITERION_ID.test(id))
      return `outcome commandCriteria key ${JSON.stringify(id)} is not AC<n>`;
    if (kind !== COMMAND_CRITERION_KIND)
      return `outcome commandCriteria[${JSON.stringify(id)}] must be "${COMMAND_CRITERION_KIND}"`;
  }
  return undefined;
}

/**
 * Why a `commandNotRunnable` map is not a record this run may print, or undefined.
 *
 * Each not-runnable reason reaches its own row of the PR body, so every key is a
 * criterion id and every value a bounded string — the same rules the
 * `commandCriteria` map and the reason field follow, since prose out of a tree
 * check has no business widening a durable record. Per-criterion rather than a
 * single slot because a spec's command criteria each fail for their own reason,
 * and a reader who is told only the first cannot fix the other two.
 */
export function commandNotRunnableProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null)
    return "outcome commandNotRunnable must be an object";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > RECORD_MAX_ENTRIES)
    return `outcome commandNotRunnable must hold at most ${RECORD_MAX_ENTRIES} criteria`;
  for (const [id, why] of entries) {
    if (!CRITERION_ID.test(id))
      return `outcome commandNotRunnable key ${JSON.stringify(id)} is not AC<n>`;
    if (typeof why !== "string")
      return `outcome commandNotRunnable[${JSON.stringify(id)}] must be a string`;
    if (why.length > RECORD_REASON_MAX_CHARS)
      return `outcome commandNotRunnable[${JSON.stringify(id)}] must be at most ${RECORD_REASON_MAX_CHARS} characters`;
  }
  return undefined;
}

/**
 * How long one stated conflict may PRINT. Distinct from {@link RECORD_REASON_MAX_CHARS},
 * which is the DURABLE record's bound: a stored reason may be 300 characters, but
 * neither rendering of it may print more than this. The value is the child's prose
 * and both outputs are public — the record itself, and the handback comment built
 * from it — so the two sites share these two caps rather than each carrying its
 * own copy: `build.ts` clips the map it records and `handback.ts` clips the
 * comment it posts, and a widening on one side only is exactly what a shared
 * constant refuses to allow. They sit here, beside the validator that enforces the
 * record bound, so both renderers import from below them rather than from each
 * other.
 */
export const BLOCKED_REASON_CAP = 160;

/** A path long enough to be a blob is not a line anyone skims. See {@link BLOCKED_REASON_CAP}. */
export const BLOCKED_PATH_CAP = 200;

/**
 * Why a `blockedBy` map is not the build step's named cause, or undefined.
 *
 * It is printed into the handback comment as the reason the run stopped, so a
 * half-record (a `blocked` step whose map holds nothing) is refused rather than
 * rendered as a fragment by the reader downstream.
 */
export function blockedByProblem(value: unknown): string | undefined {
  if (notAMap(value)) return "outcome blockedBy must be an object";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > RECORD_MAX_ENTRIES)
    return `outcome blockedBy must hold at most ${RECORD_MAX_ENTRIES} files`;
  for (const [file, why] of entries) {
    const keyProblem = frozenKeyProblem(file);
    if (keyProblem !== undefined)
      return `outcome blockedBy key ${JSON.stringify(file)} is not a valid test path: ${keyProblem}`;
    if (typeof why !== "string")
      return `outcome blockedBy[${JSON.stringify(file)}] must be a string`;
    if (why.length > RECORD_REASON_MAX_CHARS)
      return `outcome blockedBy[${JSON.stringify(file)}] must be at most ${RECORD_REASON_MAX_CHARS} characters`;
  }
  return undefined;
}

/**
 * The `commandCriteria` map, rebuilt from entries this module actually checked.
 *
 * Rebuilt rather than spread-and-cast: `buildOutcome`'s claim is that every field
 * it returns was looked at, and `{...(x as Record<string,string>)}` hands back the
 * raw object — an entry the caller read off a `Record<string, unknown>` with a
 * nested value or a stray word still in it. Each entry is re-derived from its own
 * validation here, so the type the caller receives is produced by the check rather
 * than asserted past it.
 */
export function validatedCommandCriteria(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, kind] of Object.entries(value as Record<string, unknown>)) {
    if (kind === COMMAND_CRITERION_KIND && CRITERION_ID.test(id)) out[id] = COMMAND_CRITERION_KIND;
  }
  return out;
}

/** The `commandNotRunnable` map, rebuilt the same way — strings only, bounded. */
export function validatedCommandNotRunnable(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, why] of Object.entries(value as Record<string, unknown>)) {
    if (typeof why !== "string" || why.length > RECORD_REASON_MAX_CHARS) continue;
    if (CRITERION_ID.test(id)) out[id] = why;
  }
  return out;
}

/**
 * The `blockedBy` map, rebuilt the same way: entries this module actually
 * checked, keys under the frozen-path rule, values bounded. Rebuilt rather than
 * cast, for the reason `validatedCommandCriteria` gives.
 */
export function validatedBlockedBy(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [file, why] of Object.entries(value as Record<string, unknown>)) {
    if (typeof why !== "string" || why.length > RECORD_REASON_MAX_CHARS) continue;
    if (frozenKeyProblem(file) !== undefined) continue;
    out[file] = why;
  }
  return out;
}

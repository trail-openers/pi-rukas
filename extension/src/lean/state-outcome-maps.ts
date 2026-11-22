/**
 * lean/state-outcome-maps — the two-entry-per-field map records an outcome may carry, and the rules
 * that let one into a durable record.
 *
 * Split from `state-outcome.ts`, which passed the size cap when `build` gained its blocked report.
 * `state-outcome.ts` keeps `DISPATCH_STATES`, the ownership table and `outcomeProblem`; this file keeps
 * what a map of paths or criterion ids must look like.
 *
 * Each map is BOTH judged (a `*Problem` for the loader) and rebuilt (a `validated*` for `buildOutcome`)
 * from the same bounds, so reader and builder cannot drift apart.
 *
 * `commandCriteria` and `commandNotRunnable` are `verify`'s account of the spec's `command` criteria — what
 * licenses `passed (command)` in the PR body and why the gate skipped the rest. `blockedBy` is `build`'s
 * account of the frozen tests it proved cannot all pass together; its KEYS are frozen test paths, so it
 * takes `frozenKeyProblem` instead of `CRITERION_ID`.
 */

import { CRITERION_ID } from "./spec.ts";
import { frozenKeyProblem } from "./state-outcome.ts";

/** The one value a recorded `command` criterion may carry: it held. */
const COMMAND_CRITERION_KIND = "passed";

/**
 * One why-a-command-was-not-run, or one stated frozen-test conflict, is prose — the record must not grow
 * without bound. Exported because the build step's blocked report holds these values BEFORE the record and
 * must refuse an entry it could not persist.
 */
export const RECORD_REASON_MAX_CHARS = 300;

/** How many entries any of these records may hold. Exported for the same reason as {@link
 * RECORD_REASON_MAX_CHARS}. */
export const RECORD_MAX_ENTRIES = 32;

/** Is this a map-shaped value at all? The three records share the answer. */
function notAMap(value: unknown): boolean {
  return typeof value !== "object" || value === null || Array.isArray(value);
}

/**
 * Why a `commandCriteria` map is not evidence this run may print, or undefined.
 *
 * The map licenses `passed (command)` in the PR body, so a value that is not the word `passed`, or an id
 * that is not a criterion id, is refused rather than carried. The entry bound is the tier's own: a record
 * with more entries than the gate can execute was not written by it.
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
 * Each not-runnable reason reaches its own row of the PR body, so every key is a criterion id and every
 * value a bounded string. Per-criterion, because a spec's command criteria each fail for their own reason.
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
 * How long one stated conflict may PRINT. Distinct from {@link RECORD_REASON_MAX_CHARS}, the DURABLE
 * bound: a stored reason may be 300 characters but neither rendering prints more than this. Both outputs
 * are public, so `build.ts` and `handback.ts` share these caps rather than each carrying a copy.
 */
export const BLOCKED_REASON_CAP = 160;

/** A path long enough to be a blob is not a line anyone skims. See {@link BLOCKED_REASON_CAP}. */
export const BLOCKED_PATH_CAP = 200;

/**
 * Why a `blockedBy` map is not the build step's named cause, or undefined.
 *
 * It is printed into the handback comment as the reason the run stopped, so a half-record — a `blocked`
 * step whose map holds nothing — is refused rather than rendered as a fragment downstream.
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
 * Rebuilt rather than spread-and-cast: `buildOutcome`'s claim is that every field it returns was looked
 * at, and a cast hands back the raw object with whatever it still held. Each entry is re-derived from its
 * own validation, so the type the caller receives is produced by the check, not asserted past it.
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
 * The `blockedBy` map, rebuilt the same way: entries this module checked, keys under the frozen-path rule,
 * bounded values. Rebuilt rather than cast, for the reason `validatedCommandCriteria` gives.
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

/**
 * How many failing test names one tier's disclosure may RECORD. The subset test runs on the complete
 * parsed sets (`verify-baseline-excuse`); this bounds only what is persisted and printed, so a suite with
 * 200 pre-existing failures records twenty names and the true total. Chosen in stream order — the runner's
 * own order is what an operator re-running the command sees.
 */
export const PREEXISTING_NAMES_CAP = 20;

/** How long one recorded test name may be. A longer token is not a name. */
export const PREEXISTING_NAME_MAX_CHARS = 200;

/** What one tier's pre-existing-failure disclosure records. */
export interface PreexistingTierRecord {
  /** The tier's command, verbatim, as the disclosure names it. */
  cmd: string;
  /** The head run's failing names, in stream order, capped at {@link PREEXISTING_NAMES_CAP}. */
  names: string[];
  /** The head run's TRUE failing count, which the cap above does not touch. */
  total: number;
  /** The commit the base run ran at — the run's `baseSha`. */
  baseSha: string;
}

/** Is this a recorded name — bounded text with no control character? */
function recordedNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string") return "must be a string";
  if (/\p{Cc}/u.test(name)) return "must not contain a control character";
  if (name.length > PREEXISTING_NAME_MAX_CHARS)
    return `must be at most ${PREEXISTING_NAME_MAX_CHARS} characters`;
  return undefined;
}

/**
 * Why a `preexistingFailures` map is not a disclosure this run may print, or undefined.
 *
 * The record licenses a GREEN over a tier that exited non-zero, so every field it asserts is checked: a
 * name that could not have been printed is refused, and a tier with no names is refused rather than
 * rendered under a heading claiming failures exist. A refused record forfeits the excuse — the caller
 * keeps the `baseline red:` hand-back — it never throws.
 */
export function preexistingFailuresProblem(value: unknown): string | undefined {
  if (notAMap(value)) return "outcome preexistingFailures must be an object";
  const tiers = Object.entries(value as Record<string, unknown>);
  if (tiers.length > RECORD_MAX_ENTRIES)
    return `outcome preexistingFailures must hold at most ${RECORD_MAX_ENTRIES} tiers`;
  for (const [tier, raw] of tiers) {
    const keyProblem = frozenKeyProblem(tier);
    if (keyProblem !== undefined)
      return `outcome preexistingFailures key ${JSON.stringify(tier)} is not a valid tier name: ${keyProblem}`;
    if (notAMap(raw))
      return `outcome preexistingFailures[${JSON.stringify(tier)}] must be an object`;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.cmd !== "string" || entry.cmd.trim() === "")
      return `outcome preexistingFailures[${JSON.stringify(tier)}].cmd must be a non-empty string`;
    if (typeof entry.baseSha !== "string" || !/^[0-9a-f]{40}$/.test(entry.baseSha))
      return `outcome preexistingFailures[${JSON.stringify(tier)}].baseSha must be a 40-hex commit sha`;
    if (!Number.isSafeInteger(entry.total) || (entry.total as number) < 1)
      return `outcome preexistingFailures[${JSON.stringify(tier)}].total must be a positive integer`;
    if (!Array.isArray(entry.names) || entry.names.length === 0)
      return `outcome preexistingFailures[${JSON.stringify(tier)}].names must be a non-empty string[]`;
    if (entry.names.length > PREEXISTING_NAMES_CAP)
      return `outcome preexistingFailures[${JSON.stringify(tier)}].names must hold at most ${PREEXISTING_NAMES_CAP} names`;
    for (const name of entry.names) {
      const problem = recordedNameProblem(name);
      if (problem !== undefined)
        return `outcome preexistingFailures[${JSON.stringify(tier)}] names entry ${problem}`;
    }
    // A legacy `baseNames` set is ignored rather than refused so a resumed run loads;
    // {@link validatedPreexistingFailures} drops it.
  }
  return undefined;
}

/**
 * How many entries one roster set may RECORD. The comparison runs on the complete parsed sets
 * (`verify-roster`); this bounds only what is persisted and printed, so a 2 000-test suite
 * records the first names in stream order and `total` keeps the true count.
 */
export const ROSTER_NAMES_CAP = 200;

/** How long one recorded roster name may be. A longer token is not a name. */
export const ROSTER_PATH_MAX_CHARS = 300;

/** How many test-file paths one roster may record. */
export const ROSTER_FILES_CAP = 200;

/**
 * What one verify step's project-test roster records.
 *
 * The project's PRE-EXISTING tests (the config pair `verify.testDir` + `verify.testGlob` listed
 * at `baseSha`) run at head and at the base, and `passed`/`failed` are the head run's per-test
 * verdicts read from the runner's machine-readable report. `baseFailed` is what the base run
 * failed, so "already broken at base" is a recorded fact rather than a claim; `editedFiles`
 * names the pre-existing files this run changed whose BASE version was then run against the
 * head code and passed. Absent means no roster at all — and a green verify without one never
 * lands (`engine-facts.ts`), which is the point of the field.
 */
export interface ProjectRosterRecord {
  /** The commit the base run ran at — the run's `baseSha`. */
  baseSha: string;
  /** The pre-existing test files the roster covers, in the listing's order. */
  files: string[];
  /** The head run's passing test names, in stream order, capped. */
  passed: string[];
  /** The head run's failing test names, in stream order, capped. */
  failed: string[];
  /** The base run's failing names, capped. A name in `failed` but not here is this run's own. */
  baseFailed: string[];
  /** The head run's TRUE total of tests it ran, which the caps above do not touch. */
  total: number;
  /** The base run's TRUE total; 0 with `baseSkipped`, since a skipped leg ran nothing. */
  baseTotal: number;
  /** The enumeration's true size, present only when {@link ROSTER_FILES_CAP} cut `files`. */
  fileCount?: number;
  /** No base SUITE ran (head failed no test, so both red arms were empty); owes `baseTotal` 0. */
  baseSkipped?: boolean;
  /** Pre-existing files this run edited whose base version PASSED against the head code. */
  editedFiles?: string[];
  /**
   * Pre-existing files this run edited whose base version FAILS against the head code: a contract the
   * run changed. Not a red — no build round can make the old expectation pass — so the run reaches
   * review, and land refuses until the newest review accepts every one (`review-test-accept.ts`).
   * Capped at {@link PREEXISTING_NAMES_CAP}; past it the step hands back rather than cut the list.
   */
  baseVersionRed?: string[];
}

/**
 * The head failures a roster records that its base run did not also fail: this run's own. Read off the
 * record so review and the host are shown the comparison the record carries, never verify's say-so.
 * On a green it is empty by construction; on a roster red it names the tests that turned the run red.
 * `undefined` when `baseFailed` sits at {@link ROSTER_NAMES_CAP}: a base failure past the cut would
 * read as new, so the record cannot make the comparison.
 */
export function rosterNewlyFailing(roster: ProjectRosterRecord): string[] | undefined {
  if (roster.baseFailed.length >= ROSTER_NAMES_CAP) return undefined;
  const base = new Set(roster.baseFailed);
  return roster.failed.filter((name) => !base.has(name));
}

/** Why one roster name is not a name, or undefined. */
function rosterNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string") return "must be a string";
  if (/\p{Cc}/u.test(name)) return "must not contain a control character";
  if (name === "") return "must not be empty";
  if (name.length > ROSTER_PATH_MAX_CHARS)
    return `must be at most ${ROSTER_PATH_MAX_CHARS} characters`;
  return undefined;
}

/** Why one roster string list is malformed, or undefined. `field` names it in the refusal. */
function rosterListProblem(value: unknown, field: string, cap: number): string | undefined {
  if (!Array.isArray(value)) return `outcome projectRoster.${field} must be a string[]`;
  if (value.length > cap) return `outcome projectRoster.${field} must hold at most ${cap} entries`;
  for (const entry of value as unknown[]) {
    const problem = rosterNameProblem(entry);
    if (problem !== undefined) return `outcome projectRoster.${field} entry ${problem}`;
  }
  return undefined;
}

/** A roster list that must be present and hold at least one entry. */
function rosterRequiredListProblem(value: unknown, field: string, cap: number): string | undefined {
  const shape = rosterListProblem(value, field, cap);
  if (shape !== undefined) return shape;
  if ((value as unknown[]).length === 0)
    return `outcome projectRoster.${field} must hold at least one entry — a roster of nothing is not evidence a suite ran`;
  return undefined;
}

/**
 * Why a `projectRoster` is not a record this run may print, or undefined.
 *
 * The record licenses a GREEN and, through `landEarned`, the MERGE, so every field it asserts is
 * checked rather than carried: an empty `passed`/`failed`/`files` set is refused (a run that
 * observed nothing must not have a roster that reads as one), the two totals must be positive
 * and at least as large as the recorded names, and `baseSha` must be the sha form a base run
 * names. A refused roster is a roster the record does not carry — which `landEarned` reads as
 * "no roster", the same refusal the forged case gets.
 */
export function projectRosterProblem(value: unknown): string | undefined {
  if (notAMap(value)) return "outcome projectRoster must be an object";
  const r = value as Record<string, unknown>;
  if (typeof r.baseSha !== "string" || !/^[0-9a-f]{40}$/.test(r.baseSha))
    return "outcome projectRoster.baseSha must be a 40-hex commit sha";
  for (const [field, cap] of [
    ["files", ROSTER_FILES_CAP],
    ["passed", ROSTER_NAMES_CAP],
    ["failed", ROSTER_NAMES_CAP],
    ["baseFailed", ROSTER_NAMES_CAP],
  ] as const) {
    // Only `files` must be non-empty: the suite having tests of its own is what makes it a roster.
    // `passed` may legitimately be empty — a project whose suite was entirely red at the base ran
    // every one of its tests and passed none of them, which is a roster the disclosure has to show
    // rather than a hand-back. Requiring a name there would refuse the honest case and leave only the
    // dishonest one (a report that claims a pass nobody observed).
    const required = field === "files";
    const problem = required
      ? rosterRequiredListProblem(r[field], field, cap)
      : rosterListProblem(r[field], field, cap);
    if (problem !== undefined) return problem;
  }
  if (!Number.isSafeInteger(r.total) || (r.total as number) < 1)
    return "outcome projectRoster.total must be a positive integer — a roster that ran nothing is no roster";
  // `baseSkipped` is what licenses `baseTotal` 0, so the pair is judged together; any other roster
  // owes a base run that ran at least one test and named none of them failing without saying so.
  const skipped = r.baseSkipped === true;
  if (r.baseSkipped !== undefined && typeof r.baseSkipped !== "boolean")
    return "outcome projectRoster.baseSkipped must be a boolean";
  if (!Number.isSafeInteger(r.baseTotal) || (r.baseTotal as number) < (skipped ? 0 : 1))
    return skipped
      ? "outcome projectRoster.baseTotal must be 0 when the base leg is skipped"
      : "outcome projectRoster.baseTotal must be a positive integer";
  if (skipped && (r.baseFailed as string[]).length > 0)
    return "outcome projectRoster.baseFailed must be empty when the base leg is skipped";
  const passed = r.passed as string[];
  const failed = r.failed as string[];
  if ((r.total as number) < passed.length + failed.length)
    return "outcome projectRoster.total must be at least the number of names it records";
  if ((r.baseTotal as number) < (r.baseFailed as string[]).length)
    return "outcome projectRoster.baseTotal must be at least the number of base names it records";
  if (r.editedFiles !== undefined) {
    const problem = rosterListProblem(r.editedFiles, "editedFiles", ROSTER_FILES_CAP);
    if (problem !== undefined) return problem;
  }
  if (r.baseVersionRed !== undefined) {
    const problem = rosterRequiredListProblem(
      r.baseVersionRed,
      "baseVersionRed",
      PREEXISTING_NAMES_CAP,
    );
    if (problem !== undefined) return problem;
  }
  // A count beside a capped list can only be AT LEAST that list: fewer describes a suite it did not run.
  if (
    r.fileCount !== undefined &&
    (!Number.isSafeInteger(r.fileCount) || (r.fileCount as number) < (r.files as string[]).length)
  )
    return "outcome projectRoster.fileCount must be an integer at least the list it sits beside";
  return undefined;
}

/**
 * The roster, rebuilt from the entries this module checked.
 *
 * Rebuilt rather than cast, for the reason {@link validatedCommandCriteria} gives: each list is
 * re-derived from its own validation, so the object the caller receives was produced by the check
 * rather than asserted past it. `undefined` is what a roster that failed any rule becomes — a
 * dropped roster is the same refusal as a missing one.
 */
export function validatedProjectRoster(value: unknown): ProjectRosterRecord | undefined {
  if (projectRosterProblem(value) !== undefined) return undefined;
  const r = value as Record<string, unknown>;
  return {
    baseSha: r.baseSha as string,
    files: [...(r.files as string[])],
    passed: [...(r.passed as string[])],
    failed: [...(r.failed as string[])],
    baseFailed: [...(r.baseFailed as string[])],
    total: r.total as number,
    baseTotal: r.baseTotal as number,
    ...(r.fileCount === undefined ? {} : { fileCount: r.fileCount as number }),
    ...(r.baseSkipped === undefined ? {} : { baseSkipped: r.baseSkipped as boolean }),
    ...(r.editedFiles === undefined ? {} : { editedFiles: [...(r.editedFiles as string[])] }),
    ...(r.baseVersionRed === undefined
      ? {}
      : { baseVersionRed: [...(r.baseVersionRed as string[])] }),
  };
}

/**
 * The `preexistingFailures` map, rebuilt from entries this module checked.
 *
 * Rebuilt rather than cast, for the reason {@link validatedCommandCriteria} gives: an entry failing any
 * rule is DROPPED, so that tier loses its disclosure and the reader cannot mistake it for one the gate
 * proved.
 */
export function validatedPreexistingFailures(
  value: unknown,
): Record<string, PreexistingTierRecord> | undefined {
  if (notAMap(value)) return undefined;
  const out: Record<string, PreexistingTierRecord> = {};
  for (const [tier, raw] of Object.entries(value as Record<string, unknown>)) {
    if (frozenKeyProblem(tier) !== undefined || notAMap(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.cmd !== "string" || entry.cmd.trim() === "") continue;
    if (typeof entry.baseSha !== "string" || !/^[0-9a-f]{40}$/.test(entry.baseSha)) continue;
    if (!Number.isSafeInteger(entry.total) || (entry.total as number) < 1) continue;
    if (!Array.isArray(entry.names) || entry.names.length === 0) continue;
    if (entry.names.length > PREEXISTING_NAMES_CAP) continue;
    if (entry.names.some((name) => recordedNameProblem(name) !== undefined)) continue;
    out[tier] = {
      cmd: entry.cmd,
      names: [...entry.names] as string[],
      total: entry.total as number,
      baseSha: entry.baseSha,
    };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

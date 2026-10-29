/**
 * lean/state-outcome — the validator and rebuilder for ONE step's `outcome`.
 *
 * Split from `state.ts` along the seam the file already had: `assertRun` walks
 * the run and delegates the whole outcome question here, so the durable record
 * keeps its field-by-field claim while the shape of what a step may report
 * lives where a step author reads it.
 *
 * Every check guards a field a LATER reader indexes: `frozen` is the tamper
 * evidence `build` and `verify` compare, `verifiedHead` is what the land gate
 * matches against the PR head, and `prUrl` is the address `handback` prints.
 * A value that is merely present but the wrong shape would be a record that
 * reads as evidence and never matches — or, for the URL, a link to a PR that
 * does not exist.
 */

import { CRITERION_ID } from "./spec.ts";
import { normaliseRelPath, pathProblem } from "./specify-tree.ts";
import type { LeanState, Outcome } from "./state.ts";

/** A sha256 in the hex form the `specify` step freezes into its outcome. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A path is data here, not prose: refuse a key that would print as a heading. */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Why a `frozen` key is not a path this run may hold tamper evidence for.
 *
 * A frozen key is looked up by exact string against the bytes at HEAD, so one
 * that is absolute, traverses, or differs from its normalised form (`./x`, a
 * doubled or trailing slash) can never match a real blob: the record reads as
 * evidence and compares unequal forever, and no reader can tell a forged path
 * from a test somebody edited. A control character is refused because the key
 * is printed into a report verbatim — a `\n### heading` inside it is an
 * injection into the comment. The rules are `specify-tree`'s own — one
 * definition of "is this a git-relative path" for the whole pipeline — plus
 * the absolute and non-normalised forms that module's callers reject earlier.
 */
function frozenKeyProblem(key: string): string | undefined {
  if (key === "") return "empty path";
  if (CONTROL_CHARS.test(key)) return "path contains a control character";
  if (key.startsWith("/") || key.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(key))
    return "path is absolute";
  if (normaliseRelPath(key) !== key) return "path is not in normalised git-relative form";
  return pathProblem(key);
}

/** A full commit sha, the form `verify` records as the tree it judged. */
const SHA1_HEX = /^[0-9a-f]{40}$/;

/**
 * A publish step's PR URL: https text, no whitespace, bounded in length.
 *
 * Exported because `handback` applies the SAME rule when it reads the field
 * back. `state.ts` refuses to LOAD an outcome that breaks it, but the step log
 * a handler sees is only one of the ways a `Step[]` arrives — an in-memory log
 * reaches `handbackOutcome` without ever passing through the loader — so a
 * multi-line blob stuffed into `prUrl` would otherwise be printed into a
 * comment verbatim, heading and all.
 */
export const PR_URL = /^https:\/\/\S+$/;
export const PR_URL_MAX_CHARS = 500;

/**
 * The one reader of that rule: `url` as validated text, or `undefined`.
 *
 * Both callers of `PR_URL` ask the same question of a value that arrived as
 * `unknown` — `handback` before it prints a line into a comment, the headless
 * `work-lean` verb before it puts the field in a host's document — and the
 * three tests (string, length, shape) are easy to apply in the wrong order or
 * to skip one of. One exported reader keeps them identical: a change to what
 * "a URL we will print" means lands in one place.
 */
export function validPrUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  if (url.length > PR_URL_MAX_CHARS) return undefined;
  return PR_URL.test(url) ? url : undefined;
}

/**
 * Which state is allowed to record which evidence-bearing field.
 *
 * `prUrl` is the address `handback` prints and `verifiedHead` is what the land
 * gate matches against the PR head, so a value that arrived on a step that
 * never produced it is not extra information — it is a forged record that reads
 * as evidence. `assertRun` refuses it at load with the step's own key in the
 * message, so a hand-edited file naming a PR this run never opened (or claiming
 * a head this run never verified) is never driven.
 */
const OWNER_OF_FIELD: Readonly<Record<string, LeanState>> = {
  prUrl: "publish",
  verifiedHead: "verify",
  commandCriteria: "verify",
  commandNotRunnable: "verify",
};

/** The one value a recorded `command` criterion may carry: it held. */
const COMMAND_CRITERION_KIND = "passed";

/** One why-a-command-was-not-run is prose; the record must not grow without bound. */
const COMMAND_NOT_RUNNABLE_MAX_CHARS = 300;

/** How many declined criteria one verify record may explain. */
const COMMAND_NOT_RUNNABLE_MAX_ENTRIES = 32;

/**
 * Why a `commandCriteria` map is not evidence this run may print, or undefined.
 *
 * The map is what licenses `passed (command)` in the PR body, so a value that is
 * not the word `passed` — or an id that is not a criterion id — is refused rather
 * than carried: it would read as evidence for a check the gate never made.
 */
function commandCriteriaProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "outcome commandCriteria must be an object";
  for (const [id, kind] of Object.entries(value as Record<string, unknown>)) {
    if (!CRITERION_ID.test(id))
      return `outcome commandCriteria key ${JSON.stringify(id)} is not AC<n>`;
    if (kind !== COMMAND_CRITERION_KIND)
      return `outcome commandCriteria[${JSON.stringify(id)}] must be "${COMMAND_CRITERION_KIND}"`;
  }
  return undefined;
}

/**
 * Why a step's own report of itself is not a valid outcome, or `undefined`.
 *
 * `state` is the step's own state; when it is supplied, a field that belongs to
 * another state is refused. Omitting it keeps the shape-only checks for callers
 * that have not resolved the step's state yet.
 */
export function outcomeProblem(oc: Record<string, unknown>, state?: LeanState): string | undefined {
  if (typeof oc.kind !== "string") return "outcome needs a string kind";
  // Step-owned fields are checked BEFORE their shape: a forged `prUrl` on a
  // handback step is refused for being on the wrong step whatever its value, so
  // a caller cannot dodge the ownership rule with a well-formed URL.
  if (state !== undefined) {
    for (const [field, owner] of Object.entries(OWNER_OF_FIELD)) {
      if (oc[field] !== undefined && state !== owner)
        return `outcome ${field} is only recorded by a ${owner} step, not a ${state} step`;
    }
  }
  // `next()` calls `.join` on this when it routes a refusal, so a string-valued
  // `failedRules` is a crash waiting in the report path rather than a cosmetic
  // type slip.
  if (
    oc.failedRules !== undefined &&
    (!Array.isArray(oc.failedRules) || oc.failedRules.some((x) => typeof x !== "string"))
  )
    return "outcome failedRules must be a string[]";
  // `frozen` is the tamper evidence `build` and `verify` read back, so a value
  // that is not a sha256 is refused rather than carried: a truncated or
  // mistyped digest would compare unequal forever and the reader could not tell
  // a broken record from an edited test.
  if (oc.frozen !== undefined) {
    if (typeof oc.frozen !== "object" || oc.frozen === null || Array.isArray(oc.frozen))
      return "outcome frozen must be an object";
    for (const [file, sha] of Object.entries(oc.frozen as Record<string, unknown>)) {
      const keyProblem = frozenKeyProblem(file);
      if (keyProblem !== undefined)
        return `outcome frozen key ${JSON.stringify(file)} is not a valid test path: ${keyProblem}`;
      if (typeof sha !== "string" || !SHA256_HEX.test(sha))
        return `outcome frozen[${JSON.stringify(file)}] must be a 64-hex sha256`;
    }
  }
  if (oc.tests !== undefined) {
    if (typeof oc.tests !== "object" || oc.tests === null || Array.isArray(oc.tests))
      return "outcome tests must be an object";
    for (const [id, files] of Object.entries(oc.tests as Record<string, unknown>)) {
      if (!Array.isArray(files) || files.some((x) => typeof x !== "string"))
        return `outcome tests[${JSON.stringify(id)}] must be a string[]`;
    }
  }
  // `verifiedHead` is what the land gate compares to the PR head, so a
  // truncated or mistyped sha is refused rather than carried: it would compare
  // unequal forever and no reader could tell a broken record from a run that
  // verified a different commit. The `typeof` test comes first because a
  // number or an object has no business reaching a regex at all.
  if (oc.verifiedHead !== undefined) {
    if (typeof oc.verifiedHead !== "string" || !SHA1_HEX.test(oc.verifiedHead))
      return "outcome verifiedHead must be a 40-hex commit sha";
  }
  if (oc.commandCriteria !== undefined) {
    const problem = commandCriteriaProblem(oc.commandCriteria);
    if (problem !== undefined) return problem;
  }
  // Each not-runnable reason reaches its own row of the PR body, so every key is
  // a criterion id and every value a bounded string — the same rules the
  // `commandCriteria` map and the reason field follow, since prose out of a tree
  // check has no business widening a durable record. Per-criterion rather than a
  // single slot because a spec's command criteria each fail for their own reason,
  // and a reader who is told only the first cannot fix the other two.
  if (oc.commandNotRunnable !== undefined) {
    if (typeof oc.commandNotRunnable !== "object" || oc.commandNotRunnable === null)
      return "outcome commandNotRunnable must be an object";
    const entries = Object.entries(oc.commandNotRunnable as Record<string, unknown>);
    if (entries.length > COMMAND_NOT_RUNNABLE_MAX_ENTRIES)
      return `outcome commandNotRunnable must hold at most ${COMMAND_NOT_RUNNABLE_MAX_ENTRIES} criteria`;
    for (const [id, why] of entries) {
      if (!CRITERION_ID.test(id))
        return `outcome commandNotRunnable key ${JSON.stringify(id)} is not AC<n>`;
      if (typeof why !== "string")
        return `outcome commandNotRunnable[${JSON.stringify(id)}] must be a string`;
      if (why.length > COMMAND_NOT_RUNNABLE_MAX_CHARS)
        return `outcome commandNotRunnable[${JSON.stringify(id)}] must be at most ${COMMAND_NOT_RUNNABLE_MAX_CHARS} characters`;
    }
  }
  // `prUrl` is the address `handback` prints, so it is refused when it is not
  // https url text rather than carried into a comment as a fake link; the
  // length bound keeps a blob a handler stuffed in here out of the record.
  if (oc.prUrl !== undefined) {
    if (typeof oc.prUrl !== "string" || !PR_URL.test(oc.prUrl))
      return "outcome prUrl must be an https URL";
    if (oc.prUrl.length > PR_URL_MAX_CHARS)
      return `outcome prUrl must be at most ${PR_URL_MAX_CHARS} characters`;
  }
  return undefined;
}

/**
 * The validated outcome, rebuilt field by field.
 *
 * Rebuilt rather than cast: `assertRun`'s whole claim is that a caller can
 * trust every field it reads, and an `as Outcome` on the raw object would carry
 * an unvalidated field through as if it had been checked. Its caller refused
 * anything `outcomeProblem` judged bad, so every field read here is a field
 * that was looked at.
 */
export function buildOutcome(oc: Record<string, unknown>): Outcome {
  const tests = oc.tests as Record<string, string[]> | undefined;
  return {
    kind: oc.kind as string,
    ...(typeof oc.reason === "string" ? { reason: oc.reason } : {}),
    ...(typeof oc.message === "string" ? { message: oc.message } : {}),
    ...(oc.failedRules === undefined ? {} : { failedRules: [...(oc.failedRules as string[])] }),
    ...(oc.frozen === undefined ? {} : { frozen: { ...(oc.frozen as Record<string, string>) } }),
    ...(tests === undefined
      ? {}
      : {
          tests: Object.fromEntries(Object.entries(tests).map(([id, files]) => [id, [...files]])),
        }),
    ...(typeof oc.verifiedHead === "string" ? { verifiedHead: oc.verifiedHead } : {}),
    ...(oc.commandCriteria === undefined
      ? {}
      : { commandCriteria: { ...(oc.commandCriteria as Record<string, string>) } }),
    ...(oc.commandNotRunnable === undefined
      ? {}
      : { commandNotRunnable: { ...(oc.commandNotRunnable as Record<string, string>) } }),
    ...(typeof oc.prUrl === "string" ? { prUrl: oc.prUrl } : {}),
  };
}

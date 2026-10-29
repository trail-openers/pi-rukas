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

import type { LeanState, Outcome } from "./state.ts";

/** A sha256 in the hex form the `specify` step freezes into its outcome. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
};

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
    ...(typeof oc.prUrl === "string" ? { prUrl: oc.prUrl } : {}),
  };
}

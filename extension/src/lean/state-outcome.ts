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

import type { Outcome } from "./state.ts";

/** A sha256 in the hex form the `specify` step freezes into its outcome. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A full commit sha, the form `verify` records as the tree it judged. */
const SHA1_HEX = /^[0-9a-f]{40}$/;

/** A publish step's PR URL: https text, no whitespace, bounded in length. */
const PR_URL = /^https:\/\/\S+$/;
const PR_URL_MAX_CHARS = 500;

/** Why a step's own report of itself is not a valid outcome, or `undefined`. */
export function outcomeProblem(oc: Record<string, unknown>): string | undefined {
  if (typeof oc.kind !== "string") return "outcome needs a string kind";
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

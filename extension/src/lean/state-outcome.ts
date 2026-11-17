/**
 * lean/state-outcome — the validator and rebuilder for ONE step's `outcome`.
 *
 * Split from `state.ts` along the seam the file already had: `assertRun` delegates the whole outcome question
 * here, so the durable record keeps its field-by-field claim while the shape of what a step may report lives
 * where a step author reads it.
 *
 * Every check guards a field a LATER reader indexes: `frozen` is the tamper evidence `build` and `verify`
 * compare, `verifiedHead` is what the land gate matches against the PR head, and `prUrl` is the address
 * `handback` prints. Present but the wrong shape is a record that reads as evidence and never matches.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { DispatchUsage } from "../types.ts";
import { HANDOFF_CHANNELS, type HandoffChannel } from "../work-driver-handoff-channel.ts";
import { CRITERION_ID } from "./spec.ts";
import { normaliseRelPath, pathProblem } from "./specify-path.ts";
import { reviewBoundProblem, validatedReviewBound } from "./state-dispatches.ts";
import {
  DISPATCHES_MAX_ROWS,
  dispatchesProblem,
  isMeasure,
  validatedDispatches,
} from "./state-dispatches.ts";
import {
  buildRedRecord,
  buildReviewRecord,
  redRecordProblem,
  reviewRecordProblem,
} from "./state-outcome-gates.ts";
import {
  BLOCKED_PATH_CAP,
  BLOCKED_REASON_CAP,
  blockedByProblem,
  commandCriteriaProblem,
  commandNotRunnableProblem,
  preexistingFailuresProblem,
  validatedBlockedBy,
  validatedCommandCriteria,
  validatedCommandNotRunnable,
  validatedPreexistingFailures,
} from "./state-outcome-maps.ts";
// The two print caps for a `blockedBy` entry live with the validator of the record's own bound; re-exported
// so a caller need not know which file holds them.
export { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./state-outcome-maps.ts";
import type { LeanState, Outcome, Step } from "./state.ts";
// Re-exported so every consumer's import site stays where it was.
export { DISPATCHES_MAX_ROWS, validatedDispatches } from "./state-dispatches.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The states that REPORT how a run ended rather than do work on it. The single definition
 * lives in `state.ts`; this copy is local because `state.ts` imports this file as its
 * validator, so a binding reaching back is a cycle read before init.
 * `test-lean-state-outcome.ts` pins the two equal.
 */
export const REPORTING_STATES: readonly LeanState[] = ["handback", "decline"];

/** A sha256 in the hex form the `specify` step freezes into its outcome. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A path is data here, not prose: refuse a key that would print as a heading. */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Why a `frozen` key is not a path this run may hold tamper evidence for.
 *
 * A frozen key is looked up by exact string against the bytes at HEAD, so one that is absolute, traverses, or
 * differs from its normalised form can never match a real blob — the record reads as evidence and compares
 * unequal forever. A control character is refused because the key prints into a report verbatim: a
 * `\n### heading` inside it is an injection into the comment. The rules are `specify-path`'s own, plus the
 * absolute and non-normalised forms its callers reject earlier.
 *
 * Exported because the build step's blocked report is judged by the same rule before a runner is spent.
 */
export function frozenKeyProblem(key: string): string | undefined {
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
 * Exported because `handback` applies the SAME rule reading the field back: an in-memory log reaches
 * `handbackOutcome` without the loader, so a multi-line blob in `prUrl` would print into a comment verbatim.
 */
export const PR_URL = /^https:\/\/\S+$/;
export const PR_URL_MAX_CHARS = 500;

/**
 * The one reader of that rule: `url` as validated text, or `undefined`. Both callers ask the same three
 * tests of an `unknown`, so a change to what "a URL we will print" means lands in one place.
 */
export function validPrUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  if (url.length > PR_URL_MAX_CHARS) return undefined;
  return PR_URL.test(url) ? url : undefined;
}

/**
 * The states whose dispatch may be stopped by its budget, hence own the `limit`/`value`/`used` trio.
 * `DISPATCH_STATES` below is the wider set that may record cost; deliberately not one constant, and
 * `test-lean-state-dispatches.ts` pins both.
 */
export const BUDGET_STATES: readonly LeanState[] = ["specify", "build", "challenge"];

/**
 * The states that may record what their children cost — the ONE statement of that set. A widening that
 * lands on one expression of it and not the other quietly shrinks a run's cost record.
 *
 * `review` is here but NOT in `BUDGET_STATES`: it pays for a reviewer, six lenses and a fixer per round, so
 * it MUST record cost — but a review breach THROWS rather than routing a `budget` kind, so it owns no trio.
 */
export const DISPATCH_STATES: readonly LeanState[] = [...BUDGET_STATES, "review"];

/**
 * Which state may record which evidence-bearing field. One table, one `includes` reads it; an owner is a
 * state or a SET of states, which is how the budget verdict's three fields are expressed.
 *
 * A field on a step that never produced it is not extra information — it is a forged record that reads as
 * evidence. `assertRun` refuses a breach at load naming the step's key, so a hand-edited file is never driven.
 */
const OWNER_OF_FIELD: Readonly<Record<string, LeanState | readonly LeanState[]>> = {
  prUrl: "publish", // Publish's own record of what it pushed; elsewhere it claims a commit that step never
  // shipped. Same shape rule as `verifiedHead`, which it is matched to for equality.
  publishedHead: "publish",
  draft: "publish",
  // The two steps that REPORT how a run ended are the only ones claiming a comment reached the forge.
  posted: REPORTING_STATES,
  // …and only `handback` carries the comment it built: a gate stamping one would put a child's prose on the
  // record as the run's closing statement.
  report: "handback",
  // …and the only ones that may name the channel they reported on.
  channel: REPORTING_STATES,
  dispatches: DISPATCH_STATES,
  verifiedHead: "verify",
  commandCriteria: "verify",
  commandNotRunnable: "verify",
  // The build step's own account of which frozen tests it proved cannot all pass together;
  // `handback` prints it as the run's cause.
  blockedBy: "build",
  // The tiers a verify/ci step excused over the base: they license a GREEN over a tier that exited
  // non-zero, so a step that never ran it may not carry the record.
  preexistingFailures: ["verify", "ci"],
  // Owned by whichever dispatching step hit its ceiling: a handback inventing one the step never crossed
  // prints it as the run's cause.
  limit: BUDGET_STATES,
  value: BUDGET_STATES,
  used: BUDGET_STATES,
  // The review step's own clock. Elsewhere it claims a review stopped short of judging its lanes when no
  // review of this run stopped at all.
  reviewBound: "review",
  // What the review step judged. `review` alone: a verify step with round tallies reports findings no
  // reviewer raised, and a handback with a wave head claims a fix it never integrated.
  review: "review",
  // Which tier and criterion a red gate failed on: the two steps that RUN the gate, and no other —
  // `handback` printing a tier nobody ran sends a host to a check this run never made.
  red: ["verify", "ci"],
  // The head facts of a handback that shipped (or refused to ship) a verified head. `handback` alone: any
  // other step carrying them claims a move it never made — the rewind is the reporting step's act.
  shippedHead: "handback",
  shippedVerified: "handback",
  unshippedHead: "handback",
  unshippedReason: "handback",
};

/** The ceilings a budget verdict may name; the only reader of the field's type. */
const LIMITS = ["minutes", "turns", "tokens"] as const;

/**
 * Is this a count a ceiling can be compared against? A float, a negative or `Infinity` is not a number of
 * turns anyone counted, and `1e400` arrives as `Infinity` from JSON — reader and builder ask the SAME
 * question.
 */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Is this value one of the ceilings {@link LIMITS} names? No cast involved. */
function isBudgetLimit(value: unknown): value is LeanLimit {
  return LIMITS.some((limit) => limit === value);
}

/** The ceiling kinds a budget verdict may carry — the form `Outcome.limit` uses. */
type LeanLimit = (typeof LIMITS)[number];

/**
 * The rows of a step's dispatches, attached only when the step paid for one. A step that
 * never dispatched records nothing: `[]` would put a key saying "zero children" where the
 * truth is "this step is not one that dispatches".
 */
function rowsField(rows: DispatchUsageRow[]): { dispatches?: DispatchUsageRow[] } {
  return rows.length === 0 ? {} : { dispatches: rows };
}

/**
 * Why a step's own report of itself is not a valid outcome, or `undefined`.
 *
 * `state` is the step's own state; when supplied, a field belonging to another state is refused. Omitting it
 * keeps the shape-only checks for callers that have not resolved the state yet.
 */
export function outcomeProblem(oc: Record<string, unknown>, state?: LeanState): string | undefined {
  if (typeof oc.kind !== "string") return "outcome needs a string kind";
  // Step-owned fields are checked BEFORE their shape: a forged `prUrl` on a handback step is refused
  // whatever its value, so a caller cannot dodge ownership with a well-formed URL.
  if (state !== undefined) {
    for (const [field, owner] of Object.entries(OWNER_OF_FIELD)) {
      if (oc[field] === undefined) continue;
      if (Array.isArray(owner) ? !owner.includes(state) : owner !== state)
        return `outcome ${field} is only recorded by a ${String(owner)} step, not a ${state} step`;
    }
  }
  // The budget trio is written only by a budget verdict: `handback` renders `limit`/`value`/`used` into the
  // operator's cause line, so the trio on a non-budget step prints a never-crossed ceiling as the cause.
  if (oc.kind !== "budget") {
    for (const key of ["limit", "value", "used"] as const) {
      if (oc[key] !== undefined) return `outcome ${key} is only recorded by a budget verdict`;
    }
  }
  if (oc.kind === "budget") {
    if (!isBudgetLimit(oc.limit))
      return 'outcome kind "budget" needs limit "minutes" | "turns" | "tokens"';
    for (const key of ["value", "used"] as const) {
      if (!isCount(oc[key]))
        return `outcome ${key} must be a non-negative safe integer for a budget verdict`;
    }
  }
  // `next()` calls `.join` on this when routing a refusal, so a string-valued `failedRules` is a crash
  // waiting in the report path.
  if (
    oc.failedRules !== undefined &&
    (!Array.isArray(oc.failedRules) || oc.failedRules.some((x) => typeof x !== "string"))
  )
    return "outcome failedRules must be a string[]";
  // `frozen` is the tamper evidence `build` and `verify` read back, so a non-sha256 is refused rather than
  // carried: a mistyped digest compares unequal forever and the reader cannot tell a broken record from an
  // edited test.
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
  // `verifiedHead` is what the land gate compares to the PR head, so a truncated or mistyped sha is refused
  // rather than carried. `typeof` first — a number or object has no business reaching a regex.
  if (oc.verifiedHead !== undefined) {
    if (typeof oc.verifiedHead !== "string" || !SHA1_HEX.test(oc.verifiedHead))
      return "outcome verifiedHead must be a 40-hex commit sha";
  }
  // Matched to `verifiedHead` for EQUALITY by the result's `prState`, so it takes that field's shape rule
  // — the same predicate `state.ts` holds `baseSha` to.
  if (oc.publishedHead !== undefined) {
    if (typeof oc.publishedHead !== "string" || !isFullCommitSha(oc.publishedHead))
      return "outcome publishedHead must be a 40-hex commit sha";
  }
  // The handback's head facts each take the shape their gate's field takes: the comment prints them as
  // evidence of what shipped, so a truncated or mistyped value is refused rather than carried.
  for (const field of ["shippedHead", "unshippedHead"] as const) {
    if (oc[field] !== undefined && (typeof oc[field] !== "string" || !isFullCommitSha(oc[field])))
      return `outcome ${field} must be a 40-hex commit sha`;
  }
  if (oc.shippedVerified !== undefined && typeof oc.shippedVerified !== "boolean")
    return "outcome shippedVerified must be a boolean";
  if (oc.unshippedReason !== undefined && typeof oc.unshippedReason !== "string")
    return "outcome unshippedReason must be a string";
  if (oc.commandCriteria !== undefined) {
    const problem = commandCriteriaProblem(oc.commandCriteria);
    if (problem !== undefined) return problem;
  }
  if (oc.commandNotRunnable !== undefined) {
    const problem = commandNotRunnableProblem(oc.commandNotRunnable);
    if (problem !== undefined) return problem;
  }
  if (oc.blockedBy !== undefined) {
    const problem = blockedByProblem(oc.blockedBy);
    if (problem !== undefined) return problem;
  }
  if (oc.preexistingFailures !== undefined) {
    const problem = preexistingFailuresProblem(oc.preexistingFailures);
    if (problem !== undefined) return problem;
  }
  if (oc.dispatches !== undefined) {
    const problem = dispatchesProblem(oc.dispatches);
    if (problem !== undefined) return problem;
  }
  // The review step's own clock: refused rather than carried — a record whose wave or lanes will not load
  // is a disclosure no reader can print.
  if (oc.reviewBound !== undefined) {
    const problem = reviewBoundProblem(oc.reviewBound);
    if (problem !== undefined) return problem;
  }
  // The gate events a host reads off the result record. Refused rather than carried: a tally naming a fifth
  // severity, or a wave head that is not an oid, would reach the host contract as an answer nobody judged.
  if (oc.review !== undefined) {
    const problem = reviewRecordProblem(oc.review);
    if (problem !== undefined) return problem;
  }
  if (oc.red !== undefined) {
    const problem = redRecordProblem(oc.red);
    if (problem !== undefined) return problem;
  }
  // `prUrl` is the address `handback` prints, so non-https-url text is refused; the length bound keeps a
  // blob out of the record.
  if (oc.prUrl !== undefined) {
    if (typeof oc.prUrl !== "string" || !PR_URL.test(oc.prUrl))
      return "outcome prUrl must be an https URL";
    if (oc.prUrl.length > PR_URL_MAX_CHARS)
      return `outcome prUrl must be at most ${PR_URL_MAX_CHARS} characters`;
  }
  // `posted` is the report steps' delivery claim, so it is a boolean or nothing: a truthy
  // string would survive a reader that asks `if (outcome.posted)`.
  if (oc.posted !== undefined && typeof oc.posted !== "boolean")
    return "outcome posted must be a boolean";
  // `channel` is one of the two the contract publishes or nothing: a hand-edited `"hostt"`
  // would read as a forge post and drop the body the host was owed.
  if (oc.channel !== undefined && !HANDOFF_CHANNELS.some((channel) => channel === oc.channel))
    return `outcome channel must be one of ${HANDOFF_CHANNELS.join(" | ")}`;
  // `report` is the comment the handback step built, so it is a string or nothing.
  if (oc.report !== undefined && typeof oc.report !== "string")
    return "outcome report must be a string";
  return undefined;
}

/**
 * The validated outcome, rebuilt field by field. Rebuilt rather than cast: `assertRun`'s
 * whole claim is that a caller can trust every field it reads, and an `as Outcome` would
 * carry an unvalidated field through as if it had been checked.
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
      : { commandCriteria: validatedCommandCriteria(oc.commandCriteria) }),
    ...(oc.commandNotRunnable === undefined
      ? {}
      : { commandNotRunnable: validatedCommandNotRunnable(oc.commandNotRunnable) }),
    ...(oc.blockedBy === undefined ? {} : { blockedBy: validatedBlockedBy(oc.blockedBy) }),
    ...(oc.preexistingFailures === undefined
      ? {}
      : { preexistingFailures: validatedPreexistingFailures(oc.preexistingFailures) }),
    ...(typeof oc.prUrl === "string" ? { prUrl: oc.prUrl } : {}),
    ...(typeof oc.publishedHead === "string" ? { publishedHead: oc.publishedHead } : {}),
    ...(typeof oc.shippedHead === "string" ? { shippedHead: oc.shippedHead } : {}),
    ...(typeof oc.shippedVerified === "boolean" ? { shippedVerified: oc.shippedVerified } : {}),
    ...(typeof oc.unshippedHead === "string" ? { unshippedHead: oc.unshippedHead } : {}),
    ...(typeof oc.unshippedReason === "string" ? { unshippedReason: oc.unshippedReason } : {}),
    ...(typeof oc.draft === "boolean" ? { draft: oc.draft } : {}),
    ...(typeof oc.posted === "boolean" ? { posted: oc.posted } : {}),
    // Rebuilt beside `posted`, because the two are ONE fact — who owns the channel, and did
    // anything reach them. Dropping `channel` would read as a forge post the forge refused.
    ...(oc.channel === "host" || oc.channel === "forge" ? { channel: oc.channel } : {}),
    ...(typeof oc.report === "string" ? { report: oc.report } : {}),
    ...rowsField(validatedDispatches(oc.dispatches)),
    ...(oc.reviewBound === undefined ? {} : { reviewBound: validatedReviewBound(oc.reviewBound) }),
    ...(oc.review === undefined ? {} : { review: buildReviewRecord(oc.review) }),
    ...(oc.red === undefined ? {} : { red: buildRedRecord(oc.red) }),
    ...(isBudgetLimit(oc.limit) ? { limit: oc.limit } : {}),
    ...(isCount(oc.value) ? { value: oc.value as number } : {}),
    ...(isCount(oc.used) ? { used: oc.used as number } : {}),
  };
}

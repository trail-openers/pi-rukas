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
// The two print caps for a `blockedBy` entry live with the validator that enforces
// the record's own bound, and reach their two render sites through here — the same
// re-export shape `validatedDispatches` above uses, so a caller does not have to
// learn which file in the pair holds the constant.
export { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./state-outcome-maps.ts";
import type { LeanState, Outcome, Step } from "./state.ts";
// The row validators moved to `state-dispatches.ts` when this file passed the size
// cap, but their callers keep importing them from here. A re-export is the
// smallest honest change: it is one line, it does not duplicate the rule, and it
// leaves every consumer's import site untouched — a caller should not have to
// learn where a validator lives in order to ask it a question.
export { DISPATCHES_MAX_ROWS, validatedDispatches } from "./state-dispatches.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The states that REPORT how a run ended rather than do work on it. The single
 * definition lives in `state.ts` (where every caller reads it); this copy is
 * exported so a reader of the table below can reach what the table enforces.
 * Local because `state.ts` imports this file as its validator, so a binding
 * reaching back is a cycle read before init; `test-lean-state-outcome.ts` pins
 * the two equal, which keeps the copy honest.
 */
export const REPORTING_STATES: readonly LeanState[] = ["handback", "decline"];

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
 * injection into the comment. The rules are `specify-path`'s own — one
 * definition of "is this a git-relative path" for the whole pipeline — plus
 * the absolute and non-normalised forms that module's callers reject earlier.
 *
 * Exported because the build step's blocked report is judged by the same rule
 * before the driver spends a runner on it: a name that could never be a frozen
 * record is not worth executing.
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
 * The states whose dispatch may be stopped by its budget, hence own the
 * `limit`/`value`/`used` trio.
 *
 * The narrower set: a step that arms a ceiling can report which ceiling fired.
 * `DISPATCH_STATES` below is the wider set of steps that may record cost — the
 * two are deliberately not one constant, and `test-lean-state-dispatches.ts`
 * pins both on the two paths a step's cost travels.
 */
export const BUDGET_STATES: readonly LeanState[] = ["specify", "build", "challenge"];

/**
 * The states that may record what their children cost.
 *
 * The ONE statement of that set. Two readers used to hand-derive it from
 * opposite directions — `OWNER_OF_FIELD.dispatches` below spelled it as a list
 * built from `BUDGET_STATES` plus `"review"`, and `recordsDispatches` in
 * `error-outcome.ts` re-wrote `state === "review" || BUDGET_STATES.includes(state)`
 * — and two expressions of one rule is how a widening can land on one side and
 * silently lose the step whose children cost the most: the loader would drop the
 * rows, or the throw path would refuse to copy them, and either way a run's
 * cost record just got smaller with nothing said.
 *
 * `review` is in this set but NOT in `BUDGET_STATES`: it pays for a reviewer,
 * six lenses and a fixer per round, so it MUST record cost. A review breach is
 * not a routed verdict: `review` has no `budget` kind in the table, so the step
 * THROWS with the sentence the other three render (see `review.ts`) and the
 * engine bills the rows off the throw. `BUDGET_STATES` stays the narrower set
 * that owns the `limit`/`value`/`used` trio for the pre-existing steps; widening
 * it to include `review` would name `review` as the owner of a trio only a
 * `budget`-kind outcome may carry, and a review throw carries no trio.
 */
export const DISPATCH_STATES: readonly LeanState[] = [...BUDGET_STATES, "review"];

/**
 * Which state is allowed to record which evidence-bearing field. One table, and
 * one `includes` reads it: an owner is a state or a SET of states, which is how
 * the budget verdict's three fields are expressed — `limit`/`value`/`used`
 * belong to whichever dispatching step's ceiling was crossed, so a list says it
 * directly instead of naming a fake owner and excusing the real ones past it in
 * a second check.
 *
 * `prUrl` is the address `handback` prints and `verifiedHead` is what the land
 * gate matches against the PR head, so a value that arrived on a step that never
 * produced it is not extra information — it is a forged record that reads as
 * evidence. `draft` is the publish step's answer to "what did I hand the forge",
 * and `dispatches` is the per-child cost of the three dispatching steps, so both
 * belong to no other state either. `posted` is the two REPORTING steps' answer to
 * "did the comment reach the forge": a report step that claimed delivery when
 * nobody posted anything is a record that reads as delivery, which is why no
 * other state may carry it. `assertRun` refuses a breach at load with the
 * step's own key in the message, so a hand-edited file naming a PR this run never
 * opened (or claiming a head this run never verified) is never driven.
 */
const OWNER_OF_FIELD: Readonly<Record<string, LeanState | readonly LeanState[]>> = {
  prUrl: "publish", // Publish's own record of what it pushed; elsewhere it claims a commit that
  // step never shipped. Same shape rule as `verifiedHead`, which it is matched
  // to for equality: a prefix or mistyped oid compares unequal forever.
  publishedHead: "publish",
  draft: "publish",
  // The two steps that REPORT how a run ended are the only ones that may claim a
  // comment reached the forge.
  posted: REPORTING_STATES,
  // …and only `handback` may carry the comment it built: it is the run's report,
  // and a gate that stamped one would put a child's prose on the record as the
  // run's own closing statement.
  report: "handback",
  // …and the only ones that may name the channel they reported on (#1920 item 3).
  // A `verify` step claiming `channel: "host"` would make the projection publish
  // a gate verdict as a report the host still has to deliver.
  channel: REPORTING_STATES,
  dispatches: DISPATCH_STATES,
  verifiedHead: "verify",
  commandCriteria: "verify",
  commandNotRunnable: "verify",
  // The build step's own account of which frozen tests it proved cannot all
  // pass together. `handback` prints it as the run's cause, so a step that never
  // ran those tests may not carry it.
  blockedBy: "build",
  failing: "build",
  // The tiers a verify/ci step excused over the base commit. They license a GREEN
  // over a tier that exited non-zero, so a step that never ran that tier may not
  // carry the record that would excuse it.
  preexistingFailures: ["verify", "ci"],
  // Owned by whichever dispatching step hit its ceiling: a handback inventing a
  // ceiling the step never crossed would print it as the run's cause.
  limit: BUDGET_STATES,
  value: BUDGET_STATES,
  used: BUDGET_STATES,
  // The review step's own clock. On any other step it is a claim that a review
  // stopped short of judging its lanes when no review of this run stopped at all.
  reviewBound: "review",
};

/** The ceilings a budget verdict may name; the only reader of the field's type. */
const LIMITS = ["minutes", "turns", "tokens"] as const;

/**
 * Is this a count a ceiling can be compared against? A float, a negative or
 * `Infinity` is not a number of turns or tokens anybody counted, and `1e400`
 * arrives as `Infinity` from a JSON file — so the reader that validates and the
 * builder that rebuilds ask the SAME question, or a field could pass one and be
 * written back unexamined by the other.
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
 * The rows of a step's dispatches, attached only when the step paid for one.
 *
 * A step that never dispatched records nothing: `[]` would put a key on the
 * durable record that says "zero children" where the truth is "this step is not
 * one that dispatches", and the fold cannot tell the two apart.
 */
function rowsField(rows: DispatchUsageRow[]): { dispatches?: DispatchUsageRow[] } {
  return rows.length === 0 ? {} : { dispatches: rows };
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
      if (oc[field] === undefined) continue;
      if (Array.isArray(owner) ? !owner.includes(state) : owner !== state)
        return `outcome ${field} is only recorded by a ${String(owner)} step, not a ${state} step`;
    }
  }
  // The budget trio is only ever written by a budget verdict: `handback` renders
  // `limit`/`value`/`used` into the operator's cause line, so the same trio on a
  // step whose kind is not `budget` is a ceiling this run never crossed, printed
  // as the run's cause. Refused whatever the step's state, so an `ok` step on a
  // budget-owning state cannot carry them either — which is also what stops a
  // step reporting a ceiling merely because it reports what its children cost.
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
  // Checked like `frozen`'s keys: a name no step froze has no evidence behind it.
  if (
    oc.failing !== undefined &&
    (!Array.isArray(oc.failing) ||
      oc.failing.some((file) => typeof file !== "string" || frozenKeyProblem(file) !== undefined))
  )
    return "outcome failing must be a string[] of frozen test paths";
  // `verifiedHead` is what the land gate compares to the PR head, so a
  // truncated or mistyped sha is refused rather than carried: it would compare
  // unequal forever and no reader could tell a broken record from a run that
  // verified a different commit. The `typeof` test comes first because a
  // number or an object has no business reaching a regex at all.
  if (oc.verifiedHead !== undefined) {
    if (typeof oc.verifiedHead !== "string" || !SHA1_HEX.test(oc.verifiedHead))
      return "outcome verifiedHead must be a 40-hex commit sha";
  }
  // Matched to `verifiedHead` for EQUALITY by the result's `prState`, so it
  // takes that field's shape rule: a broken oid is indistinguishable from a run
  // that shipped another commit. Same predicate `state.ts` holds `baseSha` to.
  if (oc.publishedHead !== undefined) {
    if (typeof oc.publishedHead !== "string" || !isFullCommitSha(oc.publishedHead))
      return "outcome publishedHead must be a 40-hex commit sha";
  }
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
  // The review step's own clock: refused rather than carried, because a record
  // whose wave or lanes will not load is a disclosure no reader can print.
  if (oc.reviewBound !== undefined) {
    const problem = reviewBoundProblem(oc.reviewBound);
    if (problem !== undefined) return problem;
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
  // `posted` is the report steps' delivery claim, so it is a boolean or nothing:
  // a truthy string would survive a reader that asks `if (outcome.posted)` and
  // print a handoff as delivered when the forge refused it.
  if (oc.posted !== undefined && typeof oc.posted !== "boolean")
    return "outcome posted must be a boolean";
  // `channel` is the report steps' channel claim, so it is one of the two the
  // contract publishes or nothing: a hand-edited `"hostt"` would read as a forge
  // post to the projection and drop the body the host was owed.
  if (oc.channel !== undefined && !HANDOFF_CHANNELS.some((channel) => channel === oc.channel))
    return `outcome channel must be one of ${HANDOFF_CHANNELS.join(" | ")}`;
  // `report` is the comment the handback step built, so it is a string or nothing
  // — a number or an object would reach the host's document as `[object Object]`.
  if (oc.report !== undefined && typeof oc.report !== "string")
    return "outcome report must be a string";
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
      : { commandCriteria: validatedCommandCriteria(oc.commandCriteria) }),
    ...(oc.commandNotRunnable === undefined
      ? {}
      : { commandNotRunnable: validatedCommandNotRunnable(oc.commandNotRunnable) }),
    ...(oc.blockedBy === undefined ? {} : { blockedBy: validatedBlockedBy(oc.blockedBy) }),
    ...(oc.failing === undefined ? {} : { failing: [...(oc.failing as string[])] }),
    ...(oc.preexistingFailures === undefined
      ? {}
      : { preexistingFailures: validatedPreexistingFailures(oc.preexistingFailures) }),
    ...(typeof oc.prUrl === "string" ? { prUrl: oc.prUrl } : {}),
    ...(typeof oc.publishedHead === "string" ? { publishedHead: oc.publishedHead } : {}),
    ...(typeof oc.draft === "boolean" ? { draft: oc.draft } : {}),
    ...(typeof oc.posted === "boolean" ? { posted: oc.posted } : {}),
    // Rebuilt beside `posted`, because the two are ONE fact — who owns the channel,
    // and did anything reach them. A resume that kept `posted: false` and dropped
    // `channel: "host"` would read as a forge post the forge refused, and the host
    // would never be handed the body it was owed.
    ...(oc.channel === "host" || oc.channel === "forge" ? { channel: oc.channel } : {}),
    ...(typeof oc.report === "string" ? { report: oc.report } : {}),
    ...rowsField(validatedDispatches(oc.dispatches)),
    ...(oc.reviewBound === undefined ? {} : { reviewBound: validatedReviewBound(oc.reviewBound) }),
    ...(isBudgetLimit(oc.limit) ? { limit: oc.limit } : {}),
    ...(isCount(oc.value) ? { value: oc.value as number } : {}),
    ...(isCount(oc.used) ? { used: oc.used as number } : {}),
  };
}

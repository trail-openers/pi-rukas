/**
 * lean/state-outcome — the validator and rebuilder for ONE step's `outcome`.
 *
 * Split from `state.ts` along the seam the file already had: `assertRun` delegates the
 * whole outcome question here, so the durable record keeps its field-by-field claim while
 * the shape of what a step may report lives where a step author reads it.
 *
 * Every check guards a field a LATER reader indexes: `frozen` is the tamper evidence
 * `build` and `verify` compare, `verifiedHead` is what the land gate matches against the
 * PR head, and `prUrl` is the address `handback` prints. A value that is present but the
 * wrong shape is a record that reads as evidence and never matches.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { repairOutcomeProblem, validatedRepairFields } from "../oracle-repair-fields.ts";
import { HANDOFF_CHANNELS } from "../work-driver-handoff-channel.ts";
import { normaliseRelPath, pathProblem } from "./specify-path.ts";
import { canonicalDerivedSpec } from "./state-derived-spec.ts";
import type { DerivedSpec } from "./state-derived-spec.ts";
import { derivedSpecProblem } from "./state-derived-spec.ts";
import { reviewBoundProblem, validatedReviewBound } from "./state-dispatches.ts";
import { dispatchesProblem, isCount, validatedDispatches } from "./state-dispatches.ts";
import {
  buildRedRecord,
  buildReviewRecord,
  redRecordProblem,
  reviewRecordProblem,
} from "./state-outcome-gates.ts";
import {
  blockedByProblem,
  commandCriteriaProblem,
  commandNotRunnableProblem,
  preexistingFailuresProblem,
  projectRosterProblem,
  validatedBlockedBy,
  validatedCommandCriteria,
  validatedCommandNotRunnable,
  validatedPreexistingFailures,
  validatedProjectRoster,
} from "./state-outcome-maps.ts";
import { preservedListProblem, validatedPreservedList } from "../preserved-record.ts";
import type { LeanState, Outcome } from "./state.ts";
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
 * A frozen key is looked up by exact string against the bytes at HEAD, so one that is
 * absolute, traverses, or differs from its normalised form can never match a real blob:
 * the record reads as evidence and compares unequal forever. A control character is refused
 * because the key is printed into a report verbatim — a `\n### heading` inside it is an
 * injection into the comment. The rules are `specify-path`'s own, plus the absolute and
 * non-normalised forms its callers reject earlier.
 *
 * Exported because the build step's blocked report is judged by the same rule before the
 * driver spends a runner on it.
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
 * Exported because `handback` applies the SAME rule when it reads the field back: an
 * in-memory log reaches `handbackOutcome` without passing through the loader, so a
 * multi-line blob stuffed into `prUrl` would otherwise print into a comment verbatim.
 */
export const PR_URL = /^https:\/\/\S+$/;
export const PR_URL_MAX_CHARS = 500;

/**
 * The one reader of that rule: `url` as validated text, or `undefined`. Both callers ask
 * the same three tests of a value that arrived as `unknown`, so a change to what "a URL we
 * will print" means lands in one place.
 */
export function validPrUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  if (url.length > PR_URL_MAX_CHARS) return undefined;
  return PR_URL.test(url) ? url : undefined;
}

/**
 * The states whose dispatch may be stopped by its budget, hence own the
 * `limit`/`value`/`used` trio. `DISPATCH_STATES` below is the wider set of steps that may
 * record cost; the two are deliberately not one constant, and
 * `test-lean-state-dispatches.ts` pins both.
 */
export const BUDGET_STATES: readonly LeanState[] = ["specify", "build", "challenge"];

/**
 * The states that may record what their children cost — the ONE statement of that set. A
 * widening that lands on one expression of it and not the other quietly shrinks a run's
 * cost record.
 *
 * `review` is in this set but NOT in `BUDGET_STATES`: it pays for a reviewer, six lenses
 * and a fixer per round, so it MUST record cost — but a review breach THROWS rather than
 * routing a `budget` kind, so it owns no `limit`/`value`/`used` trio.
 *
 * `ready` is in it for the same reason on a smaller scale: in `derive` intake mode it pays
 * for the drafting child, and a state outside this set has its rows DROPPED rather than
 * refused — the cost goes missing silently. Like `review` it arms no child ceiling of its
 * own (`derive` is its own budget row), so it owns no budget trio.
 * `publish` pays for the child that checks a host's approved spec.
 */
export const DISPATCH_STATES: readonly LeanState[] = [
  ...BUDGET_STATES,
  "review",
  "ready",
  "publish",
  // The repair round pays for one adversary, so its rows are cost the run really spent. A step outside this
  // set has its rows DROPPED rather than refused — the quiet failure, where the file loads and the round's
  // cost is simply absent.
  "repair",
];

/**
 * Which state is allowed to record which evidence-bearing field. One table, one `includes`
 * reads it: an owner is a state or a SET of states, which is how the budget verdict's three
 * fields are expressed.
 *
 * A field that arrived on a step that never produced it is not extra information — it is a
 * forged record that reads as evidence. `assertRun` refuses a breach at load with the
 * step's own key in the message, so a hand-edited file is never driven.
 */
const OWNER_OF_FIELD: Readonly<Record<string, LeanState | readonly LeanState[]>> = {
  prUrl: "publish", // Publish's own record of what it pushed; elsewhere it claims a commit that
  // step never shipped.
  publishedHead: "publish",
  draft: "publish",
  // The two steps that REPORT how a run ended are the only ones that may claim a comment
  // reached the forge.
  posted: REPORTING_STATES,
  // Only `handback` may carry the comment it built: a gate that stamped one would put
  // a child's prose on the record as the run's own closing statement.
  report: "handback",
  // The only steps that may name the channel they reported on.
  channel: REPORTING_STATES,
  dispatches: DISPATCH_STATES,
  // Only `ready` may record a derived contract: a step that never ran the deriving
  // child has no evidence for a contract no author wrote.
  derivedSpec: "ready",
  // The same for the commit the run was judged at: a step stamping its own
  // `baseSha` would anchor a diff, a config read and a verify verdict to a commit the
  // run never seeded.
  baseSha: "ready",
  verifiedHead: "verify",
  commandCriteria: "verify",
  commandNotRunnable: "verify",
  // `specify` alone froze a declared criterion as must-pass; no other step may carry the list.
  preserved: "specify",
  // The build step's own account of which frozen tests it proved cannot all pass together;
  // `handback` prints it as the run's cause.
  blockedBy: "build",
  // The driver's own executed red, and the head it was run at. Both are written by `build` and read back
  // many visits later by the round that repairs it, so `build` holds them alone.
  blockedEvidence: "build",
  headBefore: "build",
  // The round's own facts: the corrected contract it froze, and what its judge observed of the replacement.
  // `frozen` is the contract, so the two steps that hold one own it — the freeze that wrote it and the round
  // that corrected it. The repair record belongs to the one step that ran the judge.
  frozen: ["specify", "repair"],
  repair: "repair",
  // The tiers a verify/ci step excused over the base commit: they license a GREEN over a
  // tier that exited non-zero, so a step that never ran that tier may not carry the record.
  preexistingFailures: ["verify", "ci"],
  // The project-test roster. `verify` alone: it is the roster of the suite the GATE ran, and a
  // step that ran no suite carrying one would report a gate's evidence on a step that made none
  // — `ci` re-probes its own full tier and records `preexistingFailures`, never a roster.
  projectRoster: "verify",
  // Owned by whichever dispatching step hit its ceiling: a handback inventing a ceiling the
  // step never crossed would print it as the run's cause.
  limit: BUDGET_STATES,
  value: BUDGET_STATES,
  used: BUDGET_STATES,
  // The review step's own clock. On any other step it claims a review stopped short of
  // judging its lanes when no review of this run stopped at all.
  reviewBound: "review",
  // The head a review fix wave started from: on any other step it claims a wave nobody bought.
  preFixHead: "review",
  // What the review step judged. `review` alone: a verify step carrying round tallies
  // would report findings no reviewer of this run ever raised, and a handback carrying a
  // wave head would claim a fix it did not integrate.
  review: "review",
  // Which tier and which criterion a red gate failed on. The two steps that RUN the gate,
  // and no other: `handback` printing a tier nobody ran would send a host to a check this
  // run never made.
  red: ["verify", "ci"],
  // The four head facts of a handback that shipped (or refused to ship) a verified head.
  // `handback` alone: any other step carrying them would claim a move its own step never
  // made, and the rewind is the reporting step's act, not a gate's verdict.
  shippedHead: "handback",
  shippedVerified: "handback",
  unshippedHead: "handback",
  unshippedReason: "handback",
};

/** The ceilings a budget verdict may name; the only reader of the field's type. */
const LIMITS = ["minutes", "turns", "tokens", "stall"] as const;

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
 * With `state` supplied, a field belonging to another state is refused; omitting
 * it keeps the shape-only checks for callers that have not resolved the state yet.
 */
export function outcomeProblem(oc: Record<string, unknown>, state?: LeanState): string | undefined {
  if (typeof oc.kind !== "string") return "outcome needs a string kind";
  // Step-owned fields are checked BEFORE their shape: a forged `prUrl` on a handback step
  // is refused whatever its value, so a caller cannot dodge the ownership rule with a
  // well-formed URL.
  if (state !== undefined) {
    for (const [field, owner] of Object.entries(OWNER_OF_FIELD)) {
      if (oc[field] === undefined) continue;
      if (Array.isArray(owner) ? !owner.includes(state) : owner !== state)
        return `outcome ${field} is only recorded by a ${String(owner)} step, not a ${state} step`;
    }
  }
  // The budget trio is only ever written by a budget verdict: `handback` renders
  // `limit`/`value`/`used` into the operator's cause line, so the trio on any other kind is a
  // ceiling this run never crossed, printed as the run's cause. `challenge` asks the question first
  // and names its own sentence — it is the one state with a legitimate `budget` kind, so “which
  // ceiling?” is one its operator actually has — and every other state keeps the generic wording.
  if (
    state === "challenge" &&
    oc.kind !== "budget" &&
    ["limit", "value", "used"].some((key) => oc[key] !== undefined)
  )
    return `outcome on a challenge ${String(oc.kind)} step carries the ceiling trio it never crossed`;
  if (oc.kind !== "budget") {
    for (const key of ["limit", "value", "used"] as const) {
      if (oc[key] !== undefined) return `outcome ${key} is only recorded by a budget verdict`;
    }
  }
  if (oc.kind === "budget") {
    if (!isBudgetLimit(oc.limit))
      return 'outcome kind "budget" needs limit "minutes" | "turns" | "tokens" | "stall"';
    for (const key of ["value", "used"] as const) {
      if (!isCount(oc[key]))
        return `outcome ${key} must be a non-negative safe integer for a budget verdict`;
    }
  }
  // `next()` calls `.join` on this when it routes a refusal, so a string-valued
  // `failedRules` is a crash waiting in the report path.
  if (
    oc.failedRules !== undefined &&
    (!Array.isArray(oc.failedRules) || oc.failedRules.some((x) => typeof x !== "string"))
  )
    return "outcome failedRules must be a string[]";
  // The derived contract is the document nine steps execute, so it is held to the
  // contract's own rules on load rather than carried: see `state-derived-spec.ts`.
  if (oc.derivedSpec !== undefined) {
    const derived = derivedSpecProblem(oc.derivedSpec);
    if (derived !== undefined) return `outcome ${derived}`;
  }
  // `frozen` is the tamper evidence `build` and `verify` read back, so a value that is not
  // a sha256 is refused rather than carried: a mistyped digest would compare unequal
  // forever and the reader could not tell a broken record from an edited test.
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
  // `verifiedHead` is what the land gate compares to the PR head, so a truncated or
  // mistyped sha is refused rather than carried. The `typeof` test comes first because a
  // number or object has no business reaching a regex.
  if (oc.verifiedHead !== undefined) {
    if (typeof oc.verifiedHead !== "string" || !SHA1_HEX.test(oc.verifiedHead))
      return "outcome verifiedHead must be a 40-hex commit sha";
  }
  // Matched to `verifiedHead` for EQUALITY by the result's `prState`, so it takes that
  // field's shape rule. Same predicate `state.ts` holds `baseSha` to.
  if (oc.publishedHead !== undefined) {
    if (typeof oc.publishedHead !== "string" || !isFullCommitSha(oc.publishedHead))
      return "outcome publishedHead must be a 40-hex commit sha";
  }
  // The handback's head facts and the review's pre-fix head are each a full oid, so a
  // truncated or mistyped value is refused rather than carried: the comment prints them
  // as evidence of what shipped.
  for (const field of ["shippedHead", "unshippedHead", "preFixHead"] as const) {
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
  if (oc.preserved !== undefined) {
    const problem = preservedListProblem(oc.preserved);
    if (problem !== undefined) return problem;
  }
  if (oc.headBefore !== undefined && !SHA1_HEX.test(String(oc.headBefore)))
    return "outcome headBefore must be a full commit sha";
  // The repair round's fields: rules in `oracle-repair-fields.ts`.
  const repairProblem = repairOutcomeProblem(oc);
  if (repairProblem !== undefined) return repairProblem;
  if (oc.preexistingFailures !== undefined) {
    const problem = preexistingFailuresProblem(oc.preexistingFailures);
    if (problem !== undefined) return problem;
  }
  // The roster licenses the MERGE (`landEarned` reads it), so it is refused rather than carried:
  // a record whose totals disagree with its own names, or whose name lists are empty, is a claim
  // no gate could have produced.
  if (oc.projectRoster !== undefined) {
    const problem = projectRosterProblem(oc.projectRoster);
    if (problem !== undefined) return problem;
  }
  if (oc.dispatches !== undefined) {
    const problem = dispatchesProblem(oc.dispatches);
    if (problem !== undefined) return problem;
  }
  // The review step's own clock: refused rather than carried, because a record whose wave
  // or lanes will not load is a disclosure no reader can print.
  if (oc.reviewBound !== undefined) {
    const problem = reviewBoundProblem(oc.reviewBound);
    if (problem !== undefined) return problem;
  }
  // The gate events a host reads off the result record. Refused rather than carried: a
  // round tally naming a fifth severity, or a wave head that is not an oid, would reach
  // the host contract as an answer nobody judged.
  if (oc.review !== undefined) {
    const problem = reviewRecordProblem(oc.review);
    if (problem !== undefined) return problem;
  }
  if (oc.red !== undefined) {
    const problem = redRecordProblem(oc.red);
    if (problem !== undefined) return problem;
  }
  // `prUrl` is the address `handback` prints, so it is refused when it is not https url
  // text; the length bound keeps a blob out of the record.
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
 * Why `fields` are not what a running `state` step may save before it decides, or `undefined`:
 * only fields `OWNER_OF_FIELD` gives that state, each held to its outcome shape rule.
 */
export function progressProblem(
  fields: Record<string, unknown>,
  state: LeanState,
): string | undefined {
  const stray = Object.keys(fields).find((f) => OWNER_OF_FIELD[f] !== state);
  if (stray !== undefined) return `progress ${stray} is not a ${state}-owned field`;
  return outcomeProblem({ ...fields, kind: "progress" }, state);
}

/**
 * The validated outcome, rebuilt field by field. Rebuilt rather than cast: `assertRun`'s
 * whole claim is that a caller can trust every field it reads, and an `as Outcome` would
 * carry an unvalidated field through as if it had been checked.
 */
export function buildOutcome(oc: Record<string, unknown>): Outcome {
  const tests = oc.tests as Record<string, string[]> | undefined;
  // Computed ONCE so the two clauses below cannot disagree about which arm they are on.
  const derived: DerivedSpec | undefined = canonicalDerivedSpec(oc.derivedSpec);
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
    ...(oc.preserved === undefined ? {} : { preserved: validatedPreservedList(oc.preserved) }),
    ...(typeof oc.headBefore === "string" && isFullCommitSha(oc.headBefore)
      ? { headBefore: oc.headBefore }
      : {}),
    ...validatedRepairFields(oc),
    ...(oc.preexistingFailures === undefined
      ? {}
      : { preexistingFailures: validatedPreexistingFailures(oc.preexistingFailures) }),
    // A roster that fails any rule is DROPPED rather than carried, and a dropped roster is the
    // same refusal as a missing one: `landEarned` refuses the merge on either.
    ...(oc.projectRoster === undefined
      ? {}
      : { projectRoster: validatedProjectRoster(oc.projectRoster) }),
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
    ...(typeof oc.preFixHead === "string" ? { preFixHead: oc.preFixHead } : {}),
    ...(oc.review === undefined ? {} : { review: buildReviewRecord(oc.review) }),
    ...(oc.red === undefined ? {} : { red: buildRedRecord(oc.red) }),
    ...(isBudgetLimit(oc.limit) ? { limit: oc.limit } : {}),
    ...(isCount(oc.value) ? { value: oc.value as number } : {}),
    ...(isCount(oc.used) ? { used: oc.used as number } : {}),
    // `ready`'s two run-level facts, at the END of the spread: the key order above is what the
    // handback key-list case pins, and a field inserted mid-list rewrites those bytes. Only
    // `ready` may carry either field, and `outcomeProblem` has refused it anywhere else BEFORE
    // this runs — so each clause here rebuilds only what that judgement already passed. The
    // contract goes through the reader that canonicalises it rather than carrying the file's
    // shape, so the executed document is the reader's shape rather than the file's.
    ...(derived === undefined ? {} : { derivedSpec: derived }),
    ...(derived === undefined
      ? {}
      : {
          // `baseSha` is `ready`'s too and the two are written by one save, so the knob gates
          // the pair together — the off arm is the release's outcome, which carried neither.
          // The sha is taken only as a full oid, the same shape `state.ts` holds the run's own
          // to; a truncated one is dropped rather than reaching a reader.
          ...(typeof oc.baseSha === "string" && isFullCommitSha(oc.baseSha)
            ? { baseSha: oc.baseSha }
            : {}),
        }),
  };
}

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
import { CRITERION_ID } from "./spec.ts";
import { normaliseRelPath, pathProblem } from "./specify-path.ts";
import type { LeanState, Outcome, Step } from "./state.ts";
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
 * six lenses and a fixer per round, so it MUST record cost — and since this
 * round it arms its ceiling through `armBudget` like the other three, so a
 * breach routes as a budget verdict. `BUDGET_STATES` stays the narrower set that
 * owns the `limit`/`value`/`used` trio for the pre-existing steps; widening it
 * to include `review` would name `review` as the owner of a trio only a
 * `budget`-kind outcome may carry.
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
  prUrl: "publish",
  // Publish's own record of what it pushed; elsewhere it claims a commit that
  // step never shipped. Same shape rule as `verifiedHead`, which it is matched
  // to for equality: a prefix or mistyped oid compares unequal forever.
  publishedHead: "publish",
  draft: "publish",
  // The two steps that REPORT how a run ended are the only ones that may claim a
  // comment reached the forge.
  posted: REPORTING_STATES,
  dispatches: DISPATCH_STATES,
  verifiedHead: "verify",
  commandCriteria: "verify",
  commandNotRunnable: "verify",
  // Owned by whichever dispatching step hit its ceiling: a handback inventing a
  // ceiling the step never crossed would print it as the run's cause.
  limit: BUDGET_STATES,
  value: BUDGET_STATES,
  used: BUDGET_STATES,
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

/** The one value a recorded `command` criterion may carry: it held. */
const COMMAND_CRITERION_KIND = "passed";

/** One why-a-command-was-not-run is prose; the record must not grow without bound. */
const COMMAND_NOT_RUNNABLE_MAX_CHARS = 300;

/** How many entries either command record may hold. */
const COMMAND_RECORD_MAX_ENTRIES = 32;

/**
 * Why a `commandCriteria` map is not evidence this run may print, or undefined.
 *
 * The map is what licenses `passed (command)` in the PR body, so a value that is
 * not the word `passed` — or an id that is not a criterion id — is refused rather
 * than carried: it would read as evidence for a check the gate never made. The
 * entry bound is the tier's own (`COMMAND_CRITERION_MAX` in `verify-commands`):
 * a record with more entries than the gate can execute was not written by it.
 */
function commandCriteriaProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "outcome commandCriteria must be an object";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > COMMAND_RECORD_MAX_ENTRIES)
    return `outcome commandCriteria must hold at most ${COMMAND_RECORD_MAX_ENTRIES} criteria`;
  for (const [id, kind] of entries) {
    if (!CRITERION_ID.test(id))
      return `outcome commandCriteria key ${JSON.stringify(id)} is not AC<n>`;
    if (kind !== COMMAND_CRITERION_KIND)
      return `outcome commandCriteria[${JSON.stringify(id)}] must be "${COMMAND_CRITERION_KIND}"`;
  }
  return undefined;
}

/** The token-count fields of a usage row; `cost` is checked as a measure, not a count. */
const USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "turns"] as const;

/**
 * How many dispatch rows one step may record. Exported because `specify` folds
 * two attempts into ONE outcome and clips its merge here rather than keeping a
 * second copy of the bound the validator enforces.
 */
export const DISPATCHES_MAX_ROWS = 16;

/** Is this a duration a child can honestly report? Finite and never negative. */
function isMeasure(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The shape of a fixer row's `runId`: the epoch milliseconds `fixRunId` mints,
 * then `-<visit>` for the fix-tree creation that made this tree. No sign, no
 * fraction, no exponent. `Number.isNaN` is not the risk this guards — a
 * hand-edited record or a replayed child result carries `"1e12"`, `"-5"` and
 * `"1.5"` all of which `Number()` would accept and no tree name ever has. The
 * visit suffix is part of the name because a review round dispatches a fixer on
 * two arms, so the epoch alone could not make two trees distinct.
 */
const FIX_RUN_ID = /^[0-9]{13,17}(-[0-9]{1,9})?$/;

/** Is this a fixer row's tree identity, in the shape `fixRunId` mints? */
function isRunId(value: unknown): boolean {
  return typeof value === "string" && FIX_RUN_ID.test(value);
}

/** Is this value a usage row of the shape `DispatchUsage` describes? */
function isUsageRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  // A count of tokens is never a fraction and never infinite: `1e400` arrives
  // from JSON as `Infinity`, and an infinite total printed to a host is a
  // record that reads as evidence and compares against nothing.
  if (!["input", "output", "cacheRead", "cacheWrite", "turns"].every((k) => isCount(u[k])))
    return false;
  // `cost` is the one field that is NOT an integer count: `addUsage` in
  // `pi-usage.ts` accumulates a currency total, so a real report carries
  // fractions (0.00000625 for one small child) and refusing them would refuse
  // every honest row. It is still a finite non-negative number — a negative
  // cost would SUBTRACT from a host's total and an infinite one cannot print.
  return isMeasure(u.cost);
}

/**
 * Why a `dispatches` array is not a cost record this run may report, or undefined.
 *
 * Each row is one child the step paid for, and the headless result sums these
 * into `usage.byRole`. A row with no role cannot be attributed to a role, a
 * negative cost would subtract from the total, and a row whose `ok` is not a
 * boolean leaves the reader unable to tell a stopped child from a finished one
 * — which is the distinction the whole per-role comparison between engines rests on.
 */
function dispatchesProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "outcome dispatches must be an array";
  if (value.length > DISPATCHES_MAX_ROWS)
    return `outcome dispatches must hold at most ${DISPATCHES_MAX_ROWS} rows`;
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return `outcome dispatches[${String(i)}] must be an object`;
    const row = raw as Record<string, unknown>;
    if (typeof row.role !== "string" || row.role === "")
      return `outcome dispatches[${String(i)}].role must be a non-empty string`;
    if (typeof row.ok !== "boolean") return `outcome dispatches[${String(i)}].ok must be a boolean`;
    if (!isMeasure(row.ms))
      return `outcome dispatches[${String(i)}].ms must be a finite number >= 0`;
    if (!isUsageRow(row.usage))
      return `outcome dispatches[${String(i)}].usage must carry non-negative integer input, output, cacheRead, cacheWrite, cost and turns`;
    // `runId` is optional, but when present it must be the shape `fixRunId`
    // mints: the reader that puts a resumed attempt back onto the tree its
    // crashed self left matches on this field, and a value that is merely
    // *present* would name a directory the step then treats as its own.
    if (row.runId !== undefined && !isRunId(row.runId))
      return `outcome dispatches[${String(i)}].runId must be a decimal epoch-millisecond string`;
  }
  return undefined;
}

/** The `dispatches` rows, rebuilt from the ones this module actually checked. */
export function validatedDispatches(value: unknown): DispatchUsageRow[] {
  const out: DispatchUsageRow[] = [];
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.role !== "string" || row.role === "") continue;
    if (typeof row.ok !== "boolean" || !isMeasure(row.ms) || !isUsageRow(row.usage)) continue;
    if (row.runId !== undefined && !isRunId(row.runId)) continue;
    const u = row.usage as Record<string, unknown>;
    // Each count is RE-DERIVED from the check rather than cast: `isUsageRow`
    // already proved all six are non-negative safe integers, and reading them
    // back through `unknown` keeps the rebuilt row a product of the validation.
    const count = (k: (typeof USAGE_COUNTERS)[number] | "cost"): number => u[k] as number;
    out.push({
      role: row.role,
      ms: row.ms as number,
      ok: row.ok as boolean,
      usage: {
        input: count("input"),
        output: count("output"),
        cacheRead: count("cacheRead"),
        cacheWrite: count("cacheWrite"),
        cost: count("cost"),
        turns: count("turns"),
      },
      ...(row.runId === undefined ? {} : { runId: row.runId as DispatchUsageRow["runId"] }),
    });
  }
  return out;
}

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
    if (entries.length > COMMAND_RECORD_MAX_ENTRIES)
      return `outcome commandNotRunnable must hold at most ${COMMAND_RECORD_MAX_ENTRIES} criteria`;
    for (const [id, why] of entries) {
      if (!CRITERION_ID.test(id))
        return `outcome commandNotRunnable key ${JSON.stringify(id)} is not AC<n>`;
      if (typeof why !== "string")
        return `outcome commandNotRunnable[${JSON.stringify(id)}] must be a string`;
      if (why.length > COMMAND_NOT_RUNNABLE_MAX_CHARS)
        return `outcome commandNotRunnable[${JSON.stringify(id)}] must be at most ${COMMAND_NOT_RUNNABLE_MAX_CHARS} characters`;
    }
  }
  if (oc.dispatches !== undefined) {
    const problem = dispatchesProblem(oc.dispatches);
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
function validatedCommandCriteria(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, kind] of Object.entries(value as Record<string, unknown>)) {
    if (kind === COMMAND_CRITERION_KIND && CRITERION_ID.test(id)) out[id] = COMMAND_CRITERION_KIND;
  }
  return out;
}

/** The `commandNotRunnable` map, rebuilt the same way — strings only, bounded. */
function validatedCommandNotRunnable(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, why] of Object.entries(value as Record<string, unknown>)) {
    if (typeof why !== "string" || why.length > COMMAND_NOT_RUNNABLE_MAX_CHARS) continue;
    if (CRITERION_ID.test(id)) out[id] = why;
  }
  return out;
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
    ...(typeof oc.prUrl === "string" ? { prUrl: oc.prUrl } : {}),
    ...(typeof oc.publishedHead === "string" ? { publishedHead: oc.publishedHead } : {}),
    ...(typeof oc.draft === "boolean" ? { draft: oc.draft } : {}),
    ...(typeof oc.posted === "boolean" ? { posted: oc.posted } : {}),
    ...rowsField(validatedDispatches(oc.dispatches)),
    ...(isBudgetLimit(oc.limit) ? { limit: oc.limit } : {}),
    ...(isCount(oc.value) ? { value: oc.value as number } : {}),
    ...(isCount(oc.used) ? { used: oc.used as number } : {}),
  };
}

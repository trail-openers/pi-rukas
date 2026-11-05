/**
 * lens-unproven-high — the executed check on a HIGH's claimed reproduction
 * (#2040), the second of the two severity caps beside `SEVERITY_RUBRIC`.
 *
 * The rubric asks a HIGH to state a reachable failure, but a stated failure is
 * still a claim, and AGENTS.md §7 is that a gate checks executed evidence, never
 * a child's claim. Field evidence: one six-lens round on a ~780-line diff
 * returned 138 findings with 2 HIGH, and both were refuted elsewhere — one
 * demanded behaviour the issue put out of scope, the other claimed a
 * verdict-forgery path that did not survive ~16,000 crafted inputs through the
 * real parsers. Each fix round produced new unproven HIGHs (1, then 2, then 2),
 * so the review never converged and a correct PR needed an operator.
 *
 * The rule: a HIGH keeps its severity only when it names `reproduction`
 * (`lens-review-types.ts`) whose `command` equals — whitespace collapsed on both
 * sides — the `command` argument of a `bash` call the SAME lens child is
 * recorded as having run, and whose `observed` says something. Anything else
 * comes down to MEDIUM with `severityCapped: "unproven"`. The finding is kept and
 * rendered; only its blocking power changes.
 *
 * Two facts make a call "run", not one. `toolUses` is what the child ASKED for
 * and `toolResults` is what Pi accepted (`types.ts`), so a call joined to a
 * result carrying `isError: true` was refused — a failing `bun test` is the
 * opposite of a reproduction. A child whose session recorded no result for the
 * tool at all is judged on its calls alone: absence of a ledger is not a ledger
 * of refusals (AGENTS.md §7 — silence is never a pass, and never a refusal).
 *
 * `observed` is a gate, never content: nothing here parses it and no renderer
 * prints it, so untrusted child text reaches neither a prompt nor a post.
 *
 * Not capped, each deliberate:
 *   - CRITICAL — the harness does not downgrade what the lens called critical,
 *     the same call `capTestPathFinding` makes, and the reason `hasCritical`, the
 *     delta veto and CRITICAL carry stay untouched;
 *   - `CLAIM_SCAN` rows — deterministic lookups with no lens judgement behind
 *     them, so there is no inflated label to correct;
 *   - a row the TEST-PATH cap already moved — that cap runs FIRST, in the same
 *     pass, and wins (see `capFindings` in lens-severity-rubric.ts), so a
 *     reproduction can never rescue a HIGH that cited a test file. Any OTHER
 *     marker on a HIGH row — including a stored `"unproven"` — is re-checked:
 *     a marker records some earlier round's judgement, and a row's blocking
 *     power is decided by the calls THIS round's children made.
 */

import { sortFindings } from "./lens-review-format.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import { readReproduction } from "./review-findings-reproduction.ts";

/** The tool whose recorded calls can carry a reproduction. A child that ran its
 * command through anything else recorded nothing the harness can read, and the
 * harness does not second-guess what a lens chose to run. */
const REPRODUCTION_TOOL = "bash";
/** The argument naming the command on a recorded call. */
const COMMAND_KEY = "command";
/** The cap whose marker alone short-circuits this pass — it runs first, in the
 * same composition, so a row carrying it has already been judged (see the
 * module header for why no other marker does). */
const EARLIER_CAP = "test-path";

/**
 * One recorded call, paired with the result Pi accepted for it — `refused: true`
 * when the child's session recorded an `isError` result for it, or none at all
 * once the child recorded any (see {@link successfulCalls}).
 */
interface RecordedCall {
  /** The call itself, in the shape the child's session records it. */
  readonly call: unknown;
  /** True when the child's session recorded an `isError` result for this call. */
  readonly refused: boolean;
}

/**
 * The evidence surface the caps read: what each lens child in the round is
 * recorded as having RUN, KEYED BY THE CHILD. A round-wide pool is the shape
 * that let one lens's `bun test` prove another lens's HIGH, so the map is the
 * type that makes that unrepresentable. The value is the child's RAW record —
 * its calls and its results — so the join is applied in exactly one place
 * ({@link successfulCalls}) and no caller can hand in a list that skipped it.
 * A plain array is accepted only for a caller that genuinely holds one
 * undifferentiated list (a fixture, or a path with no per-child attribution to
 * make): with no attribution, every row is judged against the whole list.
 */
export type ReproductionEvidence =
  | ChildToolRecord
  | readonly unknown[]
  | ReadonlyMap<string, unknown>;

/**
 * One child's raw record: the calls it made and the results Pi accepted for
 * them. Either list may carry the other kind of record (a session transcript
 * holds them interleaved); {@link successfulCalls} partitions them.
 */
export interface ChildToolRecord {
  readonly toolUses?: readonly unknown[];
  readonly toolResults?: readonly unknown[];
}

/**
 * What a caller hands the one-row cap: one child's raw record, a bare list of
 * records for one child, or an already-built round surface. The arms cannot be
 * confused: a `Map` is a surface, an array is one child's mixed records, and an
 * object is a record.
 */
export type ToolEvidenceInput = ReproductionEvidence | readonly unknown[];

/**
 * One row, checked against the recorded calls of the child that reported it
 * (see the module header). Returns the SAME object when nothing moves, so
 * `severityCapped` always means "this row's severity was lowered here".
 */
export function capUnprovenHighFinding(
  finding: Finding,
  toolUses: ToolEvidenceInput | undefined,
): Finding {
  if (finding.lens === "CLAIM_SCAN") return finding;
  if (finding.severity !== "HIGH") return finding;
  if (finding.severityCapped === EARLIER_CAP) return finding;
  if (runsTheClaimedCommand(finding, callsFor(evidenceOf(toolUses), finding.lens))) {
    return finding;
  }
  return { ...finding, severity: "MEDIUM", severityCapped: "unproven" };
}

/**
 * The merge-path pass (see `capUnprovenHighFinding`), and the reason it takes
 * the round's evidence as a parameter rather than reading them itself: the
 * row that survives a dedup collision is the row whose evidence decides, and the
 * calls belong to the lens child that made them — never to another lens's child
 * that happened to run a similar command.
 *
 * Re-sorts afterwards for the reason `capTestPathFindings` states: rows move
 * between severity levels, and every report reads this array's order.
 *
 * An EMPTY evidence surface for a row's lens means nothing was proven, so that
 * row caps — the same outcome as a round whose lens children ran no commands.
 */
export function capUnprovenHighFindings(
  findings: readonly Finding[],
  evidence: ReproductionEvidence,
): Finding[] {
  return findings.map((f) => capUnprovenHighFinding(f, evidence)).sort(sortFindings);
}

/**
 * Build the per-child evidence surface from the round's lens rows. One entry per
 * lens, holding THAT child's calls reduced to the ones it ran. A lens the round
 * never ran contributes nothing, which reads the same as a child that ran
 * nothing: an empty list, and a HIGH that caps.
 */
export function evidenceByLens(
  lensResults: readonly Pick<LensRunResult, "lens" | "toolUses" | "toolResults">[],
): ReadonlyMap<string, ChildToolRecord> {
  const byLens = new Map<string, ChildToolRecord>();
  for (const r of lensResults) {
    byLens.set(r.lens, { toolUses: r.toolUses ?? [], toolResults: r.toolResults ?? [] });
  }
  return byLens;
}

/**
 * Normalise whatever the caller handed in into the evidence surface. A `Map` is
 * one per child (a value may be a record or a bare list of that child's records);
 * anything else is ONE CHILD — `{ toolUses, toolResults }`, or a bare list of
 * records in which calls and results are mixed, the shape a child's session
 * transcript holds. Treating anything else as an empty child is deliberate: an
 * input this function cannot read carries no evidence, so every HIGH caps, which
 * is the direction a severity gate must fail in.
 */
function evidenceOf(toolUses: ToolEvidenceInput | undefined): ReproductionEvidence {
  if (toolUses === undefined) return {};
  if (toolUses instanceof Map) {
    const normalised = new Map<string, unknown>();
    for (const [lens, records] of toolUses) normalised.set(lens, recordOf(records));
    return normalised;
  }
  return recordOf(toolUses);
}

/**
 * One child's records, sorted into calls and results. A result is keyed by
 * `toolCallId` and a call by `name`, so a bare list is partitioned by shape
 * rather than by which argument it arrived in — a record of one kind is never
 * read as the other, and `isError` is compared to `false`, never to truthiness.
 */
function recordOf(records: unknown): ChildToolRecord {
  if (!records) return {};
  if (!Array.isArray(records)) {
    return typeof records === "object" ? (records as ChildToolRecord) : {};
  }
  const calls: unknown[] = [];
  const results: unknown[] = [];
  for (const entry of records) {
    if (isResultRecord(entry)) results.push(entry);
    else if (isCallRecord(entry)) calls.push(entry);
  }
  return { toolUses: calls, toolResults: results };
}

/** A recorded tool RESULT: keyed by `toolCallId`, and not a tool call. */
function isResultRecord(v: unknown): boolean {
  return (
    !!v && typeof v === "object" && "toolCallId" in (v as object) && !("type" in (v as object))
  );
}

/** A recorded tool CALL: has a `name` and carries `arguments`. */
function isCallRecord(v: unknown): boolean {
  return !!v && typeof v === "object" && "name" in (v as object);
}

/**
 * The calls of one row's child (or the whole pool), joined to what ran.
 *
 * A map miss is the same reading as an empty record: the round recorded no child
 * by that name, so nothing was proven and the row caps.
 */
function callsFor(
  toolUses: ToolEvidenceInput | undefined,
  lens: Finding["lens"],
): readonly RecordedCall[] {
  const evidence = evidenceOf(toolUses);
  const record = evidence instanceof Map ? evidence.get(lens) : evidence;
  if (Array.isArray(record)) return successfulCalls(asList(record), []);
  if (!record || typeof record !== "object") return [];
  // The two lists are read SEPARATELY, because which one an entry came from is
  // the only thing that distinguishes a call from a result: a session transcript
  // keys a call by `name`/`arguments` and a result by `toolCallId`/`isError`, and
  // a single mixed list would let a malformed record silently become either.
  const r = record as ChildToolRecord;
  return successfulCalls(asList(r.toolUses), asList(r.toolResults));
}

/** A field that is not an array carries no records. */
function asList(v: readonly unknown[] | undefined): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * The child's recorded calls, reduced to the ones it is recorded as having RUN:
 * every `bash` call whose result was not an error. Joining here, rather than in
 * the matcher, keeps the refusal rule in one place and keeps the surface a list
 * of things that happened.
 */
function successfulCalls(
  toolUses: readonly unknown[],
  toolResults: readonly unknown[],
): readonly RecordedCall[] {
  const ledger = resultLedger(toolResults);
  const calls: RecordedCall[] = [];
  for (const tu of toolUses) {
    if (!isBashCall(tu)) continue;
    const id = (tu as { id?: unknown }).id;
    const key = typeof id === "string" ? id : UNJOINABLE;
    // Two kinds of "no result", and they mean opposite things. `ledger ===
    // undefined` is "this child's session recorded no result for the tool at
    // all" — no ledger to be judged by, so the call stands as recorded. A call
    // simply ABSENT from a ledger that exists was not accepted either: a real
    // ledger is the record of what Pi ran, and a call missing from it proved
    // nothing. `refused` is the join's verdict, read once here.
    const refused = ledger === undefined ? false : !ledger.has(key);
    calls.push({ call: tu, refused });
  }
  return calls;
}

/** A call recorded without an `id` cannot be joined to any result. */
const UNJOINABLE = "\u0000unjoinable";

/**
 * The child's results, read as a ledger of what Pi ACCEPTED for the reproduction
 * tool: the set of `toolCallId`s whose result carried `isError === false`.
 * Undefined when the child recorded no result for the tool at all — the
 * difference between "nothing ran" and "nothing was recorded", which must not
 * collapse (AGENTS.md §7). A result naming no tool counts for the reproduction
 * tool: it is the only tool this gate reads, and a ledger with no names is still
 * a ledger.
 */
function resultLedger(toolResults: readonly unknown[]): Set<string> | undefined {
  const accepted = new Set<string>();
  let sawResult = false;
  for (const tr of toolResults) {
    if (!tr || typeof tr !== "object") continue;
    const r = tr as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
    if (r.toolName !== undefined && r.toolName !== REPRODUCTION_TOOL) continue;
    sawResult = true;
    if (r.isError === false && typeof r.toolCallId === "string") accepted.add(r.toolCallId);
  }
  return sawResult ? accepted : undefined;
}

function isBashCall(tu: unknown): boolean {
  if (!tu || typeof tu !== "object") return false;
  const t = tu as { name?: unknown; arguments?: unknown };
  return t.name === REPRODUCTION_TOOL && !!t.arguments && typeof t.arguments === "object";
}

/**
 * Did this row's own child run the command the row names?
 *
 * The comparison is equality after collapsing whitespace on BOTH sides — the
 * child's call and its claim are two separate renderings of one command, and the
 * child is told to spell it as it ran it. Substrings and prefixes are refused: a
 * claim of `bun test` does not evidence a call of `bun test x
 * --reporter=junit`, and a claim carrying `; rm -rf /` beside a real command is
 * not that command.
 *
 * The claim is read through the one reader the store's validator uses
 * (`readReproduction`), so an over-bound or malformed claim is no evidence here
 * either: the claim drops, and a dropped claim caps.
 */
function runsTheClaimedCommand(finding: Finding, toolUses: readonly RecordedCall[]): boolean {
  const claimedRepro = readReproduction(finding.reproduction);
  const claimed = collapse(claimedRepro?.command ?? "");
  const observed = collapse(claimedRepro?.observed ?? "");
  // An empty `observed` is not evidence of anything: the child said it ran
  // something and reported no result. Same for an empty command — nothing was
  // named to check.
  if (claimed === "" || observed === "") return false;
  return toolUses.some((entry) => {
    // A call Pi refused is not a run: the join already decided it, and a failing
    // `bun test` is evidence against the claim, not for it.
    if (entry.refused || !isBashCall(entry.call)) return false;
    const args = (entry.call as { arguments?: unknown }).arguments as { [COMMAND_KEY]?: unknown };
    return collapse(args[COMMAND_KEY]) === claimed;
  });
}

/** Whitespace collapsed for comparison; a non-string is no command at all. */
function collapse(v: unknown): string {
  return typeof v === "string" ? v.replaceAll(/\s+/g, " ").trim() : "";
}

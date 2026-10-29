/**
 * lean/state — the one durable record of a run, and the only thing a resumed
 * run trusts.
 *
 * `<repoRoot>/.pi/lean-state/<issue>.json`, one file per issue, written
 * atomically (tmp file + rename) so a kill mid-write leaves the previous good
 * bytes rather than half a JSON document.
 *
 * The shape is deliberately two-layered, like a WAL:
 *
 *   - `steps` is the append-only log. Every step ever started is in it, with
 *     its key `${issue}:${state}:${n}`. Nothing in it is ever rewritten once
 *     it has an outcome.
 *   - `state` / `counters` are the snapshot, always derivable by replaying
 *     `steps` through `next()`. They are cached for reads, not trusted as
 *     truth: `steps` is the record.
 *
 * A step WITHOUT an `outcome` is a crash mid-step, and is what makes a resume
 * safe to reason about: the engine re-runs exactly that step and no other.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isFullCommitSha } from "../commit-sha.ts";
import { buildOutcome, outcomeProblem } from "./state-outcome.ts";

export const SCHEMA_VERSION = 1;

/**
 * The states a run can sit in. `decline` is the step that reports a refusal;
 * the last three end the run. See machine.ts.
 */
export type LeanState =
  | "ready"
  | "specify"
  | "build"
  | "challenge"
  | "verify"
  | "publish"
  | "review"
  | "ci"
  | "land"
  | "handback"
  | "decline"
  | "not-ready"
  | "landed"
  | "handed-back";

/** States that end a run — the engine stops here and reports. */
export const TERMINAL_STATES: readonly LeanState[] = ["landed", "handed-back", "not-ready"];

export function isTerminal(state: LeanState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** What a step decided. The fields the engine reads are named on `Outcome` below. */

export interface Step {
  /** `${issue}:${state}:${n}` — unique per (state, attempt). */
  key: string;
  state: LeanState;
  /** Injected clock, epoch ms. Recorded before the handler runs. */
  startedAt: number;
  endedAt?: number;
  /** Absent means the step started and never finished: re-run it. */
  outcome?: Outcome;
}

/**
 * The newest DECIDED step of one state, or `undefined`.
 *
 * A step without an outcome is a crash mid-step — the engine is about to
 * re-run it, and it has said nothing, so it is never "the newest". Reading
 * a trailing outcome-less `verify:1` as the state's verdict made a
 * legitimately green run look unverified.
 *
 * Lives next to `Step` rather than in `engine.ts` because the rule is a
 * property of the log, not of the runner: the engine's land gate and the
 * publish step's green-check are two readers of one record and must not
 * diverge.
 */
export function newestDecided(steps: Step[], state: LeanState): Step | undefined {
  const decided = steps.filter((s) => s.state === state && s.outcome !== undefined);
  return decided[decided.length - 1];
}

export interface RunCounters {
  buildAttempts: number;
  challengeDone: boolean;
  /** The review step has run: `publish` goes to `ci` instead of round-tripping. */
  reviewDone: boolean;
  ciFixUsed: boolean;
  draft: boolean;
}

/**
 * A position in the run: where the walk stands and with what counters. Both
 * the fold in resume.ts and the snapshot fields on a run are of this shape,
 * which is what lets a caller compare them field by field rather than by
 * object identity.
 */
export interface Position {
  state: LeanState;
  counters: RunCounters;
}

export interface LeanRun {
  schema: 1;
  issue: number;
  /** extension/package.json version, so a state file can be read years later. */
  version: string;
  models: Record<string, string>;
  baseSha: string;
  branch: string;
  state: LeanState;
  counters: RunCounters;
  steps: Step[];
  /** Set once the run is over: the exit code and the reason it ended there. */
  result?: { code: number; reason: string };
}

/**
 * What a step's handler returned. The engine routes on `kind` and reads the
 * four fields below for a reason line or a report, so they are named rather
 * than left to an index signature — a handler that adds a scratch field is a
 * compile error, which is what keeps the durable log a record of verdicts an
 * operator reads rather than of whatever a closure happened to hold.
 */
export interface Outcome {
  kind: string;
  reason?: string;
  message?: string;
  failedRules?: string[];
  /**
   * `specify` only: the frozen acceptance tests, path -> sha256 of the bytes
   * at freeze time. Persisted in the step log so a resumed run, `build` and
   * `verify` can tell "the test still holds" apart from "somebody edited it
   * after the step that proved it red".
   */
  frozen?: Record<string, string>;
  /**
   * `specify` only: criterion id -> the kept test files that cover it. The
   * record of which criterion each frozen file answers for.
   */
  tests?: Record<string, string[]>;
  /**
   * `verify` only: the 40-hex commit whose tree produced this verdict. The land
   * gate compares it to the PR head, so "the tests were green" is a claim about
   * a named commit rather than about whatever tree happened to be on disk when
   * the step ran.
   */
  verifiedHead?: string;
  /**
   * `verify` only: the spec's `command` criteria this gate EXECUTED and that
   * exited 0, keyed by criterion id. A criterion the gate ran is a claim
   * `publish-body` may print as `passed (command)`; one absent from this map was
   * never run, and the body says so. Kept as a bare id->word map (not nested
   * objects) so the durable record stays a record of verdicts and the validator
   * can check every value it reads.
   */
  commandCriteria?: Record<string, string>;
  /**
   * `verify` only: why the gate did NOT run each `command` criterion, keyed by
   * criterion id — verbatim from the gate's own tree and on-disk checks, and each
   * bounded. Per criterion rather than one slot because the reasons differ and so
   * do the fixes: `x does not exist at base` is an issue to rewrite, `x is a
   * symlink` is a tree to repair and `x changed since base` means the criterion
   * stopped describing preservation. Carried so the PR body explains each blank
   * instead of leaving the operator to guess.
   */
  commandNotRunnable?: Record<string, string>;
  /**
   * `publish` only: the PR's https URL, as the forge returned it. Publish-only
   * by contract — no other step writes it, and `handback` reads no other field
   * for a URL — so "there is a PR at this address" is a recorded fact rather
   * than something a later reader guesses out of a reason line.
   */
  prUrl?: string;
}

export const INITIAL_COUNTERS: RunCounters = {
  buildAttempts: 0,
  challengeDone: false,
  reviewDone: false,
  ciFixUsed: false,
  draft: false,
};

export class LeanStateError extends Error {
  override readonly name = "LeanStateError";
}

export function leanStateDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "lean-state");
}

export function leanStateFile(repoRoot: string, issue: number): string {
  return path.join(leanStateDir(repoRoot), `${issue}.json`);
}

export function stepKey(issue: number, state: LeanState, n: number): string {
  return `${issue}:${state}:${n}`;
}

/**
 * A step's attempt number, or `undefined` when its key has no `:N` suffix.
 *
 * The engine's replay decision has to tell "this is attempt 0" apart from
 * "this key is corrupt": treating both as 0 let a hand-edited key collide
 * with the real first step of its state, and the run then replayed an
 * outcome for a step it had never run. `loadRun` refuses such a file; this
 * is the same distinction on the inside, where a caller must not fall back
 * to 0.
 */
export function attemptOfStrict(key: string): number | undefined {
  const suffix = key.slice(key.lastIndexOf(":") + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : undefined;
}

/**
 * The next attempt number for a state: the number of entries the log already
 * holds for it.
 *
 * The engine keys a write-ahead with this and the fold in resume.ts derives a
 * step's identity from the same quantity — the count of earlier entries of
 * that state — so the two agree by construction rather than by convention.
 * `attemptOfStrict` is what a key must read back as, and a key that does not
 * is refused by `loadRun`; a corrupt key therefore never reaches here as a
 * silently-low count. A max-based count would differ exactly when a key was
 * edited, which is the case that must not be able to disagree.
 */
export function nextAttempt(run: LeanRun, state: LeanState): number {
  let n = 0;
  for (const s of run.steps) if (s.state === state) n++;
  return n;
}

export function createRun(
  init: Pick<LeanRun, "issue" | "version" | "models" | "baseSha" | "branch">,
): LeanRun {
  return {
    schema: SCHEMA_VERSION,
    issue: init.issue,
    version: init.version,
    models: { ...init.models },
    baseSha: init.baseSha,
    branch: init.branch,
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps: [],
  };
}

/** A run as found on disk, or `undefined` when no file exists yet. Throws on garbage. */
export function loadRun(repoRoot: string, issue: number): LeanRun | undefined {
  const file = leanStateFile(repoRoot, issue);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new LeanStateError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new LeanStateError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return assertRun(obj, file);
}

/** Field-by-field so a partial file names the missing field instead of `undefined`. */
function assertRun(obj: unknown, file: string): LeanRun {
  const bad = (msg: string): never => {
    throw new LeanStateError(`${file}: ${msg}`);
  };
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) bad("run must be an object");
  const r = obj as Record<string, unknown>;
  if (r.schema !== SCHEMA_VERSION)
    bad(`unknown schema ${JSON.stringify(r.schema)}, expected ${SCHEMA_VERSION}`);
  if (typeof r.issue !== "number" || !Number.isInteger(r.issue) || r.issue <= 0)
    bad("issue must be a positive integer");
  if (typeof r.version !== "string") bad("version must be a string");
  if (typeof r.state !== "string") bad("state must be a string");
  // baseSha and branch are required to be STRINGS; branch may be empty (a
  // phase-1 run is created before a branch is cut) and so may baseSha (a seed
  // whose probe failed, which `ready` then refuses with a reason).
  for (const key of ["baseSha", "branch"] as const) {
    if (typeof r[key] !== "string") bad(`${key} must be a string`);
  }
  // A NON-empty base is held to the same rule `ready` applies: a full
  // lowercase oid, and nothing else. The base is the ref every later read of
  // the run is anchored to — the config load, the diff, the verify verdict —
  // and a record carrying `main` or `HEAD` in that field anchors the whole run
  // to a moving ref, so an operator's hand-edit cannot make a run mean "the
  // mainline, whatever it is now". Empty is the one value that is not a base
  // at all, and `ready` refuses that path with the reason the probe gave.
  if (typeof r.baseSha === "string" && r.baseSha !== "" && !isFullCommitSha(r.baseSha))
    bad(
      `baseSha must be empty or a full commit sha (got ${JSON.stringify(r.baseSha.slice(0, 80))})`,
    );
  if (!isTerminal(r.state as LeanState) && !NON_TERMINAL.includes(r.state as LeanState))
    bad(`unknown state ${JSON.stringify(r.state)}`);
  if (typeof r.counters !== "object" || r.counters === null || Array.isArray(r.counters))
    bad("counters must be an object");
  const c = r.counters as Record<string, unknown>;
  if (typeof c.buildAttempts !== "number" || !Number.isInteger(c.buildAttempts))
    bad("counters.buildAttempts must be an integer");
  for (const key of ["challengeDone", "reviewDone", "ciFixUsed", "draft"] as const) {
    if (typeof c[key] !== "boolean") bad(`counters.${key} must be a boolean`);
  }
  const models = r.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object" || Array.isArray(models))
    bad("models must be an object");
  if (!Array.isArray(r.steps)) bad("steps must be an array");
  const seenKeys = new Set<string>();
  const steps: Step[] = [];
  for (const raw of r.steps as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      bad("every step must be an object");
    const st = raw as Record<string, unknown>;
    // Explicit narrowing: `bad` throws, but a call expression does not narrow
    // for TypeScript, so without these locals every later use stayed
    // `unknown` and the built object would have carried unchecked values.
    // `bad` throws, but a bare call does not narrow for TypeScript, so the
    // narrowing is written as an assertion that cannot be satisfied by a
    // wrong-typed field rather than left to the validator's side effect.
    const key = st.key as string;
    const startedAt = st.startedAt as number;
    if (typeof st.key !== "string" || typeof st.startedAt !== "number")
      bad("every step needs key and startedAt");
    if (typeof st.state !== "string") bad(`step ${key} needs a state`);
    // A step whose `state` is no state the run can sit in would be skipped by
    // the replay fold below — silently, as if it had never happened — so it is
    // refused on load like any other corruption.
    if (!isTerminal(st.state as LeanState) && !NON_TERMINAL.includes(st.state as LeanState))
      bad(`step ${key} has unknown state ${JSON.stringify(st.state)}`);
    // Keys are the identity the re-run decision is keyed on: two steps
    // sharing one key means the replay path can pick either, so a hand-edited
    // file that duplicated a key must be refused rather than driven.
    if (seenKeys.has(key)) bad(`duplicate step key ${JSON.stringify(key)}`);
    seenKeys.add(key);
    // A step whose `outcome` is not an object would reach the replay path as
    // a step that "has" an outcome, and `next()` would then route on an
    // undefined `kind` — a corrupt file must be refused here rather than
    // become an unlisted-pair handback mid-drive.
    if (
      st.outcome !== undefined &&
      (typeof st.outcome !== "object" || st.outcome === null || Array.isArray(st.outcome))
    )
      bad(`step ${key} outcome must be an object`);
    const oc = st.outcome as Record<string, unknown> | undefined;
    if (oc !== undefined) {
      const problem = outcomeProblem(oc, st.state as LeanState);
      if (problem !== undefined) bad(`step ${key} ${problem}`);
    }
    // The `:N` suffix is a derived field (the entry count) and the engine
    // trusts it when deciding whether a state still owes a handler call, so
    // a corrupt suffix is refused rather than read as attempt 0.
    const suffix = key.slice(key.lastIndexOf(":") + 1);
    if (!/^\d+$/.test(suffix)) bad(`step key ${JSON.stringify(key)} needs a numeric :N suffix`);
    steps.push({
      key,
      state: st.state as LeanState,
      startedAt,
      ...(typeof st.endedAt === "number" ? { endedAt: st.endedAt } : {}),
      ...(oc === undefined ? {} : { outcome: buildOutcome(oc) }),
    });
  }
  // Built field by field rather than cast: a caller must be able to trust
  // every field it reads, and an `as unknown as LeanRun` made a field this
  // function never checked look as validated as the ones it did.
  return {
    schema: SCHEMA_VERSION,
    issue: r.issue as number,
    version: r.version as string,
    models: Object.fromEntries(
      Object.entries(models as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>,
    baseSha: r.baseSha as string,
    branch: r.branch as string,
    state: r.state as LeanState,
    counters: {
      buildAttempts: c.buildAttempts as number,
      challengeDone: c.challengeDone as boolean,
      reviewDone: c.reviewDone as boolean,
      ciFixUsed: c.ciFixUsed as boolean,
      draft: c.draft as boolean,
    },
    steps,
    ...(r.result !== undefined ? { result: assertResult(r.result, bad) } : {}),
  };
}

/** The terminal stamp: an int code and a string reason, or nothing. */
function assertResult(
  value: unknown,
  bad: (msg: string) => never,
): { code: number; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    bad("result must be an object");
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "number" || !Number.isInteger(v.code))
    bad("result.code must be an integer");
  if (typeof v.reason !== "string") bad("result.reason must be a string");
  return { code: v.code, reason: v.reason };
}

/** Lock file path for a run. One per issue, alongside the state file. */
export function leanLockFile(repoRoot: string, issue: number): string {
  return `${leanStateFile(repoRoot, issue)}.lock`;
}

/** Every state a run can be sitting in mid-flight. */
const NON_TERMINAL: readonly LeanState[] = [
  "ready",
  "specify",
  "build",
  "challenge",
  "verify",
  "publish",
  "review",
  "ci",
  "land",
  "handback",
  "decline",
];

/**
 * Persist atomically. A failed write cleans up its tmp file and rethrows: the
 * caller keeps the previous good file and learns the save did not happen,
 * rather than believing a step was durable when it was not.
 */
export function saveRun(repoRoot: string, run: LeanRun): void {
  const file = leanStateFile(repoRoot, run.issue);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    // Only ever our own file, at a path we generated, and `renameSync` either
    // fully replaced the target or did not run — so removing it cannot destroy
    // durable state.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the tmp file is left behind; the caller already has the real error */
    }
    throw err;
  }
}

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
import type { Transition } from "./transitions.ts";

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

export interface RunCounters {
  buildAttempts: number;
  challengeDone: boolean;
  /** The review step has run: `publish` goes to `ci` instead of round-tripping. */
  reviewDone: boolean;
  ciFixUsed: boolean;
  draft: boolean;
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
 * The trailing `:N` of a step key: how many times this state has been entered
 * before this step. A malformed key reads as attempt 0 rather than throwing,
 * because the engine keys its re-run decision on this number and a corrupt
 * key must not turn into a crash inside the resume path.
 */
export function attemptOf(key: string): number {
  const n = Number(key.slice(key.lastIndexOf(":") + 1));
  return Number.isInteger(n) && n >= 0 ? n : 0;
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

/** The next attempt number for a state: one past the highest already logged. */
export function nextAttempt(run: LeanRun, state: LeanState): number {
  let max = -1;
  for (const s of run.steps) if (s.state === state) max = Math.max(max, attemptOf(s.key));
  return max + 1;
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
  // baseSha and branch are required to be STRINGS but may be empty: a phase-1
  // run is created before its ready handler has resolved the mainline sha or
  // cut a branch, and a validator that demanded both would refuse the only
  // shape a first run can legitimately have. Requiring "is a string" still
  // catches the failure that matters — a field nobody ever filled in because
  // the code that fills it was renamed.
  for (const key of ["baseSha", "branch"] as const) {
    if (typeof r[key] !== "string") bad(`${key} must be a string`);
  }
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
      if (typeof oc.kind !== "string") bad(`step ${key} outcome needs a string kind`);
      // `next()` calls `.join` on this when it routes a refusal, so a
      // string-valued `failedRules` is a crash waiting in the report path
      // rather than a cosmetic type slip.
      if (
        oc.failedRules !== undefined &&
        (!Array.isArray(oc.failedRules) || oc.failedRules.some((x) => typeof x !== "string"))
      )
        bad(`step ${key} outcome failedRules must be a string[]`);
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
      ...(oc === undefined ? {} : { outcome: st.outcome as Outcome }),
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

/**
 * Where the step log says the run actually is.
 *
 * `state` and `counters` on a run are a CACHE (see the module header): the
 * append-only `steps` log is the record, and the snapshot is only ever
 * supposed to be what replaying the log through `next()` produces. A
 * hand-edited or truncated file can carry a snapshot that disagrees with its
 * own log — and driving from the snapshot then re-applies an older outcome of
 * the current state, which is how a log ending `ci:1 = red` on a snapshot of
 * `ci` replayed a `ci:0 = green` and merged.
 *
 * Returns `undefined` when the log cannot be replayed at all (an outcome the
 * table has no rule for). It never repairs anything: a caller that gets a
 * disagreement is expected to refuse the run, not to rewrite the file.
 *
 * The fold STARTS at the first logged step's own state rather than assuming
 * `ready`: a run whose very first step ended the run (a `ready` that refused,
 * whose report is the `decline` step) has a log that does not begin at
 * `ready`, and a fold that started there would route `decline`'s outcome from
 * the wrong state and call the honest file a forgery. The key names the state
 * the engine was in when it wrote the step, so the log carries its own start.
 */
export function replay(
  run: LeanRun,
  stepOf: (state: LeanState, counters: RunCounters) => Transition | undefined,
): { state: LeanState; counters: RunCounters } | undefined {
  const log = [...run.steps];
  let state: LeanState = log[0]?.state ?? "ready";
  let counters: RunCounters = { ...INITIAL_COUNTERS };
  // The fold consumes the log in ARRAY order, deliberately. The engine appends
  // one step per entry and never reorders, so array order IS the sequence the
  // run lived through, and it is the only order that keeps a re-entered state
  // honest: `verify:0` and a later `verify:1` are separate events of the walk,
  // and sorting by key would pull the second one in front of the states that
  // only the first one led to. A file whose array was shuffled is therefore
  // not silently re-derived into some other run — the fold simply cannot
  // reproduce the snapshot, and the caller refuses it.
  // One fold per LOG ENTRY, including a step that earned no outcome (the
  // caller makes that one contribute the identity). Folding every entry is
  // what makes the derived position the one the engine itself persisted: the
  // engine writes the file after each step, so its snapshot already counts the
  // step it had just written ahead. Skipping outcome-less steps would leave
  // the fold permanently one step behind and refuse every honest crash
  // recovery as a forgery.
  for (const _ of log) {
    void _;
    try {
      const moved = stepOf(state, counters);
      if (moved === undefined) return undefined;
      state = moved.state;
      counters = moved.counters;
    } catch (err) {
      // The caller's `stepOf` throwing is itself the diagnosis — the fold
      // must not swallow it into a bare "cannot replay".
      throw err instanceof LeanStateError
        ? err
        : new LeanStateError(`replay: ${String((err as Error)?.message ?? err)}`);
    }
  }
  return { state, counters };
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

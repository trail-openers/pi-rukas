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

export const SCHEMA_VERSION = 1;

/** The states a run can sit in. The last three end the run. See machine.ts. */
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
  | "not-ready"
  | "landed"
  | "handed-back";

/** States that end a run — the engine stops here and reports. */
export const TERMINAL_STATES: readonly LeanState[] = ["landed", "handed-back", "not-ready"];

export function isTerminal(state: LeanState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** What a step decided. `kind` is the vocabulary `next()` routes on. */
export type Outcome = { kind: string } & Record<string, unknown>;

export interface Step {
  /** `${issue}:${state}:${n}` — unique per (state, attempt). */
  key: string;
  state: LeanState;
  /** Injected clock, epoch ms. Recorded before the handler runs. */
  startedAt: number;
  endedAt?: number;
  /** Absent means the step started and never finished: re-run it. */
  outcome?: Outcome;
  /**
   * Set when the step's handler reported that the side effect it exists to
   * perform did not land. The step keeps its outcome (the table still routes
   * on it) but the replay rule treats it as an attempt rather than a fact, and
   * re-runs the step once. The distinguishing mark between "this step was
   * attempted and its delivery failed" and "this step happened": both carry an
   * outcome, and only one of them may be trusted as the outside world's state.
   */
  deliveryError?: string;
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
  const run = r as unknown as LeanRun;
  for (const s of run.steps) {
    if (typeof s?.key !== "string" || typeof s?.startedAt !== "number")
      bad("every step needs key and startedAt");
    if (typeof s.state !== "string") bad(`step ${s.key} needs a state`);
    // Keys are the identity the re-run decision is keyed on: two steps
    // sharing one key means the replay path can pick either, so a hand-edited
    // file that duplicated a key must be refused rather than driven.
    if (seenKeys.has(s.key)) bad(`duplicate step key ${JSON.stringify(s.key)}`);
    seenKeys.add(s.key);
    // A step whose `outcome` is not an object would reach the replay path as
    // a step that "has" an outcome, and `next()` would then route on an
    // undefined `kind` — a corrupt file must be refused here rather than
    // become an unlisted-pair handback mid-drive.
    if (
      s.outcome !== undefined &&
      (typeof s.outcome !== "object" || s.outcome === null || Array.isArray(s.outcome))
    )
      bad(`step ${s.key} outcome must be an object`);
    // `deliveryError` is the marker the engine uses to say "attempted, delivery
    // failed, do not trust this outcome as a fact about the forge". A
    // hand-edited value there must not survive into a drive that reads it.
    if (s.deliveryError !== undefined && typeof s.deliveryError !== "string")
      bad(`step ${s.key} deliveryError must be a string`);
    if (s.outcome !== undefined && typeof s.outcome === "object" && !Array.isArray(s.outcome)) {
      const oc = s.outcome as Record<string, unknown>;
      // `unrecoverable` is the engine's own "the retry failed too" stamp, read
      // by the loop to decide whether to ask again. A hand-edited truthy value
      // would silently turn a retryable reporting step into one that never
      // re-posts, so it is the one outcome field this file validates.
      if (oc.unrecoverable !== undefined && typeof oc.unrecoverable !== "boolean")
        bad(`step ${s.key} outcome.unrecoverable must be a boolean`);
    }
    // The `:N` suffix is a derived field (the entry count) and the engine
    // trusts it when deciding whether a state still owes a handler call, so
    // a corrupt suffix is refused rather than read as attempt 0.
    const suffix = s.key.slice(s.key.lastIndexOf(":") + 1);
    if (!/^\d+$/.test(suffix)) bad(`step key ${JSON.stringify(s.key)} needs a numeric :N suffix`);
  }
  return run;
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

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
  const run = r as unknown as LeanRun;
  for (const s of run.steps) {
    if (typeof s?.key !== "string" || typeof s?.startedAt !== "number")
      bad("every step needs key and startedAt");
    if (typeof s.state !== "string") bad(`step ${s.key} needs a state`);
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

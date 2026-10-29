/**
 * Fixtures whose step logs come from REAL runs, never from a hand-written array.
 *
 * `driveRun` runs `runLean` to completion with scripted handlers and returns
 * the saved record. `truncate` then keeps the first k steps of that record and
 * optionally blanks the k-th, which is exactly the bytes a kill leaves at that
 * moment: the engine writes one entry ahead for every visit to a state, so
 * every prefix of a real log is a state file a crashed drive really produced.
 * The snapshot beside it is set to what the fold in `src/lean/resume.ts`
 * derives from that prefix — the position the engine itself persisted — so a
 * fixture cannot accidentally assert against a file no drive could have written.
 *
 * Why not build logs by hand: an array typed from the table is a guess about
 * what a drive writes, and the guess has twice been wrong in this repo (a
 * `build` entry left blank mid-log, a `verify` written for a state the run was
 * never routed into). Both were refused as forgeries by the fold while the case
 * meant to test something else. Deriving the fixture from a real run removes
 * the guess.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { type LeanHandlers, runLean } from "../../src/lean/engine.ts";
import { foldLog } from "../../src/lean/resume.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  type Outcome,
  type Position,
  createRun,
  leanStateDir,
  leanStateFile,
  loadRun,
} from "../../src/lean/state.ts";
import { CLOCK, FIXTURE_BASE_SHA, HAPPY, scripted } from "./lean-engine-fixtures.ts";

/** The run's log, plus the run it came from (for its issue, branch and seed). */
export interface DrivenRun {
  run: LeanRun;
  /** The outcomes each handler returned, in call order — for asserting on. */
  calls: Record<string, number>;
}

/** Drive `issue` to a terminal state with scripted handlers and read it back. */
export async function driveRun(
  dir: string,
  issue: number,
  plan: Partial<Record<LeanState, Outcome[]>> = HAPPY,
  extra: { handlers?: LeanHandlers; maxSteps?: number } = {},
): Promise<DrivenRun> {
  const full: Partial<Record<LeanState, Outcome[]>> = {
    ...structuredClone(HAPPY),
    ...structuredClone(plan),
  };
  const { handlers, calls } = scripted(full);
  for (const [state, handler] of Object.entries(extra.handlers ?? {}))
    handlers[state as LeanState] = handler as LeanHandlers[LeanState];
  // Seed the file the way a first `/work-lean` would, so the drive below is
  // the FIRST drive of this issue. `runLean` on an existing file RESUMES it,
  // and a case that drives one issue several times with different verdicts
  // would otherwise read the previous case's log as its own starting point and
  // report a walk that never happened — here, a red `verify` the fold never
  // saw because the older green one was still on the file.
  writeForged(dir, {
    ...createRun({
      issue,
      version: "test",
      models: {},
      baseSha: FIXTURE_BASE_SHA,
      branch: `feature/issue-${issue}`,
    }),
    result: undefined,
  });
  await runLean({
    repoRoot: dir,
    issue,
    handlers,
    now: () => CLOCK,
    maxSteps: extra.maxSteps,
    seed: {
      version: "test",
      baseSha: FIXTURE_BASE_SHA,
      branch: `feature/issue-${issue}`,
    },
  });
  const run = loadRun(dir, issue);
  if (run === undefined) throw new Error(`driveRun: no state file for issue ${issue}`);
  return { run, calls };
}

/** How the snapshot sits beside a prefix: on the fold, or one step behind it. */
export type SnapshotAt = "log" | "before";

/**
 * A prefix of a REAL run's log, written as a state file.
 *
 * `blankLast` removes the k-th step's outcome — the write-ahead of a step
 * whose handler never answered. `at` chooses the snapshot: `"log"` is the
 * position the fold derives (what the engine persists when it writes an
 * entry), `"before"` is the one-step lag a crash between recording an outcome
 * and applying it leaves behind.
 */
export function writePrefix(
  dir: string,
  source: LeanRun,
  k: number,
  opts: { blankLast?: boolean; at?: SnapshotAt } = {},
): LeanRun {
  const steps = source.steps
    .slice(0, k)
    .map((s, i) =>
      opts.blankLast && i === k - 1
        ? { key: s.key, state: s.state, startedAt: s.startedAt }
        : { ...s },
    );
  const prefix: LeanRun = { ...source, steps };
  // The fold reads the DISPLAYED prefix, so with `blankLast` it stops at the
  // blanked entry and names the state that entry belongs to — which is exactly
  // where the engine stood when it saved the write-ahead. Deriving from
  // `source.steps.slice(0, k)` instead (still decided) would put the snapshot
  // one step AHEAD of the log, and `verifiedPosition` allows a snapshot to lag
  // by one but never to lead: the resume would refuse a file that is the honest
  // bytes of a kill.
  const seed0: LeanRun = { ...source, steps, state: "ready", counters: { ...INITIAL_COUNTERS } };
  const derived = foldOf(seed0);
  const at = opts.at ?? "log";
  const snapshot = at === "before" ? positionBefore(source, k) : derived;
  // `source.result` is the stamp of the COMPLETED drive, and `writePrefix` is
  // usually called on that very record. Carrying it onto a prefix writes a
  // file that reads as "this run is over" and `runLean` returns it verbatim
  // without driving a step — so the prefix under test never runs, and the case
  // passes (or fails) on the source run's verdict rather than its own. A
  // prefix therefore never carries it; only the whole log may, and `seed` is
  // built WITHOUT the field rather than having it removed afterwards.
  const seed: LeanRun = {
    ...source,
    steps,
    state: snapshot.state,
    counters: snapshot.counters,
    ...(at === "log" && source.result !== undefined && k === source.steps.length
      ? { result: source.result }
      : {}),
  };
  mkdirSync(leanStateDir(dir), { recursive: true });
  writeFileSync(leanStateFile(dir, seed.issue), JSON.stringify(seed, null, 2), "utf8");
  return seed;
}

/**
 * The position immediately before the k-th step was applied — the snapshot a
 * crash between writing that outcome and applying it leaves. Derived by
 * folding the first k-1 entries, so it is the fold's own `before`, not a
 * guessed state name.
 */
export function positionBefore(source: LeanRun, k: number): Position {
  return foldOf({ ...source, steps: source.steps.slice(0, k - 1) });
}

/**
 * The same log with one entry mutated, for the forgery cases: each returns the
 * run whose file `writeForged` then writes. `steps` is the ONLY thing a case
 * changes, so the difference between a real prefix and a forged file is the
 * assertion.
 */
export function withSteps(source: LeanRun, steps: LeanRun["steps"]): LeanRun {
  return { ...source, steps };
}

/**
 * Write a run verbatim — snapshot included — for a case about a log that does
 * NOT match its snapshot. Nothing here re-derives the position: the point is
 * that the file is wrong, and the fold must say so.
 */
export function writeForged(dir: string, run: LeanRun): LeanRun {
  mkdirSync(leanStateDir(dir), { recursive: true });
  writeFileSync(leanStateFile(dir, run.issue), JSON.stringify(run, null, 2), "utf8");
  return run;
}

/**
 * The position a log implies, with the snapshot fields taken out of the way.
 *
 * `verifiedPosition`'s fold is pure in the log; the snapshot fields only enter
 * through the judgement. A fixture that wants the position a drive would have
 * persisted therefore asks the fold directly rather than reproducing its
 * arithmetic — which is the arithmetic that this repo's fixtures twice got
 * wrong by hand, and a fixture that guesses here refuses an honest file.
 */
export function foldOf(source: LeanRun): Position {
  return foldLog(source).pos;
}

/**
 * Write a truncation of a real log whose snapshot is what the fold derives for
 * it, and return the file that was written.
 *
 * This is the shape `writePrefix` produces, from a log the caller has already
 * narrowed (to a state's last entry, say) rather than to a count. The snapshot
 * comes from `verifiedPosition`, never from the source run: a completed run's
 * snapshot is its TERMINAL state, and a prefix of its log folds to somewhere
 * earlier — carrying the terminal one would write a file that reads as a
 * forgery when the case is about something else entirely.
 */
export function writeDerivedPrefix(dir: string, source: LeanRun): LeanRun {
  const position = foldOf(source);
  return writeForged(dir, { ...source, state: position.state, counters: position.counters });
}

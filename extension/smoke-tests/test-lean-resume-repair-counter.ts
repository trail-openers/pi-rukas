#!/usr/bin/env bun
/**
 * lean/resume — the fold re-checks the repair round's counter (#2668).
 *
 * `verifiedPosition` reproduces a snapshot by folding the log through the table,
 * and `sameCounters` is what makes that comparison mean anything: a field it does
 * not read is a field a hand-edited file can carry any value of. `repairsSpent`
 * is the one statement that a run's single repair round is spent, so an unchecked
 * one lets a run buy the round a second time by editing its own state file.
 *
 * The log comes from a real drive, and the snapshot beside it from the fold's own
 * derivation, because a hand-typed array is a guess about what a drive writes and
 * this file's claim is about a file a drive really produced. The drive goes through
 * `runLean` with the switch seeded, which is the only way a run reaches `repair` at
 * all: the knob is read once, at creation.
 */

import { runLean } from "../src/lean/engine.ts";
import { foldLog, verifiedPosition } from "../src/lean/resume.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Outcome,
} from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state-store.ts";
import {
  CLOCK,
  FIXTURE_BASE_SHA,
  HAPPY,
  makeAssert,
  scripted,
  tempDir,
} from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const BLOCKED: Outcome = {
  kind: "blocked",
  blockedBy: { "tests/AC1.test.sh": "cannot hold" },
  headBefore: "b".repeat(40),
};

/**
 * Drive one issue through a verified-blocked round and its one repair round.
 *
 * The plan is `HAPPY` with the first build round blocked and the round refusing:
 * a refused round still sends the builder back out, so the run lands and the log
 * holds the decided round that resume has to reproduce.
 */
async function repairedRun(dir: string, issue: number): Promise<LeanRun | undefined> {
  const plan = structuredClone(HAPPY) as Partial<Record<LeanState, Outcome[]>>;
  plan.build = [BLOCKED, { kind: "ok" }, { kind: "ok" }];
  const { handlers } = scripted(plan);
  handlers.repair = async () => ({ kind: "refused", reason: "the round refused to correct it" });
  await runLean({
    repoRoot: dir,
    issue,
    handlers,
    now: () => CLOCK,
    seed: { version: "test", baseSha: FIXTURE_BASE_SHA, branch: `feature/issue-${issue}`, oracleRepair: true },
  });
  return loadRun(dir, issue);
}

/** The rows a drive would have persisted once the round decided. */
function resumeFile(run: LeanRun, drift?: number): LeanRun {
  const at = run.steps.findIndex((s) => s.state === "repair");
  // Cut the log at the round's own verdict and ask the fold where those bytes
  // stand: that is the snapshot the engine would have written, not one typed here.
  const steps = run.steps.slice(0, at + 1);
  const seed = { ...run, steps, state: "ready", counters: { ...INITIAL_COUNTERS } } as LeanRun;
  const { pos } = foldLog(seed, "fold");
  return {
    ...run,
    steps,
    state: pos.state,
    counters: drift === undefined ? pos.counters : { ...pos.counters, repairsSpent: drift },
  };
}

// ── a real drive really spent the round, so there is a counter to check
{
  const { dir, cleanup } = tempDir();
  try {
    const run = await repairedRun(dir, 2670);
    assert(run !== undefined, "the drive left a state file");
    const rounds = run?.steps.filter((s) => s.state === "repair" && s.outcome !== undefined) ?? [];
    assert(rounds.length === 1, `the run holds one decided round (${String(rounds.length)})`);
    assert(
      run?.counters.repairsSpent === 1,
      `and the table billed it (got ${String(run?.counters.repairsSpent)})`,
    );
    assert(
      run?.oracleRepair === true,
      `the drive carried the switch stamp (${String(run?.oracleRepair)})`,
    );
  } finally {
    cleanup();
  }
}

// ── the honest file, whose counter the fold reproduces, resumes
{
  const { dir, cleanup } = tempDir();
  try {
    const run = await repairedRun(dir, 2671);
    if (run === undefined) throw new Error("no state file");
    const honest = resumeFile(run);
    assert(
      honest.counters.repairsSpent === 1,
      `the fold derives the spent round (got ${String(honest.counters.repairsSpent)})`,
    );
    try {
      verifiedPosition(`resume:2671`, honest);
      assert(true, "a log whose round is billed resumes");
    } catch (err) {
      assert(false, `a log whose round is billed resumes (got ${(err as Error).message})`);
    }
  } finally {
    cleanup();
  }
}

// ── a drifted repairsSpent is refused, on either side of the value the log bills
for (const drift of [0, 2]) {
  const { dir, cleanup } = tempDir();
  try {
    const run = await repairedRun(dir, 2672 + drift);
    if (run === undefined) throw new Error("no state file");
    const forged = resumeFile(run, drift);
    let refused = false;
    let message = "";
    try {
      verifiedPosition(`resume:${String(2672 + drift)}`, forged);
    } catch (err) {
      refused = err instanceof LeanStateError;
      message = (err as Error).message;
    }
    assert(
      refused && /snapshot disagrees/.test(message),
      `a snapshot whose repairsSpent drifted to ${drift} is refused (got ${
        refused ? "LeanStateError" : `no refusal at ${forged.state}`
      })`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());

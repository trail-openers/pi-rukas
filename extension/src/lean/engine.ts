/**
 * lean/engine — the runner. Small on purpose: load, loop, save.
 *
 * The invariant everything else rests on: **a step that has an outcome is never re-run.** Resuming
 * finds the step for the current state — with an outcome, apply `next()`; without one, run that
 * one step again. Nothing else replays, so a crash cannot double-bill a build.
 *
 * The engine knows nothing about models, git or the forge, and its only clock is the injected
 * `now`. Handlers are awaited strictly serially; a throw becomes its error outcome in
 * `error-outcome.ts`.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { trace } from "../trace.ts";
import { type CycleBudgetMs, flagBudgetMs } from "../work-driver-deadline.ts";
import { deadlineStopsSteps, leanDeadline } from "./deadline.ts";
import { engineFacts } from "./engine-facts.ts";
import {
  type DeadlineStop,
  type HandbackHandler,
  runHandbackReport,
  stopForDeadline,
} from "./engine-report.ts";
import { errorOutcome } from "./error-outcome.ts";
import { acquireLock } from "./lock.ts";
import { exitCodeFor, hasTransition, next } from "./machine.ts";
import { verifiedPosition } from "./resume.ts";
import {
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Outcome,
  type Step,
  createRun,
  isTerminal,
  leanStateFile,
  loadRun,
  newestDecided,
  nextAttempt,
  saveRun,
  stepKey,
} from "./state.ts";

/** Everything a handler may look at. Nothing more — handlers take their args from here. */
export interface HandlerCtx {
  repoRoot: string;
  issue: number;
  /**
   * The log as of BEFORE this step ran, so a handler can read what earlier steps decided. It
   * survives a crash. Handlers must not mutate it.
   */
  run: LeanRun;
  /** The same array as `run.steps`, named for the reporting handlers that take it under this name. */
  steps: Step[];
  /** The step being executed, already written ahead with its startedAt. */
  stepKey: string;
  /** The injected clock. The only way a handler sees time. */
  now: () => number;
}

export type LeanHandler = (ctx: HandlerCtx) => Promise<Outcome>;

/** One handler per non-terminal state; a missing handler ends the run handed-back. */
export type LeanHandlers = Partial<Record<LeanState, LeanHandler>>;

export interface RunLeanOpts {
  repoRoot: string;
  issue: number;
  handlers: LeanHandlers;
  /** Injected clock; the engine's only clock. */
  now?: () => number;
  /** Fields a brand-new run starts with; ignored when a state file exists. */
  seed?: Partial<Pick<LeanRun, "version" | "models" | "baseSha" | "branch">>;
  /** Safety net for a table that loops on a bug of its own. Never a feature. */
  maxSteps?: number;
  /**
   * The caller's whole-cycle arm as a DURATION resolved to an epoch once (`flagBudgetMs`): the
   * lean verb's `--timeout <minutes>`. `PI_ENSEMBLE_CYCLE_DEADLINE` and
   * `PI_ENSEMBLE_CYCLE_BUDGET_MS` both outrank it.
   */
  budgetMs?: CycleBudgetMs;
}

export interface RunLeanResult {
  run: LeanRun;
  /** 0 landed, 10 handed-back, 11 not-ready. */
  code: number;
  state: LeanState;
}

/** ~10 transitions is the longest legal path; each leaves room for one re-run. */
const DEFAULT_MAX_STEPS = 100;

/**
 * A first run: `ready`, plus whatever the caller already knows.
 *
 * The issue number and seed base sha are validated here because `createRun` does not consult
 * `assertRun` for a run it just built — this is the only place a hand-built seed is judged.
 * `""` (no mainline found) passes without the shape check.
 */
function newRun(opts: RunLeanOpts): LeanRun {
  if (!Number.isInteger(opts.issue) || opts.issue <= 0)
    throw new LeanStateError(`runLean: issue ${String(opts.issue)} must be a positive integer`);
  const baseSha = opts.seed?.baseSha ?? "";
  if (baseSha !== "" && !isFullCommitSha(baseSha))
    throw new LeanStateError(
      `runLean: seed baseSha must be empty or a full commit sha (got ${JSON.stringify(baseSha.slice(0, 80))})`,
    );
  return createRun({
    issue: opts.issue,
    version: opts.seed?.version ?? "unknown",
    models: { ...(opts.seed?.models ?? {}) },
    baseSha,
    branch: opts.seed?.branch ?? "",
  });
}

interface Drive {
  repoRoot: string;
  save: (run: LeanRun) => void;
  /** The resolved deadline, so each boundary reads one value. */
  deadlineMs?: number;
}

/** Stamp the terminal result and persist — the only place `result` is written. */
function endRun(drive: Drive, run: LeanRun, state: LeanState, reason: string): LeanRun {
  const done: LeanRun = { ...run, state, result: { code: exitCodeFor(state), reason } };
  drive.save(done);
  return done;
}

/** `endRun` in the shape `runLean` returns, for a gate that stops a resumed run. */
function ended(drive: Drive, run: LeanRun, state: LeanState, reason: string): RunLeanResult {
  const done = endRun(drive, run, state, reason);
  return { run: done, code: done.result?.code ?? exitCodeFor(state), state };
}

/** Attach an outcome to one step, leaving the others alone. */
function withOutcome(run: LeanRun, key: string, outcome: Outcome, endedAt: number): LeanRun {
  return {
    ...run,
    steps: run.steps.map((s) => (s.key === key ? { ...s, endedAt, outcome } : s)),
  };
}

/**
 * Copy `ready`'s three run-level fields off its verdict and onto the run.
 *
 * Field by field, and only on `ready`: each is owned by that step's verdict (see
 * `OWNER_OF_FIELD`), and a step that cannot own a field on the record cannot put
 * it there either. A resumed run re-runs `ready` before anything else, so the
 * fields are re-established from the same source on every entry — the record is
 * never the only place they were ever written, except for `derivedSpec`, which is
 * precisely why it is written here.
 */
function applyReadyFacts(run: LeanRun, outcome: Outcome): LeanRun {
  return {
    ...run,
    ...(outcome.config === undefined ? {} : { config: outcome.config }),
    ...(outcome.baseSha === undefined || run.baseSha !== ""
      ? {}
      : { baseSha: outcome.baseSha }),
    ...(outcome.derivedSpec === undefined ? {} : { derivedSpec: outcome.derivedSpec }),
  };
}

/**
 * Has this run earned the merge? The newest DECIDED `verify` AND `ci` both green, and no `draft`
 * left standing. Rules live in `engine-facts.ts`, shared with the stamp check.
 */
const landEarned = engineFacts.landEarned;

/** The reason the record gives for refusing the merge, for the handback line. */
const landRefusal = engineFacts.landRefusal;

/** Why a stamped `result` is not the answer its own step log gives, or `undefined` when it is. */
const stampedResultRefusal = engineFacts.stampedResultRefusal;

/**
 * Apply the table, then enforce the two arrival rules a (state, kind) pair cannot express:
 * `land` is entered by `ci` + `green` and nothing else, and only by a run whose OWN record
 * currently says green — the merge is the irreversible act, so the gate sits on the arrival.
 */
function apply(drive: Drive, run: LeanRun, outcome: Outcome): LeanRun {
  const moved = next(run, outcome);
  if (moved.state === "land") {
    if (!(run.state === "ci" && outcome.kind === "green")) {
      return endRun(
        drive,
        run,
        "handed-back",
        `illegal arrival at land from ${run.state} + ${JSON.stringify(outcome.kind)}`,
      );
    }
    // Asking the log even though this outcome is green by construction is what makes the gate
    // a reading of the record rather than a restatement of the pair.
    if (!landEarned(run)) return endRun(drive, run, "handed-back", landRefusal(run));
  }
  const advanced: LeanRun = { ...run, state: moved.state, counters: moved.counters };
  if (isTerminal(advanced.state)) {
    // `advanced`, not `run`: the step that carried the run here is on the log only in that copy.
    return endRun(
      drive,
      advanced,
      advanced.state,
      engineFacts.reasonFor(advanced.state, outcome, advanced.steps),
    );
  }
  drive.save(advanced);
  return advanced;
}

/** Run one handler, record its outcome (or its throw), save once. */
async function settle(
  drive: Drive,
  opts: RunLeanOpts,
  run: LeanRun,
  key: string,
  state: LeanState,
  now: () => number,
): Promise<LeanRun> {
  const handler = opts.handlers[state] as LeanHandler;
  let outcome: Outcome;
  try {
    outcome = await handler({
      repoRoot: opts.repoRoot,
      issue: opts.issue,
      // The handler sees the caller's copy: what a handler reads is "the log before this visit".
      run,
      steps: run.steps,
      stepKey: key,
      now,
    });
  } catch (err) {
    outcome = errorOutcome(state, err);
  }
  const logged = withOutcome(run, key, outcome, now());
  // `ready` is the one step whose verdict has to land on the RUN and not only on
  // its step record: `config` is what later steps execute under, `baseSha` is the
  // commit that config was read at, and `derivedSpec` is the only copy of a
  // contract that exists on no issue. Without this the run would carry its own
  // settings to the steps that need them and the process would die holding them.
  const withFacts = key === "ready" ? applyReadyFacts(logged, outcome) : logged;
  if (outcome.kind === "error") {
    drive.save(withFacts);
    return endRun(
      drive,
      withFacts,
      "handed-back",
      `handler error at ${state}: ${String(outcome.message ?? "")}`,
    );
  }
  // An outcome the table does not list is a handler bug, whatever the state.
  if (!hasTransition(state, outcome.kind)) {
    drive.save(withFacts);
    return endRun(
      drive,
      withFacts,
      "handed-back",
      `no transition for ${state} + ${JSON.stringify(outcome.kind)}`,
    );
  }
  return apply(drive, withFacts, outcome);
}

/**
 * Drive a run to a terminal state. A handler that throws does NOT retry: the step records
 * `{kind: "error", message}` and the run ends `handed-back`.
 */
export async function runLean(opts: RunLeanOpts): Promise<RunLeanResult> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const release = acquireLock(opts.repoRoot, opts.issue);
  try {
    const file = leanStateFile(opts.repoRoot, opts.issue);
    const loaded = loadRun(opts.repoRoot, opts.issue);
    // The drive carries the deadline once, so every boundary reads one value.
    const drive: Drive = {
      repoRoot: opts.repoRoot,
      save: (run) => saveRun(opts.repoRoot, run),
      deadlineMs: loaded?.deadlineMs,
    };
    let run: LeanRun;
    if (loaded === undefined) {
      run = newRun(opts);
    } else {
      // Drive from the DERIVED position, never the snapshot.
      const position = verifiedPosition(file, loaded);
      run = { ...loaded, state: position.state, counters: position.counters };
      const derivedState = position.state;
      if (run.result !== undefined) {
        // A second `/work-lean` on a finished issue. The verbatim return is only for a record
        // whose result its OWN log earned: `result` is a cache, not the record.
        const refusal = stampedResultRefusal(file, derivedState, run);
        if (refusal !== undefined) throw new LeanStateError(refusal);
        return { run, code: run.result.code, state: run.state };
      }
      if (run.state === "land" && !landEarned(run))
        // The fold reached `land` through `next()`, the edge check, not the arrival check.
        return ended(drive, run, "handed-back", landRefusal(run));
      if (run.state === "landed" && !landEarned(run))
        // Otherwise a record could assert its own merge by writing the step that says so.
        return ended(drive, run, "handed-back", landRefusal(run));
    }
    return await driveLoop(drive, opts, run, now, maxSteps);
  } finally {
    release();
  }
}

async function driveLoop(
  drive: Drive,
  opts: RunLeanOpts,
  initial: LeanRun,
  now: () => number,
  maxSteps: number,
): Promise<RunLeanResult> {
  let iterations = 0;
  // The loop's current position, not the parameter: biome's noParameterAssign forbids reassigning.
  let run = initial;

  while (run.result === undefined) {
    if (++iterations > maxSteps) {
      run = endRun(drive, run, "handed-back", `step cap ${maxSteps} reached at ${run.state}`);
      break;
    }
    const state = run.state;
    // Resolved BEFORE the handler test below so a run the clock stops says so in its own words
    // rather than in `no handler for state …`.
    const deadline =
      drive.deadlineMs ?? leanDeadline(run.deadlineMs, now(), flagBudgetMs(opts.budgetMs));
    if (deadline !== undefined && deadline !== run.deadlineMs) {
      run = { ...run, deadlineMs: deadline };
      drive.save(run);
    }
    if (deadline !== undefined && deadlineStopsSteps(deadline, now(), state)) {
      // One call decides and performs the whole stop; `stopForDeadline`'s jsdoc is the contract.
      // This side of the seam must not start WORK here: `endRun` ends the loop.
      run = await stopForDeadline({
        end: (r, reason) => endRun(drive, r, "handed-back", reason),
        request: {
          repoRoot: opts.repoRoot,
          issue: opts.issue,
          handler: opts.handlers.handback as HandbackHandler | undefined,
          keyFor: (state, n) => stepKey(opts.issue, state, n),
          attach: withOutcome,
        },
        run,
        stoppedAt: state,
        deadline,
        now,
      });
      break;
    }
    if (!opts.handlers[state]) {
      // Every state the table routes through has a handler, so this is a state nobody built.
      run = endRun(drive, run, "handed-back", `no handler for state ${state}`);
      break;
    }

    const pending = run.steps.find((s) => s.state === state && s.outcome === undefined);
    if (pending) {
      // Crash mid-step: same key, same startedAt, so the re-run is visibly the same step.
      run = await settle(drive, opts, run, pending.key, state, now);
      continue;
    }

    // No "already decided, apply it" branch: the position the loop drives from is DERIVED by
    // folding the log, which consumes one entry per visit.
    run = await startStep(drive, opts, run, state, now);
  }

  return { run, code: run.result?.code ?? exitCodeFor(run.state), state: run.state };
}

/** Write one step ahead and run it: the half of the loop's body that touches the record. */
async function startStep(
  drive: Drive,
  opts: RunLeanOpts,
  run: LeanRun,
  state: LeanState,
  now: () => number,
): Promise<LeanRun> {
  const key = stepKey(opts.issue, state, nextAttempt(run, state));
  // Write-ahead BEFORE the handler runs: a process that dies here leaves a step with no outcome,
  // which is the "re-run this one" signal.
  const started = { ...run, steps: [...run.steps, { key, state, startedAt: now() }] };
  drive.save(started);
  // A line at each boundary: a step can sit inside one model call for twenty minutes. Stderr,
  // because stdout is the JSON stream in `-p` mode.
  trace(`lean #${opts.issue} ${key} start`);
  const done = await settle(drive, opts, started, key, state, now);
  const verdict = newestDecided(done.steps, state)?.outcome?.kind ?? "undecided";
  trace(`lean #${opts.issue} ${key} end: ${verdict}`);
  return done;
}

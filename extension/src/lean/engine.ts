/**
 * lean/engine — the runner. Small on purpose: load, loop, save.
 *
 * The invariant everything else rests on: **a step that has an outcome is never re-run.** The
 * step log is the record, so resuming a run means finding the step for the current state — if it
 * exists with an outcome, apply `next()`; if it exists without one (the process died between the
 * write-ahead and the outcome), run that one step again. Nothing else replays, so a crash cannot
 * double-bill a build or re-post a comment.
 *
 * The engine knows nothing about models, git or the forge — those live in the handlers. The
 * engine's only clock is the injected `now`, so a test can advance time without waiting for it.
 *
 * Handler calls are awaited strictly serially — one at a time, each settled before the next state
 * is considered, because a step's outcome is what its log line claims actually happened. A throw
 * becomes its error outcome in `error-outcome.ts`, where a throw's dispatch rows join the record.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { trace } from "../trace.ts";
import { type CycleBudgetMs, flagBudgetMs } from "../work-driver-deadline.ts";
import { deadlineStopShouldReport } from "./deadline-handback.ts";
import {
  deadlineReason,
  deadlineStopsSteps,
  handoffAllowanceMs,
  leanDeadline,
} from "./deadline.ts";
import { engineFacts } from "./engine-facts.ts";
import { reportBoundSentence } from "./engine-report-bound.ts";
import { type HandbackHandler, runHandbackReport } from "./engine-report.ts";
import { errorOutcome } from "./error-outcome.ts";
import { leanReportBoundEnabled } from "./handback-report-bound-switch.ts";
import { acquireLock } from "./lock.ts";
import { exitCodeFor, hasTransition, next } from "./machine.ts";
import { verifiedPosition } from "./resume.ts";
import { type RoutedReport, routeHandbackReport } from "./routed-report.ts";
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
   * The log as of BEFORE this step ran, so a handler can read what earlier steps decided. The log
   * is what handlers are given: it is what the resume checks derive from and it survives a crash.
   * Handlers must not mutate it.
   */
  run: LeanRun;
  /**
   * The same array as `run.steps`, named separately because the handlers that need it need only
   * it. Reading a verdict out of the log rather than a closure is the difference between a resumed
   * run that reproduces what the crashed one decided and one that reports "never ran".
   */
  steps: Step[];
  /** The step being executed, already written ahead with its startedAt. */
  stepKey: string;
  /** The injected clock. The only way a handler sees time. */
  now: () => number;
}

export type LeanHandler = (ctx: HandlerCtx) => Promise<Outcome>;

/** One handler per non-terminal state. A missing handler ends the run handed-back. */
export type LeanHandlers = Partial<Record<LeanState, LeanHandler>>;

export interface RunLeanOpts {
  repoRoot: string;
  issue: number;
  handlers: LeanHandlers;
  /** Injected clock. Default `Date.now`, and the engine's only clock. */
  now?: () => number;
  /**
   * Fields a brand-new run starts with. Ignored when a state file exists, so the seed is where a
   * run-start fact belongs: a resumed run keeps what its first round recorded.
   */
  seed?: Partial<Pick<LeanRun, "version" | "models" | "baseSha" | "branch">>;
  /** Safety net for a table that loops on a bug of its own. Never a feature. */
  maxSteps?: number;
  /**
   * The caller's whole-cycle arm, as a DURATION the shared reader resolves to an epoch once
   * (`flagBudgetMs`): the lean verb's `--timeout <minutes>`, threaded as a value rather than
   * written to `process.env`. `PI_ENSEMBLE_CYCLE_DEADLINE` and `PI_ENSEMBLE_CYCLE_BUDGET_MS` both
   * outrank it, and a resumed run keeps the arm its first round persisted.
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
 * The issue number is validated here rather than left to `loadRun`. A run is addressed by
 * `<repoRoot>/.pi/lean-state/<issue>.json`, so a number the file system cannot round-trip writes
 * a file whose `issue` does not parse back, and a completed run then refuses to load. `assertRun`
 * already refuses that shape on the read path; this is the same rule on the write path.
 *
 * The seed's base is validated on the same principle: `createRun` does not consult `assertRun` for
 * a run it just built, so this is the ONLY place a hand-built seed is judged. `""` (no mainline
 * found) is legitimate and the one value passing without the shape check.
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

/** Persist a run at the root the current drive was started with. */
interface Drive {
  repoRoot: string;
  save: (run: LeanRun) => void;
  /** The resolved deadline, kept on the drive so each boundary reads one value. */
  deadlineMs?: number;
}

/** Stamp the terminal result and persist. The only place `result` is written. */
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

/** Attach an outcome to one step without disturbing any other. */
function withOutcome(run: LeanRun, key: string, outcome: Outcome, endedAt: number): LeanRun {
  return {
    ...run,
    steps: run.steps.map((s) => (s.key === key ? { ...s, endedAt, outcome } : s)),
  };
}

/**
 * Has this run earned the merge? Its own record must currently say so: the newest DECIDED `verify`
 * AND the newest DECIDED `ci` both green, and no `draft` marker left standing. Two readers call
 * it: `apply()` on the ARRIVAL (the irreversible act), and `runLean` when a resumed run's DERIVED
 * state is already `land` — the fold reached it through `next()`, never through `apply()`.
 */
const landEarned = engineFacts.landEarned;

/** The reason the record gives for refusing the merge, for the handback line. */
const landRefusal = engineFacts.landRefusal;

/**
 * Why a stamped `result` is not the answer its own step log gives, or `undefined` when it is. The
 * rules are `engine-facts.ts`'s, so the stamp is judged by the same gate the arrival is.
 */
const stampedResultRefusal = engineFacts.stampedResultRefusal;

/**
 * Apply the table, then enforce the two arrival rules a (state, kind) pair cannot express:
 *
 * 1. `land` is entered by `ci` + `green` and nothing else.
 * 2. `land` is entered only by a run whose OWN record currently says green. The pair check cannot
 *    say this — the replay path re-applies a recorded `ci:green` without asking what the log before
 *    it recorded — and the merge is the irreversible act, so the gate sits on the arrival.
 *
 * The exhaustive pair enumeration and the reachability walk in `test-lean-machine.ts` are the
 * offline halves of the same guarantee.
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
    // `lastCi` is the outcome `next()` just routed on, so it is green by construction here —
    // asking the log anyway is what makes the gate a reading of the record rather than a
    // restatement of the pair.
    if (!landEarned(run)) return endRun(drive, run, "handed-back", landRefusal(run));
  }
  const advanced: LeanRun = { ...run, state: moved.state, counters: moved.counters };
  // Every terminal state, `not-ready` included, is the end of the road and stamps immediately.
  // The step that reports a refusal is `decline`, a state like any other.
  if (isTerminal(advanced.state)) {
    // `advanced`, not `run`: the step that just carried the run here is on the log only in the
    // advanced copy, and the reason for a failed report is read from the verdict step beside it.
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

/**
 * Route a deadline-stopped run into its report: run the reporting step for real, then end the run with
 * its verdict. The full contract — why the visit needs `resume.ts`'s one fold exemption, and why the
 * report's verdict must not be written onto the gate entry the clock left unanswered — is
 * `engine-report.ts`'s jsdoc; this is the runner's seam into it, and the pair it returns (the ended
 * run and the bound that cut it) is `routed-report.ts`'s. The handler table is the runner's to consult,
 * so the decision to route is taken entirely here: a run with no reporting step built cannot be routed,
 * and the caller stamps it plainly. The three helpers the report needs to write a step are passed in so
 * their definitions stay private to the runner, and the bound on its wall is read here for the same
 * reason: `handoffAllowanceMs()` is the number the stop test one boundary earlier compared against.
 */
async function reportRun(
  drive: Drive,
  opts: RunLeanOpts,
  run: LeanRun,
  stoppedAt: LeanState,
  now: () => number,
): Promise<RoutedReport> {
  const handler = opts.handlers.handback as HandbackHandler | undefined;
  if (handler === undefined) return { run: undefined, boundMs: undefined };
  // `undefined` is the switch's off arm: the handler is awaited and nothing else, as before #2269.
  const boundMs = leanReportBoundEnabled() ? handoffAllowanceMs() : undefined;
  return routeHandbackReport(
    {
      repoRoot: opts.repoRoot,
      issue: opts.issue,
      run,
      stoppedAt,
      now,
      handler,
      boundMs,
      keyFor: (state, n) => stepKey(opts.issue, state, n),
      attach: withOutcome,
      finish: (r, state, reason) => endRun(drive, r, state, reason),
    },
    runHandbackReport,
  );
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
      run,
      steps: run.steps,
      stepKey: key,
      now,
    });
  } catch (err) {
    outcome = errorOutcome(state, err);
  }
  const logged = withOutcome(run, key, outcome, now());
  if (outcome.kind === "error") {
    drive.save(logged);
    return endRun(
      drive,
      logged,
      "handed-back",
      `handler error at ${state}: ${String(outcome.message ?? "")}`,
    );
  }
  // An outcome the table does not list is a handler bug, whatever the state. Nothing intercepts
  // any kind: a failed post is a routed outcome with its own arrow, not a step the engine re-drives.
  if (!hasTransition(state, outcome.kind)) {
    drive.save(logged);
    return endRun(
      drive,
      logged,
      "handed-back",
      `no transition for ${state} + ${JSON.stringify(outcome.kind)}`,
    );
  }
  return apply(drive, logged, outcome);
}

/**
 * Drive a run to a terminal state.
 *
 * A handler that throws does NOT retry: the step records `{kind: "error", message}` and the run
 * ends `handed-back`. Retrying a handler that threw would loop a run whose handler is broken.
 */
export async function runLean(opts: RunLeanOpts): Promise<RunLeanResult> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const release = acquireLock(opts.repoRoot, opts.issue);
  try {
    const file = leanStateFile(opts.repoRoot, opts.issue);
    const loaded = loadRun(opts.repoRoot, opts.issue);
    // The drive carries the deadline once, so every boundary reads the same value the first one
    // resolved (a budget resolved twice would restart the clock and never park). The record is the
    // only caller-side source: a resume must keep the arm its first round wrote there.
    const drive: Drive = {
      repoRoot: opts.repoRoot,
      save: (run) => saveRun(opts.repoRoot, run),
      deadlineMs: loaded?.deadlineMs,
    };
    let run: LeanRun;
    if (loaded === undefined) {
      run = newRun(opts);
    } else {
      // Drive from the DERIVED position, never the snapshot: `verifiedPosition` refuses a file whose
      // log does not fold to its snapshot and returns the position the log implies.
      const position = verifiedPosition(file, loaded);
      run = { ...loaded, state: position.state, counters: position.counters };
      const derivedState = position.state;
      if (run.result !== undefined) {
        // The log folds to a terminal state and the record already carries its result — a second
        // `/work-lean` on a finished issue. Nothing runs and nothing is written.
        //
        // The verbatim return is only for a record whose result its OWN log earned: `result` is a
        // cache like `state` and `counters`, so a stamp that grants a merge the fold refused must
        // not win by being read first.
        const refusal = stampedResultRefusal(file, derivedState, run);
        if (refusal !== undefined) throw new LeanStateError(refusal);
        return { run, code: run.result.code, state: run.state };
      }
      if (run.state === "land" && !landEarned(run))
        // The fold reached `land` through `next()`, which is the edge check, not the arrival check.
        return ended(drive, run, "handed-back", landRefusal(run));
      if (run.state === "landed" && !landEarned(run))
        // The log's newest step is `land + merged`, so `apply()` never saw this outcome. Both shapes
        // must be refused, or a record could assert its own merge by writing the step that says so.
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
  // The loop's current position, not the parameter: biome's noParameterAssign forbids reassigning
  // `initial`, and each step below returns a whole new run.
  let run = initial;

  while (run.result === undefined) {
    if (++iterations > maxSteps) {
      run = endRun(drive, run, "handed-back", `step cap ${maxSteps} reached at ${run.state}`);
      break;
    }
    const state = run.state;
    // The caller's deadline, resolved once and carried on the drive. Resolved BEFORE the handler
    // test below so a run the clock stops says so in its own words rather than in
    // `no handler for state …`, which blames a missing step for what a clock decided.
    //
    // `flagBudgetMs` re-derives the value rather than taking a cast at the call site: `budgetMs` is
    // branded, and this is the one place the flag becomes an arm.
    const deadline =
      drive.deadlineMs ?? leanDeadline(run.deadlineMs, now(), flagBudgetMs(opts.budgetMs));
    if (deadline !== undefined && deadline !== run.deadlineMs) {
      run = { ...run, deadlineMs: deadline };
      drive.save(run);
    }
    if (deadline !== undefined && deadlineStopsSteps(deadline, now(), state)) {
      // The clock stopped a WORKING step. Most such runs have nothing further to
      // say and are stamped where they stand, as they always were — but a run whose
      // newest work step is a `fixed` review is holding origin over bytes no gate
      // certified, and the step that says so (and moves origin back) is `handback`.
      // Stamping here made that step unreachable, so the run is routed to the report
      // rather than ended. The predicate reads the same log the reporting step reads,
      // so the two cannot disagree about the shape.
      if (state !== "handback" && deadlineStopShouldReport(run.steps)) {
        // The report runs, and the record it leaves is one the engine's own loader can still open.
        // The fold consequence of writing that record — why `resume.ts` needs its one exemption, and why
        // a loader refusal there outranks the bug this branch fixes — is `isReportRoute`'s jsdoc in
        // `resume.ts`; this is the runner's side of that seam and the shape it has to keep producing.
        //
        // So the routing runs the report through the handler, exactly as `runLean`'s crash-resume path
        // would, and lands its verdict on the run through `endRun` — the writer every terminal stamp
        // already uses — rather than through `apply()` on an entry the table never routed. The rewind,
        // the head fields and the comment therefore run on the shape they were written for. The log
        // keeps the entry the loop wrote ahead for the refused step: the run DID enter the
        // re-verification and came back with no answer, which is the honest record and the premise
        // `handback-heads.ts` acts on — which is why the verdict is not written onto that entry.
        //
        // Nothing past this line starts WORK: the only handler reached is the reporting one, which the
        // stop test exempts; `state !== "handback"` keeps this from re-firing, and `endRun` ends the
        // loop, so there is no path back into the walk. Every other stop takes the stamp below, exactly
        // as it did before the routing existed.
        const routed = await reportRun(drive, opts, run, state, now);
        if (routed.run === undefined) {
          // The report could not be run at all, or could not be run IN TIME. Either way the run
          // is stamped where it stands, as it always was — and when the bound is what stopped
          // it, the stamp says so (`routed-report.ts` says why the bound travels with the run).
          run = endRun(
            drive,
            run,
            "handed-back",
            deadlineReason(
              run.steps,
              state,
              deadline,
              routed.boundMs === undefined ? undefined : reportBoundSentence(routed.boundMs),
            ),
          );
          break;
        }
        run = routed.run;
        break;
      }
      run = endRun(drive, run, "handed-back", deadlineReason(run.steps, state, deadline));
      break;
    }
    if (!opts.handlers[state]) {
      // Every state the table routes through has a handler and every state without one is terminal,
      // so this is the engine's one way to stop on a state nobody built.
      run = endRun(drive, run, "handed-back", `no handler for state ${state}`);
      break;
    }

    const pending = run.steps.find((s) => s.state === state && s.outcome === undefined);
    if (pending) {
      // Crash mid-step: same key, same startedAt, so the re-run is visibly the same step and not a
      // second one.
      run = await settle(drive, opts, run, pending.key, state, now);
      continue;
    }

    // There is deliberately no "this entry already decided something, apply it" branch here: the
    // position the loop drives from is DERIVED by folding the log (`verifiedPosition`), which
    // consumes one entry per visit, so the loop never stands in a state whose entry it has already
    // consumed.
    run = await startStep(drive, opts, run, state, now);
  }

  return { run, code: run.result?.code ?? exitCodeFor(run.state), state: run.state };
}

/**
 * Write one step ahead and run it: the half of the loop's body that touches the record.
 */
async function startStep(
  drive: Drive,
  opts: RunLeanOpts,
  run: LeanRun,
  state: LeanState,
  now: () => number,
): Promise<LeanRun> {
  const key = stepKey(opts.issue, state, nextAttempt(run, state));
  // Write-ahead BEFORE the handler runs: a process that dies here leaves a step with no outcome,
  // which is exactly the "re-run this one" signal.
  const started = { ...run, steps: [...run.steps, { key, state, startedAt: now() }] };
  drive.save(started);
  // A line at each boundary: a lean run drives a model per step and can sit inside one for twenty
  // minutes, and without both an operator watching stderr cannot tell a working step from a hung
  // one. Stderr, gated like every other trace line, because stdout is the JSON stream in `-p` mode.
  trace(`lean #${opts.issue} ${key} start`);
  const done = await settle(drive, opts, started, key, state, now);
  const verdict = newestDecided(done.steps, state)?.outcome?.kind ?? "undecided";
  trace(`lean #${opts.issue} ${key} end: ${verdict}`);
  return done;
}

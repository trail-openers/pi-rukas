/**
 * lean/engine — the runner. Small on purpose: load, loop, save.
 *
 * The invariant everything else rests on: **a step that has an outcome is
 * never re-run.** The step log is the record, so resuming a run means finding
 * the step for the current state — if it exists with an outcome, apply
 * `next()`; if it exists without one (the process died between the write-ahead
 * and the outcome), run that one step again. Nothing else replays, so a crash
 * cannot double-bill a build or re-post a comment.
 *
 * The engine knows nothing about models, git or the forge. Those live in the
 * handlers, which later phases plug in. The engine's only clock is the injected
 * `now`, so a test can advance time without waiting for it.
 *
 * Handler calls are awaited strictly serially — one at a time, each settled
 * before the next state is considered. Nothing is fired and forgotten, because
 * a step's outcome is what its log line claims actually happened. A throw
 * becomes its error outcome in `error-outcome.ts`, where a throw's dispatch rows
 * join the record.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { trace } from "../trace.ts";
import { type CycleBudgetMs, flagBudgetMs } from "../work-driver-deadline.ts";
import { deadlineReason, deadlineStopsSteps, leanDeadline } from "./deadline.ts";
import { engineFacts } from "./engine-facts.ts";
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
   * The log as of BEFORE this step ran, so a handler can read what earlier
   * steps decided. `steps` is the run's append-only record, and the snapshot
   * fields beside it are a cache — which is why the log is what handlers are
   * given: it is the thing the resume checks are derived from, and it survives
   * a crash. Handlers must not mutate it.
   */
  run: LeanRun;
  /**
   * The same array as `run.steps`, named separately because the handlers that
   * need it need only it. A handler reading a verdict out of the log rather
   * than out of a closure is the difference between a resumed run that
   * reproduces what the crashed one decided and one that reports "never ran".
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
   * Fields a brand-new run starts with. Ignored when a state file exists, so
   * the seed is where a run-start fact belongs: a resumed run keeps what its
   * first round recorded (a base sha re-resolved on resume would be a
   * different commit than the one the run was cut against).
   */
  seed?: Partial<Pick<LeanRun, "version" | "models" | "baseSha" | "branch">>;
  /** Safety net for a table that loops on a bug of its own. Never a feature. */
  maxSteps?: number;
  /**
   * The caller's whole-cycle arm, as a DURATION the shared reader resolves to an
   * epoch once (`flagBudgetMs`): the lean verb's `--timeout <minutes>`, threaded
   * as a value rather than written to `process.env`. One run's budget therefore
   * never becomes the next dispatch's deadline, and the environment stays the
   * host's input rather than something this process writes.
   *
   * `PI_ENSEMBLE_CYCLE_DEADLINE` and `PI_ENSEMBLE_CYCLE_BUDGET_MS` both outrank
   * it, and a resumed run keeps the arm its first round persisted on the record.
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
 * The issue number is validated here rather than left to `loadRun`. A run is
 * addressed by `<repoRoot>/.pi/lean-state/<issue>.json`, so a number the file
 * system cannot round-trip — `NaN`, `1.5`, `-5` — writes a file whose `issue`
 * no longer parses back to the value passed in, and the run that completed
 * successfully then refuses to load. `assertRun` already refuses exactly that
 * shape on the read path; this is the same rule on the write path, so a caller
 * cannot bypass its own validator simply by starting a run.
 *
 * The seed's base is validated on the same principle: `createRun` does not
 * consult `assertRun` for a run it just built, so the ONLY place a hand-built
 * seed is judged is here. A caller that passed `"main"` — or a typo'd oid —
 * would otherwise write a record that loads green, because `assertRun` accepts
 * `""` (a seed that found no mainline is legitimate) and would have accepted
 * anything else too. `""` is therefore the one value that passes without the
 * shape check; any other value must be a full lowercase oid, which is the same
 * rule the loader enforces on the read path.
 *
 * Split out of `engine.ts` at AGENTS.md §12's line cap: a run's START facts (its
 * issue number and its seed) are validated here while the runner stays the runner.
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
 * Has this run earned the merge? Its own record must currently say so: the
 * newest DECIDED `verify` AND the newest DECIDED `ci` both green, and no
 * `draft` marker left standing. `ci`'s green is what the table routes on and
 * `verify`'s is what the run's own gate said — a recorded `ci:green` read
 * over a later red verify is the shape that used to walk into the merge.
 *
 * Two readers call this. `apply()` asks it on the ARRIVAL, which is the
 * irreversible act; and `runLean` asks it when a resumed run's DERIVED state
 * is already `land`, because the fold reached that state through `next()` and
 * never through `apply()` — so without the second call a file that forged the
 * arrival would run the merge handler on load.
 */
function landEarned(run: LeanRun): boolean {
  return engineFacts.landEarned(run);
}

/** The reason the record gives for refusing the merge, for the handback line. */
function landRefusal(run: LeanRun): string {
  return engineFacts.landRefusal(run);
}

/**
 * Apply the table, then enforce the two arrival rules a (state, kind) pair
 * cannot express.
 *
 * 1. `land` is entered by `ci` + `green` and nothing else — fires only on a
 *    future edit that opens a second edge.
 * 2. `land` is entered only by a run whose OWN record currently says green.
 *    The pair check cannot say this: `ci` + `green` is a legal arrival for a
 *    run whose last `verify` said red, because the outcomes arrive through
 *    the step log, and the replay path re-applies a recorded `ci:green`
 *    without asking what the log before it recorded. The merge is the
 *    irreversible act, so the gate sits on the arrival rather than on the
 *    edge: the newest DECIDED `verify` step and the newest DECIDED `ci`
 *    step must both carry green, and the run must not still carry the draft
 *    marker its gate raised.
 *
 * The exhaustive pair enumeration and the reachability walk in
 * `test-lean-machine.ts` are the offline halves of the same guarantee.
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
    // `lastCi` is the outcome `next()` just routed on, so it is green by
    // construction here — asking the log anyway is what makes the gate a
    // reading of the record rather than a restatement of the pair.
    if (!landEarned(run)) return endRun(drive, run, "handed-back", landRefusal(run));
  }
  const advanced: LeanRun = { ...run, state: moved.state, counters: moved.counters };
  // Every terminal state, `not-ready` included, is the end of the road and
  // stamps immediately. Nothing here needs an exception: the step that reports
  // a refusal is `decline`, a state like any other, and by the time the run
  // arrives at `not-ready` that step has carried its outcome.
  if (isTerminal(advanced.state)) {
    // `advanced`, not `run`: the step that just carried the run here is on the
    // log only in the advanced copy, and the reason for a failed report is read
    // from the verdict step that sits beside it.
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
 * Why a stamped `result` is not the answer its own step log gives, or
 * `undefined` when it is. The rules are `engine-facts.ts`'s; this is the call
 * that feeds it the engine's own `landEarned`, so the stamp is judged by the
 * same gate the arrival is.
 */
function stampedResultRefusal(
  file: string,
  derivedState: LeanState,
  run: LeanRun,
): string | undefined {
  return engineFacts.stampedResultRefusal(file, derivedState, run, landEarned);
}

/**
 * Run one handler, record its outcome (or its throw), save once.
 */
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
  // An outcome the table does not list is a handler bug, whatever the state —
  // including `decline + report-failed`'s opposite number, a stray `done` from
  // a state that does not declare one. Nothing intercepts any kind: a failed
  // post is a routed outcome with its own arrow, not a step the engine
  // re-drives.
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
 * A handler that throws does NOT retry: the step records
 * `{kind: "error", message}` and the run ends `handed-back`. Retrying a
 * handler that threw would loop a run whose handler is broken, which is the
 * failure mode this engine exists to make impossible.
 */
export async function runLean(opts: RunLeanOpts): Promise<RunLeanResult> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const release = acquireLock(opts.repoRoot, opts.issue);
  try {
    const file = leanStateFile(opts.repoRoot, opts.issue);
    const loaded = loadRun(opts.repoRoot, opts.issue);
    // The drive carries the deadline once, so every boundary reads the same
    // value the first one resolved (a budget resolved twice would restart the
    // clock and never park — `readCycleDeadline`'s own reason for persisting).
    // The record is the only caller-side source: a second entry point would be
    // a second clock for one run, and a resume must keep the arm its first round
    // wrote there, not whatever a fresh caller passes.
    const drive: Drive = {
      repoRoot: opts.repoRoot,
      save: (run) => saveRun(opts.repoRoot, run),
      deadlineMs: loaded?.deadlineMs,
    };
    let run: LeanRun;
    if (loaded === undefined) {
      run = newRun(opts);
    } else {
      // Drive from the DERIVED position, never the snapshot. `verifiedPosition`
      // refuses a file whose log does not fold to its snapshot and returns the
      // position the log implies; taking `state`/`counters` off `loaded` as
      // well would drive the run from the cache the check exists to displace.
      const position = verifiedPosition(file, loaded);
      run = { ...loaded, state: position.state, counters: position.counters };
      const derivedState = position.state;
      if (run.result !== undefined) {
        // The log folds to a terminal state and the record already carries its
        // result — a second `/work-lean` on a finished issue. Nothing runs and
        // nothing is written: the file is the answer. (A fold that reached a
        // terminal state with NO result is the crash-after-the-final-step
        // shape, and `driveLoop` ends it below, which is what stamps it.)
        //
        // The verbatim return is only for a record whose result its OWN log
        // earned. `result` is a cache like `state` and `counters`, and before
        // this check a file whose log folded to `landed` while its counters
        // still carried `draft` and whose hand-written `result.code` was 0
        // reported success: the fold had refused the merge, the stamp had
        // granted it, and the stamp won because it was read first. So the
        // stamp is judged against the derived position on the same three
        // rules `endRun` writes: terminal, code matches the state, and a
        // `landed` state whose land gate actually holds.
        const refusal = engineFacts.stampedResultRefusal(file, derivedState, run, landEarned);
        if (refusal !== undefined) throw new LeanStateError(refusal);
        return { run, code: run.result.code, state: run.state };
      }
      if (run.state === "land" && !landEarned(run))
        // The fold reached `land` by applying the log's outcomes through
        // `next()`, which is the edge check and not the arrival check.
        return ended(drive, run, "handed-back", landRefusal(run));
      if (run.state === "landed" && !landEarned(run))
        // The log's newest step is `land + merged`, so the fold is already
        // past the arrival and `apply()` never saw this outcome. Both shapes
        // have to be refused: the one where the merge is still owed, and the
        // one where a file claims it happened. Without this second branch a
        // record could assert its own merge by writing the step that says so.
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
  // The loop's current position, not the parameter: biome's noParameterAssign
  // forbids reassigning `initial`, and each step below returns a whole new run.
  let run = initial;

  while (run.result === undefined) {
    if (++iterations > maxSteps) {
      run = endRun(drive, run, "handed-back", `step cap ${maxSteps} reached at ${run.state}`);
      break;
    }
    const state = run.state;
    // The caller's deadline, resolved once and carried on the drive (#1920
    // item 2). Resolved BEFORE the handler test below so a run that the clock
    // stops says so in its own words rather than in `no handler for state …`,
    // which blames a missing step for what a clock decided.
    //
    // `flagBudgetMs` re-derives the value rather than taking a cast at the call
    // site: `RunLeanOpts.budgetMs` is branded, and `runWorkLean` — the only
    // production caller — mints the brand from the verb's parsed `--timeout`
    // minutes here, so the one place the flag becomes an arm is the one place
    // the reader consumes it.
    const deadline =
      drive.deadlineMs ?? leanDeadline(run.deadlineMs, now(), flagBudgetMs(opts.budgetMs));
    if (deadline !== undefined && deadline !== run.deadlineMs) {
      run = { ...run, deadlineMs: deadline };
      drive.save(run);
    }
    if (deadline !== undefined && deadlineStopsSteps(deadline, now(), state)) {
      run = endRun(drive, run, "handed-back", deadlineReason(run.steps, state, deadline));
      break;
    }
    if (!opts.handlers[state]) {
      // Every state the table routes through has a handler, and every state
      // without one is terminal, so this is the engine's one way to stop on a
      // state nobody built. No state is exempt: the step that reports a refusal
      // is `decline` and the caller gives it a handler.
      run = endRun(drive, run, "handed-back", `no handler for state ${state}`);
      break;
    }

    const pending = run.steps.find((s) => s.state === state && s.outcome === undefined);
    if (pending) {
      // Crash mid-step: same key, same startedAt (the record of when it
      // began), so the re-run is visibly the same step and not a second one.
      run = await settle(drive, opts, run, pending.key, state, now);
      continue;
    }

    // There is deliberately no "this entry already decided something, apply it
    // instead of running" branch here. The position the loop drives from is
    // DERIVED by folding the log (`verifiedPosition`), and that fold consumes one
    // entry per visit, so the state the loop stands in is always one whose entry
    // it has not yet consumed: there is never a decided step of the current state
    // to re-apply. The branch that used to do this is what made "log entry
    // missing" a shape a real drive could produce, and with it the exemptions the
    // fold needed to tolerate that shape.
    run = await startStep(drive, opts, run, state, now);
  }

  return { run, code: run.result?.code ?? exitCodeFor(run.state), state: run.state };
}

/**
 * Write one step ahead and run it: the half of the loop's body that touches the
 * record, split out at §12's line cap so the loop above stays the loop.
 */
async function startStep(
  drive: Drive,
  opts: RunLeanOpts,
  run: LeanRun,
  state: LeanState,
  now: () => number,
): Promise<LeanRun> {
  const key = stepKey(opts.issue, state, nextAttempt(run, state));
  // Write-ahead BEFORE the handler runs: a process that dies here leaves a step
  // with no outcome, which is exactly the "re-run this one" signal.
  const started = { ...run, steps: [...run.steps, { key, state, startedAt: now() }] };
  drive.save(started);
  // A line at each boundary: a lean run drives a model per step and can sit
  // inside one for twenty minutes, and without both an operator watching stderr
  // cannot tell a step that is working from one that is hung. Stderr, gated
  // like every other trace line, because stdout is the JSON stream in `-p` mode.
  trace(`lean #${opts.issue} ${key} start`);
  const done = await settle(drive, opts, started, key, state, now);
  const verdict = newestDecided(done.steps, state)?.outcome?.kind ?? "undecided";
  trace(`lean #${opts.issue} ${key} end: ${verdict}`);
  return done;
}

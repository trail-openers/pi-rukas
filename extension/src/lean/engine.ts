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
 * a step's outcome is what its log line claims actually happened.
 */

import { exitCodeFor, hasTransition, next } from "./machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  type Outcome,
  attemptOf,
  isTerminal,
  loadRun,
  nextAttempt,
  saveRun,
  stepKey,
} from "./state.ts";

/** Everything a handler may look at. Nothing more — handlers take their args from here. */
export interface HandlerCtx {
  repoRoot: string;
  issue: number;
  /** The run as of before this step ran. Handlers must not mutate it. */
  run: LeanRun;
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
  /** Fields a brand-new run starts with. Ignored when a state file exists. */
  seed?: Partial<Pick<LeanRun, "version" | "models" | "baseSha" | "branch">>;
  /** Safety net for a table that loops on a bug of its own. Never a feature. */
  maxSteps?: number;
}

export interface RunLeanResult {
  run: LeanRun;
  /** 0 landed, 10 handed-back, 11 not-ready. */
  code: number;
  state: LeanState;
}

/** ~10 transitions is the longest legal path; each leaves room for one re-run. */
const DEFAULT_MAX_STEPS = 100;

/** Why a run ended where it did — for the result record and the summary line. */
function reasonFor(state: LeanState, outcome: Outcome | undefined): string {
  if (state === "landed") return "merged";
  const rules = outcome?.failedRules;
  if (Array.isArray(rules) && rules.length > 0) return (rules as unknown[]).join("; ");
  if (outcome && typeof outcome.reason === "string") return outcome.reason;
  if (outcome && typeof outcome.message === "string") return outcome.message;
  return `ended at ${state}`;
}

/** A first run: `ready`, plus whatever the caller already knows. */
function newRun(opts: RunLeanOpts): LeanRun {
  return {
    schema: 1,
    issue: opts.issue,
    version: opts.seed?.version ?? "unknown",
    models: { ...(opts.seed?.models ?? {}) },
    baseSha: opts.seed?.baseSha ?? "",
    branch: opts.seed?.branch ?? "",
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps: [],
  };
}

/** Persist a run at the root the current drive was started with. */
interface Drive {
  repoRoot: string;
  save: (run: LeanRun) => void;
}

/** Stamp the terminal result and persist. The only place `result` is written. */
function endRun(drive: Drive, run: LeanRun, state: LeanState, reason: string): LeanRun {
  const done: LeanRun = { ...run, state, result: { code: exitCodeFor(state), reason } };
  drive.save(done);
  return done;
}

/** Attach an outcome to one step without disturbing any other. */
function withOutcome(run: LeanRun, key: string, outcome: Outcome, endedAt: number): LeanRun {
  return {
    ...run,
    steps: run.steps.map((s) => (s.key === key ? { ...s, endedAt, outcome } : s)),
  };
}

/**
 * Apply the table, then enforce the one arrival rule a (state, kind) pair
 * cannot express: `land` is entered by `ci` + `green` and nothing else. Every
 * transition in the table that names `land` as its destination IS that pair,
 * so this fires only on a future edit that opens a second edge — and it fires
 * before anything can merge, which is the only thing the rule is for. The
 * exhaustive pair enumeration and the reachability walk in
 * `test-lean-machine.ts` are the offline halves of the same guarantee.
 */
function apply(drive: Drive, run: LeanRun, outcome: Outcome): LeanRun {
  const moved = next(run, outcome);
  if (moved.state === "land" && !(run.state === "ci" && outcome.kind === "green")) {
    return endRun(
      drive,
      run,
      "handed-back",
      `illegal arrival at land from ${run.state} + ${JSON.stringify(outcome.kind)}`,
    );
  }
  const advanced: LeanRun = { ...run, state: moved.state, counters: moved.counters };
  if (isTerminal(advanced.state))
    return endRun(drive, advanced, advanced.state, reasonFor(advanced.state, outcome));
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
    outcome = await handler({ repoRoot: opts.repoRoot, issue: opts.issue, run, stepKey: key, now });
  } catch (err) {
    outcome = { kind: "error", message: (err as Error)?.message ?? String(err) };
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
  const drive: Drive = { repoRoot: opts.repoRoot, save: (run) => saveRun(opts.repoRoot, run) };
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  let run = loadRun(opts.repoRoot, opts.issue) ?? newRun(opts);
  let iterations = 0;

  while (!isTerminal(run.state)) {
    if (++iterations > maxSteps) {
      run = endRun(drive, run, "handed-back", `step cap ${maxSteps} reached at ${run.state}`);
      break;
    }
    const state = run.state;
    if (!opts.handlers[state]) {
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

    // "A step that has an outcome is never re-run" is scoped to the PATH the
    // run is on, which is the number of times this state has already been
    // ENTERED — not merely to the state's name. Reusing the first `verify:0`
    // outcome after a build round came back would re-apply a verdict from a
    // tree that no longer exists, and would let a run whose second verify was
    // never actually re-run reach `land` on a green it observed before the
    // red. Same attempt number means the same step, and only that step is
    // re-run after a crash.
    const entries = run.steps.filter((s) => s.state === state).length;
    const completed = run.steps.find(
      (s) => s.state === state && s.outcome !== undefined && attemptOf(s.key) === entries - 1,
    );
    if (completed?.outcome) {
      // Completed on this entry: never re-run. Apply the table and move on.
      run = apply(drive, run, completed.outcome);
      continue;
    }

    const key = stepKey(opts.issue, state, nextAttempt(run, state));
    // Write-ahead BEFORE the handler runs: a process that dies here leaves a
    // step with no outcome, which is exactly the "re-run this one" signal.
    const started = { ...run, steps: [...run.steps, { key, state, startedAt: now() }] };
    drive.save(started);
    run = await settle(drive, opts, started, key, state, now);
  }

  return { run, code: run.result?.code ?? exitCodeFor(run.state), state: run.state };
}

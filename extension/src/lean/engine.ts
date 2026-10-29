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

import { REPORT_FAILED_KIND, exitCodeFor, hasTransition, next } from "./machine.ts";
import {
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Outcome,
  type Step,
  attemptOfStrict,
  createRun,
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

/** The rules the most recent verdict recorded, for a report that could not deliver them. */
function lastFailedRules(steps: Step[]): unknown[] | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const rules = steps[i]?.outcome?.failedRules;
    if (Array.isArray(rules) && rules.length > 0) return rules as unknown[];
  }
  return undefined;
}

/** Why a run ended where it did — for the result record and the summary line. */
function reasonFor(state: LeanState, outcome: Outcome | undefined, steps: Step[] = []): string {
  if (state === "landed") return "merged";
  const rules = outcome?.failedRules;
  if (Array.isArray(rules) && rules.length > 0) return (rules as unknown[]).join("; ");
  // A refusal reaches here as the outcome of its REPORTING step, which carries
  // the rules it posted (or failed to post) — `ready`'s and `specify`'s own
  // outcomes live in the log, so they are read back from there rather than
  // copied onto the run. One fact, two readers: the rules alone for a comment
  // that went out, and the rules plus the delivery failure for one that did
  // not, so a summary line never reads as a clean verdict somebody was told.
  if (state === "not-ready") {
    const judged = lastFailedRules(steps);
    if (Array.isArray(judged) && judged.length > 0) {
      const joined = (judged as unknown[]).join("; ");
      const failure =
        outcome?.kind === REPORT_FAILED_KIND
          ? String(outcome.reason ?? outcome.message ?? "report did not land")
          : undefined;
      return failure === undefined ? joined : `${joined}: ${failure}`;
    }
  }
  if (outcome && typeof outcome.reason === "string") return outcome.reason;
  if (outcome && typeof outcome.message === "string") return outcome.message;
  return `ended at ${state}`;
}

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
 */
function newRun(opts: RunLeanOpts): LeanRun {
  if (!Number.isInteger(opts.issue) || opts.issue <= 0)
    throw new LeanStateError(`runLean: issue ${String(opts.issue)} must be a positive integer`);
  return createRun({
    issue: opts.issue,
    version: opts.seed?.version ?? "unknown",
    models: { ...(opts.seed?.models ?? {}) },
    baseSha: opts.seed?.baseSha ?? "",
    branch: opts.seed?.branch ?? "",
  });
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
 * Apply the table, then enforce the two arrival rules a (state, kind) pair
 * cannot express.
 *
 * 1. `land` is entered by `ci` + `green` and nothing else — fires only on a
 *    future edit that opens a second edge.
 * 2. `land` is entered only by a run whose OWN gate currently says green.
 *    The pair check cannot say this: `ci` + `green` is a legal arrival for a
 *    run whose last `verify` said red, because the outcomes arrive through
 *    the step log, and the replay path re-applies a recorded `ci:green`
 *    without asking what the log before it recorded. The merge is the
 *    irreversible act, so the gate sits on the arrival rather than on the
 *    edge: the newest `verify` step must carry a green outcome and the run
 *    must not still carry the draft marker its gate raised.
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
    const lastVerify = [...run.steps].reverse().find((s) => s.state === "verify");
    if (run.counters.draft || lastVerify?.outcome?.kind !== "green") {
      return endRun(
        drive,
        run,
        "handed-back",
        `land refused: verify not green (draft=${run.counters.draft}, last verify=${
          lastVerify?.outcome?.kind ?? "none"
        })`,
      );
    }
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
      reasonFor(advanced.state, outcome, advanced.steps),
    );
  }
  drive.save(advanced);
  return advanced;
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
  const drive: Drive = { repoRoot: opts.repoRoot, save: (run) => saveRun(opts.repoRoot, run) };
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  let run = loadRun(opts.repoRoot, opts.issue) ?? newRun(opts);
  let iterations = 0;

  while (run.result === undefined) {
    if (++iterations > maxSteps) {
      run = endRun(drive, run, "handed-back", `step cap ${maxSteps} reached at ${run.state}`);
      break;
    }
    const state = run.state;
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

    // "A step that has an outcome is never re-run" is scoped to the PATH the
    // run is on, which is the number of times this state has already been
    // ENTERED — not merely to the state's name. Reusing the first `verify:0`
    // outcome after a build round came back would re-apply a verdict from a
    // tree that no longer exists, and would let a run whose second verify was
    // never actually re-run reach `land` on a green it observed before the
    // red. Same attempt number means the same step, and only that step is
    // re-run after a crash.
    const entries = run.steps.filter((s) => s.state === state).length;
    // A step whose key cannot be read as an attempt number is refused by
    // `loadRun`, so it reaches here only from an in-memory run. Treating it
    // as attempt 0 would let such a key collide with the state's real first
    // step and replay a verdict the run never earned — so no attempt number
    // means no replay: the state is entered again instead.
    const completed = run.steps.find(
      (s) => s.state === state && s.outcome !== undefined && attemptOfStrict(s.key) === entries - 1,
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

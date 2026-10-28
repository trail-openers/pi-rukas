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

/**
 * The outcome the reporting step returns when its side effect did not land.
 *
 * The table has no `fail` arrow out of `not-ready`: the run is already refused
 * by `ready + fail`, so a posting failure must not route it to `handback` (that
 * would relabel a spec refusal, exit 11, as a driver fault, exit 10). What the
 * kind expresses is not "where to go" but "this step did not accomplish its
 * side effect" — and what the engine does with it is keep the step unrecorded
 * so the next drive performs the post again. A handler that returned `done`
 * after a failed post would be logging a comment it never sent.
 */
export const REPORT_FAILED = "report-failed";

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
function reasonFor(state: LeanState, outcome: Outcome | undefined, steps: Step[] = []): string {
  if (state === "landed") return "merged";
  // A reporting step that could not deliver carries the reason on its marker
  // instead of an outcome, so the rules it was meant to send never reach the
  // run. Surfacing only the rules here would read as a clean verdict whose
  // operator had been told — the whole difference between a finding somebody
  // can act on and one that sat unread in a state file.
  const undelivered = steps
    .filter((s) => s.state === state && s.deliveryError !== undefined)
    .map((s) => s.deliveryError);
  const rules = outcome?.failedRules;
  if (Array.isArray(rules) && rules.length > 0) {
    const joined = (rules as unknown[]).join("; ");
    return undelivered.length > 0
      ? `${joined} (comment not posted: ${undelivered.join("; ")})`
      : joined;
  }
  if (undelivered.length > 0 && state === "not-ready") return undelivered.join("; ");
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
 * The rules the reporting step was meant to deliver, recovered from the verdict
 * step that sent the run here.
 *
 * They live on `ready`'s outcome rather than copied onto the reporting step:
 * one record, two readers. The final reason line needs them (a comment that
 * never posted must still say what the run refused), and reading them back from
 * the step that decided it is the only way this stays one fact rather than two
 * that can drift.
 */
function judgedRules(run: LeanRun, state: LeanState): unknown[] | undefined {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const rules = run.steps[i]?.outcome?.failedRules;
    if (Array.isArray(rules) && rules.length > 0) return rules as unknown[];
  }
  return state === "not-ready" ? ["the run was refused and no rule was recorded"] : undefined;
}

/**
 * Mark a step whose handler reported that its side effect never landed.
 *
 * `outcome` is deliberately `undefined` for such a step: the replay rule reads
 * a missing outcome as "still owed", which is the only way a step that already
 * ran can be run again without a second key for the same entry. `deliveryError`
 * is what distinguishes it from a process that died mid-step — both re-run, and
 * only one of them has a reason on the record.
 */
function withDeliveryError(run: LeanRun, key: string, message: string): LeanRun {
  return {
    ...run,
    steps: run.steps.map((s) =>
      s.key === key ? { ...s, outcome: undefined, deliveryError: message } : s,
    ),
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
  // `not-ready` reached from `ready + fail` is the run's VERDICT, and the
  // `not-ready` step still has to report it. Stamping the result here would
  // end the run before the comment naming the failed rules was ever posted, so
  // that state is saved un-stamped and the loop runs its handler; every other
  // terminal state is the end of the road and stamps immediately.
  if (isTerminal(advanced.state) && advanced.state !== "not-ready")
    return endRun(drive, advanced, advanced.state, reasonFor(advanced.state, outcome));
  if (advanced.state === "not-ready" && run.result !== undefined) {
    // A re-drive onto a verdict already recorded reports once and stops: the
    // step log has its own guard, and this is the one that stops a second
    // reporting step being appended every `/work-lean` on a finished issue.
    return run;
  }
  drive.save(advanced);
  return advanced;
}

/**
 * Run one handler, record its outcome (or its throw), save once.
 *
 * `notReadyReported` is the loop's stop condition for the reporting state. It
 * is read rather than returned, because `not-ready` IS terminal: a handler that
 * reports from inside a terminal state cannot also un-terminal the run, and
 * `settle` has no way to say "stay here and try again" through its return type.
 */
async function settle(
  drive: Drive,
  opts: RunLeanOpts,
  run: LeanRun,
  key: string,
  state: LeanState,
  now: () => number,
  notReadyReported: { value: boolean },
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
  // A reporting step whose side effect did not land is intercepted BEFORE the
  // table is consulted, and before its outcome is recorded. Both halves of that
  // order matter. `not-ready` declares only `done`, because no arrow out of a
  // terminal state can carry "the post failed" — routing it would mean asking
  // whether a spec refusal (11) should become a driver fault (10), which it
  // must not. And recording the outcome first would memoize the very claim the
  // step failed to deliver: the run would read as "the comment was posted".
  //
  // Restricted to the reporting state, so no other handler can use this to
  // decline a verdict it owes: `ready + fail` is the run's answer and the table
  // must route it. A `report-failed` from anywhere else is what it looks like —
  // a handler bug — and falls through to the unlisted-pair handback below.
  if (outcome.kind === REPORT_FAILED && state === "not-ready") {
    const reason = String(outcome.reason ?? outcome.message ?? "report did not land");
    const prior = run.steps.find((s) => s.key === key);
    const retried = prior?.deliveryError !== undefined;
    // The step is left WITHOUT an outcome — the record the replay rule reads as
    // "this one still owes its work" — and carries the reason instead, so a
    // reader of the file can tell a failed report from a killed process. The
    // run stays at `not-ready` and keeps exit 11: the spec refused it whether or
    // not the forge took the comment.
    const marked = withDeliveryError(run, key, reason);
    drive.save(marked);
    if (!retried) {
      // Stay in the loop: the run has no result, so the pass below finds this
      // step by its marker and calls the handler again.
      // One retry offered, not more: a second drive whose post also failed has
      // established that retrying is not what is wrong, and a run that cannot
      // report itself should say so once rather than re-post on every
      // `/work-lean` until the forge comes back.
      notReadyReported.value = true;
      return marked;
    }
    return endRun(
      drive,
      marked,
      state,
      reasonFor(state, { kind: "fail", failedRules: judgedRules(run, state) }, marked.steps),
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
  // Set by `settle` when the reporting step failed to post and the loop owes it
  // another go. Only a step the CURRENT drive started may ask for that: a step
  // written by a process that has since died was never seen reporting by this
  // one, so the pass that finds it re-runs it without the flag having to be set
  // first — which is what keeps a crash between "mark the step" and "stamp the
  // result" recoverable instead of a permanent stall on an empty loop.
  const reporting = { value: false };
  // Which step this drive started, per state. `settle` is told about it through
  // this map rather than through a return channel, because the state it settles
  // is terminal and a handler there cannot both report and un-terminal the run.
  const startedHere = new Map<LeanState, string>();

  // The condition is `state`, not `result`: `not-ready` is terminal and its
  // reporting step still owes a post, so a plain `!isTerminal` test would leave
  // the run sitting on an unstamped verdict with no comment on the issue.
  while (run.result === undefined) {
    if (reporting.value) {
      // The reporting step's post did not land. Continue rather than break: the
      // step carries no outcome, so the pass below re-runs exactly that step
      // under its own key. `iterations` still counts the pass, so a handler that
      // never reports cannot spin here — the step cap ends the run.
      reporting.value = false;
      continue;
    }
    if (++iterations > maxSteps) {
      run = endRun(drive, run, "handed-back", `step cap ${maxSteps} reached at ${run.state}`);
      break;
    }
    const state = run.state;
    if (!opts.handlers[state]) {
      // `not-ready` is the one state whose handler is optional: it is a REPORT,
      // not a gate, and the run was already refused by `ready + fail` whether or
      // not anything posts a comment. Turning a spec refusal (11) into a driver
      // fault (10) because a caller has no forge — a test, a future non-forge
      // entry point — would report the harness as broken for a finding that is
      // the whole point of the run.
      if (state !== "not-ready") {
        run = endRun(drive, run, "handed-back", `no handler for state ${state}`);
        break;
      }
      run = endRun(
        drive,
        run,
        state,
        reasonFor(state, { kind: "fail", failedRules: judgedRules(run, state) }, run.steps),
      );
      break;
    }

    const pending = run.steps.find(
      (s) =>
        s.state === state &&
        s.outcome === undefined &&
        (s.deliveryError === undefined || startedHere.get(state) !== s.key),
    );
    if (pending) {
      // Crash mid-step: same key, same startedAt (the record of when it
      // began), so the re-run is visibly the same step and not a second one.
      // A step the reporting branch left marked is NOT re-run by this path:
      // it finished, and its marker says what its outcome means.
      run = await settle(drive, opts, run, pending.key, state, now, reporting);
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
    //
    // A step the reporting branch left marked (`outcome.kind === "fail"` with
    // a delivery error) is excluded for the same reason it is excluded from
    // `pending` above: its recorded outcome says the side effect did NOT
    // happen, so replaying it as truth would be a second lie.
    const completed = run.steps.find(
      (s) =>
        s.state === state &&
        s.outcome !== undefined &&
        attemptOfStrict(s.key) === entries - 1 &&
        // A step whose handler reported that its side effect did not land is
        // not a completed step in the sense this rule means: its recorded
        // outcome describes an attempt, not something the outside world
        // received. Replaying it would re-assert the very claim the marker
        // says failed — which is how "the comment could not be posted" came to
        // read as "the comment was posted". The reporting step re-runs instead.
        !(s.outcome.kind === "fail" && s.deliveryError !== undefined),
    );
    if (completed?.outcome) {
      // Completed on this entry: never re-run. Apply the table and move on.
      run = apply(drive, run, completed.outcome);
      continue;
    }

    const key = stepKey(opts.issue, state, nextAttempt(run, state));
    // A step already on record for this entry whose outcome was withheld by the
    // reporting branch is re-run under ITS OWN key, not a new one: a second
    // key for one entry would make the entry count, and therefore the replay
    // rule above, depend on how many times a flaky network happened to fail.
    const marked = run.steps.find(
      (s) =>
        s.state === state &&
        s.outcome === undefined &&
        s.deliveryError !== undefined &&
        attemptOfStrict(s.key) === entries - 1,
    );
    if (marked) {
      // Re-run the SAME step: a second key for one entry would make the entry
      // count, and so the replay rule above, depend on how many times a flaky
      // network happened to fail.
      startedHere.set(state, marked.key);
      const reposted = await settle(drive, opts, run, marked.key, state, now, reporting);
      // A step left marked by a process that has since died was never seen
      // reporting by this drive, so its handler re-runs once and this drive
      // owns the outcome. When it still cannot report, the run ends at its own
      // verdict with the failure on the record: leaving `result` unset here
      // would exit the loop with nothing stamped, and a later drive would find
      // the same marked step and ask the forge the same question forever.
      run =
        reposted.result === undefined && reposted.state === state
          ? endRun(
              drive,
              reposted,
              state,
              reasonFor(
                state,
                { kind: "fail", failedRules: judgedRules(reposted, state) },
                reposted.steps,
              ),
            )
          : reposted;
      continue;
    }
    // Write-ahead BEFORE the handler runs: a process that dies here leaves a
    // step with no outcome, which is exactly the "re-run this one" signal.
    const started = { ...run, steps: [...run.steps, { key, state, startedAt: now() }] };
    drive.save(started);
    startedHere.set(state, key);
    run = await settle(drive, opts, started, key, state, now, reporting);
  }

  return { run, code: run.result?.code ?? exitCodeFor(run.state), state: run.state };
}

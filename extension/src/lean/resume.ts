/**
 * lean/resume — deriving where a run actually is, from its step log.
 *
 * The engine loads a run and drives it. The run's `state` and `counters` are a
 * CACHE by state.ts's own contract ("not trusted as truth; `steps` is the
 * record"), and this module is what makes that sentence mean something: it
 * folds the append-only log through the transition table and refuses a file
 * whose snapshot the fold cannot reproduce. It lives beside the engine rather
 * than inside it because the two check different things — the engine drives a
 * run, this decides whether a file may be driven at all — and the check is
 * pure, so it is testable without a handler in sight.
 *
 * Split out of engine.ts for the 500-line cap (AGENTS.md §12); the split is
 * also the reason `replay` in state.ts takes a `stepOf` callback: the fold
 * policy is here, the mechanics of walking a log are there.
 */

import { hasTransition, next } from "./machine.ts";
import {
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Outcome,
  type RunCounters,
  type Step,
  replay,
} from "./state.ts";

/**
 * The position the step log implies, refusing a run whose snapshot disagrees.
 *
 * Each fold consumes the log's next entry in the ORDER IT WAS WRITTEN (see
 * `replay` in state.ts). A step's outcome is read from that entry, which is
 * what picks the right attempt of a state the run entered twice — and a step
 * that earned no outcome holds the position without moving it, because the
 * engine is about to re-run exactly that step. That is what lets a genuine
 * mid-step crash replay to the snapshot its writer persisted instead of
 * reading as a forgery.
 *
 * `runLean` used to drive from `loadRun(...).state` alone — a CACHE by the
 * module's own contract. A file whose newest `ci` step was `red` but whose
 * snapshot still said `ci` replayed the older `ci:green` and merged, because
 * the replay path applies recorded outcomes without running their handlers.
 * So: derive the position by folding the log through the table, and refuse
 * the file rather than repair it. A snapshot nobody wrote deliberately is a
 * file to be looked at, not silently rewritten.
 */
export function verifiedPosition(
  file: string,
  run: LeanRun,
): { state: LeanState; counters: RunCounters } {
  const log = [...run.steps];
  // A step left on disk WITHOUT an outcome is a resume, not a replay: the
  // engine re-runs exactly that step, so the snapshot the writer persisted
  // already counts it and there is nothing to derive. Anything after such a
  // step cannot be folded at all (the run never reached it), so the fold only
  // ever sees a log of completed steps.
  if (log.some((s) => s.outcome === undefined)) return { state: run.state, counters: run.counters };
  const halted = haltedStep(run, log);
  if (halted !== undefined && run.result === undefined)
    throw new LeanStateError(
      `${file}: snapshot disagrees with the step log (step ${halted.key} carries the outcome a drive halts on, but the run claims it is still running)`,
    );
  // A run the drive ENDED is always folded WHOLE: its last step is the
  // routable step that carried it into the terminal state
  // (`land + merged` -> `landed`, `handback + done` -> `handed-back`). Only a
  // run the engine HALTED on an unroutable outcome — a thrown handler or a
  // kind the table has no arrow for — has a step nobody routed, and only that
  // one is dropped from the fold (`settle` records it and ends the run
  // itself, so the snapshot sits one arrow past what the fold can derive).
  const foldable = halted === undefined || !run.result ? log : log.slice(0, log.length - 1);
  // A build attempt is spent when the run ENTERS build, so a log that holds a
  // build verdict but no outcome for the step that entered build (a re-entry
  // earned by a red verify or a red CI) still has to charge the round.
  let owedBuilds = 0;
  let fold = 0;
  const why = (m: string): never => {
    throw new LeanStateError(`${file}: snapshot disagrees with the step log (${m})`);
  };
  const derived = replay({ ...run, steps: foldable }, (state, counters) => {
    // The fold walks the log in the order it was WRITTEN (see `replay`), so
    // the entry it is on is the step itself.
    const step = foldable[fold];
    fold++;
    // The fold runs once per entry, so an absent step means the log was
    // mutated underneath it — a refusal, not a position.
    if (step === undefined)
      return why(`fold ${fold} walked past the end of a ${foldable.length}-step log`);
    // The fold walks the log in write order (see `replay`), so the entry it is
    // on must be the step the walk owes: the state the fold currently stands
    // in, and the attempt number that state's earlier entries already used.
    // A file whose array was shuffled, spliced or renumbered describes no walk
    // through the table, and is refused rather than re-derived into a run
    // nobody drove.
    // THE FORGERY SIGNAL. A step must belong to the state the walk currently
    // stands in: every step a real drive wrote was written while the run stood
    // there, so a step from anywhere else names a verdict for a state the run
    // was never in. The dangerous file is the one that dropped the LATER step
    // of the current state (a red `ci:1`) so an earlier `ci:0 = green` sits at
    // the end and the snapshot resumes by replaying it into the merge — and
    // the walk arrives at that position one state behind, exactly where the
    // forgery is. The exemptions are the states that can stand at the moment
    // the next step is written without an arrow out of them having been
    // itemised: `build` (entered by `verify + red` / `ci + red`, whose entering
    // step is left outcome-less on a re-entry), `verify` (entered by
    // `build + ok`, which bills the round) and `challenge` (the mirror case).
    // No other jump has an explanation, so it is refused rather than
    // re-derived — which is what keeps `land` unreachable from a red verdict.
    if (state !== step.state) {
      // The walk standing at `build` while the log's next entry belongs to
      // `challenge` or `verify` is not a jump: `build + ok` enters one of
      // exactly those two states, and the step that enters `build` is left
      // with NO outcome whenever the round is a re-entry (the engine writes it
      // ahead and the outcome lands on the build step itself). So the walk
      // owes that entry, the log does not hold it, and the fold steps over to
      // where the writer actually stood — charging the attempt below the way
      // `owedBuilds` charges any other build verdict whose entry step is
      // missing. No other state has a `viaBuild` arrow, so every other jump
      // stays a refusal, which is what keeps `land` unreachable from red.
      const entered = state === "build" && (step.state === "challenge" || step.state === "verify");
      if (!entered)
        return why(`step ${step.key} belongs to ${step.state} but the walk stands at ${state}`);
      return { state: step.state, counters };
    }
    if (!hasTransition(step.state, step.outcome?.kind ?? ""))
      return why(`step ${step.key} + ${JSON.stringify(step.outcome?.kind)} has no arrow`);
    const moved = next({ ...run, state: step.state, counters }, step.outcome as Outcome);
    // Charge the round only when the step itself cannot have billed it. A step
    // routed FROM `build` bills its own attempt through `viaBuild`, and so does
    // a step the walk stepped over to reach — charging either here would
    // double-count the round.
    if (step.state !== "build" && moved.counters.buildAttempts > counters.buildAttempts)
      owedBuilds++;
    return moved;
  });
  if (derived === undefined)
    throw new LeanStateError(
      `${file}: snapshot disagrees with the step log (the log cannot be replayed through the table)`,
    );
  // A drive that halted on a thrown handler or an unlisted kind stamped its
  // `handed-back` snapshot WITHOUT routing that last outcome (`settle` records
  // it and ends the run itself), so for that one shape the snapshot sits one
  // arrow past what the fold can derive — and the halt rule below is what
  // proves it really was a halt rather than an invented position.
  const expected =
    halted === undefined
      ? derived
      : { state: "handed-back" as LeanState, counters: derived.counters };
  const expectedCounters = {
    ...expected.counters,
    buildAttempts: expected.counters.buildAttempts + owedBuilds,
  };
  if (
    expected.state !== run.state ||
    JSON.stringify(expectedCounters) !== JSON.stringify(run.counters)
  )
    throw new LeanStateError(
      `${file}: snapshot disagrees with the step log (snapshot ${run.state} ${JSON.stringify(
        run.counters,
      )}, log replays to ${expected.state} ${JSON.stringify(expectedCounters)})`,
    );
  return { state: run.state, counters: run.counters };
}

/**
 * The step a drive halted on without routing it, or `undefined` when the log
 * describes a clean walk: the LAST step, and only when the engine's own halt
 * rules say it would have stopped there (`settle` ends the run on a thrown
 * handler or on a kind the table has no arrow for).
 */
function haltedStep(run: LeanRun, log: Step[]): Step | undefined {
  const last = log[log.length - 1];
  if (last?.outcome === undefined) return undefined;
  // A terminal run's final step IS the routable step that carried it there
  // (`handback + done` → `handed-back`, `land + merged` → `landed`), so it is
  // not a halt. Only a step the table cannot route is one.
  return hasTransition(last.state, last.outcome.kind) ? undefined : last;
}

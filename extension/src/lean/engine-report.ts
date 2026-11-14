/**
 * lean/engine-report — the reporting step a stopped run is routed into.
 *
 * The split from `engine.ts` is by concern, not by size: `engine.ts` owns the runner (load, loop,
 * save); this module owns the one move the runner makes that is not a step the table routes — running
 * the report for a run the clock stopped over an uncertified head, and ending the run with its verdict.
 * `deadline-handback.ts` decides WHETHER that move happens (`deadlineStopShouldReport`); this module
 * performs it.
 *
 * `Drive` is the persist seam and `HandbackHandler` the injectable report step, both injected rather
 * than reached around: the runner holds `saveRun` and the injected `now`, and the report step is the
 * runner's `handback` handler, passed in so this module never reads the handler table itself and a test
 * can drive it with a reporting step that only records. The three helpers it needs to write a step —
 * the visit's key, the outcome attach, the terminal stamp — arrive on the request, so the definitions
 * stay private to `engine.ts` and this module writes a step exactly the way the runner does.
 */
import { trace } from "../trace.ts";
import type { LeanRun, LeanState, Outcome, Step } from "./state.ts";
import { nextAttempt, stepKey } from "./state.ts";

/** The persist seam: the runner's save, bound to the current drive. */
export interface ReportDrive {
  save: (run: LeanRun) => void;
}

/** The reporting step, as the runner holds it — the `handback` entry of the injected handler table. */
export type HandbackHandler = (ctx: {
  repoRoot: string;
  issue: number;
  run: LeanRun;
  steps: LeanRun["steps"];
  stepKey: string;
  now: () => number;
}) => Promise<Outcome>;

/** Everything the runner passes to the report, so this module reads none of the runner's state. */
export interface ReportRequest {
  drive: ReportDrive;
  repoRoot: string;
  issue: number;
  run: LeanRun;
  /** The step the clock refused — `verify` or `ci` — named verbatim in the run's reason line. */
  stoppedAt: LeanState;
  now: () => number;
  handler: HandbackHandler;
  /** `<issue>:<state>:<n>` for a visit — the runner's `stepKey`, injected so the key is written once. */
  keyFor: (state: LeanState, n: number) => string;
  /** Attach an outcome to one step — the runner's `withOutcome`. */
  attach: (run: LeanRun, key: string, outcome: Outcome, endedAt: number) => LeanRun;
  /** Stamp the terminal result and persist — the runner's `endRun`, the one writer of `result`. */
  finish: (run: LeanRun, state: LeanState, reason: string) => LeanRun;
}

/**
 * Run the report for a run the clock stopped over an uncertified head, and end the run with it.
 *
 * The reporting step runs for real — the rewind, the head fields, the comment — because those are the
 * things the deadline used to make unreachable, which is the whole point of the routing. Its visit goes
 * on the log, keyed and stamped the way the runner writes one, and the run ends with its verdict beside a
 * stamped result, so the durable record reads like any other handback's: newest step the report, result
 * stamped from its verdict.
 *
 * The visit needs the fold's one exemption (`resume.ts`, `isReportRoute`), and that need is what the
 * routing costs. `resume.ts` re-derives a run by walking its log back through `next()`, and the table
 * routes `review:fixed` to `verify` — so at the end of this log the walk stands at `verify` and the
 * report's entry belongs to no state the walk reached. Without the exemption the file is refused, and the
 * refusal is worse than the bug this branch fixes: it comes from `loadRun`/`verifiedPosition`, which run
 * before the routing's switch is read, so `PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK=0` recovers nothing and the
 * documented recovery for a timed-out issue ("re-run `/work-lean <issue>`") is shut for good. The
 * exemption is admitted on the WALK and the LOG, never on the entry being judged, and is the narrowest
 * shape the routing can produce — one report visit ever, log ending on it, premise still the `fixed`
 * review with no decided `verify` behind it.
 *
 * What the record deliberately does NOT do is put the report's verdict on the gate entry the clock left
 * unanswered. That fold-legal-looking shortcut stamps `verify` with a kind its table has no arrow for, and
 * `handback-heads.ts` reads any DECIDED `verify` after the review as "the gate has spoken" — so a resumed
 * run would stop rewinding and its next comment would lose the head fields, silencing the very rule this
 * run reports under. An unanswered entry is also the truth: the gate was entered and never answered, which
 * is the premise the report acts on.
 *
 * Returns the ended run, or `undefined` when the report threw, so the caller falls back to the plain
 * deadline stamp rather than a run with no result. (The caller has already established the handler
 * exists; a missing handler is the caller's decision, not this function's.)
 */
export async function runHandbackReport(req: ReportRequest): Promise<LeanRun | undefined> {
  const { drive, run, stoppedAt, now, handler } = req;
  const key = req.keyFor("handback", nextAttempt(run, "handback"));
  const startedAt = now();
  let outcome: Outcome;
  try {
    outcome = await handler({
      repoRoot: req.repoRoot,
      issue: req.issue,
      run,
      steps: run.steps,
      stepKey: key,
      now,
    });
  } catch (err) {
    // The step's contract is that it answers; a throw is a handler bug, and the run gets the stamp it
    // would have got without the routing rather than one built on a verdict nobody returned.
    trace(`lean #${String(req.issue)} ${key} threw: ${String((err as Error)?.message ?? err)}`);
    return undefined;
  }
  // The visit, then its verdict, then the result — one save, one record. `startedAt` is the instant the
  // routing took the decision, which is the step's real start; the runner is not asked to re-run it.
  const visit: Step = { key, state: "handback", startedAt };
  const reported = req.attach({ ...run, steps: [...run.steps, visit] }, key, outcome, now());
  return req.finish(reported, "handed-back", reportReason(stoppedAt, outcome));
}

/**
 * The reason line a routed run carries: what the report said, and where the clock had stopped it.
 *
 * The report's own reason answers the question an operator asks of a handed-back run — why what they were
 * sent is not what the gate approved — so it leads. The deadline is nevertheless what ended the run, and a
 * reader comparing this record with a plain deadline stop has to be able to see that this one was stopped
 * at the same boundary and reported on the way out, so the step the clock refused is named verbatim.
 */
function reportReason(stoppedAt: LeanState, outcome: Outcome): string {
  const said =
    typeof outcome.reason === "string" && outcome.reason !== "" ? outcome.reason : "reported";
  return `${said} (cycle deadline reached at ${stoppedAt})`;
}

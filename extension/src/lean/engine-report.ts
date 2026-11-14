/**
 * lean/engine-report — the reporting step a stopped run is routed into.
 *
 * The split from `engine.ts` is by concern, not by size: `engine.ts` owns the runner (load, loop,
 * save); this module owns the one move the runner makes that is not a step the table routes — running
 * the report for a run the clock stopped over an uncertified head, and ending the run with its verdict.
 * `deadline-handback.ts` decides WHETHER that move happens (`deadlineStopShouldReport`); this module
 * performs it.
 *
 * `HandbackHandler` is the injectable report step, injected rather than reached around: the
 * runner holds the injected `now`, and the report step is the runner's `handback` handler,
 * passed in so this module never reads the handler table itself and a test can
 * drive it with a reporting step that only records. The three helpers it needs to write a step —
 * the visit's key, the outcome attach, the terminal stamp — arrive on the request, so the definitions
 * stay private to `engine.ts` and this module writes a step exactly the way the runner does.
 */
import { traceWarn } from "../trace.ts";
import { reportBoundSentence } from "./engine-report-bound.ts";
import type { LeanRun, LeanState, Outcome, Step } from "./state.ts";
import { nextAttempt } from "./state.ts";

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
  repoRoot: string;
  issue: number;
  run: LeanRun;
  /** The step the clock refused — `verify` or `ci` — named verbatim in the run's reason line. */
  stoppedAt: LeanState;
  now: () => number;
  handler: HandbackHandler;
  /**
   * The report's own wall, in ms, or `undefined` for no wall.
   *
   * The runner supplies it — it is `handoffAllowanceMs()`, the number the stop test
   * one boundary earlier compared against — so this module reads neither the env nor
   * the deadline module. Present, the handler is raced against it and an overrun ends
   * the run as the plain deadline stop it would have been without the routing;
   * absent, the handler is awaited and nothing else.
   */
  boundMs?: number;
  /** Set by THIS module to the bound it ran out at, and ONLY on that arm.
   *
   * The overrun changes the run's outcome — it loses the report it was routed to make — so the
   * runner has to be able to say so on the stamp it falls back to. A field on the request rather
   * than a sentinel return value because `undefined` already means "the report threw", and a
   * record that cannot tell those two apart is the record that hides a hung forge post behind a
   * routine stop. Read back by `routed-report.ts`, which pairs it with the ended run. */
  boundFiredMs?: number;
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
 * The visit needs the fold's one exemption, and that need is what the routing costs. The rule is
 * `isReportRoute`'s jsdoc in `resume.ts` — why the fold cannot reproduce this log on its own, why a
 * refusal there outranks the bug this branch fixes (it comes from `loadRun`/`verifiedPosition`, which run
 * before the routing's switch is read, so `PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK=0` recovers nothing), and
 * how narrow the admitted shape is. The routing's side of the seam — what it writes, below — is what has
 * to keep agreeing with that rule.
 *
 * What the record deliberately does NOT do is put the report's verdict on the gate entry the clock left
 * unanswered. That fold-legal-looking shortcut stamps `verify` with a kind its table has no arrow for, and
 * `handback-heads.ts` reads any DECIDED `verify` after the review as "the gate has spoken" — so a resumed
 * run would stop rewinding and its next comment would lose the head fields, silencing the very rule this
 * run reports under. An unanswered entry is also the truth: the gate was entered and never answered, which
 * is the premise the report acts on.
 *
 * Returns the ended run, or `undefined` when the report threw or overran its bound, so
 * the caller falls back to the plain deadline stamp rather than a run with no result.
 * (The caller has already established the handler exists; a missing handler is the
 * caller's decision, not this function's.)
 *
 * The bound is the report's own wall, and it is what the exemption above makes
 * necessary: the step the clock cannot refuse is a step nothing else bounds. On
 * overrun the handler's result is discarded — no visit, no verdict, no stamp from this
 * function — and the run takes the plain deadline stamp below in `engine.ts`, exactly
 * the record it would have been given without the routing. A handler that settles after
 * the bound fired may still run (an in-flight `git push` cannot be recalled) but writes
 * nothing: the only writers of the record are the two `req` calls below, both reached on
 * the settled arm alone.
 */
export async function runHandbackReport(req: ReportRequest): Promise<LeanRun | undefined> {
  const { run, stoppedAt, now, handler, boundMs } = req;
  const key = req.keyFor("handback", nextAttempt(run, "handback"));
  const startedAt = now();
  // Two enforcement points, deliberately: the per-call timeouts inside the handler bound
  // its own `git` and forge calls, and only this race frees the RUN. A wedged in-process
  // await — a comment-poster seam, a call that never returns — leaves the handler pending
  // whatever those timeouts say, which is the shape that outlived both the deadline and
  // the child-bound grace. The timer is `unref`'d and cleared: it is what we are waiting
  // on, and once the run has stopped waiting it must stop being a reason the process
  // stays alive (`work-driver-handoff-ops.ts` is the precedent for both halves).
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  let outcome: Outcome;
  try {
    const call = handler({
      repoRoot: req.repoRoot,
      issue: req.issue,
      run,
      steps: run.steps,
      stepKey: key,
      now,
    });
    if (boundMs === undefined) {
      outcome = await call;
    } else {
      const overrun = new Promise<{ overrun: true }>((resolve) => {
        boundTimer = setTimeout(() => resolve({ overrun: true }), boundMs);
        boundTimer.unref?.();
      });
      // Branded object rather than a sentinel string: `Outcome.kind` is an open `string`,
      // so a `"bound"` marker would type-check against a handler's own verdict and the
      // overrun arm could be silently skipped.
      const settled = await Promise.race([call, overrun]);
      if ("overrun" in settled) {
        // The report's wall ran out. Disclosed on the same UNGATED channel as the throw
        // arm beside it, for the same reason: the run loses its report, and an operator
        // who was promised a handback has to be able to see that this one is a deadline
        // stop that timed out on the way out rather than a clean report or a kill. The
        // runner is told on the same arm, so the stamp it falls back to says the same.
        traceWarn(
          `lean #${String(req.issue)} ${key} bound reached: ${reportBoundSentence(boundMs)} — the run takes the plain deadline stamp`,
        );
        req.boundFiredMs = boundMs;
        return undefined;
      }
      outcome = settled;
    }
  } catch (err) {
    // The step's contract is that it answers; a throw is a handler bug, and the run gets the stamp it
    // would have got without the routing rather than one built on a verdict nobody returned.
    // `traceWarn`, not `trace`: the throw changes the run's outcome (it loses its report and
    // takes the plain deadline stamp), so the operator has to see it without `PI_ENSEMBLE_DEBUG`.
    traceWarn(`lean #${String(req.issue)} ${key} threw: ${String((err as Error)?.message ?? err)}`);
    return undefined;
  } finally {
    if (boundTimer) clearTimeout(boundTimer);
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

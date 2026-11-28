/**
 * lean/engine-report — the reporting step a stopped run is routed into.
 *
 * The split from `engine.ts` is by concern: `engine.ts` owns the runner; this module owns the one move
 * the runner makes that is not a step the table routes — the clock or a kill stopping a working step,
 * and what the run becomes because of it. `handback-heads.ts` decides WHETHER the routing happens; this
 * module performs it and stamps the run either way.
 *
 * `HandbackHandler` is injected rather than reached around, so this module never reads the handler
 * table itself; the three helpers it needs to write a step arrive on the request, so a step is written
 * exactly the way the runner writes one.
 */
import { traceWarn } from "../trace.ts";
import { handoffAllowanceMs, stopReason } from "./deadline.ts";
import { reportBoundSentence } from "./engine-report-bound.ts";
import { handbackHeads } from "./handback-heads.ts";
import { type LeanRun, type LeanState, type Outcome, type Step, nextAttempt } from "./state.ts";

/** The reporting step, as the runner holds it — the `handback` entry of the injected handler table. */
export type HandbackHandler = (ctx: {
  repoRoot: string;
  issue: number;
  run: LeanRun;
  steps: LeanRun["steps"];
  stepKey: string;
  now: () => number;
}) => Promise<Outcome>;

/**
 * The routed report's own wall: the handoff allowance plus a fraction of headroom.
 *
 * The allowance is the time the run was already told the report owns, but not the time it needs: the
 * per-call git and forge ceilings on the reporting path sum past it, so a bound equal to the allowance
 * cuts a report in which nothing hung and loses the rewind. Hence allowance × (1 +
 * {@link REPORT_BOUND_HEADROOM_RATIO}), which still fires strictly before the grace. The headroom is a
 * RATIO of the allowance because the allowance is the knob an operator moves
 * (`PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`).
 *
 * The limit on it is the child-bound grace (`PI_ENSEMBLE_CHILD_BOUND_GRACE_MS`), past which the run is
 * killed and the kill — not the handback — is what gets recorded. `test-lean-report-bound-ceiling.ts` holds
 * the bound strictly inside that grace.
 */
export function handoffReportBoundMs(): number {
  return Math.round(handoffAllowanceMs() * (1 + REPORT_BOUND_HEADROOM_RATIO));
}

/** What the bound adds to the allowance, as a fraction of it; sized by
 *  `test-lean-report-bound-ceiling.ts` against the path's summed ceilings and the grace. */
export const REPORT_BOUND_HEADROOM_RATIO = 0.2;

/** Everything the runner passes to the report, so this module reads none of the runner's state. */
export interface ReportRequest {
  repoRoot: string;
  issue: number;
  run: LeanRun;
  /** The step the stop refused, named verbatim in the run's reason line. */
  stoppedAt: LeanState;
  /** What refused it, as the reason line names it: `cycle deadline reached`, `job killed`. */
  cause: string;
  now: () => number;
  handler: HandbackHandler;
  /**
   * The report's own wall in ms: the handler is raced against it and an overrun ends the run as
   * the plain deadline stop.
   */
  boundMs: number;
  /** Set by THIS module to the bound it ran out at, and ONLY on that arm: the overrun changes the
   * run's outcome, so the runner says so on the stamp it falls back to. A field rather than a
   * sentinel because `undefined` already means "the report threw". */
  boundFiredMs?: number;
  /** `<issue>:<state>:<n>` for a visit — the runner's `stepKey`. */
  keyFor: (state: LeanState, n: number) => string;
  /** Attach an outcome to one step — the runner's `withOutcome`. */
  attach: (run: LeanRun, key: string, outcome: Outcome, endedAt: number) => LeanRun;
  /** Stamp the terminal result and persist — the runner's `endRun`. */
  finish: (run: LeanRun, state: LeanState, reason: string) => LeanRun;
}

/**
 * Run the report for a run the clock stopped over an uncertified head, and end the run with it.
 *
 * The step runs for real — the rewind, the head fields, the comment — because those are the things
 * the deadline made unreachable, and its visit is written the way the runner writes one.
 *
 * The visit needs the fold's one exemption, and that is what the routing costs: see `isReportRoute`
 * in `resume.ts`. The record deliberately does NOT put the report's verdict on the gate entry the
 * clock left unanswered: that would stamp `verify` with a kind its table has no arrow for, and
 * `handback-heads.ts` would read it as "the gate has spoken".
 *
 * Returns the ended run, or `undefined` when the report threw or overran, so the caller falls back
 * to the plain deadline stamp. On overrun the result is discarded; a handler that settles after the
 * bound fired may still run but writes nothing — the only writers of the record are the two `req`
 * calls below, both reached on the settled arm alone.
 */
export async function runHandbackReport(req: ReportRequest): Promise<LeanRun | undefined> {
  const { run, stoppedAt, now, handler, boundMs } = req;
  const key = req.keyFor("handback", nextAttempt(run, "handback"));
  const startedAt = now();
  // Two enforcement points: the per-call timeouts inside the handler bound its own calls, and only
  // this race frees the RUN. The timer is REF'd (an unref'd bound lets the loop exit with no result)
  // and cleared in the `finally`.
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
    const overrun = new Promise<{ overrun: true }>((resolve) => {
      boundTimer = setTimeout(() => resolve({ overrun: true }), boundMs);
    });
    // Branded object rather than a sentinel string: `Outcome.kind` is an open `string`.
    const settled = await Promise.race([call, overrun]);
    if ("overrun" in settled) {
      // UNGATED channel, as the throw arm beside it: the run loses its report.
      traceWarn(
        `lean #${String(req.issue)} ${key} bound reached: ${reportBoundSentence(boundMs)} — the run takes the plain deadline stamp`,
      );
      req.boundFiredMs = boundMs;
      return undefined;
    }
    outcome = settled;
  } catch (err) {
    // A throw is a handler bug: the run gets the stamp it would have got without the routing.
    // `traceWarn`, not `trace` — the outcome changed, so it must show without `PI_ENSEMBLE_DEBUG`.
    traceWarn(`lean #${String(req.issue)} ${key} threw: ${String((err as Error)?.message ?? err)}`);
    return undefined;
  } finally {
    if (boundTimer) clearTimeout(boundTimer);
  }
  // The visit, then its verdict, then the result — one save, one record.
  const visit: Step = { key, state: "handback", startedAt };
  const reported = req.attach({ ...run, steps: [...run.steps, visit] }, key, outcome, now());
  return req.finish(reported, "handed-back", reportReason(stoppedAt, req.cause, outcome));
}

/**
 * The reason line a routed run carries: the report's own reason leads, and what the run was
 * refused for is named beside it, so a reader can tell a routed report from a plain stamp.
 */
function reportReason(stoppedAt: LeanState, cause: string, outcome: Outcome): string {
  const said =
    typeof outcome.reason === "string" && outcome.reason !== "" ? outcome.reason : "reported";
  return `${said} (${cause} at ${stoppedAt})`;
}

/** What the runner gives the stop: the two writers of the record, and the report's pieces. */
export interface BoundaryStop {
  /** Stamp `handed-back` with a reason and persist — the runner's `endRun` on that state. */
  end: (run: LeanRun, reason: string) => LeanRun;
  /** Everything the report needs that the runner holds: the handler table's entry and the step writers. */
  request: {
    repoRoot: string;
    issue: number;
    /** The `handback` handler, or `undefined` — a run with no reporting step built cannot be routed. */
    handler: HandbackHandler | undefined;
    keyFor: (state: LeanState, n: number) => string;
    attach: ReportRequest["attach"];
    /** The runner's terminal stamp: only the runner may write `result` and persist it. */
    finish: ReportRequest["finish"];
  };
  run: LeanRun;
  /** The step the stop refused, named verbatim in the run's reason line. */
  stoppedAt: LeanState;
  /** What stopped the run, as the plain stamp names it: `cycle deadline <epoch> reached`, `job killed`. */
  cause: string;
  /** The same cause as the routed report names it, which omits the epoch. */
  reportCause: string;
  now: () => number;
}

/**
 * Stop a run whose deadline or kill refused a working step, and return the ended run.
 *
 * Most such runs are stamped where they stand — but a run whose newest work step is a `fixed` review
 * holds origin over bytes no gate certified, and the step that says so (and moves origin back) is
 * `handback`, so the run is routed to the report. A run with no reporting step built takes the plain
 * stamp.
 *
 * The report lands its verdict through `end` — the writer every terminal stamp uses — not through
 * `apply()` on an entry the table never routed. The log keeps the unanswered entry the loop wrote
 * ahead, which is the premise `handback-heads.ts` acts on. Nothing here starts WORK: the only handler
 * reached is the reporting one.
 */
export async function stopAtBoundary(stop: BoundaryStop): Promise<LeanRun> {
  const { run, stoppedAt, cause, now } = stop;
  // The head rule decides whether the report runs, keyed on the LOG and not the stop cause, so the
  // routing fires on the same shape the reporting step reports on and on nothing else. It is
  // affordable because `REPORT_STATES` is exempt from `deadlineStopsSteps` — the one step past the
  // line the deadline cannot refuse — and it is needed because `machine.ts` routes `fixed` back
  // through `verify`, so stamping there left origin over bytes no gate certified.
  if (stoppedAt !== "handback" && handbackHeads(run.steps).applies && stop.request.handler) {
    // The report's own bound, raced against the handler inside `runHandbackReport`; an overrun throws
    // away the verdict and answers `undefined` with `boundFiredMs` set, which is what lets the stamp
    // below say the report was LOST rather than that there was none to lose.
    const req: ReportRequest = {
      repoRoot: stop.request.repoRoot,
      issue: stop.request.issue,
      run,
      stoppedAt,
      cause: stop.reportCause,
      now,
      handler: stop.request.handler,
      boundMs: handoffReportBoundMs(),
      keyFor: stop.request.keyFor,
      attach: stop.request.attach,
      finish: (r, state, reason) => stop.end(r, reason),
    };
    const reported = await runHandbackReport(req);
    // The report could not be run at all, or could not be run IN TIME. Either way the run is
    // stamped where it stands, and when the bound is what stopped it, the stamp says so.
    if (reported === undefined) {
      return stop.end(
        run,
        stopReason(
          run.steps,
          stoppedAt,
          cause,
          req.boundFiredMs === undefined ? undefined : reportBoundSentence(req.boundFiredMs),
        ),
      );
    }
    return reported;
  }
  return stop.end(run, stopReason(run.steps, stoppedAt, cause));
}

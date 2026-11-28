/**
 * lean-errored-review-report — the one error path that owes a report: a `review` whose handler
 * threw (#2667).
 *
 * A review that threw judged nothing, and where the run's newest decided `verify` certified a
 * head, that head is owed the reporting step the throw would otherwise skip: the rewind, the four
 * head fields, and the comment naming why review did not complete. `handbackHeads` over the log
 * decides whether the run is that shape, so an errored review over nothing green — and every
 * other state's throw — takes the caller's plain stamp.
 *
 * This module is the routing; `lean/engine-report.ts` still performs the report, and the runner
 * in `lean/engine.ts` stays a thin call site that supplies the two writers of the record, because
 * the runner owns the state file and this module does not.
 */
import {
  type HandbackHandler,
  type ReportRequest,
  handoffReportBoundMs,
  runHandbackReport,
} from "./lean/engine-report.ts";
import { handbackHeads } from "./lean/handback-heads.ts";
import type { LeanRun } from "./lean/state.ts";

/** The writers the runner holds, minus the pieces this routing fixes itself. */
export type ErroredReviewWriters = Omit<
  ReportRequest,
  "run" | "cause" | "boundMs" | "boundFiredMs" | "handler" | "stoppedAt"
> & {
  handler: HandbackHandler | undefined;
};

/**
 * Route an errored review over a certified head into the reporting step, and end the run with it.
 *
 * Returns the ended run, or `undefined` when nothing could be reported: no reporting step built, a
 * report that threw, or one that overran its own bound (on overrun `req.boundFiredMs` carries the
 * bound, which lets the caller say the report was LOST rather than that there was none to lose).
 */
export async function reportErroredReview(
  run: LeanRun,
  cause: string,
  writers: ErroredReviewWriters,
): Promise<LeanRun | undefined> {
  if (!handbackHeads(run.steps).applies) return undefined;
  const { handler, ...rest } = writers;
  if (handler === undefined) return undefined;
  return await runHandbackReport({
    ...rest,
    stoppedAt: "review",
    run,
    cause,
    handler,
    boundMs: handoffReportBoundMs(),
  });
}

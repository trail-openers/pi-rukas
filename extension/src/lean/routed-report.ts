/**
 * lean/routed-report — the runner's half of the routed deadline report.
 *
 * `engine-report.ts` performs the report; this module holds the fact the RUNNER has to carry
 * alongside the ended run: that this plain deadline stamp is the answer to a report that ran
 * out of wall, and how long that wall was.
 *
 * Why a value and not a sentinel: `runHandbackReport` returns `undefined` for a report that
 * threw, and the run stamps the plain deadline reason for a throw and an overrun alike. Those
 * are not the same fact to an operator — one run had no report to lose, the other lost one to a
 * hung forge post — so the bound travels beside the ended run rather than being inferred from prose.
 */

import type { ReportRequest } from "./engine-report.ts";
import type { LeanRun } from "./state.ts";

/** What one routing of the report settled on: the ended run, and the bound that cut it. */
export interface RoutedReport {
  /** The ended run, or `undefined` when the report threw or overran its bound. */
  run: LeanRun | undefined;
  /** The bound the report ran out at, present ONLY on that arm. */
  boundMs: number | undefined;
}

/**
 * Route a run into its report and report back what the routing cost.
 *
 * The report is injected rather than imported, so the dependency runs one way and a test can
 * drive this move with a reporting step that never returns. Nothing here decides WHETHER to
 * route: that is `deadline-handback.ts`'s answer, already taken.
 *
 * The overrun is read back off the request the report fills on its bound arm alone, which keeps
 * the pair — the run and the bound that cut it — the return of one call.
 */
export async function routeHandbackReport(
  req: ReportRequest,
  report: (req: ReportRequest) => Promise<LeanRun | undefined>,
): Promise<RoutedReport> {
  const run = await report(req);
  return { run, boundMs: run === undefined ? req.boundFiredMs : undefined };
}

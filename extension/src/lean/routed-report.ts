/**
 * lean/routed-report — the runner's half of the routed deadline report.
 *
 * `engine-report.ts` performs the report: it runs the handler, writes the visit, and ends
 * the run with its verdict. This module holds the fact the RUNNER has to carry alongside the
 * ended run and the reporting step has no reason to know about: that this particular plain
 * deadline stamp is the answer to a report that ran out of wall, and how long that wall was.
 *
 * Why a value and not a sentinel: `runHandbackReport` returns `undefined` for a report that
 * threw, and the run stamps the plain deadline reason for a throw and an overrun alike. Those
 * two records are not the same fact to an operator — one run had no report to lose, the other
 * lost one to a hung forge post or a wedged in-process call — so the overrun's bound travels
 * beside the ended run rather than being inferred from prose a reader would have to guess at.
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
 * The report is injected rather than imported, so the dependency runs one way — from the
 * runner's seam to the report — and a test can drive this move with a reporting step that
 * never returns. Nothing here decides WHETHER to route: that is `deadline-handback.ts`'s
 * answer, already taken by the time this is called.
 *
 * The overrun is read back off the request the report fills on its bound arm alone
 * (`ReportRequest.boundFiredMs`), which keeps the pair — the run and the bound that cut it —
 * the return of one call. A report that answered, or threw, leaves it unset.
 */
export async function routeHandbackReport(
  req: ReportRequest,
  report: (req: ReportRequest) => Promise<LeanRun | undefined>,
): Promise<RoutedReport> {
  const run = await report(req);
  return { run, boundMs: run === undefined ? req.boundFiredMs : undefined };
}

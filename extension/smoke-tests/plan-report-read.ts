/**
 * plan-report-read — reading a DELIVERED driver report back into the shape
 * pre-#1044 tests asserted on directly.
 *
 * #1044 moved the plan/research result out of the tool return and into an
 * `[ensemble:async]` steer. The tests that pinned structured facts (was it
 * filed? how many gaps? which cap reason?) now recover them from the text the
 * operator actually reads, so this module is the single reader of that text for
 * every plan smoke test — its regexes mirror renderPlanResult's sections, and
 * drift between the two is a test failure rather than a silently-absent field.
 */

/**
 * Strip the delivery envelope off a steer: the `[ensemble:async] ... (job X)
 * complete` line and the driver's "you started this earlier" trailer. Shared by
 * the plan and research async tests — the envelope is the job layer's, not the
 * driver's.
 */
export function reportBody(report: string): string {
  const marker = "\n\n";
  const head = report.indexOf(marker);
  const body = head === -1 ? report : report.slice(head + 2);
  return body.replace(/\n\n---\nYou started this driver earlier[\s\S]*$/, "").trim();
}

/**
 * The structured facts of a delivered plan report.
 *
 * #1044 moved them out of the tool return: the steer now carries the rendered
 * text, and these are recovered from what that renderer writes. Two entries
 * are NOT recoverable from the text and come from the caller's own request,
 * which the driver's rendering already branches on:
 *
 * - `gapCount` — the renderer prints the disposition BULLETS and a cap block
 *   that names the cause in prose; it never prints a count, and a test that
 *   asserts "the stub's two CRITICALs survived the loop" is asking about the
 *   structured value, not the prose.
 * - `capReason` — ditto: the cap block is rendered FROM it, and discriminating
 *   the cause is the whole point of the field (D1).
 *
 * `dryRun` is `asked.dryRun` for the same reason: a PLAN DRY-RUN whose gate
 * capped renders `PLAN COMPLETED` (the head only reads `filed` /
 * `filingFailure`), so the substring cannot decide it.
 */
export function parseReportDetails(
  report: string,
  asked: Record<string, unknown> = {},
): Record<string, unknown> {
  // The key/value fields are read from the head window: they are what a spec
  // body could imitate, and the renderer writes its own BEFORE the body. The
  // section MARKERS are scanned across the whole report — the cap block, the
  // FILING STATUS section and the INVESTIGATION REUSED note all render after a
  // long body, and a window would silently drop them.
  const head = report.slice(0, 2000);
  const details: Record<string, unknown> = {};
  const type = head.match(/^Type: (\S+)/m);
  if (type) details.type = type[1];
  const title = head.match(/^Title: (.+)$/m);
  if (title) details.title = title[1].trim();
  const digest = head.match(/reviewedDigest: ([0-9a-f]{8,})/);
  if (digest) details.reviewedDigest = digest[1];
  const url = head.match(/https?:\/\/\S+\/issues\/(\d+)/);
  if (url) {
    details.issueUrl = url[0];
    details.issueNumber = Number(url[1]);
  }
  details.filed = /PLAN FILED/.test(head);
  details.dryRun = asked.dryRun === true;
  if (
    /GAP GATE CAP HIT|GAP GATE UNAVAILABLE|GAP GATE NOTE|GAP GATE REVIEW UNPARSEABLE/.test(report)
  ) {
    details.capHit = true;
    details.capReason = capReasonFromReport(report);
  }
  const dispositions = report.match(/=== GAP DISPOSITIONS ===\n([\s\S]*?)\n\n/);
  if (dispositions) {
    const block = dispositions[1];
    // '(none)' is a clean review, not zero-parsed-from-prose: the count is 0,
    // and the assertion that distinguishes them is the block's own text.
    details.gapCount = /^- \[/m.test(block)
      ? block
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- [")).length
      : 0;
    const first = block.match(/^- \[([A-Z]+)\]/m);
    if (first) details.firstGapSeverity = first[1];
  }
  if (/FILED FROM REVIEWED DRY RUN/.test(report)) details.filedFromDryRun = { ageMs: 0 };
  if (/THE REVIEWED SPEC CHANGED/.test(report))
    details.reviewedSpecChanged = { reason: "rendered" };
  const halt = report.match(/NOT FILEABLE AS-IS \(([^)]+)\)/);
  if (halt) {
    const detail = report.match(/=== FILING STATUS ===\n([\s\S]*?)(?:\n\n|$)/)?.[1];
    details.filingFailure = { reason: halt[1], detail };
  }
  if (/reused from the confirmed dry run (\S+?) ago/.test(report)) {
    details.investigationReused = { ageMs: 0 };
  }
  if (/COMPACTED: the body was deterministically compacted/.test(report)) {
    details.compacted = true;
  }
  // The structured `failedAngles` is asserted by the pipeline-level tests that
  // call runPlanPipeline directly; here the rendered disclosure is what the
  // operator reads, and its count and per-angle lines are asserted on the text.
  if (/=== INVESTIGATION STATUS ===/.test(report)) details.investigationStatusRendered = true;
  // A halt that never reaches the `NOT FILEABLE AS-IS` head still owes a
  // FILING STATUS section (renderPlanResult renders it from filingFailure
  // alone), and that line is the only place its reason survives — the head
  // carries the reason only when the run is not filed AND the head branch
  // fired. Read it out of the section so a halt whose head was rewritten (a
  // dryRun renders PLAN COMPLETED for some reasons) stays readable.
  const status = report.match(/=== FILING STATUS ===\n+([^\n]+)/);
  if (status && !details.filingFailure) {
    const line = status[1];
    const policy = line.match(/^Not filed \(by policy\): ([\s\S]*)/);
    const reason = line.match(/Reason: ([A-Za-z0-9_-]+)/);
    details.filingFailure = { reason: reason?.[1] ?? policy?.[1]?.slice(0, 40), detail: line };
  }
  if (/=== FILING STATUS ===/.test(report)) details.filingStatusRendered = true;
  return details;
}

/**
 * The discriminated cap cause, read back out of the rendered cap block. The
 * wording is the renderer's (renderPlanResult's per-cause branches in
 * plan-tool.ts) — if a branch's prose changes, this reads it differently, so
 * drift is a test failure rather than a silently-absent field.
 */
function capReasonFromReport(head: string): string | undefined {
  if (/unresolved CRITICAL gaps remain/.test(head)) return "unresolved-blocking";
  if (/returned HIGH findings alongside/.test(head)) return "residual-high";
  if (/returned only MEDIUM\/LOW findings/.test(head)) return "residual-medium-low";
  if (/never wrote a verdict line/.test(head)) return "verdict-absent";
  if (/the gap-gate dispatch itself failed/.test(head)) return "gate-unavailable";
  if (/REVIEW UNPARSEABLE/.test(head)) return "review-unparseable";
  return undefined;
}

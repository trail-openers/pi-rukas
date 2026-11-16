/**
 * The routed report's own wall, told apart from a kill's.
 *
 * The bound is `handoffReportBoundMs()` — the handoff allowance × (1 + headroom ratio), because the
 * routed path's per-call ceilings sum below it — and the race lives in `engine-report.ts`;
 * `test-lean-report-bound-ceiling.ts` is the witness. This module holds only the sentence the
 * overrun tells, so the `traceWarn` an operator reads and the clause the durable record carries are
 * written by one reader. It names the await that ran out and how long it was given, because the
 * distinction the bound exists to make is between a run that reported its own deadline stop and one
 * an external wrapper killed.
 *
 * It also says what the bound does NOT do — cancel the handler. The rewind's push and the forge
 * comment of a cut report keep running; nothing at this layer recalls them.
 */
export function reportBoundSentence(ms: number): string {
  return `the routed handback report timed out after ${String(ms)}ms; its rewind and comment may still complete`;
}

/**
 * The routed report's own wall, told apart from a kill's.
 *
 * The bound is `handoffAllowanceMs()` and the race lives in `engine-report.ts`;
 * this module holds only the sentence the overrun tells, so the `traceWarn` an
 * operator reads and the clause the durable record carries are written by one
 * reader and cannot drift into saying different things about the same cut.
 *
 * The sentence names the await that ran out and how long it was given, because
 * the difference the bound exists to make is between a run that reported its own
 * deadline stop and a run an external wrapper killed: the reason line is what a
 * host, a resumed run and an operator with `/runs` all read.
 */
export function reportBoundSentence(ms: number): string {
  return `the routed handback report timed out after ${String(ms)}ms`;
}

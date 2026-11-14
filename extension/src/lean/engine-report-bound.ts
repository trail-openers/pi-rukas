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
 *
 * It also says what the bound does NOT do — cancel the handler. The rewind's push
 * and the forge comment of a cut report were issued before the wall ran out and
 * keep running; nothing at this layer recalls them. A record that read as though
 * the report had simply never happened would hide a landed push and a posted
 * comment behind a routine stop, so both halves are stated and the settled arm,
 * which abandoned nothing, gets neither word.
 */
export function reportBoundSentence(ms: number): string {
  return `the routed handback report timed out after ${String(ms)}ms; its rewind and comment may still complete`;
}

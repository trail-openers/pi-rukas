/**
 * research-cancel — the cancellation halt for a killed /research run (#1541).
 *
 * The mirror of plan-driver-cancel.ts for the research spine: when the async
 * job's AbortSignal fires between phases, the run returns a `ResearchResult`
 * carrying `cancelled`, which research-tool.ts renders as `RESEARCH CANCELLED`.
 * Without it a kill mid-retrieval renders the all-angles-failed halt
 * ("RESEARCH HALTED — reporter-silent") and sends the operator after a reporter
 * extension that was never the problem.
 *
 * Split out of research-driver.ts at the AGENTS.md §12 size cap.
 */
import { sessionShutdownReason } from "./session-shutdown.ts";

/**
 * Who asked for the kill. Session teardown aborts every in-flight job at once,
 * so an aborted session is the far likelier cause than an operator's
 * dispatch_kill — and the two want different follow-ups.
 */
export function killedBy(signal: AbortSignal | undefined): string {
  if (sessionShutdownReason() !== undefined) return "session shutdown";
  return signal?.aborted ? "dispatch_kill (or session shutdown)" : "the harness";
}

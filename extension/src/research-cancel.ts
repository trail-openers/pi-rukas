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
 * The "who killed it" wording (`killedBy`) is shared with the plan spine and
 * lives in session-shutdown.ts, beside the shutdown flag it reads — this module
 * is the research-side reader of that one fact.
 *
 * Split out of research-driver.ts at the AGENTS.md §12 size cap.
 */
export { killedBy } from "./session-shutdown.ts";

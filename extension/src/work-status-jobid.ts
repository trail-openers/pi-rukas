/**
 * work-status-jobid — jobId-to-issue resolution for /work-status.
 *
 * Pure functions for the /work-status command handler. Kept separate so
 * work-status.ts stays under the 500-line hard cap (see #587).
 */

import { getJobIssues } from "./async-jobs-registry.ts";
import { trace } from "./trace.ts";

/** Determine whether a string is a pure issue-number argument (digits only) */
export function isIssueNumberArg(arg: string): boolean {
  return /^[0-9]+$/.test(arg);
}

/**
 * Resolve a jobId → primary issue number via the async-jobs registry.
 * Synchronous: the registry is in-process, no I/O needed.
 * Returns undefined when the jobId is unknown (not yet registered or
 * start_work_driver still uses the old fire-and-forget path).
 */
export function resolveJobId(_repoRoot: string, jobId: string): number | undefined {
  const issues = getJobIssues(jobId);
  if (issues && issues.length > 0) {
    return issues[0];
  }
  trace(`work-status: jobId ${jobId} not found in registry (mapping not yet wired up — see #587)`);
  return undefined;
}

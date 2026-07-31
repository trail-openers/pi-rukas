/**
 * Status/kill/session-lifecycle surface for the async-job registry: snapshot
 * for `dispatch_status`, best-effort abort for `dispatch_kill` and
 * `session_shutdown`, and the test-only drain helper. Split out of
 * async-jobs.ts (#171) to stay under the module-size guideline (AGENTS.md
 * §12) — this cluster only touches the job/childHandles maps and Pi's
 * `session_shutdown` hook, not the job-start/report-delivery machinery.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type JobKind, childHandles, jobs } from "./async-jobs-registry.ts";
import { trace } from "./trace.ts";

/** Snapshot of current jobs for dispatch_status (metadata only — never content). */
export interface JobStatusRow {
  jobId: string;
  kind: JobKind;
  role: string;
  label: string;
  elapsedMs: number;
  batchId?: string;
  batchProgress?: { completed: number; size: number };
}

export function jobStatusSnapshot(): JobStatusRow[] {
  const now = Date.now();
  const out: JobStatusRow[] = [];
  for (const job of jobs.values()) {
    const base = {
      jobId: job.jobId,
      kind: job.kind,
      role: job.role,
      label: job.label,
      elapsedMs: now - job.startedAt,
    };
    if (job.kind === "batch-member") {
      out.push({ ...base, batchId: job.batchId });
    } else if (job.kind === "batch-orchestrator") {
      out.push({
        ...base,
        batchProgress: { completed: job.completed, size: job.size },
      });
    } else {
      out.push(base);
    }
  }
  return out;
}

/** Kill one job by id (best-effort — AbortSignal propagates to spawnSpecialist). */
export function killJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.abort.abort();
  return true;
}

/** Kill everything in flight. Called from session_shutdown so we don't orphan children. */
export function killAllJobs(): number {
  let n = 0;
  for (const job of jobs.values()) {
    job.abort.abort();
    n++;
  }
  return n;
}

/**
 * Test-only: forcibly drain the jobs and childHandles maps without going
 * through the abort+settle cycle. Required for tests that use
 * never-resolving work (`new Promise(() => undefined)`) — aborting such a
 * promise emits the signal but the work function never reacts, so the
 * `.then` cleanup that would remove the entry never runs. Production code
 * never wants this; tests need it for clean isolation against the
 * module-level singleton maps.
 */
export function clearJobsForTesting(): void {
  for (const job of jobs.values()) job.abort.abort();
  jobs.clear();
  childHandles.clear();
}

/**
 * Register the session_shutdown handler that aborts in-flight async jobs.
 * Pi's only documented shutdown hook is `session_shutdown` (`session_end`
 * was a guess we dropped in #23); we register against the documented API
 * directly with proper typing instead of the previous `as unknown as` cast.
 */
export function registerAsyncJobsLifecycle(pi: ExtensionAPI): void {
  const piWithOn = pi as unknown as {
    on?: (event: "session_shutdown", handler: () => Promise<void> | void) => void;
  };
  piWithOn.on?.("session_shutdown", () => {
    const n = killAllJobs();
    if (n > 0) trace(`session_shutdown: aborted ${n} in-flight async jobs`);
  });
}

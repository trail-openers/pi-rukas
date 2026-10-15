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
import { reset as resetDeck } from "./dispatch-deck.ts";
import { exitOrigin } from "./exit-cause.ts";
import { incrementNotice } from "./notice-counter.ts";
import * as pendingJobs from "./pending-jobs-signal.ts";
import { markSessionShutdown } from "./session-shutdown.ts";
import { trace } from "./trace.ts";

/** The narrow host surface startJob / dispatch need: steer delivery only. */
export interface DispatchHost {
  sendUserMessage(text: string, options: { deliverAs: "steer" }): void;
}

/**
 * Push a report back to the parent agent. `deliverAs: "steer"` queues the
 * message during a streaming turn (delivered before the next LLM call) or
 * directly if the agent is idle.
 * #916 SLICE B: counts the delivery for the live view's "N new notices"
 * badge (reset on view open).
 */
export function deliverReport(host: DispatchHost, report: string): void {
  incrementNotice();
  try {
    host.sendUserMessage(report, { deliverAs: "steer" });
  } catch (err) {
    trace(`async report delivery failed: ${(err as Error).message}`);
  }
}

/**
 * The one stand-in path for a settle that could not hand its report to Pi: deliver
 * `standIn(failure)` (naming the job or batch) so the caller's releaseAfter never drops
 * a count without a report. Never throws — a stand-in that also fails is traced with
 * both errors, so the caller can still release.
 */
export function deliverStandIn(
  host: DispatchHost,
  label: string,
  failure: unknown,
  standIn: (failure: unknown) => string,
): void {
  try {
    deliverReport(host, standIn(failure));
  } catch (err) {
    trace(`${label} stand-in report also failed: ${String(err)} (original: ${String(failure)})`);
  }
}

/**
 * Deliver `build()`; if building throws, fall back to the stand-in. Never throws.
 */
export function deliverOrStandIn(
  host: DispatchHost,
  label: string,
  build: () => string,
  standIn: (failure: unknown) => string,
): void {
  let failure: unknown;
  try {
    deliverReport(host, build());
    return;
  } catch (err) {
    failure = err;
    trace(`${label} report failed: ${String(err)}`);
  }
  deliverStandIn(host, label, failure, standIn);
}

/** Snapshot of current jobs for dispatch_status (metadata only — never content). */
export interface JobStatusRow {
  jobId: string;
  kind: JobKind;
  role: string;
  label: string;
  elapsedMs: number;
  batchId?: string;
  batchProgress?: { completed: number; size: number };
  /** Set when the job is the /work driver's, not the PM's. */
  driverOwned?: true;
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
      out.push(job.ownerKind === "driver" ? { ...base, driverOwned: true } : base);
    }
  }
  return out;
}

/**
 * Kill one job by id (best-effort — AbortSignal propagates to spawnSpecialist).
 * An id that is no job but a registered inner child (an adversarial round or
 * lens child, keyed by the deck key `dispatch_peek` and the slow-run notice
 * print) is killed through its handle, so every id those surfaces show is
 * one this accepts.
 */
export function killJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (job) {
    job.abort.abort();
    return true;
  }
  const kill = childHandles.get(jobId)?.kill;
  if (!kill) return false;
  kill();
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
 * Kill exactly the given job ids (best-effort — an id absent from the
 * registry, e.g. already settled, is skipped; no error for unknown ids).
 * Returns the number of jobs actually aborted, so a caller can prove the
 * action's scope equals the set it was asked to kill (the agent-list
 * stop-all prompt counts the visible rows; `y` must abort that same set —
 * `killAllJobs` would abort registry jobs the list does not show: batch
 * orchestrators, non-deck driver children, jobs absent from the deck
 * maps).
 */
export function killJobs(keys: readonly string[]): number {
  let n = 0;
  for (const key of keys) {
    if (jobs.has(key) && killJob(key)) n++;
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
  // #799 — the deck mirrors the job state (one entry per job); drain it so a
  // drained test leaves the render surface empty. Quiet mode included — the
  // entries map holds data independent of the widget (see updateEntry).
  resetDeck();
}

/**
 * Register the session_shutdown handler that aborts in-flight async jobs.
 * Pi's only documented shutdown hook is `session_shutdown` (`session_end`
 * was a guess we dropped in #23); we register against the documented API
 * directly with proper typing instead of the previous `as unknown as` cast.
 */
export function registerAsyncJobsLifecycle(pi: ExtensionAPI): void {
  const piWithOn = pi as unknown as {
    on?: (
      event: "session_shutdown",
      handler: (event?: { reason?: string }) => Promise<void> | void,
    ) => void;
  };
  piWithOn.on?.("session_shutdown", (event) => {
    // FIRST, and synchronously: the /work driver reads this flag when its
    // aborted child comes back, and must find the reason already there — or
    // it blames the step for the abort below and starts a handoff it cannot
    // finish (session-shutdown.ts). The origin is what actually closed the
    // session (a signal, a dead stdin, or nothing observable): Pi's `reason`
    // is only `quit`/`reload` and does not say where the quit came from.
    const origin = exitOrigin();
    markSessionShutdown(event?.reason ?? "not given", origin);
    // Name what ended, why Pi says it ended, and where it came from: the bare
    // count and the bare reason left an operator with "aborted 1 in-flight
    // async jobs (reason: quit)" and no cause.
    const labels = [...jobs.values()].map((j) => j.label).join(", ");
    let n = 0;
    try {
      n = killAllJobs();
    } finally {
      // #1295 — the aborted jobs' reports will never reach this session: "0".
      // In a finally so a throw from killAllJobs cannot leave the count stuck.
      pendingJobs.shutdown();
    }
    if (n > 0) {
      trace(
        `session_shutdown (reason: ${event?.reason ?? "not given"}, origin: ${origin}): aborted ${n} in-flight async jobs — ${labels}`,
      );
    }
  });
}

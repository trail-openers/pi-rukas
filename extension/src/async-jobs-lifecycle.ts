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
import { incrementNotice } from "./notice-counter.ts";
import * as pendingJobs from "./pending-jobs-signal.ts";
import { markSessionShutdown } from "./session-shutdown.ts";
import { trace, traceWarn } from "./trace.ts";

/** The narrow host surface startJob / dispatch need: steer delivery only. */
export interface DispatchHost {
  sendUserMessage(text: string, options: { deliverAs: "steer" }): void;
}

/**
 * Push a report back to the parent agent. `deliverAs: "steer"` queues the
 * message during a streaming turn (delivered before the next LLM call) or
 * directly if the agent is idle.
 * #916 SLICE B: counts the delivery for the live view's "N new notices"
 * badge (reset on view open). The badge counts an ATTEMPTED delivery: the
 * increment runs before the send, so a host whose send throws still badges.
 *
 * #1389: the catch used to be a debug-gated `trace()` only, so a dropped report
 * was indistinguishable from a delivered one — to every caller and to the
 * pending count, which is how "0" came to be published for a report nobody
 * received. Pi makes this worse than it looks: the `ExtensionAPI` binding turns
 * a rejection from `AgentSession.prompt` into `runner.emitError` (agent-message
 * .ts), so the common failure never reaches a caller's try/catch either. Two
 * things now survive the swallow: an unconditional WARN (`traceWarn`, not
 * `PI_ENSEMBLE_DEBUG`-gated — an operator must see a report that changed an
 * outcome), and the return value — `true` when the send did not throw, `false`
 * when the host rejected it. The caller that made this send reads its own
 * result; no out-of-band tally is needed to answer a question this call
 * already knows the answer to.
 * Still never throws: `deliverStandIn` / `deliverOrStandIn` and the batch
 * settle are documented never to throw and depend on it.
 */
export function deliverReport(host: DispatchHost, report: string): boolean {
  incrementNotice();
  try {
    host.sendUserMessage(report, { deliverAs: "steer" });
    return true;
  } catch (err) {
    traceWarn(`async report delivery failed: ${String(err)}`);
    return false;
  }
}

/**
 * The one stand-in path for a settle that could not hand its report to Pi: deliver
 * `standIn(failure)` (naming the job or batch) so the caller's releaseAfter never drops
 * a count without a report. Never throws — a stand-in that also fails is reported
 * with both errors (unconditionally: it is the last thing this path can say), so
 * the caller can still release.
 *
 * #1389 — it REPORTS whether the stand-in reached the host. `deliverReport` cannot
 * throw, so a caller that must decide whether anything was handed over has no
 * try/catch to write; without a return value the batch settle could not tell "the
 * PM has been told something" from "nothing reached the PM and the count is about
 * to print 0". `false` is what the batch tail's last-resort WARN reads.
 */
export function deliverStandIn(
  host: DispatchHost,
  label: string,
  failure: unknown,
  standIn: (failure: unknown) => string,
): boolean {
  try {
    return deliverReport(host, standIn(failure));
  } catch (err) {
    traceWarn(
      `${label} stand-in report also failed: ${String(err)} (original: ${String(failure)})`,
    );
    return false;
  }
}

/**
 * Deliver `build()`; if building throws, fall back to the stand-in. Never throws.
 *
 * #1389: the build-failure line is a `traceWarn`, not a debug-gated `trace` — a
 * report the PM was promised and did not get is a fault, not a diagnostic, and
 * the criterion this closes is that no path publishes "0" with nothing handed
 * over.
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
    traceWarn(`${label} report failed: ${String(err)}`);
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
    // finish (session-shutdown.ts).
    markSessionShutdown(event?.reason ?? "not given");
    // Name what ended and why Pi says it ended: the bare count left an
    // operator with "aborted 1 in-flight async jobs" and no cause.
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
        `session_shutdown (reason: ${event?.reason ?? "not given"}): aborted ${n} in-flight async jobs — ${labels}`,
      );
    }
  });
}

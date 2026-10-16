import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DispatchHost, deliverReport, deliverStandIn } from "./async-jobs-lifecycle.ts";
import {
  type BatchMemberJobState,
  type BatchOrchestratorJobState,
  MAX_JOBS,
  childHandles,
  clearJobIssues,
  jobs,
  newJobId,
} from "./async-jobs-registry.ts";
import {
  type BatchReportInput,
  formatBatchReport,
  reportsGitState,
  totalTokens,
} from "./async-jobs-report.ts";
import { makeSlowWatch } from "./async-jobs-slow.ts";
import type { WorkHooks } from "./async-jobs.ts";
import * as live from "./dispatch-deck-live.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { type GitLineFor, gitStateLine } from "./git-state.ts";
import * as lifecycle from "./lifecycle-events.ts";
import { getFailedNotices, getNotices } from "./notice-counter.ts";
import * as pendingJobs from "./pending-jobs-signal.ts";
import * as sessionAutosave from "./session-autosave.ts";
import { feedSlowProgress } from "./slow-notice.ts";
import { trace, traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

interface StartBatchInput {
  batchLabel: string;
  /** Test seam for the git-state line; defaults to gitStateLine. */
  gitLineFor?: GitLineFor;
  members: Array<{
    label: string;
    role: string;
    /** #1015 — resolved member cwd; the developer/ops member's git-state line runs here. */
    cwd?: string;
    work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  }>;
}

/**
 * #1389 — did the `deliverReport` call made after `before` reach Pi?
 *
 * `deliverReport` cannot throw (its callers' never-throws contracts depend on
 * that), so the batch has no try/catch to write. The two counters in
 * notice-counter.ts are the out-of-band answer: attempts and failures, read as
 * a delta across the call — which is what makes a process-global pair safe,
 * since a failure some other deliverer recorded before the call cannot be
 * blamed on this send.
 */
function sendSucceeded(before: DeliveryTally): boolean {
  const after = deliveredAttempts();
  return after.attempts > before.attempts && after.failures === before.failures;
}

function deliveredAttempts(): DeliveryTally {
  return { attempts: getNotices(), failures: getFailedNotices() };
}

interface DeliveryTally {
  attempts: number;
  failures: number;
}

/**
 * #1015 — computes the git-state line for each developer/ops member (against its own
 * cwd; failed members and reviewers get none), then delivers the one batch steer.
 *
 * #1389 — `delivered` used to be set unconditionally after `send()`, and
 * `send()` calls `deliverReport`, which cannot throw: a host whose
 * `sendUserMessage` throws left the flag true on a message that never arrived,
 * so the batch released its pending slot to "0" with nothing handed over and no
 * witness. The flag now means what the comment always claimed — a send that did
 * not fail — and a failed send is answered by `settleBatch`'s stand-in, so a
 * batch never reaches "0" with neither a report nor a stand-in, and never sends
 * the same report twice.
 *
 * Rejects only when NOTHING was handed to Pi, so the caller can send a fallback.
 */
async function deliverBatchReport(
  pi: DispatchHost,
  head: { batchLabel: string; batchId: string; startedAt: number },
  memberResults: BatchReportInput["members"],
  gitMembers: Map<string, string | undefined>,
  gitLineFor: GitLineFor,
): Promise<void> {
  // Exactly one delivery. #1389 makes this three-valued, because two states could
  // not tell the two fallbacks apart: a send that reached Pi (true), one the host
  // rejected (false), and no send attempted at all (the pre-send default, which
  // the git-state failure below still answers with the unannotated report — the
  // pre-#1389 behaviour, unchanged). A rejected send must NOT take that fallback
  // (a second doomed send of the same content); deliverBatchReport's tail answers
  // it with the stand-in instead.
  let delivered: boolean | undefined = false;
  const send = (lines?: Map<string, string>) => {
    const members = memberResults.map((m) => ({
      ...m,
      gitLine: lines?.get(m.jobId),
    }));
    const before = deliveredAttempts();
    deliverReport(pi, formatBatchReport({ ...head, members }));
    delivered = sendSucceeded(before);
  };
  try {
    const lines = new Map<string, string>();
    await Promise.all(
      memberResults.map(async (m) => {
        if ("failed" in m.result || !gitMembers.has(m.jobId)) return;
        lines.set(m.jobId, await Promise.resolve().then(() => gitLineFor(gitMembers.get(m.jobId))));
      }),
    );
    send(lines);
  } catch (err) {
    trace(`async batch ${head.batchId} git-state report failed: ${String(err)}`);
    if (!delivered) send();
  }
  // #1389 — a send the host rejected is a report that does not exist. The
  // unannotated fallback above must NOT fire for it (that would be a second
  // doomed send of the same content), so the batch reports the failure once,
  // with a stand-in naming the batch, and never lets its pending slot drop to
  // "0" with neither a report nor a stand-in on the wire.
  if (delivered === false) {
    traceWarn(`async batch ${head.batchId} report delivery rejected by the host`);
    deliverStandIn(pi, `async batch ${head.batchId}`, new Error("sendUserMessage failed"), () =>
      batchDeliveryFailureReport(head.batchLabel, head.batchId),
    );
  }
}

/** The stand-in report for a batch whose settle threw before its report reached Pi. */
function batchFailureReport(batchLabel: string, batchId: string, err: unknown): string {
  return `[ensemble:async] Batch \`${batchLabel}\` (batch ${batchId}) FAILED — its report could not be built: ${String(err)}. Its members' results are lost; re-dispatch the batch if they are still needed.`;
}

/**
 * #1389 — the stand-in for a batch whose report was built but whose send the host
 * rejected. Distinct from `batchFailureReport`: the members' results are NOT lost
 * here (they were formatted, and the transcripts still hold them) — only the
 * delivery failed, so the line says that instead of telling the PM to re-run a
 * batch that already ran.
 */
function batchDeliveryFailureReport(batchLabel: string, batchId: string): string {
  return `[ensemble:async] Batch \`${batchLabel}\` (batch ${batchId}) FINISHED but its report could not be delivered — the host rejected the message. Its members ran; their results are in /runs, not in this session. Re-read the transcripts rather than re-dispatching the batch.`;
}

/**
 * The batch's settle: closes the lifecycle row and hands the ONE consolidated report
 * to Pi. Runs under releaseAfter, so the count drops to 0 only after this returns. If
 * the body throws before the report is handed over, a failure report naming the batch
 * is delivered instead — the PM is never left with a silent drop to 0.
 */
async function settleBatch(
  pi: DispatchHost,
  input: StartBatchInput,
  batchId: string,
  startedAt: number,
  memberResults: BatchReportInput["members"],
  gitMembers: Map<string, string | undefined>,
): Promise<void> {
  try {
    jobs.delete(batchId);
    dispatchDeck.clearBatchEntry(batchId);
    const batchMs = Date.now() - startedAt;
    const anyFailed = memberResults.some((m) => "failed" in m.result || !m.result.ok);
    const tokens = memberResults.reduce((acc, m) => {
      if ("failed" in m.result) return acc;
      return acc + totalTokens(m.result);
    }, 0);
    if (anyFailed) {
      lifecycle.emitFailed(batchId, input.batchLabel, input.batchLabel, batchMs);
    } else {
      lifecycle.emitCompleted(batchId, input.batchLabel, input.batchLabel, batchMs, tokens);
    }
    await deliverBatchReport(
      pi,
      { batchLabel: input.batchLabel, batchId, startedAt },
      memberResults,
      gitMembers,
      input.gitLineFor ?? gitStateLine,
    );
    trace(`async batch ${batchId} (${input.batchLabel}) finished in ${Date.now() - startedAt}ms`);
  } catch (err) {
    trace(`async batch ${batchId} (${input.batchLabel}) report failed: ${String(err)}`);
    deliverStandIn(pi, `async batch ${batchId}`, err, (e) =>
      batchFailureReport(input.batchLabel, batchId, e),
    );
  }
}

/**
 * Fire a batch: spawn all members concurrently, but deliver ONE steer message
 * when ALL members have settled. This preserves the parent's "I called the
 * tool, I expect one return" mental model — async-batched, not async-N-arrivals.
 */
export function startBatch(
  pi: ExtensionAPI,
  input: StartBatchInput,
): { batchId: string; jobIds: string[] } {
  // An empty batch would never settle (no member completes the orchestrator), so
  // it would hold its pending slot forever. Refuse it up-front.
  if (input.members.length === 0) {
    throw new Error("async-jobs: refusing to start an empty batch (no members).");
  }
  // Batch slot count: 1 orchestrator + N members. Reject up-front rather than
  // letting some members land and others fail mid-construction.
  const required = 1 + input.members.length;
  if (jobs.size + required > MAX_JOBS) {
    throw new Error(
      `async-jobs: refusing to start batch of ${input.members.length} members — would exceed cap (in-flight=${jobs.size}, required=${required}, cap=${MAX_JOBS}). Check 'dispatch_status' or restart Pi.`,
    );
  }
  const batchId = newJobId();
  const startedAt = Date.now();
  const orchestratorAbort = new AbortController();
  const orchestrator: BatchOrchestratorJobState = {
    kind: "batch-orchestrator",
    jobId: batchId,
    role: input.batchLabel,
    label: input.batchLabel,
    startedAt,
    abort: orchestratorAbort,
    size: input.members.length,
    completed: 0,
  };
  jobs.set(batchId, orchestrator);
  lifecycle.emitDispatched(batchId, input.batchLabel, input.batchLabel);

  // Persistent batch summary row (#139). Registered BEFORE members so its
  // seq is lowest and Pi's alphabetical sort places it first on the footer.
  // The label collapses uniform-role batches to "<role>×N" and mixed batches
  // to a generic count; users get e.g. "batch[explore×3]" or "batch[mixed×3]".
  const uniqueRoles = new Set(input.members.map((m) => m.role));
  const batchDeckLabel =
    uniqueRoles.size === 1
      ? `${[...uniqueRoles][0]}×${input.members.length}`
      : `mixed×${input.members.length}`;
  dispatchDeck.startBatchEntry(batchId, {
    label: batchDeckLabel,
    size: input.members.length,
  });

  const memberJobIds: string[] = [];
  const memberResults: BatchReportInput["members"] = [];
  // #1015 — developer/ops members only, keyed by jobId, value = dispatch cwd.
  const gitMembers = new Map<string, string | undefined>();
  // #1389 — everything the loop below registered per member, so its catch can
  // undo exactly what was done. A member that started has an in-flight `work`
  // promise whose `.then/.finally` still runs after the setup error reaches the
  // caller — it would advance `orchestrator.completed` and settle a batch that
  // never started — so each carries the slow-watch `stop` and reads the dead
  // flag off its own registry state (`killedBySetupFailure`).
  const startedMembers: Array<{ jobId: string; stop: () => void }> = [];

  try {
    for (const m of input.members) {
      const jobId = newJobId();
      memberJobIds.push(jobId);
      const memberAbort = new AbortController();
      // If the orchestrator aborts (e.g., session_end), cascade to all members.
      orchestratorAbort.signal.addEventListener("abort", () => memberAbort.abort(), { once: true });
      const memberState: BatchMemberJobState = {
        kind: "batch-member",
        jobId,
        role: m.role,
        label: m.label,
        startedAt,
        abort: memberAbort,
        batchId,
      };
      jobs.set(jobId, memberState);
      if (reportsGitState(m.role)) gitMembers.set(jobId, m.cwd);

      dispatchDeck.startEntry(jobId, {
        label: m.label,
        role: m.role,
        batchKey: batchId,
      });
      live.startBuffer(jobId);
      sessionAutosave.recordDispatch(m.role);
      // #799/#907 — batch members get the same watch + span feed as single
      // jobs (the batch orchestrator itself gets none — it is a bookkeeping row, not a child).
      const memberSlow = makeSlowWatch(jobId, m.role, m.label, pi, undefined);
      startedMembers.push({ jobId, stop: memberSlow.stop });
      const memberHooks: WorkHooks = {
        onProgress: (progress) => {
          dispatchDeck.updateEntry(jobId, progress);
          feedSlowProgress(jobId, progress);
        },
        onRawEvent: memberSlow.hooks.onRawEvent,
        onStdin: (stdin) => {
          childHandles.set(jobId, { stdin, label: m.label, role: m.role });
        },
        jobId,
      };

      // Wrapping in `new Promise` turns a SYNCHRONOUS throw from `m.work` into
      // a rejection that settles through the handlers below (as async failures
      // already do) — no separate synchronous-throw path.
      void new Promise<DispatchResult>((resolve) =>
        resolve(m.work(memberAbort.signal, memberHooks)),
      )
        .then(
          (result) => {
            if (memberState.killedBySetupFailure) return;
            jobs.delete(jobId);
            childHandles.delete(jobId);
            memberSlow.stop();
            // #916 — settle outcome for the live view (member finished).
            live.markSettled(jobId, "finished");
            dispatchDeck.clearEntry(jobId);
            sessionAutosave.recordOutcome(result.ok);
            memberResults.push({ jobId, label: m.label, result });
          },
          (err: Error) => {
            if (memberState.killedBySetupFailure) return;
            jobs.delete(jobId);
            childHandles.delete(jobId);
            memberSlow.stop();
            // #916 — settle outcome for the live view (member rejected).
            live.markSettled(jobId, "failed");
            dispatchDeck.clearEntry(jobId);
            sessionAutosave.recordOutcome(false);
            memberResults.push({
              jobId,
              label: m.label,
              result: { failed: true, error: err.message },
            });
          },
        )
        .finally(() => {
          // A member killed by the setup-failure path below is not a member of a
          // batch that ever existed: it must not advance the counter, and must not
          // complete a batch that has already errored to its caller.
          if (memberState.killedBySetupFailure) return;
          orchestrator.completed++;
          // Advance the batch row's counter so the user sees "1/3 done · 2 running".
          dispatchDeck.updateBatchProgress(batchId, orchestrator.completed);
          if (orchestrator.completed === orchestrator.size) {
            // Single delivery: settleBatch is the batch's only steer. The whole
            // settle runs under releaseAfter so the batch is released on every path.
            void pendingJobs
              .releaseAfter(batchId, () =>
                settleBatch(pi, input, batchId, startedAt, memberResults, gitMembers),
              )
              .catch((err: unknown) =>
                trace(`async batch ${batchId} (${input.batchLabel}) settle failed: ${String(err)}`),
              );
          }
        });
    }
  } catch (err) {
    // A throw partway through setup: abort the members already started (the cascade
    // above reaches only those), take them out of every surface they were
    // registered on, and close the orchestrator row. Nothing is owed yet
    // (jobPending runs after this loop) and the aborted members can never complete
    // the batch, so no report is produced; the caller gets the error.
    // Cleanup runs in its own try: a cleanup throw must not replace the original error.
    try {
      orchestratorAbort.abort();
      // #1389 — the abort alone left the started members in `jobs` (so
      // dispatch_status reported slots in flight and killAllJobs counted children
      // that no longer existed), in the deck as rows nothing would clear, and in
      // the live buffers — where dispatch-deck-confirm.ts will open a live view
      // for any key that still has a buffer, even with the deck row gone. Each
      // member is marked dead FIRST so its in-flight settle does no bookkeeping
      // on a batch the caller has already been told about.
      for (const started of startedMembers) {
        const state = jobs.get(started.jobId);
        if (state?.kind === "batch-member") state.killedBySetupFailure = true;
      }
      for (const started of startedMembers) {
        started.stop();
        childHandles.delete(started.jobId);
        clearJobIssues(started.jobId);
        // clearEntry also releases the ring buffer (releaseOnEntryClear), and is
        // a no-op on the row under PI_ENSEMBLE_QUIET_STATUS — dropBuffer is not,
        // which is why both are called and why the buffer is the quiet-proof
        // surface the test asserts on.
        dispatchDeck.clearEntry(started.jobId);
        live.dropBuffer(started.jobId);
        jobs.delete(started.jobId);
      }
      jobs.delete(batchId);
      dispatchDeck.clearBatchEntry(batchId);
      lifecycle.emitFailed(batchId, input.batchLabel, input.batchLabel, Date.now() - startedAt);
    } catch (cleanupErr) {
      trace(`async batch ${batchId} (${input.batchLabel}) cleanup failed: ${String(cleanupErr)}`);
    }
    trace(`async batch ${batchId} (${input.batchLabel}) setup failed: ${String(err)}`);
    throw err;
  }

  // #1295 — one batch, one report: counted once, not per member. Marked AFTER the
  // member loop: a throw during member setup leaves the count untouched, and no
  // member can settle before this line (their settle callbacks are always async).
  pendingJobs.jobPending(batchId, "pm");
  trace(`async batch ${batchId} (${input.batchLabel}, n=${input.members.length}) started`);
  return { batchId, jobIds: memberJobIds };
}

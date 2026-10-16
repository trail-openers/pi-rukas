import type { Writable } from "node:stream";
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
import { getNotices } from "./notice-counter.ts";
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
 * #1389 — a batch member's handle exists from the moment the member is
 * registered, but the real stdin only appears when the child spawns. Until then
 * the slot carries this: a `Writable` that does nothing, because nothing is
 * reading it. `dispatch_steer` writes an RPC frame to a handle it believes is
 * live, so a member killed before its spawn must not have a real stream there —
 * and `ChildHandle.stdin` is not optional, so something has to occupy the field.
 */
function deadStdin(): Writable {
  return {
    write: () => true,
    end: () => deadStdin(),
    destroyed: true,
    writable: false,
  } as unknown as Writable;
}

/**
 * #1389 — the state of the batch's one send. Three values because the two
 * fallbacks answer different failures and must not be confused: `"sent"` the
 * host accepted it; `"rejected"` the host threw (a second doomed send of the
 * same content is pointless — the stand-in answers it); `"not-attempted"` the
 * pre-send default, which the git-state failure below still answers with the
 * unannotated report (the pre-#1389 behaviour, unchanged).
 */
type BatchSendState = "sent" | "rejected" | "not-attempted";

/**
 * #1015 — computes the git-state line for each developer/ops member (against its own
 * cwd; failed members and reviewers get none), then delivers the one batch steer.
 *
 * #1389 — `delivered` used to be set unconditionally after `send()`, and
 * `send()` called `deliverReport`, which cannot throw: a host whose
 * `sendUserMessage` throws left the flag true on a message that never arrived,
 * so the batch released its pending slot to "0" with nothing handed over and no
 * witness. The state now comes from `deliverReport`'s own return value — the
 * batch reads the result of the call it made, not a counter some other
 * deliverer may have moved — and a rejected send is answered by `settleBatch`'s
 * stand-in, so a batch never reaches "0" with neither a report nor a stand-in,
 * and never sends the same report twice.
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
  // Exactly one delivery, in one of the three states above. The state lives in an
  // object rather than a closure-assigned `let`: control-flow analysis narrows a
  // captured union variable to its initialiser and then reports the tail's
  // `"rejected"` comparison as impossible. `error` is what the host actually threw
  // — `deliverReport` swallows it behind its never-throws contract, so this is the
  // only place the real cause survives, and the stand-in's WARN reads it.
  const sendState: { value: BatchSendState; error?: unknown } = { value: "not-attempted" };
  const send = (lines?: Map<string, string>) => {
    const members = memberResults.map((m) => ({
      ...m,
      gitLine: lines?.get(m.jobId),
    }));
    // `getNotices` is read only to confirm the attempt was counted for the badge
    // before the send ran. The OUTCOME is `sent` — the return value of this very
    // call, which is what replaced the #1389 global-counter delta.
    const attemptsBefore = getNotices();
    let sent = false;
    try {
      sent = deliverReport(pi, formatBatchReport({ ...head, members }));
    } catch (err) {
      // Cannot happen against the documented contract (deliverReport never
      // throws) but a host that broke it must not take down the batch settle.
      sendState.error = err;
    }
    const attempted = getNotices() > attemptsBefore;
    sendState.value = attempted ? (sent ? "sent" : "rejected") : "not-attempted";
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
    if (sendState.value === "not-attempted") send();
  }
  // #1389 — a send the host rejected is a report that does not exist. The
  // unannotated fallback above must NOT fire for it (that would be a second
  // doomed send of the same content), so the batch reports the failure once,
  // with a stand-in naming the batch, and never lets its pending slot drop to
  // "0" with neither a report nor a stand-in on the wire.
  if (sendState.value === "rejected") {
    traceWarn(`async batch ${head.batchId} report delivery rejected by the host`);
    const standInLanded = deliverStandIn(pi, `async batch ${head.batchId}`, sendState.error, () =>
      batchDeliveryFailureReport(head.batchLabel, head.batchId),
    );
    // #1389 — the last honest word. A rejected report AND a rejected stand-in
    // means `releaseAfter` is about to print "0" on a session that received
    // neither message, which is the exact lie this ticket exists to close. The
    // count still has to drop (a bound must not strand it), but the channel's
    // "nothing is coming" is now contradicted on stderr, in a line naming the
    // batch — not left as silence indistinguishable from a clean delivery.
    if (!standInLanded) {
      traceWarn(
        `async batch ${head.batchId} handed Pi NOTHING: the report and its stand-in were both rejected — the pending count will reach 0 with no message delivered`,
      );
    }
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
  const startedMembers: Array<{
    jobId: string;
    stop: () => void;
    state: BatchMemberJobState;
  }> = [];

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
      // #1389 — the member's handle is registered HERE, not only in `onStdin`
      // below. A member killed by a partway setup failure may never have reached
      // the spawn, and `onStdin` fires only once `child.stdin` exists — so with
      // the handle created there, the teardown had no `kill` to call on exactly
      // the member it most needed to stop, and deleted a map entry that was never
      // written. The abort IS a batch member's kill (same contract as a
      // startJob child, whose job abort is its kill), so `kill` aborts this
      // member directly. `onStdin` fills in the real stdin when the child
      // appears; `killJob` still short-circuits on the job entry while it exists.
      childHandles.set(jobId, {
        stdin: deadStdin(),
        label: m.label,
        role: m.role,
        kill: () => memberAbort.abort(),
      });
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
      startedMembers.push({ jobId, stop: memberSlow.stop, state: memberState });
      const memberHooks: WorkHooks = {
        onProgress: (progress) => {
          dispatchDeck.updateEntry(jobId, progress);
          feedSlowProgress(jobId, progress);
        },
        // #1389 — gated on the dead flag: once the setup-failure path has torn this
        // member down, a late raw event must not re-create the live buffer it just
        // dropped (`feedRawEvent` no-ops on an absent key, so an un-gated feed
        // would silently re-register the member as an openable empty live view).
        onRawEvent: (event) => {
          if (memberState.killedBySetupFailure) return;
          memberSlow.hooks.onRawEvent(event);
        },
        onStdin: (stdin) => {
          // Keep the `kill` the registration above installed — dropping it here
          // would silently make a spawned member unkillsble by the teardown.
          const previous = childHandles.get(jobId);
          childHandles.set(jobId, {
            stdin,
            label: m.label,
            role: m.role,
            ...(previous?.kill ? { kill: previous.kill } : {}),
          });
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
          // complete a batch that has already errored to its caller. `completed`
          // is what settles a batch, so this guard — not the two `.then` guards
          // above — is what stops a half-started batch from delivering a report.
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
      // for any key that still has a buffer, even with the deck row gone. ONE
      // loop per member: mark it dead first (so its in-flight settle does no
      // bookkeeping on a batch the caller has already been told about), then tear
      // down everything it registered. Each step is guarded on the member that is
      // actually gone — a child which never registered stdin has no handle to
      // kill, a buffer the deck already released does not need dropping again —
      // and one member's teardown throw cannot strand the members after it.
      for (const started of startedMembers) {
        try {
          started.state.killedBySetupFailure = true;
          started.stop();
          // kill() only exists for a child that actually spawned and registered
          // a handle; aborting a member whose work never started a child must not
          // reach for one it does not have.
          if (childHandles.has(started.jobId)) {
            childHandles.get(started.jobId)?.kill?.();
            childHandles.delete(started.jobId);
          }
          // Only for a member that really registered in the registry.
          if (jobs.has(started.jobId)) {
            clearJobIssues(started.jobId);
            // clearEntry also releases the ring buffer (releaseOnEntryClear), and is
            // a no-op on the row under PI_ENSEMBLE_QUIET_STATUS — dropBuffer is not,
            // which is why both are called and why the buffer is the quiet-proof
            // surface the test asserts on.
            dispatchDeck.clearEntry(started.jobId);
            live.dropBuffer(started.jobId);
            jobs.delete(started.jobId);
          }
        } catch (memberErr) {
          traceWarn(
            `async batch ${batchId} member ${started.jobId} cleanup failed: ${String(memberErr)}`,
          );
        }
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

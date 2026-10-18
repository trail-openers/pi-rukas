import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  batchDeliveryFailureReport,
  batchFailureReport,
  deadStdin,
  deliverBatchReport,
} from "./async-jobs-batch-delivery.ts";
import type { WorkHooks } from "./async-jobs-input.ts";
import { type DispatchHost, deliverStandIn } from "./async-jobs-lifecycle.ts";
import {
  type BatchMemberJobState,
  type BatchOrchestratorJobState,
  MAX_JOBS,
  childHandles,
  clearJobIssues,
  jobs,
  newJobId,
} from "./async-jobs-registry.ts";
import { type BatchReportInput, reportsGitState, totalTokens } from "./async-jobs-report.ts";
import { makeSlowWatch } from "./async-jobs-slow.ts";
import * as live from "./dispatch-deck-live.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { type GitLineFor, gitStateLine } from "./git-state.ts";
import * as lifecycle from "./lifecycle-events.ts";
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
 * #1389 — take ONE batch member off every surface it registered on, in one
 * place. Called from three sites that used to carry their own copy of the list
 * and drifted apart: the setup-failure teardown, and the two settle handlers
 * (resolved / rejected). The surfaces are the ones a leaked member is visible
 * on — `dispatch_status` (the registry), `dispatch_kill`/`dispatch_steer` (the
 * child handle), the footer (the deck row, whose clear also releases the ring
 * buffer) and the live view (the buffer itself, which `clearEntry` does NOT
 * drop under `PI_ENSEMBLE_QUIET_STATUS`). A fourth site is `stop` — the slow-run
 * watch, which is per-member state the caller holds, not a module map, so it
 * stays a parameter.
 *
 * Every step is guarded on the member that is actually gone: a child that never
 * registered stdin has no handle to kill, a registry entry the deck already
 * released does not need dropping twice — and one member's throw cannot strand
 * the members after it (each caller wraps this in its own `try`).
 */
function releaseBatchMember(
  jobId: string,
  stop: () => void,
  settle: "finished" | "failed" | "killed",
): void {
  stop();
  // kill() only exists for a child that actually spawned and registered a
  // handle; a member whose work never started a child must not reach for one.
  if (childHandles.has(jobId)) {
    childHandles.get(jobId)?.kill?.();
    childHandles.delete(jobId);
  }
  // Only for a member that really registered in the registry.
  if (jobs.has(jobId)) {
    clearJobIssues(jobId);
    // #916 — the settle outcome for the live view, recorded while the buffer
    // still exists: the teardown below drops it, and an absent buffer keeps no
    // status. The settle handlers pass "finished"/"failed"; the teardown passes
    // "failed" — a member killed by a setup failure never ran.
    live.markSettled(jobId, settle);
    // clearEntry also releases the ring buffer (releaseOnEntryClear), and is a
    // no-op on the row under PI_ENSEMBLE_QUIET_STATUS — dropBuffer is not, which
    // is why both are called and why the buffer is the quiet-proof surface the
    // teardown test asserts on.
    dispatchDeck.clearEntry(jobId);
    live.dropBuffer(jobId);
    jobs.delete(jobId);
  }
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
    // #1389 — every read of a member's `usage` is a read of UNTRUSTED data a
    // child produced, so the whole pre-report block sits in its own try: a
    // getter that throws here must land in the same stand-in path as a report
    // that could not be built, not escape to the outer catch. Before this the
    // token sum below threw first and the batch's own delivery accounting — the
    // WARN that says the count is about to print 0 with nothing handed over —
    // was never reached.
    let tokens = 0;
    try {
      tokens = memberResults.reduce((acc, m) => {
        if ("failed" in m.result) return acc;
        return acc + totalTokens(m.result);
      }, 0);
    } catch {
      tokens = 0;
    }
    if (anyFailed) {
      lifecycle.emitFailed(batchId, input.batchLabel, input.batchLabel, batchMs);
    } else {
      lifecycle.emitCompleted(batchId, input.batchLabel, input.batchLabel, batchMs, tokens);
    }
    // #1389 — the tail that used to be missing, and the reason `deliverBatchReport`
    // now returns an answer at all: the settle asks the only question that
    // survives every branch — did anything reach this batch's host? — and
    // records the answer. It does NOT send anything here. The "nothing reached
    // Pi" line is printed by `deliverBatchReport` itself, which is the only
    // place that knows whether the report, a stand-in, or neither reached the
    // host. A second stand-in from this site is the bug this comment replaces:
    // the rejected-send path had already sent its own stand-in, so the batch
    // handed over the report AND a "could not be built" line, and the count's
    // release ordering was decided by a send nobody had promised.
    const handedOver = await deliverBatchReport(
      pi,
      { batchLabel: input.batchLabel, batchId, startedAt },
      memberResults,
      gitMembers,
      input.gitLineFor ?? gitStateLine,
    );
    if (!handedOver) {
      trace(`async batch ${batchId} (${input.batchLabel}) reached Pi with no report`);
    }
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
      // Guarded, not unconditional: `childHandles` outlives the `jobs` entry on
      // the QUIET_STATUS path (`clearEntry`, and so `releaseBatchMember`, is a
      // no-op there while its `childHandles.delete` still runs on the live path),
      // so an id that is reused — by a collision in `newJobId`, which is
      // date-plus-6-random-base36 — would otherwise have its `kill` overwritten
      // by a fresh member and a still-running child silently lose its only
      // handle. Refusing the collision keeps the older, load-bearing entry.
      if (!childHandles.has(jobId)) {
        childHandles.set(jobId, {
          stdin: deadStdin(),
          label: m.label,
          role: m.role,
          kill: () => memberAbort.abort(),
        });
      }
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
        // #1389 — gated on the same dead flag as `onRawEvent` below. Once the
        // setup-failure path has torn this member down, a late progress frame
        // must not re-arm the surfaces it just released: `updateEntry` re-fills
        // the state of a deck row that was cleared (so it reappears whenever a
        // neighbour keeps the render scheduled) and `feedSlowProgress` stamps a
        // `lastState` on a watch that was stopped.
        onProgress: (progress) => {
          if (memberState.killedBySetupFailure) return;
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
            // #916 — the settle outcome for the live view (member finished).
            releaseBatchMember(jobId, memberSlow.stop, "finished");
            sessionAutosave.recordOutcome(result.ok);
            memberResults.push({ jobId, label: m.label, result });
          },
          (err: Error) => {
            if (memberState.killedBySetupFailure) return;
            // #916 — settle outcome for the live view (member rejected).
            releaseBatchMember(jobId, memberSlow.stop, "failed");
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
          // One call, the same release the settle handlers use — so the three
          // sites cannot disagree about which surfaces a member was on.
          releaseBatchMember(started.jobId, started.stop, "failed");
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

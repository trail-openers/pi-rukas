import type { StartJobHandle, StartJobInput, WorkHooks } from "./async-jobs-input.ts";
import { type DispatchHost, deliverOrStandIn, deliverStandIn } from "./async-jobs-lifecycle.ts";
import {
  MAX_JOBS,
  type SingleJobState,
  childHandles,
  clearJobIssues,
  getJobIssues,
  jobs,
  newJobId,
} from "./async-jobs-registry.ts";
import {
  driverReportStandIn,
  formatDriverReport,
  formatFailReport,
  formatSingleReport,
  reportsGitState,
  totalTokens,
} from "./async-jobs-report.ts";
import { makeSlowWatch } from "./async-jobs-slow.ts";
import * as live from "./dispatch-deck-live.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { gitStateLine } from "./git-state.ts";
import * as lifecycle from "./lifecycle-events.ts";
import * as pendingJobs from "./pending-jobs-signal.ts";
import * as sessionAutosave from "./session-autosave.ts";
import { feedSlowProgress } from "./slow-notice.ts";
import { trace } from "./trace.ts";
import { type DispatchResult, isRateLimit429Msg } from "./types.ts";

export {
  driverReportStandIn,
  formatDriverReport,
  formatSingleReport,
} from "./async-jobs-report.ts";
export { startBatch } from "./async-jobs-batch.ts";
export {
  getChildHandle,
  getJobIssues,
  DRIVER_OWNED_NOTICE,
  getOrchestratorActiveChild,
  isDriverOwnedJob,
  isOrchestratorJob,
  markOrchestrator,
  setOrchestratorActiveChild,
} from "./async-jobs-registry.ts";
export {
  type JobStatusRow,
  clearJobsForTesting,
  jobStatusSnapshot,
  killAllJobs,
  killJob,
  registerAsyncJobsLifecycle,
} from "./async-jobs-lifecycle.ts";

/**
 * Async-dispatch job registry.
 *
 * Every dispatch tool is fire-and-forget from the LLM's POV: the tool returns
 * a `{ jobId }` handle immediately, the child runs in the background under our
 * supervision, and on completion we push the result back to the parent agent
 * via `pi.sendUserMessage(report, { deliverAs: "steer" })`. Pi delivers the
 * steer as a fresh user turn → new `agent_start` → parent picks up.
 *
 * Why this matters: a synchronous tool call locks the user out of the parent
 * for the full duration of the dispatch (often minutes). Async means the user
 * can interact with the parent at any time while children run in the background.
 *
 * Invariants enforced here (see issue #19):
 *   1. The parent agent ONLY ever sees the child's final assistant text in the
 *      steer report — never the full transcript, never per-turn output.
 *   2. The report header is ~100 chars (jobId, role, turns, elapsed, cost).
 *      Going async adds zero context bloat over sync dispatch.
 *   3. Batched orchestrators (dispatch_parallel, lens review) fire a SINGLE
 *      steer when ALL children complete — never N out-of-order arrivals.
 */

/**
 * The job-input contract lives in async-jobs-input.ts (WorkHooks, StartJobInput,
 * StartJobHandle). Re-exported so every existing `from "./async-jobs.ts"` import
 * of these types keeps working — async-jobs-batch.ts imports WorkHooks, and the
 * dispatch tools import StartJobHandle through here.
 */
export type { StartJobHandle, StartJobInput, WorkHooks } from "./async-jobs-input.ts";

/** The stand-in for a single job whose report could not be built or handed to Pi. */
function jobStandIn(jobId: string, label: string, err: unknown): string {
  return `[ensemble:async] Job \`${label}\` (job ${jobId}) FAILED \u2014 its report could not be built: ${String(err)}. Its result is lost; re-dispatch the job if it is still needed.`;
}

/**
 * Fire a single async job. Returns immediately with the jobId; the tool's
 * execute() should also return immediately. The report is delivered to the
 * parent via pi.sendUserMessage when the work resolves — UNLESS
 * `input.ownerKind === "driver"`, in which case the in-process caller
 * consumes the result via the `completion` promise and the steer is skipped.
 */
export function startJob(pi: DispatchHost, input: StartJobInput): StartJobHandle {
  if (jobs.size >= MAX_JOBS) {
    throw new Error(
      `async-jobs: refusing to start job — ${jobs.size} jobs already in flight (cap ${MAX_JOBS}). This usually indicates a stuck settle path; check 'dispatch_status' or restart Pi.`,
    );
  }
  const ownerKind: "pm" | "driver" = input.ownerKind ?? "pm";
  // #1541 review (HIGH) — the `reportKind === "driver"` branch below delivers
  // its steer WITHOUT the `ownerKind === "pm"` gate every sibling path has, so
  // `ownerKind` decided only the badges and the pending-count for these jobs.
  // That is safe only while one invariant holds: a driver-shaped report is a
  // tool-launched pipeline (plan / research) whose ONLY consumer is the PM's
  // steer, so it is always PM-owned. A `reportKind: "driver"` job marked
  // driver-owned would deliver a duplicate `[ensemble:async]` to a PM that
  // never asked for one, or — if the gate were added naively — deliver nothing
  // at all and leave the caller holding a promise no operator ever reads.
  // Refuse the combination at the door rather than carry the invariant as
  // folklore.
  if (input.reportKind === "driver" && ownerKind !== "pm") {
    throw new Error(
      `async-jobs: reportKind "driver" requires ownerKind "pm" (got "${ownerKind}") — a driver-shaped report is delivered to the PM as the run's only result; an in-process caller consumes the completion promise instead.`,
    );
  }
  const jobId = newJobId();
  const abort = new AbortController();
  const state: SingleJobState = {
    kind: "single",
    jobId,
    role: input.role,
    label: input.label,
    startedAt: Date.now(),
    abort,
    ownerKind,
  };
  jobs.set(jobId, state);

  if (!input.skipDeck) {
    dispatchDeck.startEntry(jobId, {
      label: input.deckLabel ?? input.label,
      role: input.role,
      batchKey: input.batchKey,
    });
  }
  lifecycle.emitDispatched(jobId, input.label, input.role);
  sessionAutosave.recordDispatch(input.role);

  if (!input.skipDeck) live.startBuffer(jobId);
  // #799/#907 — the slow-run watch + its CI-wait span feed: one per job,
  // at the one layer that sees progress for every PM job, batch member
  // and driver child. Notice + steer, never a kill. disabled entirely by
  // PI_ENSEMBLE_SLOW_NOTICE=0.
  const slow = makeSlowWatch(
    jobId,
    input.role,
    input.label,
    pi,
    input.onSlow,
    ownerKind === "driver",
  );
  const hooks: WorkHooks = {
    onProgress: (progress) => {
      dispatchDeck.updateEntry(jobId, progress);
      feedSlowProgress(jobId, progress);
    },
    onRawEvent: slow.hooks.onRawEvent,
    onStdin: (stdin) => {
      childHandles.set(jobId, { stdin, label: input.label, role: input.role });
    },
    jobId,
  };

  // #1295 — marked only once setup has succeeded, so a throw above never leaves
  // a job owed. The owner rule (driver-owned never counts) lives in jobPending.
  pendingJobs.jobPending(jobId, ownerKind);

  // Wrapping in `new Promise` turns a SYNCHRONOUS throw from `input.work`
  // into a rejection that flows through the handlers below (as async
  // failures already do) — no separate synchronous-throw path.
  const completion = new Promise<DispatchResult>((resolve) =>
    resolve(input.work(abort.signal, hooks)),
  ).then(
    (result) =>
      pendingJobs.releaseAfter(jobId, async () => {
        try {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          clearJobIssues(jobId);
          slow.stop();
          // #916 — record the settle outcome for the live view (kill → killed,
          // any error stop → failed, ok → finished). Deliberately coarser than
          // the lifecycle's five-way classification: the header only needs the
          // three operator-visible states.
          const status = result.killCause ? "killed" : result.errorStop ? "failed" : "finished";
          live.markSettled(jobId, status);
          if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
          // Five-way: ok / killCause / 429 / FAILED-PROVIDER-ERROR / process-exit-failed.
          // #309/#314 — killCause (#296) wins over errorStop. A self-kill is NOT a
          // provider/transport error and must not emit the "terminated mid-stream" badge.
          // Uses shared isRateLimit429Msg (types.ts) so lifecycle + formatSingleReport
          // cannot disagree on what is a 429.
          const is429 = result.errorStop && isRateLimit429Msg(result.errorStop.message);
          if (result.killCause) {
            // Self-kill: treat as process-level failure, not provider error.
            lifecycle.emitFailed(
              jobId,
              input.label,
              input.role,
              result.ms,
              result.exitCode ?? undefined,
            );
          } else if (result.errorStop && !is429) {
            // Genuine provider/transport error (not 429).
            // #299 — driver-owned jobs skip the per-child "terminated
            // mid-stream" line: the driver emits its own step-failed /
            // step-retry line for the same event, and pre-#299 a single
            // error-stop produced three provider-blame lines in scrollback.
            if (ownerKind === "pm") {
              lifecycle.emitErrored(jobId, input.label, input.role, result.ms, totalTokens(result));
            }
          } else if (is429) {
            // #309 — 429 with ok=true must NOT emit a "finished" badge.
            // The child technically exited ok (it produced output), but the
            // provider rate-limited the request. Emit as failed so the
            // operator sees a consistent failure signal.
            lifecycle.emitFailed(
              jobId,
              input.label,
              input.role,
              result.ms,
              result.exitCode ?? undefined,
            );
          } else if (result.ok) {
            lifecycle.emitCompleted(jobId, input.label, input.role, result.ms, totalTokens(result));
          } else {
            lifecycle.emitFailed(
              jobId,
              input.label,
              input.role,
              result.ms,
              result.exitCode ?? undefined,
            );
          }
          sessionAutosave.recordOutcome(result.ok);
        } catch (settleErr) {
          // The settle threw before its report reached Pi: the PM is still owed one.
          trace(`async job ${jobId} (${input.label}) settle failed: ${String(settleErr)}`);
          if (ownerKind === "pm") {
            deliverStandIn(pi, `async job ${jobId}`, settleErr, (e) =>
              jobStandIn(jobId, input.label, e),
            );
          }
          return result;
        }
        // #1044 — a driver-shaped job has no subagent to describe: its text IS
        // the report body, so it skips the git-state read and the five-way
        // outcome headline entirely. Both ways this branch can fail to hand the
        // report over — `formatDriverReport` throwing, or the host refusing the
        // steer — are routed through the ONE helper, so neither strands the
        // promised steer (#1541 review round 4 HIGH: the branch used to call
        // `deliver(build())` outside any try, so a throwing formatter escaped
        // without a stand-in).
        if (input.reportKind === "driver") {
          const build = () =>
            formatDriverReport(jobId, input.label, input.subject ?? input.label, result.text ?? "");
          // #1541 review (MEDIUM) — the boolean `deliverReport` returns is read,
          // not swallowed: Pi refusing the steer is the one failure mode this
          // branch actually has, and before it was read it produced a WARN in the
          // trace and silence in the session.
          // #1541 review (HIGH): NOT `jobStandIn`, which says FAILED and
          // "its result is lost; re-dispatch" — both false here, where the run
          // settled and only the hand-over failed. This branch must not send
          // an operator to re-run a plan that already filed its issue.
          // Where to look: what the run reported it wrote, then what the tool
          // knew up front, then a generic pointer. Never a fabricated path.
          const where =
            [result.reportWhere, input.reportWhere].filter((w): w is string => !!w).join("; ") ||
            `dispatch_status (this job's row)`;
          deliverOrStandIn(
            pi,
            `async job ${jobId}`,
            build,
            (e) => driverReportStandIn(jobId, input.label, input.subject ?? input.label, e, where),
            input.deliverForTest,
          );
          trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) finished (driver)`);
          return result;
        }
        // Driver-owned jobs skip the steer: the in-process caller is awaiting
        // `completion` and will route the result through the work-driver's
        // state machine. Posting a steer too would inject a duplicate
        // [ensemble:async] message into PM's session and confuse the next turn.
        if (ownerKind === "pm") {
          // The annotated report is preferred; if the git line or its formatting throws,
          // the unannotated report is delivered instead.
          let gitLine: string | undefined;
          if (reportsGitState(input.role)) {
            try {
              gitLine = await (input.gitLineFor ?? gitStateLine)(input.cwd);
            } catch (err) {
              trace(`async job ${jobId} git-state report failed: ${String(err)}`);
            }
          }
          deliverOrStandIn(
            pi,
            `async job ${jobId}`,
            () => {
              try {
                return formatSingleReport(jobId, input.label, result, gitLine);
              } catch (err) {
                if (gitLine === undefined) throw err;
                trace(`async job ${jobId} annotated report failed: ${String(err)}`);
                return formatSingleReport(jobId, input.label, result);
              }
            },
            (e) => jobStandIn(jobId, input.label, e),
          );
        }
        trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) finished in ${result.ms}ms`);
        return result;
      }),
    (err: Error) =>
      pendingJobs.releaseAfter(jobId, async () => {
        try {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          clearJobIssues(jobId);
          slow.stop();
          // #916 — settle outcome for the live view (rejection = failed).
          live.markSettled(jobId, "failed");
          if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
          lifecycle.emitFailed(jobId, input.label, input.role, Date.now() - state.startedAt);
          sessionAutosave.recordOutcome(false);
        } catch (settleErr) {
          trace(`async job ${jobId} (${input.label}) settle failed: ${String(settleErr)}`);
          if (ownerKind === "pm") {
            deliverStandIn(pi, `async job ${jobId}`, settleErr, (e) =>
              jobStandIn(jobId, input.label, e),
            );
          }
          throw err;
        }
        if (ownerKind === "pm") {
          deliverOrStandIn(
            pi,
            `async job ${jobId}`,
            () => formatFailReport(jobId, input.label, err),
            (e) => jobStandIn(jobId, input.label, e),
          );
        }
        trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) failed: ${err.message}`);
        // Driver-owned callers want the error surfaced via the promise so
        // they can route it into the state machine; PM-owned callers had the
        // failure delivered as a fail-report steer and would have nothing to
        // do with a rejection here. Re-throw uniformly — PM-owned callers
        // ignore the promise.
        throw err;
      }),
  );

  // PM-owned callers (every dispatch tool today) destructure only `jobId`
  // and ignore `completion`. Without this suppressor a rejected completion
  // promise would trigger Node's unhandled-rejection warning. The internal
  // .catch attaches an observer — it does NOT consume the rejection from
  // the perspective of any other observer, so a driver-owned caller's
  // `await completion` still throws as expected.
  completion.catch(() => undefined);

  trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) started`);
  return { jobId, completion };
}

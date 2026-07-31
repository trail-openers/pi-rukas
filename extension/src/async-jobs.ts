import type { Writable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BatchMemberJobState,
  type BatchOrchestratorJobState,
  MAX_JOBS,
  type SingleJobState,
  childHandles,
  jobs,
  newJobId,
} from "./async-jobs-registry.ts";
import {
  type BatchReportInput,
  formatBatchReport,
  formatFailReport,
  formatSingleReport,
  totalTokens,
} from "./async-jobs-report.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import * as lifecycle from "./lifecycle-events.ts";
import type { RunningState } from "./progress.ts";
import * as sessionAutosave from "./session-autosave.ts";
import { trace } from "./trace.ts";
import { type DispatchResult, isRateLimit429Msg } from "./types.ts";

export { formatSingleReport } from "./async-jobs-report.ts";
export {
  getChildHandle,
  getOrchestratorActiveChild,
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

/** Live-progress hooks passed to a job's work function. */
export interface WorkHooks {
  /**
   * Forward a child's RunningState update. Wired to the dispatch deck so the
   * footer can render live activity (#117). Work functions should pass this
   * straight through to spawnSpecialist's onProgress option.
   */
  onProgress: (state: RunningState) => void;
  /**
   * Stdin-handle callback (#153). Called once after the child is spawned,
   * before the kickoff prompt is written. Work functions pass this through
   * to spawnSpecialist's onStdin option so the async-jobs registry can
   * record the handle for dispatch_steer lookups.
   */
  onStdin: (stdin: Writable) => void;
  /**
   * Orchestrator-shaped work functions (adversarial_loop) need to know their
   * own job id so they can register the currently-running inner child via
   * `setOrchestratorActiveChild`. Provided to every work function for
   * symmetry; single dispatches ignore it.
   */
  jobId: string;
}

interface StartJobInput {
  /** Human-readable subagent label (role + optional tag, e.g. "code-review-specialist[security]"). */
  label: string;
  /** Role name for telemetry. */
  role: string;
  /**
   * Work function. Receives an AbortSignal tied to our internal abort
   * controller (NOT the tool's exec signal — that one is gone the moment we
   * return from execute()). Should call spawnSpecialist internally and
   * forward `hooks.onProgress` to it.
   */
  work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  /**
   * Skip the automatic dispatch-deck entry. Set true for orchestrators that
   * fan out internally (lens-review, adversarial) and manage their own
   * per-child deck entries — otherwise the orchestrator's "synthetic" row
   * would mask the real children behind it.
   */
  skipDeck?: boolean;
  /**
   * Who consumes the result. Default "pm" — preserves the existing
   * send-as-steer behaviour every dispatch tool depends on. Set "driver"
   * when an in-process caller (e.g. the work-driver) will await the
   * `completion` promise directly; we then skip the sendUserMessage steer
   * so PM doesn't see a `[ensemble:async]` it didn't ask for.
   *
   * See SingleJobState.ownerKind for the full rationale.
   */
  ownerKind?: "pm" | "driver";
}

export interface StartJobHandle {
  jobId: string;
  /**
   * Resolves with the DispatchResult when the work function settles. Always
   * returned. PM-owned callers normally ignore it (the steer is the
   * contract). Driver-owned callers await this to consume the result
   * directly — `deliverReport` is skipped for them so PM never sees an
   * `[ensemble:async]` it didn't initiate.
   *
   * Note: this promise resolves (not rejects) for both ok and failed
   * dispatches — failure is encoded in `result.ok === false` /
   * `result.errorStop`. It DOES reject if the work function throws
   * (transport / spawn-level errors before any DispatchResult is produced).
   * Driver code should catch that explicitly.
   */
  completion: Promise<DispatchResult>;
}

/**
 * Fire a single async job. Returns immediately with the jobId; the tool's
 * execute() should also return immediately. The report is delivered to the
 * parent via pi.sendUserMessage when the work resolves — UNLESS
 * `input.ownerKind === "driver"`, in which case the in-process caller
 * consumes the result via the `completion` promise and the steer is skipped.
 */
export function startJob(pi: ExtensionAPI, input: StartJobInput): StartJobHandle {
  if (jobs.size >= MAX_JOBS) {
    throw new Error(
      `async-jobs: refusing to start job — ${jobs.size} jobs already in flight (cap ${MAX_JOBS}). This usually indicates a stuck settle path; check 'dispatch_status' or restart Pi.`,
    );
  }
  const ownerKind: "pm" | "driver" = input.ownerKind ?? "pm";
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
    dispatchDeck.startEntry(jobId, { label: input.label, role: input.role });
  }
  lifecycle.emitDispatched(jobId, input.label, input.role);
  sessionAutosave.recordDispatch(input.role);

  const hooks: WorkHooks = {
    onProgress: (progress) => {
      if (!input.skipDeck) dispatchDeck.updateEntry(jobId, progress);
    },
    onStdin: (stdin) => {
      childHandles.set(jobId, { stdin, label: input.label, role: input.role });
    },
    jobId,
  };

  const completion = input.work(abort.signal, hooks).then(
    (result) => {
      jobs.delete(jobId);
      childHandles.delete(jobId);
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
      // Driver-owned jobs skip the steer: the in-process caller is awaiting
      // `completion` and will route the result through the work-driver's
      // state machine. Posting a steer too would inject a duplicate
      // [ensemble:async] message into PM's session and confuse the next turn.
      if (ownerKind === "pm") {
        const report = formatSingleReport(jobId, input.label, result);
        deliverReport(pi, report);
      }
      trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) finished in ${result.ms}ms`);
      return result;
    },
    (err: Error) => {
      jobs.delete(jobId);
      childHandles.delete(jobId);
      if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
      lifecycle.emitFailed(jobId, input.label, input.role, Date.now() - state.startedAt);
      sessionAutosave.recordOutcome(false);
      if (ownerKind === "pm") {
        const report = formatFailReport(jobId, input.label, err);
        deliverReport(pi, report);
      }
      trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) failed: ${err.message}`);
      // Driver-owned callers want the error surfaced via the promise so
      // they can route it into the state machine; PM-owned callers had the
      // failure delivered as a fail-report steer and would have nothing to
      // do with a rejection here. Re-throw uniformly — PM-owned callers
      // ignore the promise.
      throw err;
    },
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

interface StartBatchInput {
  batchLabel: string;
  members: Array<{
    label: string;
    role: string;
    work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  }>;
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

    dispatchDeck.startEntry(jobId, { label: m.label, role: m.role, batchKey: batchId });
    sessionAutosave.recordDispatch(m.role);
    const memberHooks: WorkHooks = {
      onProgress: (progress) => dispatchDeck.updateEntry(jobId, progress),
      onStdin: (stdin) => {
        childHandles.set(jobId, { stdin, label: m.label, role: m.role });
      },
      jobId,
    };

    void m
      .work(memberAbort.signal, memberHooks)
      .then(
        (result) => {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          dispatchDeck.clearEntry(jobId);
          sessionAutosave.recordOutcome(result.ok);
          memberResults.push({ jobId, label: m.label, result });
        },
        (err: Error) => {
          jobs.delete(jobId);
          childHandles.delete(jobId);
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
        orchestrator.completed++;
        // Advance the batch row's counter so the user sees "1/3 done · 2 running".
        dispatchDeck.updateBatchProgress(batchId, orchestrator.completed);
        if (orchestrator.completed === orchestrator.size) {
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
          const report = formatBatchReport({
            batchLabel: input.batchLabel,
            batchId,
            startedAt,
            members: memberResults,
          });
          deliverReport(pi, report);
          trace(
            `async batch ${batchId} (${input.batchLabel}) finished in ${Date.now() - startedAt}ms`,
          );
        }
      });
  }

  trace(`async batch ${batchId} (${input.batchLabel}, n=${input.members.length}) started`);
  return { batchId, jobIds: memberJobIds };
}

/**
 * Push a report back to the parent agent. `deliverAs: "steer"` queues the
 * message during a streaming turn (delivered before the next LLM call) or
 * directly if the agent is idle.
 */
function deliverReport(pi: ExtensionAPI, report: string): void {
  try {
    pi.sendUserMessage(report, { deliverAs: "steer" });
  } catch (err) {
    trace(`async report delivery failed: ${(err as Error).message}`);
  }
}

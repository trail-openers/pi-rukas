import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliverReport } from "./async-jobs-lifecycle.ts";
import {
  type BatchMemberJobState,
  type BatchOrchestratorJobState,
  MAX_JOBS,
  childHandles,
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
import { gitStateLine } from "./git-state.ts";
import * as lifecycle from "./lifecycle-events.ts";
import * as sessionAutosave from "./session-autosave.ts";
import { feedSlowProgress } from "./slow-notice.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

interface StartBatchInput {
  batchLabel: string;
  members: Array<{
    label: string;
    role: string;
    /** #1015 — resolved member cwd; the developer/ops member's git-state line runs here. */
    cwd?: string;
    work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  }>;
}

/**
 * #1015 — computes the git-state line for each developer/ops member (against its own
 * cwd; failed members and reviewers get none), then delivers the one batch steer.
 */
async function deliverBatchReport(
  pi: ExtensionAPI,
  head: { batchLabel: string; batchId: string; startedAt: number },
  memberResults: BatchReportInput["members"],
  gitMembers: Map<string, string | undefined>,
): Promise<void> {
  const lines = new Map<string, string>();
  await Promise.all(
    memberResults.map(async (m) => {
      const cwd = gitMembers.get(m.jobId);
      if ("failed" in m.result || !gitMembers.has(m.jobId)) return;
      lines.set(m.jobId, await gitStateLine(cwd));
    }),
  );
  const members = memberResults.map((m) => ({
    ...m,
    gitLine: lines.get(m.jobId),
  }));
  deliverReport(pi, formatBatchReport({ ...head, members }));
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
  // #1015 — developer/ops members only, keyed by jobId, value = dispatch cwd.
  const gitMembers = new Map<string, string | undefined>();

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
    void new Promise<DispatchResult>((resolve) => resolve(m.work(memberAbort.signal, memberHooks)))
      .then(
        (result) => {
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
          void deliverBatchReport(
            pi,
            { batchLabel: input.batchLabel, batchId, startedAt },
            memberResults,
            gitMembers,
          )
            .then(
              () =>
                trace(
                  `async batch ${batchId} (${input.batchLabel}) finished in ${Date.now() - startedAt}ms`,
                ),
              (err: unknown) => {
                trace(`async batch ${batchId} (${input.batchLabel}) report failed: ${String(err)}`);
                // Fall back to the batch report without git-state lines so the parent still hears back.
                deliverReport(
                  pi,
                  formatBatchReport({
                    batchLabel: input.batchLabel,
                    batchId,
                    startedAt,
                    members: memberResults,
                  }),
                );
              },
            )
            .catch((err: unknown) =>
              trace(`async batch ${batchId} fallback delivery failed: ${String(err)}`),
            );
        }
      });
  }

  trace(`async batch ${batchId} (${input.batchLabel}, n=${input.members.length}) started`);
  return { batchId, jobIds: memberJobIds };
}

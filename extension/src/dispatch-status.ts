import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  DRIVER_OWNED_NOTICE,
  type JobStatusRow,
  jobStatusSnapshot,
  killJob,
} from "./async-jobs.ts";

/**
 * Structural poll-guard (#364 FIX 1).
 *
 * Settled jobs are deleted from the registry immediately with no retained
 * completion timestamp, so the robust poll signal is jobId-set equality
 * between consecutive calls within a time window: a completion shrinks the
 * set, a new dispatch grows it — either resets the guard; an identical
 * consecutive call (nothing changed) is a poll. The first/legitimate
 * pre-completion check always passes.
 *
 * Decision is factored out into exported helpers so it is unit-testable
 * without a live job registry.
 */

const POLL_WINDOW_MS = 90_000;
let lastPollAt = 0;
let lastPollKey = "";

/** Stable key for the in-flight jobId set — order-insensitive. */
export function jobSetKey(rows: Pick<JobStatusRow, "jobId">[]): string {
  return rows
    .map((r) => r.jobId)
    .sort()
    .join(",");
}

export interface StatusCallVerdict {
  polling: boolean;
}

/**
 * Decide whether a status call with the given rows is a poll: the in-flight
 * set is identical to the previous call AND the calls are within the poll
 * window. A set that grew or shrank (new dispatch / completion) resets the
 * guard. A change to the empty set resets it too — the next non-empty call
 * is a fresh, legitimate check.
 */
export function classifyStatusCall(
  rows: Pick<JobStatusRow, "jobId">[],
  now: number,
  last: { at: number; key: string },
): StatusCallVerdict {
  if (rows.length === 0) return { polling: false };
  const key = jobSetKey(rows);
  const polling = key === last.key && now - last.at < POLL_WINDOW_MS;
  return { polling };
}

const POLL_STEER =
  "⛔ You are polling. END YOUR TURN NOW. The report auto-delivers " +
  "as [ensemble:async] and resumes you; you lose nothing by stopping.";

/**
 * Strictly metadata view of in-flight async jobs. The parent agent should call
 * this when it suspects work is still running before declaring a workflow done.
 * Returns counts + jobIds + elapsed; NEVER any transcript content (invariant).
 */
export function registerDispatchStatusTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_status",
    label: "Async Dispatch Status",
    description:
      "List in-flight async subagents (jobId, role, elapsed, batch info). Call AT MOST ONCE — a single pre-completion sanity check, or once before dispatch_kill. NEVER in a loop or to 'wait': completed subagents auto-deliver a [ensemble:async] report that resumes you. Metadata only — never includes transcript content.",
    parameters: Type.Object({}),
    async execute() {
      const rows = jobStatusSnapshot();
      const now = Date.now();
      const { polling } = classifyStatusCall(rows, now, { at: lastPollAt, key: lastPollKey });
      lastPollAt = now;
      lastPollKey = jobSetKey(rows);
      if (polling) {
        return {
          content: [{ type: "text", text: POLL_STEER }],
          details: { count: rows.length, rows, polling: true },
        };
      }
      return {
        content: [{ type: "text", text: renderStatus(rows) }],
        details: { count: rows.length, rows, polling: false },
      };
    },
  });

  pi.registerTool({
    name: "dispatch_kill",
    label: "Cancel Async Dispatch",
    description:
      "Abort a running async subagent or batch by jobId. The orchestrator will deliver a FAILED report shortly after. Use sparingly — prefer letting children finish.",
    parameters: Type.Object({
      jobId: Type.String({
        description:
          "Job id as shown by dispatch_status, or a child id (`<run>/<label>`) as shown by dispatch_peek or a slow-run notice.",
      }),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Required to kill a child owned by a running /work driver cycle. Only for one dispatch_peek shows hung — never to replace it with a dispatch of your own.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { jobId: string; force?: boolean };
      // Checked here, not in killJob: the operator's agent-list `x` goes
      // through killJob directly and must keep working on every row.
      const owned = jobStatusSnapshot().find((r) => r.jobId === params.jobId && r.driverOwned);
      const refusal = owned ? driverKillRefusal(owned, params.force === true) : undefined;
      if (refusal) {
        return {
          content: [{ type: "text", text: refusal }],
          details: { jobId: params.jobId, killed: false, driverOwned: true },
        };
      }
      const killed = killJob(params.jobId);
      return {
        content: [
          {
            type: "text",
            text: !killed
              ? `No such job ${params.jobId} — already finished or never existed.`
              : owned
                ? `Sent SIGTERM to the /work driver's child ${params.jobId} (${owned.label}). No report comes to you: the driver records the failed dispatch and retries or parks the cycle itself. Do NOT dispatch a replacement.`
                : `Sent SIGTERM to job ${params.jobId}. FAILED report will arrive shortly.`,
          },
        ],
        details: { jobId: params.jobId, killed, ...(owned ? { driverOwned: true } : {}) },
      };
    },
  });
}

/**
 * Why a PM `dispatch_kill` of a driver-owned job is not carried out, or
 * undefined when it should be. The PM cannot tell a driver child from its own
 * by id, and killed one on the belief it had mis-dispatched it; saying whose
 * job it is BEFORE the kill is the fix. `force` keeps the one legitimate
 * kill — a child hung inside a tool call, which nothing else can stop.
 * The cycle's own job is refused outright: its work ignores the abort, so
 * "killed" would be a lie and the cycle would run on.
 */
export function driverKillRefusal(
  row: Pick<JobStatusRow, "jobId" | "role" | "label">,
  force: boolean,
): string | undefined {
  if (row.role === "work-driver") {
    return `Refused: ${row.jobId} (${row.label}) is the /work driver cycle itself, and dispatch_kill cannot stop a cycle — nothing in the driver listens to this abort. To stop one hung child, dispatch_kill that child's id; otherwise let the cycle reach merged or handoff (state: /work-status).`;
  }
  if (force) return undefined;
  return `Refused: ${row.jobId} (${row.label}). ${DRIVER_OWNED_NOTICE} If dispatch_peek shows it is genuinely hung (no new turn for a long time), call dispatch_kill again with force: true — the driver then handles the failed dispatch.`;
}

function renderStatus(rows: JobStatusRow[]): string {
  if (rows.length === 0) return "no async subagents running";
  const fmtElapsed = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m${s.toString().padStart(2, "0")}s`;
  };
  const lines = rows.map((r) => {
    const elapsed = fmtElapsed(r.elapsedMs);
    if (r.batchProgress) {
      return `[batch ${r.jobId}] ${r.label} · ${r.batchProgress.completed}/${r.batchProgress.size} children done · ${elapsed} elapsed`;
    }
    if (r.batchId) {
      return `  ↳ [${r.jobId}] ${r.label} (in batch ${r.batchId}) · ${elapsed}`;
    }
    return `[${r.jobId}] ${r.label} · ${elapsed} elapsed${r.driverOwned ? " · owned by the /work driver, not you" : ""}`;
  });
  return [`${rows.length} async slot(s) in flight:`, ...lines].join("\n");
}

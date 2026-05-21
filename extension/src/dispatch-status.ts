import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type JobStatusRow, jobStatusSnapshot, killJob } from "./async-jobs.ts";

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
      "List in-flight async subagents (jobId, role, elapsed, batch info). Use this before declaring a workflow done to confirm no children are still running. Metadata only — never includes transcript content.",
    parameters: Type.Object({}),
    async execute() {
      const rows = jobStatusSnapshot();
      return {
        content: [{ type: "text", text: renderStatus(rows) }],
        details: { count: rows.length, rows },
      };
    },
  });

  pi.registerTool({
    name: "dispatch_kill",
    label: "Cancel Async Dispatch",
    description:
      "Abort a running async subagent or batch by jobId. The orchestrator will deliver a FAILED report shortly after. Use sparingly — prefer letting children finish.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job id as shown by dispatch_status." }),
    }),
    async execute(_id, raw) {
      const params = raw as { jobId: string };
      const killed = killJob(params.jobId);
      return {
        content: [
          {
            type: "text",
            text: killed
              ? `Sent SIGTERM to job ${params.jobId}. FAILED report will arrive shortly.`
              : `No such job ${params.jobId} — already finished or never existed.`,
          },
        ],
        details: { jobId: params.jobId, killed },
      };
    },
  });
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
    return `[${r.jobId}] ${r.label} · ${elapsed} elapsed`;
  });
  return [`${rows.length} async slot(s) in flight:`, ...lines].join("\n");
}

/**
 * dispatch_steer — PM-callable mid-flight course correction for a running
 * subagent (#153).
 *
 * Use case: PM observes (typically via dispatch_peek) that a child is going
 * off-rails — rabbit hole, scope drift, time-box about to violate — and
 * injects a corrective message via Pi's RPC `steer` command.
 *
 * Mechanism:
 *   1. Look up the child's stdin from async-jobs.childHandles (set during
 *      spawn by the `onStdin` hook plumbed through WorkHooks)
 *   2. Write `{ type: "steer", message }\n` to that stdin
 *   3. Pi's --mode rpc agent receives the steer and queues it as the
 *      highest-priority next-turn input
 *   4. Emit a scrollback lifecycle entry so the user sees PM's interventions
 *
 * Discipline lives in the prompt layer (#154 — PM doctrine). NO mechanical
 * caps or cooldowns in this tool — same trust model as dispatch_peek.
 *
 * Failure modes the tool returns to PM:
 *   - "no such running job <id>" — the job either never existed, or already
 *     finished (handle cleaned up on settle). PM should NOT retry.
 *   - "delivery failed: <reason>" — stdin write error (e.g., EPIPE because
 *     the child exited between lookup and write). Race condition; PM treats
 *     like "job finished".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getChildHandle, getOrchestratorActiveChild, isOrchestratorJob } from "./async-jobs.ts";
import * as lifecycle from "./lifecycle-events.ts";

interface SteerDetails {
  jobId: string;
  delivered: boolean;
  /** Display label of the steered child — set only on successful delivery. */
  label?: string;
  /** Reason for non-delivery — set when delivered=false. */
  reason?: string;
}

/**
 * The steer source a lifecycle entry is tagged with (#543 F2).
 *
 *   - "pm-tool"              — the PM's dispatch_steer tool (the original path).
 *   - "driver-loop-detector" — the work-driver's loop-detector cap (#543 F1).
 *   - "driver-budget"        — the work-driver's token-budget cap (#543 F6).
 *
 * The PM tool path passes "pm-tool"; the driver's caps pass the other two.
 * The tag is informational — it tells the operator WHY the child was nudged.
 */
export type SteerSource = "pm-tool" | "driver-loop-detector" | "driver-budget";

/**
 * The driver-callable steer core (#543 F2).
 *
 * Extracted from the PM `dispatch_steer` tool's inline logic so the work-driver's
 * own caps (loop-detector, token-budget) can nudge a running child the same way
 * the PM does — without duplicating the stdin-lookup / envelope / EPIPE handling.
 *
 * Resolves BOTH direct jobIds (a single child's stdin handle) and
 * orchestrator-shaped jobIds (adversarial_loop) via `getOrchestratorActiveChild`,
 * exactly as the PM tool path does. Writes the Pi RPC envelope
 * `{ type: "steer", message }` to the resolved child's stdin and emits the
 * lifecycle 'steered' entry tagged with `source`.
 *
 * Returns `{ delivered: true, label }` on success, or `{ delivered: false,
 * reason }` when the child is gone ("no-such-job"), the orchestrator is between
 * rounds ("between-rounds"), or the stdin write failed (EPIPE — the child exited
 * between lookup and write). Never throws on delivery failure.
 */
export function steerChild(jobId: string, text: string, source: SteerSource): SteerDetails {
  // Orchestrator-shaped jobs (adversarial_loop) don't have a stdin handle of
  // their own — the orchestrator is a function, not a Pi process. Resolve the
  // active inner child so the steer reaches the currently-running phase.
  if (isOrchestratorJob(jobId)) {
    const active = getOrchestratorActiveChild(jobId);
    if (!active) {
      return { jobId, delivered: false, reason: "between-rounds" };
    }
    try {
      active.stdin.write(`${JSON.stringify({ type: "steer", message: text })}\n`);
    } catch (err) {
      return { jobId, delivered: false, reason: (err as Error).message };
    }
    lifecycle.emitSteered(jobId, `${jobId} → ${active.label}`, active.role, text, source);
    return { jobId, delivered: true, label: active.label };
  }

  const handle = getChildHandle(jobId);
  if (!handle) {
    return { jobId, delivered: false, reason: "no-such-job" };
  }
  try {
    handle.stdin.write(`${JSON.stringify({ type: "steer", message: text })}\n`);
  } catch (err) {
    return { jobId, delivered: false, reason: (err as Error).message };
  }
  lifecycle.emitSteered(jobId, handle.label, handle.role, text, source);
  return { jobId, delivered: true, label: handle.label };
}

export function registerDispatchSteerTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_steer",
    label: "Steer Running Subagent",
    description:
      "Inject a course-correction message into a currently running subagent. Use ONLY at exceptional decision points where observation (typically via dispatch_peek) suggests the agent is stuck or lost — rabbit hole, scope drift, time-box about to violate, or new user input contradicting the brief. NOT for running commentary or micromanagement; if you'd want to steer more than once on the same agent, prefer dispatch_kill + re-dispatch with a sharper brief. Every steer is logged to scrollback for user visibility. Reserve for genuine course corrections; this is the analogue of dispatch_peek's exceptional-circumstance discipline.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job id as shown by dispatch_status." }),
      message: Type.String({
        description:
          "The corrective message to inject. The subagent will treat it as highest-priority guidance, finish its current tool call, then re-evaluate its plan in light of this text.",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as { jobId: string; message: string };
      // #543 F2 — the steer core (lookup + RPC envelope + EPIPE + lifecycle)
      // lives in steerChild so the driver's caps share it. The PM tool passes
      // "pm-tool" as the source; the tool's response text below keeps its
      // existing shape so PM-facing output is unchanged.
      const result = steerChild(params.jobId, params.message, "pm-tool");
      if (isOrchestratorJob(params.jobId)) {
        if (!result.delivered && result.reason === "between-rounds") {
          return {
            content: [
              {
                type: "text",
                text: `Orchestrator '${params.jobId}' is between rounds — no inner child to steer right now. Wait for the next round (use dispatch_peek to watch progress), or if the loop seems stuck end-to-end, consider dispatch_kill.`,
              },
            ],
            details: result,
          };
        }
        if (!result.delivered) {
          return {
            content: [
              {
                type: "text",
                text: `Steer delivery to orchestrator '${params.jobId}' failed: ${result.reason}. The inner child likely exited between lookup and write.`,
              },
            ],
            details: result,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Steered orchestrator '${params.jobId}' → active inner child ${result.label}. The inner subagent will treat this as highest-priority guidance after its current tool call settles.`,
            },
          ],
          details: result,
        };
      }

      if (!result.delivered && result.reason === "no-such-job") {
        return {
          content: [
            {
              type: "text",
              text: `No such running job '${params.jobId}'. It may have already finished — call dispatch_status to confirm; if so, react to its final report instead of steering. Don't retry.`,
            },
          ],
          details: result,
        };
      }
      if (!result.delivered) {
        return {
          content: [
            {
              type: "text",
              text: `Steer delivery failed for job '${params.jobId}': ${result.reason}. The child likely exited just before the steer reached it.`,
            },
          ],
          details: result,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Steered ${result.label} (job ${params.jobId}). The subagent will treat this as highest-priority guidance after its current tool call settles.`,
          },
        ],
        details: result,
      };
    },
  });
}

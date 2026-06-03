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
import { getChildHandle } from "./async-jobs.ts";
import * as lifecycle from "./lifecycle-events.ts";

interface SteerDetails {
  jobId: string;
  delivered: boolean;
  /** Display label of the steered child — set only on successful delivery. */
  label?: string;
  /** Reason for non-delivery — set when delivered=false. */
  reason?: string;
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
      const handle = getChildHandle(params.jobId);
      if (!handle) {
        const details: SteerDetails = {
          jobId: params.jobId,
          delivered: false,
          reason: "no-such-job",
        };
        return {
          content: [
            {
              type: "text",
              text: `No such running job '${params.jobId}'. It may have already finished — call dispatch_status to confirm; if so, react to its final report instead of steering. Don't retry.`,
            },
          ],
          details,
        };
      }

      // Compose Pi's RPC steer command.
      const cmd = JSON.stringify({ type: "steer", message: params.message });
      try {
        handle.stdin.write(`${cmd}\n`);
      } catch (err) {
        const reason = (err as Error).message;
        const details: SteerDetails = { jobId: params.jobId, delivered: false, reason };
        return {
          content: [
            {
              type: "text",
              text: `Steer delivery failed for job '${params.jobId}': ${reason}. The child likely exited just before the steer reached it.`,
            },
          ],
          details,
        };
      }

      lifecycle.emitSteered(params.jobId, handle.label, handle.role, params.message);

      const details: SteerDetails = {
        jobId: params.jobId,
        delivered: true,
        label: handle.label,
      };
      return {
        content: [
          {
            type: "text",
            text: `Steered ${handle.label} (job ${params.jobId}). The subagent will treat this as highest-priority guidance after its current tool call settles.`,
          },
        ],
        details,
      };
    },
  });
}

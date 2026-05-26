/**
 * Companion Pi extension loaded into the adversarial (watcher) child during
 * pair_watch. Registers four tools:
 *
 * - intent tools (orchestrator intercepts these as tool_execution_start
 *   events in pair-watch.ts and routes accordingly):
 *     interrupt_developer(message)  →  orchestrator sends `steer` to developer
 *     approve_developer()           →  orchestrator ends the session with APPROVED
 *     escalate_to_user(reason)      →  orchestrator ends the session with REJECTED
 *
 * - investigation tool (executes here in the adversarial child):
 *     view_current_diff()           →  runs `git diff` in the child's cwd and
 *                                       returns the output. Adversarial uses
 *                                       this to inspect the dev's actual changes
 *                                       line-by-line rather than relying on the
 *                                       --stat summary in the dev-turn updates.
 *
 * Loaded via `pi --no-extensions --extension <path-to-this-file>` from
 * pair-watch.ts; never auto-discovered.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const execFile = promisify(execFileCb);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "interrupt_developer",
    label: "Interrupt Developer",
    description:
      "Send a steering message to your pair-coding partner (developer). Bias toward USE — every interrupt that prevents a wrong turn saves an entire dev cycle and prevents the issue from reaching the six-pass code review (which costs ~1M tokens per round). The bar is 'I can predict a concrete failure mode the dev hasn't addressed' — wrong path, wrong API, scope drift, foreseeable runtime error, missing test for non-trivial logic. Do NOT interrupt for style or naming preferences, and do not interrupt to acknowledge progress. Predicting a likely bug and then waiting to see whether the dev hits it themselves is the failure mode this role exists to prevent — surface it before they hit it. The developer will receive your message as a [pair:adversarial] user turn.",
    parameters: Type.Object({
      message: Type.String({
        description:
          "What you want the developer to consider. Be concrete and actionable. < 500 chars.",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as { message: string };
      return {
        content: [
          {
            type: "text",
            text: `interrupt queued for developer: ${params.message.slice(0, 200)}`,
          },
        ],
        details: { message: params.message },
      };
    },
  });

  pi.registerTool({
    name: "approve_developer",
    label: "Approve Developer",
    description:
      "Approve the developer's work as APPROVED. Call this ONLY when you have observed the developer's session and are satisfied there are no remaining CRITICAL or HIGH issues. The pair_watch session ends after this call.",
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({
          description: "Optional one-paragraph rationale for approving.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { summary?: string };
      return {
        content: [{ type: "text", text: "APPROVED — pair_watch session ending." }],
        details: { verdict: "APPROVED", summary: params.summary ?? "" },
      };
    },
  });

  pi.registerTool({
    name: "escalate_to_user",
    label: "Escalate to User",
    description:
      "Escalate to the human user because the developer is stuck, going in the wrong direction, or producing unsafe output you cannot correct via interrupt_developer. The pair_watch session ends after this call; the user will see your reason and decide what to do next.",
    parameters: Type.Object({
      reason: Type.String({
        description:
          "Why you are escalating. Include specifics: what the developer attempted, what's wrong, what you tried (if anything).",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as { reason: string };
      return {
        content: [{ type: "text", text: "Escalated — pair_watch session ending." }],
        details: { verdict: "ESCALATED", reason: params.reason },
      };
    },
  });

  pi.registerTool({
    name: "view_current_diff",
    label: "View Current Diff",
    description:
      "Pull the current `git diff` for the working tree the developer is editing. Returns the full unified diff so you can inspect actual line changes (not just the --stat summary you receive in dev-turn updates). Use this when the dev makes a change you want to verify line-by-line, especially before calling approve_developer.",
    parameters: Type.Object({
      stat_only: Type.Optional(
        Type.Boolean({
          description: "If true, returns `git diff --stat` instead of the full diff.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { stat_only?: boolean };
      const details: Record<string, unknown> = {};
      try {
        const args = params.stat_only ? ["diff", "--stat"] : ["diff"];
        const { stdout } = await execFile("git", args, {
          // process.cwd() === the dev's workCwd because pair-watch.ts spawns
          // this child with the same cwd as the developer.
          cwd: process.cwd(),
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        const trimmed = stdout.trim();
        if (!trimmed) {
          details.empty = true;
          return {
            content: [{ type: "text", text: "(no diff — working tree is clean)" }],
            details,
          };
        }
        // Cap output at 32k chars to stay context-bounded
        const capped =
          trimmed.length > 32_000 ? `${trimmed.slice(0, 32_000)}\n\n[truncated]` : trimmed;
        details.bytes = capped.length;
        details.truncated = trimmed.length > 32_000;
        return { content: [{ type: "text", text: capped }], details };
      } catch (err) {
        const msg = (err as Error).message ?? "unknown error";
        details.error = msg;
        return { content: [{ type: "text", text: `git diff failed: ${msg}` }], details };
      }
    },
  });
}

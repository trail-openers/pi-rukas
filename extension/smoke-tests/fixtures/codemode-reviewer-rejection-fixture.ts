#!/usr/bin/env bun
/**
 * Codemode-reviewer-rejection companion extension
 * (test-codemode-reviewer-rejection.ts, #1030 / epic #1026).
 *
 * Two jobs, both about PROOF rather than behaviour:
 *
 *   1. Pre-script roster capture — on the FIRST `agent_start` it calls
 *      `pi.getActiveTools()` (the same surface the model is offered each
 *      turn) and writes the result into a session entry via
 *      `pi.appendEntry("codemode-reviewer-roster", { tools })`. The test
 *      asserts that `write` and `edit` are ABSENT from that capture — i.e.
 *      the `--exclude-tools write,edit,multiedit` applied to the reviewer
 *      role has already stripped them from the live toolset BEFORE any
 *      codemode script runs.
 *
 *   2. Post-script rejection capture — it registers a no-op tool,
 *      `codemode_rejection_report`, whose ONLY documented use is the test
 *      prompt. The child is told to call the codemode tool with a script
 *      that attempts `tools.write` / `tools.edit` and then call
 *      `codemode_rejection_report` with the observed outcome. The tool
 *      re-reads `pi.getActiveTools()` at that later point and writes it via
 *      `pi.appendEntry("codemode-reviewer-roster-post", { tools })`. The
 *      test asserts write/edit are STILL absent — the codemode script's
 *      rejected calls did not resurrect them, and no file was written
 *      (the sentinel path is checked from the test process via fs).
 *
 * The fixture intentionally does NOT itself attempt any write/edit — it
 * is the child model (via the codemode script in the prompt) that does.
 * No execution logic, no network, no state. Loaded ONLY via `--extension`
 * from the live rejection test; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let rosterCaptured = false;

  // Capture the active toolset on the first agent turn, BEFORE the model has
  // a chance to call codemode. agent_start fires after all registerTool()
  // calls have completed, so the roster is complete at that point.
  pi.on("agent_start", () => {
    if (rosterCaptured) return;
    rosterCaptured = true;
    try {
      pi.appendEntry("codemode-reviewer-roster", {
        tools: pi.getActiveTools(),
        phase: "pre-script",
      });
    } catch {
      /* entry write is proof plumbing — if it fails the test asserts it failed */
    }
  });

  pi.registerTool({
    name: "codemode_rejection_report",
    label: "Codemode Rejection Report (smoke test fixture)",
    description:
      "Test fixture tool (test-codemode-reviewer-rejection). The task tells you to call this tool exactly once AFTER running the codemode script, with the parameter outcome=<short description of what the codemode script reported>. Call it and nothing else.",
    parameters: {
      type: "object",
      properties: {
        outcome: { type: "string" },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
    async execute(_id: string, _params: { outcome: string }) {
      try {
        pi.appendEntry("codemode-reviewer-roster-post", {
          tools: pi.getActiveTools(),
          phase: "post-script",
        });
      } catch {
        /* entry write is proof plumbing — test asserts it fails if missing */
      }
      return {
        content: [
          {
            type: "text",
            text: "codemode-rejection-report acknowledged",
          },
        ],
        details: { status: "ok" },
      };
    },
  });
}

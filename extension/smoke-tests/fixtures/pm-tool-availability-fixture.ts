#!/usr/bin/env bun
/**
 * PM-tool-availability fixture (test-pm-tool-availability.ts, #591).
 *
 * Two jobs, both about proving that PM mode strips edit/write from the
 * active toolset at runtime:
 *
 *   1. Arm PM mode on `agent_start` — calls the REAL `armPmMode()` +
 *      `stripPmTools()` from the extension (commands.ts / pm-mode.ts)
 *      so the live test exercises production code, not a duplicated
 *      filter in the fixture.
 *
 *   2. Report the live active toolset via a test fixture tool so the
 *      smoke test can assert the stripped set in the session transcript.
 *
 * No execution logic, no network, no state. Loaded ONLY via `--extension`
 * from the live smoke test; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { armPmMode } from "../../src/pm-mode.ts";
import { stripPmTools } from "../../src/commands.ts";

export default function (pi: ExtensionAPI) {
  let armed = false;

  // Arm PM mode on the first agent turn. This mirrors the real extension's
  // slash-command handler which calls armPmMode() then stripPmTools(pi)
  // in that order. agent_start fires AFTER all registerTool() calls have
  // completed, so getAllTools() is accurate and setActiveTools() replaces
  // the full active set in one call.
  pi.on("agent_start", () => {
    if (armed) return;
    armed = true;
    try {
      armPmMode();
      stripPmTools(pi);
      // Report the resulting active toolset via a session entry so the
      // smoke test can read it from the transcript (same pattern as
      // shape-live-roster-reporter, but for PM mode instead of roster
      // integrity).
      const active = pi.getActiveTools();
      pi.appendEntry("pm-tool-availability", {
        activeTools: active,
        forbiddenStripped: ["edit", "write"],
      });
    } catch {
      /* entry write is proof plumbing — test asserts it fails if missing */
    }
  });

  // Second capture point: the test calls this tool directly after
  // agent_start has already armed PM mode. Verifies the session-level
  // capture matches the live toolset at tool-capture time.
  pi.registerTool({
    name: "pm_tools_report",
    label: "PM Tools Report (smoke test fixture)",
    description:
      'Test fixture tool (test-pm-tool-availability). The task tells you to call this tool exactly once to capture the current active toolset. Call it with reason="availability-check".',
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { reason: string }) {
      const active = pi.getActiveTools();
      pi.appendEntry("pm-tool-availability-capture", {
        activeTools: active,
        capturedAt: `tool_call (${params.reason})`,
      });
      return {
        content: [
          {
            type: "text",
            text: `PM tools reported: ${active.length} active, edit=${!active.includes("edit")}, write=${!active.includes("write")}`,
          },
        ],
        details: { status: "ok" },
      };
    },
  });
}

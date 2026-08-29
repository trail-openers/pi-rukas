#!/usr/bin/env bun
/**
 * Live-shape-test companion extension (test-pi-shape-live.ts, #319).
 *
 * Two jobs, both cheap, both about PROOF rather than behaviour:
 *
 *   1. Tool-roster capture — on `session_start` it calls `pi.getActiveTools()`
 *      (the same surface the model is offered each turn — the #571 incident
 *      was exactly "registered extension tool silently absent from the
 *      session's tool payload") and writes the result into a session entry
 *      via `pi.appendEntry("shape-live-roster", { tools })`. The entry is
 *      emitted as an `entry_appended` event on the rpc stdout, so the test
 *      asserts against the LIVE child's own tool surface.
 *
 *   2. Forced deterministic tool call — it registers a no-op tool,
 *      `shape_roster_report`, whose ONLY documented use is the test prompt.
 *      The child is told to call it exactly once; the resulting
 *      `toolCall` content block + `tool_execution_start`/`tool_execution_end`
 *      events are what the test asserts its Pi-shape claims on.
 *
 * No execution logic, no network, no state. Loaded ONLY via `--extension`
 * from the live shape test; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let rosterCaptured = false;
  // `session_start` fires BEFORE extensions load their tools (line 1761-1762 in
  // agent-session.js: emit(session_start) then extendResourcesFromExtensions).
  // `agent_start` fires on the first agent turn, AFTER all registerTool() calls
  // have completed — the roster is complete at that point.
  pi.on("agent_start", () => {
    if (rosterCaptured) return;
    rosterCaptured = true;
    try {
      // getActiveTools() returns the active toolset (agent.state.tools) —
      // the same surface offered to the model each turn. That is the #571
      // detection target: a provider-side payload drop removes a tool from
      // here even though the registry (getAllTools) is intact. Registry
      // presence is separately proven by the fact that the fixture's own
      // registered tool is callable in the test prompt.
      const active = pi.getActiveTools();
      pi.appendEntry("shape-live-roster", { tools: active });
    } catch {
      /* entry write is proof plumbing — if it fails the test asserts it failed */
    }
  });

  pi.registerTool({
    name: "shape_roster_report",
    label: "Shape-Live Roster Report",
    description:
      "Test fixture tool (test-pi-shape-live). The task tells you to call this tool exactly once with note='pong'. Call it and nothing else. Do not call bash or any other tool.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string" },
      },
      required: ["note"],
      additionalProperties: false,
    },
    async execute(_id, _params) {
      return {
        content: [{ type: "text", text: "shape-roster-report acknowledged" }],
        details: { status: "ok" },
      };
    },
  });
}

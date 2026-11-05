/**
 * Companion Pi extension loaded into each lens-review child process.
 *
 * Registers a single `report_finding` tool with a TypeBox-validated schema.
 * Each lens specialist calls this tool ONCE per finding it identifies; Pi
 * validates the params in-process and the parent extracts every call from the
 * child's session `tool_use` events.
 *
 * No execution logic: the tool exists so the model has a structured way to
 * emit findings. Acknowledging the call is enough — the parent reads the
 * `tool_use` blocks afterward.
 *
 * Loaded via `pi --no-extensions --extension <path-to-this-file>` from
 * lens-review.ts; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface FindingInput {
  severity: string;
  path: string;
  line?: number;
  title: string;
  description?: string;
  suggestion?: string;
  /** #2040 — the evidence a HIGH claims; see `FindingReproduction`. */
  reproduction?: { command: string; observed: string };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_finding",
    label: "Report Finding",
    description:
      // The required set is spelled out with one complete call because Pi's
      // schema validation names a single missing key per rejection: a model
      // that sends only `description` is told about `title`, then about
      // `severity`, one wasted turn each.
      'Report ONE code-review finding from your assigned lens. Call once per finding — do not batch. Every call MUST carry all three required fields — severity, path, title — or it is rejected and nothing is recorded; line, description, suggestion and reproduction are optional. A HIGH must carry reproduction: the command you ran that demonstrates it, spelled exactly as you ran it, and the output you saw — the harness checks it against the tool calls recorded for this pass and caps an unverifiable HIGH to MEDIUM. Example: {"severity": "MEDIUM", "path": "src/api.ts", "line": 42, "title": "fetch() error is swallowed", "description": "The catch block returns [] so callers cannot tell a failure from an empty result.", "suggestion": "Rethrow or return a typed error."}. If you find nothing in your lane, simply do not call this tool.',
    parameters: Type.Object({
      severity: Type.String({
        description: "One of: CRITICAL, HIGH, MEDIUM, LOW",
      }),
      path: Type.String({ description: "File path relative to repo root." }),
      line: Type.Optional(
        Type.Number({
          description: "Line number; omit for file-level findings.",
        }),
      ),
      title: Type.String({
        description: "Short title (< 80 chars) summarising the issue.",
      }),
      description: Type.Optional(
        Type.String({ description: "1–3 sentence description of the issue." }),
      ),
      suggestion: Type.Optional(Type.String({ description: "Short suggested fix." })),
      // #2040 — the evidence a HIGH claims. Optional at the schema level on
      // purpose: a HIGH without it is still a finding, and the harness's cap —
      // not Pi's validator — is what decides it is not a blocker.
      reproduction: Type.Optional(
        Type.Object(
          {
            command: Type.String({
              description:
                "The ONE shell command you ran that demonstrates this finding, spelled exactly as you ran it.",
            }),
            observed: Type.String({
              description: "What that command actually printed — the failure or result you saw.",
            }),
          },
          { description: "Required for a HIGH: the command you ran and what it showed." },
        ),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as FindingInput;
      const sev = String(params.severity ?? "").toUpperCase();
      const line = typeof params.line === "number" ? params.line : 0;
      return {
        content: [
          {
            type: "text",
            text: `recorded ${sev} finding at ${params.path}:${line} — ${params.title}`,
          },
        ],
        details: { ...params, severity: sev },
      };
    },
  });
}

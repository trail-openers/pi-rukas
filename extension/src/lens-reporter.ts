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
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_finding",
    label: "Report Finding",
    description:
      "Report ONE code-review finding from your assigned lens. Call once per finding — do not batch. If you find nothing in your lane, simply do not call this tool.",
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

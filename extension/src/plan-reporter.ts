/**
 * Companion Pi extension loaded into each /plan Phase-2 investigation child.
 *
 * Registers a single `report_plan_item` tool with a TypeBox-validated schema.
 * Each angle specialist calls this tool ONCE per structured item it
 * identifies (an acceptance criterion, a test-surface entry, an edge case,
 * a sub-issue, a reference, an out-of-scope boundary); Pi validates the
 * params in-process and the parent (plan-draft.ts) extracts every call from
 * the child's `tool_use` events.
 *
 * The reason this is a tool call rather than a prose list is the fix for the
 * plan driver's line-splitting defect: `extractLines()` parsed the child's
 * prose reply line-by-line, so "Task complete:" preambles, `##` headings and
 * `**` debris all leaked into typed fields like Acceptance criteria. With a
 * schema-validated tool call there is no text to parse — the shape is
 * enforced by Pi inside the child, exactly like `report_finding` (lens
 * review) and `report_policy` (#407).
 *
 * No execution logic: the tool exists so the model has a structured way to
 * emit items. Acknowledging the call is enough — the parent reads the
 * `tool_use` blocks afterward.
 *
 * Loaded via `pi --no-extensions --extension <path-to-this-file>` from
 * plan-driver.ts; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const PLAN_ITEM_KINDS = [
  "acceptance-criterion",
  "test-surface-item",
  "edge-case",
  "sub-issue",
  "reference",
  "out-of-scope",
] as const;

interface PlanItemInput {
  kind: string;
  text: string;
  angle?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_plan_item",
    label: "Report Plan Item",
    description:
      "Report ONE structured item for the plan spec. Call once per item — do not batch. The item's content goes in `text` (the item itself, nothing else); `kind` says which spec section it belongs to. Do NOT emit items as prose lists or JSON in your reply; only these tool calls count. If you found nothing of a kind, simply do not call it for that kind.",
    parameters: Type.Object({
      kind: Type.Union(
        PLAN_ITEM_KINDS.map((k) => Type.Literal(k)),
        {
          description:
            "Which spec section this item belongs to: acceptance-criterion (a testable outcome of the work), test-surface-item (an existing test to extend or a missing one to add), edge-case (a pitfall, failure mode or boundary condition the implementer must handle), sub-issue (one sub-ticket of an epic, with title/scope), reference (a file or pattern that already exists and is in the work area), out-of-scope (something the ticket explicitly must NOT do).",
        },
      ),
      text: Type.String({
        description:
          "The item content — one complete, self-contained item (no bullets, no preamble).",
      }),
      angle: Type.Optional(
        Type.String({
          description:
            "The investigation angle that produced this item (e.g. 'test-surface', 'decomposition-surface'); omit when you did not run under a named angle.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as unknown as PlanItemInput;
      return {
        content: [
          {
            type: "text",
            text: `recorded plan item (${params.kind}): ${String(params.text ?? "").slice(0, 120)}`,
          },
        ],
        details: { ...params, angle: params.angle ?? "" },
      };
    },
  });
}

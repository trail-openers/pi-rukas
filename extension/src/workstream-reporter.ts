/**
 * Companion Pi extension loaded into the /work plan child process (#1652).
 *
 * Registers a single `report_workstream` tool with a TypeBox-validated schema.
 * The planner calls it ONCE per workstream; Pi validates each call in-process
 * (a schema-invalid call never reaches `execute`), and the parent
 * (work-driver-plan-calls.ts) reads the calls and their results back from the
 * child's session. Replaces the markdown `## Workstreams` block, whose
 * ambiguity (two blocks, a stray heading) parked cycles with
 * plan-spec-mismatch.
 *
 * The one check that needs state lives here: a duplicate `id` is refused with
 * a tool error NAMING the duplicate, so the model corrects it in the same
 * dispatch. The set is per process, which is per dispatch — a corrective
 * re-dispatch starts empty, as the plan step's contract requires.
 *
 * Loaded via `pi --no-extensions --extension <path>` from work-driver-plan.ts;
 * never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Same shape as the markdown parser accepted: lowercase, hyphens and underscores. */
export const WORKSTREAM_ID_PATTERN = "^[a-z0-9][a-z0-9_-]*$";

export default function (pi: ExtensionAPI) {
  const accepted = new Set<string>();
  pi.registerTool({
    name: "report_workstream",
    label: "Report Workstream",
    description:
      "Report ONE workstream of the plan. Call once per workstream — do not batch, and do not write a workstreams section in your reply: only these calls count. A call whose `id` repeats an earlier call in this reply is refused with an error naming the duplicate; give that workstream a distinct id and call again. Every workstream MUST declare a non-empty `paths` list.",
    parameters: Type.Object({
      id: Type.String({
        pattern: WORKSTREAM_ID_PATTERN,
        description: "Short lowercase id, e.g. task-a. Unique within this reply.",
      }),
      scope: Type.String({ description: "One-line scope label for this workstream." }),
      paths: Type.Array(Type.String(), {
        description: "Files this workstream is EXPECTED to modify, repo-relative.",
      }),
      outOfScope: Type.Array(Type.String(), {
        description: "Explicit exclusions: what this workstream must NOT touch.",
      }),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description: "Ids of the workstreams this one builds on (a DAG, no cycles).",
        }),
      ),
      integrationTest: Type.Optional(
        Type.String({
          description:
            "Consolidated-tree test path that exercises this workstream with its dependencies.",
        }),
      ),
      introduces: Type.Optional(
        Type.Array(Type.String(), {
          description: "Symbols this workstream CREATES that do not exist at the base commit.",
        }),
      ),
      consumes: Type.Optional(
        Type.Array(Type.String(), {
          description: "Symbols this workstream USES that do not exist at the base commit.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const id = String((raw as { id?: unknown }).id ?? "");
      // Refused, not merged: the second call is the one the model must redo.
      // Exact string equality — no normalisation, so `Task-A` and `task-a` differ.
      if (accepted.has(id)) {
        throw new Error(
          `workstream id '${id}' was already reported in this plan — each workstream needs a distinct id. This call was refused and added nothing; call again with a distinct id.`,
        );
      }
      accepted.add(id);
      return {
        content: [{ type: "text", text: `recorded workstream ${id}` }],
        details: { id },
      };
    },
  });
}

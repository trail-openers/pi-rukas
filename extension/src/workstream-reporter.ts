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
 * Two checks need more than the schema, and both live here so the model sees
 * the refusal as a tool error and can correct it in the same dispatch: a
 * duplicate `id` (the set is per process, which is per dispatch — a corrective
 * re-dispatch starts empty, as the plan step's contract requires) and a declared
 * path that is not plain repo-relative. The parent re-judges both (see
 * work-driver-plan-calls.ts); the message for a duplicate is exported so the two
 * layers say the same thing.
 *
 * Loaded via `pi --no-extensions --extension <path>` from work-driver-plan.ts;
 * never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { plannedPathProblem } from "./plan-path-shape.ts";

/** Same shape as the markdown parser accepted: lowercase, hyphens and underscores. */
export const WORKSTREAM_ID_PATTERN = "^[a-z0-9][a-z0-9_-]*$";

/** Longest accepted `id`. Longer ids are refused by the schema, not truncated. */
export const WORKSTREAM_ID_MAX = 80;

/** The `report_workstream` arguments, as Pi validates them. */
export const WORKSTREAM_PARAMETERS = Type.Object({
  id: Type.String({
    pattern: WORKSTREAM_ID_PATTERN,
    maxLength: WORKSTREAM_ID_MAX,
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
});

/** A `report_workstream` call's arguments. */
export type WorkstreamArgs = Static<typeof WORKSTREAM_PARAMETERS>;

/** The refusal for a second accepted call with an id already reported. */
export function duplicateWorkstreamIdMessage(id: string): string {
  return `workstream id '${id}' was already reported in this plan — each workstream needs a distinct id. This call was refused and added nothing; call again with a distinct id.`;
}

/**
 * The refusal for a declared path that is not plain repo-relative, or undefined
 * when every `paths` and `outOfScope` entry is acceptable.
 */
export function workstreamPathProblem(args: WorkstreamArgs): string | undefined {
  for (const p of args.paths) {
    const problem = plannedPathProblem(p);
    if (problem) return `paths: ${problem}`;
  }
  for (const p of args.outOfScope) {
    const problem = plannedPathProblem(p);
    if (problem) return `outOfScope: ${problem}`;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const accepted = new Set<string>();
  pi.registerTool({
    name: "report_workstream",
    label: "Report Workstream",
    description:
      "Report ONE workstream of the plan. Call once per workstream — do not batch, and do not write a workstreams section in your reply: only these calls count. A call whose `id` repeats an earlier call in this reply is refused with an error naming the duplicate; give that workstream a distinct id and call again. Every workstream MUST declare a non-empty `paths` list.",
    parameters: WORKSTREAM_PARAMETERS,
    async execute(_id, raw) {
      // Pi validated `raw` against WORKSTREAM_PARAMETERS before calling execute,
      // so the schema's static type is the true shape here (no runtime re-check).
      const args = raw as WorkstreamArgs;
      const pathProblem = workstreamPathProblem(args);
      if (pathProblem) {
        throw new Error(
          `${pathProblem}. This call was refused and added nothing; call again with plain repo-relative paths.`,
        );
      }
      // Refused, not merged: the second call is the one the model must redo.
      // Exact string equality — no normalisation, so `Task-A` and `task-a` differ.
      if (accepted.has(args.id)) throw new Error(duplicateWorkstreamIdMessage(args.id));
      accepted.add(args.id);
      return {
        content: [{ type: "text", text: `recorded workstream ${args.id}` }],
        details: { id: args.id },
      };
    },
  });
}

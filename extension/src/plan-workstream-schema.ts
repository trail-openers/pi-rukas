/**
 * plan-workstream-schema — the `report_workstream` argument schema and the rules
 * that judge a call, shared by the companion extension (workstream-reporter.ts,
 * loaded into the plan child) and the driver's reader (work-driver-plan-calls.ts).
 *
 * Import-free beyond TypeBox and plan-path-shape.ts, on purpose: the companion is
 * loaded with `--extension` and must not drag the Pi entrypoint or the driver's
 * module graph into the child. The driver imports from HERE, never from the
 * companion, for the same reason.
 *
 * The two fields are judged differently, and the schema states it:
 *   - `paths` are plain repo-relative file paths (plannedPathProblem).
 *   - `outOfScope` is free-text exclusions the developer reads. It is bounded, not
 *     verified: a prose entry is accepted, and any renderer that puts it in a
 *     prompt goes through neutraliseFenceEntry first.
 */

import { type Static, Type } from "@sinclair/typebox";
import { plannedPathProblem } from "./plan-path-shape.ts";

/** Same shape as the markdown parser accepted: lowercase, hyphens and underscores. */
export const WORKSTREAM_ID_PATTERN = "^[a-z0-9][a-z0-9_-]*$";

/** Longest accepted `id`. Longer ids are refused by the schema, not truncated. */
export const WORKSTREAM_ID_MAX = 80;

/** Longest accepted declared path. */
export const WORKSTREAM_PATH_MAX = 300;

/** Longest accepted `scope` label. */
export const WORKSTREAM_SCOPE_MAX = 300;

/** Longest accepted `integrationTest` path. */
export const WORKSTREAM_INTEGRATION_TEST_MAX = 300;

/** Longest accepted `outOfScope` entry (free text). */
export const WORKSTREAM_FENCE_MAX = 500;

/** Most entries accepted in any list field of one call. */
export const WORKSTREAM_LIST_MAX = 50;

/** The `report_workstream` arguments, as Pi validates them. */
export const WORKSTREAM_PARAMETERS = Type.Object(
  {
    id: Type.String({
      pattern: WORKSTREAM_ID_PATTERN,
      maxLength: WORKSTREAM_ID_MAX,
      description: "Short lowercase id, e.g. task-a. Unique within this reply.",
    }),
    scope: Type.String({
      maxLength: WORKSTREAM_SCOPE_MAX,
      description: "One-line scope label for this workstream.",
    }),
    paths: Type.Array(Type.String({ maxLength: WORKSTREAM_PATH_MAX }), {
      maxItems: WORKSTREAM_LIST_MAX,
      description:
        "Plain repo-relative file paths this workstream is EXPECTED to modify, one per entry (e.g. src/foo.ts). No globs, no leading / or -, no .. segment, no shell characters.",
    }),
    outOfScope: Type.Array(Type.String({ maxLength: WORKSTREAM_FENCE_MAX }), {
      maxItems: WORKSTREAM_LIST_MAX,
      description:
        "Free-text exclusions: what this workstream must NOT touch, as short phrases or sentences (e.g. 'the docs folder', 'the public API of foo'). Read by the developer; not checked as paths.",
    }),
    dependsOn: Type.Optional(
      Type.Array(Type.String({ maxLength: WORKSTREAM_ID_MAX }), {
        maxItems: WORKSTREAM_LIST_MAX,
        description: "Ids of the workstreams this one builds on (a DAG, no cycles).",
      }),
    ),
    integrationTest: Type.Optional(
      Type.String({
        maxLength: WORKSTREAM_INTEGRATION_TEST_MAX,
        description:
          "Consolidated-tree test path that exercises this workstream with its dependencies.",
      }),
    ),
    introduces: Type.Optional(
      Type.Array(Type.String({ maxLength: WORKSTREAM_PATH_MAX }), {
        maxItems: WORKSTREAM_LIST_MAX,
        description: "Symbols this workstream CREATES that do not exist at the base commit.",
      }),
    ),
    consumes: Type.Optional(
      Type.Array(Type.String({ maxLength: WORKSTREAM_PATH_MAX }), {
        maxItems: WORKSTREAM_LIST_MAX,
        description: "Symbols this workstream USES that do not exist at the base commit.",
      }),
    ),
  },
  // A misspelled key (`outOfscope`) would otherwise be dropped silently: the fence
  // the planner meant to write would simply not exist.
  { additionalProperties: false },
);

/** A `report_workstream` call's arguments. */
export type WorkstreamArgs = Static<typeof WORKSTREAM_PARAMETERS>;

/** The refusal for a second accepted call with an id already reported. */
export function duplicateWorkstreamIdMessage(id: string): string {
  return `workstream id '${id}' was already reported in this plan — each workstream needs a distinct id. This call was refused and added nothing; call again with a distinct id.`;
}

/**
 * The refusal for a declared path that is not plain repo-relative, or undefined
 * when every `paths` entry is acceptable. `outOfScope` is not checked here: it is
 * free text (see the header).
 */
export function workstreamPathProblem(args: WorkstreamArgs): string | undefined {
  for (const p of args.paths) {
    const problem = plannedPathProblem(p);
    if (problem) return `paths: ${problem}`;
  }
  return undefined;
}

/**
 * Why the companion refuses a call, or undefined when it accepts it. Pure: the
 * caller owns `accepted`, the ids already reported in this dispatch. The
 * companion and the smoke-test helper both call this, so the rules have one
 * owner.
 */
export function workstreamCallRefusal(
  args: WorkstreamArgs,
  accepted: ReadonlySet<string>,
): string | undefined {
  const pathProblem = workstreamPathProblem(args);
  if (pathProblem) {
    return `${pathProblem}. This call was refused and added nothing; call again with plain repo-relative paths.`;
  }
  // Refused, not merged: the second call is the one the model must redo.
  // Exact string equality — no normalisation, so `Task-A` and `task-a` differ.
  if (accepted.has(args.id)) return duplicateWorkstreamIdMessage(args.id);
  return undefined;
}

/**
 * An `outOfScope` entry as it may appear inside a prompt: one line, no backticks
 * (they would close the code span a renderer wraps it in), bounded. The entry is
 * the planner's text, so it is neutralised where it is rendered, never trusted.
 */
export function neutraliseFenceEntry(entry: string): string {
  return entry
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WORKSTREAM_FENCE_MAX);
}

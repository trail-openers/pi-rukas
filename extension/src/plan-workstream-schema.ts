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
 *
 * #1744 — "bounded, not verified" had stopped meaning what it said. One entry over
 * `WORKSTREAM_FENCE_MAX` failed Pi's schema check, and a whole workstream's call
 * was refused for a fence that ran long — the opposite of what a free-text field is
 * for. The schema now carries an ABUSE ceiling (`WORKSTREAM_FENCE_INPUT_MAX`, far
 * above what a sentence is) and the real bound is applied at the tool boundary by
 * `boundOutOfScope`, which clips instead of refusing and records what it did. That
 * bound — and the record's renderer — live in `plan-fence-bound.ts`, which imports
 * the constants declared here (never the other way round, so the companion's graph
 * stays this file plus TypeBox and `plan-path-shape.ts`).
 *
 * What is left here is the shape and the rules that REFUSE: the TypeBox schema, the
 * constants, and the path/duplicate checks. `plannedPathProblem` is the only import.
 *
 * #1756 round 2 also puts the ECHO here: the key, the prefix and the reader for
 * the value the companion reports back as the arguments it actually recorded
 * (`recordedWorkstreamArgs`). The companion writes it, the driver reads it, and
 * the smoke-test helper replays it, so all three agree on one shape.
 */

import { type Static, Type } from "@sinclair/typebox";
import { plannedPathProblem } from "./plan-path-shape.ts";

/** Same shape as the markdown parser accepted: lowercase, hyphens and underscores. */
export const WORKSTREAM_ID_PATTERN = "^[a-z0-9][a-z0-9_-]*$";

/** Longest accepted `id`. Longer ids are refused by the schema, not truncated. */
export const WORKSTREAM_ID_MAX = 80;

/** Longest accepted declared path. */
export const WORKSTREAM_PATH_MAX = 300;

/**
 * The abuse ceiling the SCHEMA accepts for the `paths` ARRAY (#1756 part b).
 *
 * `WORKSTREAM_PATH_INPUT_LIST_MAX` (500) is what bounds the list (#1756 part
 * b): every scope gate reads `ws.paths` as the authorised set and every prompt
 * prints the whole list, so refusing a call at the 51st path made the omitted
 * files unauthorised — five field cycles parked on exactly that (`paths: must
 * not have more than 50 items`). The schema now accepts what a large refactor
 * declares and refuses only what no plan is; there is no display bound.
 */
export const WORKSTREAM_PATH_INPUT_LIST_MAX = 500;

/** Longest accepted `scope` label. */
export const WORKSTREAM_SCOPE_MAX = 300;

/** Longest accepted `integrationTest` path. */
export const WORKSTREAM_INTEGRATION_TEST_MAX = 300;

/**
 * The length an `outOfScope` entry is BOUNDED to at the tool boundary (#1744).
 * Exceeding it clips the entry — it has never been a reason to refuse a call.
 */
export const WORKSTREAM_FENCE_MAX = 500;

/**
 * The abuse ceiling the SCHEMA accepts for one `outOfScope` entry: far above any
 * sentence a planner writes, low enough that a runaway reply cannot send a
 * megabyte of fence text through the tool channel. A value between this and
 * `WORKSTREAM_FENCE_MAX` is accepted and clipped, not refused (#1744).
 */
export const WORKSTREAM_FENCE_INPUT_MAX = 20_000;

/**
 * The abuse ceiling the SCHEMA accepts for the `outOfScope` ARRAY (#1744).
 * `WORKSTREAM_LIST_MAX` (50) is the bound the driver keeps; this is only what
 * no planner ever writes — past it a reply is a runaway loop, not a plan, and
 * refusing the call is cheaper than splitting and clipping 500 entries.
 */
export const WORKSTREAM_FENCE_INPUT_LIST_MAX = 500;

/** Most entries accepted in any list field of one call. */
export const WORKSTREAM_LIST_MAX = 50;

/** What one over-long `outOfScope` entry was cut to. */
export const FENCE_CLIP_MARKER = " …[clipped]";

/**
 * #1756 round 2 — the key under which the companion echoes the arguments it
 * actually recorded, on the tool result's `details`.
 *
 * WHY THE CHILD REPORTS IT. The parent cannot re-derive this value. Pi's tool
 * validation (`validateToolArguments` in pi-ai `utils/validation.js`) runs
 * `normalizeOptionalNulls` plus `Value.Convert` before its `Check`, and the
 * TypeBox package that does the converting is whatever the INSTALLED Pi ships:
 * the dev-pinned pi-ai validates with `typebox` 1.3.x, whose `Convert` does not
 * turn a string into an array or a number into a string, while field runs on
 * other Pi versions DID coerce a string `outOfScope` into an array. A parent
 * that converts on its own therefore accepts shapes the pinned Pi refuses (when
 * it mirrors the installed version) or refuses shapes the child recorded (when
 * it mirrors the pin). Both are wrong, and only one value is in question: the
 * one `execute` was handed. So the child reports that value and the parent
 * judges IT — the parent never converts anything.
 *
 * TWO CARRIERS, same payload, because `details` has no contract: Pi's
 * `createToolResultMessage` copies `result.details` onto the replayed
 * `toolResult` message today, but the `details` it stamps is typed `unknown` on
 * the parent's read and Pi declares nothing about it, so a future Pi may drop
 * it. The companion therefore also appends the same JSON as one text line
 * prefixed with `RECORDED_WORKSTREAM_ARGS: `, which survives Pi's 300-character
 * bound on a result's text (`TOOL_RESULT_TEXT_MAX` in spawn-collapse-events.ts)
 * for any call a real plan writes, since the echo is what the child was handed
 * and the schema already bounds it.
 */
export const RECORDED_ARGS_DETAILS_KEY = "recordedArgs";

/** The text-line prefix of the same echo; see `RECORDED_ARGS_DETAILS_KEY`. */
export const RECORDED_ARGS_TEXT_PREFIX = "RECORDED_WORKSTREAM_ARGS: ";

/**
 * The value the child says it recorded, or undefined when this result carries
 * no echo: an older companion, a channel that dropped both carriers, or a
 * refused call (which records nothing and so says nothing). Presence is never
 * inferred — absence is a distinct answer, and the reader decides what it means.
 */
export function recordedWorkstreamArgs(result: {
  details?: unknown;
  text?: string;
}): unknown | undefined {
  const viaDetails =
    result.details &&
    typeof result.details === "object" &&
    RECORDED_ARGS_DETAILS_KEY in result.details
      ? (result.details as Record<string, unknown>)[RECORDED_ARGS_DETAILS_KEY]
      : undefined;
  if (viaDetails !== undefined) return viaDetails;
  const text = result.text;
  if (typeof text !== "string") return undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith(RECORDED_ARGS_TEXT_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(RECORDED_ARGS_TEXT_PREFIX.length));
    } catch {
      // Truncated by the text bound, or not JSON. A broken echo is NO echo —
      // the reader then judges raw arguments, as it did before #1756, rather
      // than inventing a value it cannot read.
      return undefined;
    }
  }
  return undefined;
}

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
    // The ceiling is abuse-level, not plan-level (#1756 part b): a crowded
    // list is NEVER a reason to refuse the call. Every declared path is printed
    // to the developer and every one counts as in scope for the scope gates.
    paths: Type.Array(Type.String({ maxLength: WORKSTREAM_PATH_MAX }), {
      maxItems: WORKSTREAM_PATH_INPUT_LIST_MAX,
      description:
        "Plain repo-relative file paths this workstream is EXPECTED to modify, one per entry (e.g. src/foo.ts). No globs, no leading / or -, no .. segment, no shell characters. Declare every file the change touches — the whole list is shown to the developer and is the authorised set the scope gates read.",
    }),
    // No `maxItems` and a ceiling far above a sentence, on purpose (#1744): this
    // field is free text, and a long entry or a crowded list is bounded by
    // `boundOutOfScope` at the tool boundary — never a reason to refuse the call.
    outOfScope: Type.Array(Type.String({ maxLength: WORKSTREAM_FENCE_INPUT_MAX }), {
      maxItems: WORKSTREAM_FENCE_INPUT_LIST_MAX,
      description: `Free-text exclusions: what this workstream must NOT touch, as short phrases or sentences (e.g. 'the docs folder', 'the public API of foo'). Read by the developer; not checked as paths. Prefer one thing per entry: an entry longer than ${WORKSTREAM_FENCE_MAX} characters is clipped at its last path separator, comma or space, and past ${WORKSTREAM_LIST_MAX} entries the rest are dropped. A comma- or semicolon-separated list of plain paths is stored as separate entries.`,
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

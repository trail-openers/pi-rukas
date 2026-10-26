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
 * #1756 round 2 also puts the ECHO here: the key, the envelope, the reader, and
 * the rule that BINDS an echo to the call it claims to describe
 * (`recordedWorkstreamArgs`, `recordedWorkstreamDetails`, `echoMatchesCall`). The
 * companion writes it, the driver reads it, and the smoke-test helper replays it,
 * so all three agree on one shape through one exported function.
 *
 * WHY pi-ai/TypeBox is described once, here: the installed Pi's own validation is
 * the thing the echo exists to report, and the dev-pinned `pi-ai` in this
 * package's devDependencies is NOT what validates a child's call at runtime. Any
 * other module that needs to say why the parent cannot re-derive the value
 * (work-driver-plan-calls.ts) points here rather than restating it.
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
 * #1756 round 2 — the ONE key under which the companion echoes the arguments it
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
 * judges IT — the parent never converts anything. That is also why the parent
 * BINDS the echo to the call it claims to describe (`echoMatchesCall`): an
 * unbound echo is a second channel for the same fields, and one that can widen
 * `paths` or drop the fence is not evidence, it is an override.
 *
 * ONE CARRIER. `details` is the carrier; there is no text-line carrier. Pi's
 * `createToolResultMessage` copies `result.details` onto the replayed
 * `toolResult` message, and `collapseEvents` carries it verbatim (the 300-char
 * `TOOL_RESULT_TEXT_MAX` bound applies to a result's TEXT, which exists for
 * display — a real call's JSON does not fit it, which is why the text line was
 * dropped in round 2). Absence of the key is no echo and is not an error: the
 * reader then judges the raw arguments, exactly as before #1756.
 */
export const RECORDED_ARGS_DETAILS_KEY = "recordedArgs";

/**
 * The ONE envelope: what a `report_workstream` result's `details` looks like,
 * built by the companion (`workstream-reporter.ts`), by the smoke-test helper
 * (`smoke-tests/lib/plan-workstream-calls.ts`) and read by the transport
 * (`spawn-collapse-events.ts`) and the reader (`recordedWorkstreamArgs`). A
 * writer and a reader that each assembled their own object literal are how the
 * two sides of this channel drift — the shape and the key have one owner now.
 * A result that recorded nothing carries no `details` at all; the reader treats a
 * missing key, an empty `details` and a non-object payload alike as NO echo (see
 * `recordedWorkstreamArgs`), so a writer never has to invent a sentinel.
 */
export function recordedWorkstreamDetails(args: unknown): { [RECORDED_ARGS_DETAILS_KEY]: unknown } {
  return { [RECORDED_ARGS_DETAILS_KEY]: args };
}

/**
 * The value the child says it recorded, or undefined when this result carries
 * no echo: an older companion, a channel that dropped the payload, a refused
 * call (which records nothing and so says nothing), or a `details` whose
 * `recordedArgs` is not a plain object — a null, string or array there, or a
 * key present with the value `undefined`, is not a params object anybody
 * recorded, so it is NO echo and never a judged value.
 * Presence is never inferred — absence is a distinct answer, and the reader
 * decides what it means.
 *
 * The `details?: unknown` parameter is deliberate: the transport types it
 * `unknown` (Pi declares no schema for `details`), and this is where it narrows.
 */
export function recordedWorkstreamArgs(result: { details?: unknown }): unknown | undefined {
  // A missing `details`, one without the key, and a key present with the value
  // `undefined` are each explicitly no echo — never inferred, and never judged
  // as a value.
  if (!isEchoObject(result.details)) return undefined;
  const echoed = result.details[RECORDED_ARGS_DETAILS_KEY];
  return isEchoObject(echoed) ? echoed : undefined;
}

/**
 * A value that can BE an echo: an own-property plain object (an `Object.create`
 * with a null prototype is not — the reader must only ever judge values JSON
 * produced or the companion built). Not `plan-provenance.ts`'s `isPlainObject`
 * because importing it here would put the issue-filing provenance module in the
 * companion's import graph; the prototype test is the same one.
 */
function isEchoObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Why an echo does NOT describe the raw call it arrived with, or undefined when
 * it is a coercion of it. This is the parent's own check (#1756 round 2, lens
 * HIGH): an echo is untrusted input, and an unbound one can replace the
 * authorised `paths`, empty `outOfScope` (deleting the fence the developer is
 * held to), or mint an id the transcript never contains.
 *
 * What is allowed is EXACTLY what a tool-argument normalisation can do — nothing
 * else, so an echo cannot widen anything:
 *  - every key the echo carries is a schema key, and every key `raw` carries with
 *    a non-null value is carried by the echo (a `raw` key whose value is `null`
 *    may be absent — that is Pi's `normalizeOptionalNulls`);
 *  - a string field matches when `echo === raw`, or `raw` is a number/boolean and
 *    `echo === String(raw)`; `id` must be EXACTLY the raw `id` when the raw `id`
 *    is a string — a coercion never invents a different identity;
 *  - an array field matches when the echo deep-equals `raw` (both arrays), or the
 *    echo deep-equals `[raw]` (`raw` a single string), element by element under
 *    the string rule above;
 *  - a number/boolean field matches under the same two-way string rule.
 *
 * The differing key is named so the caller can trace it.
 */
export function echoMatchesCall(
  raw: unknown,
  echo: unknown,
): { ok: true } | { ok: false; keys: string[] } {
  if (!isEchoObject(echo) || !isEchoObject(raw)) return { ok: false, keys: ["<not an object>"] };
  const keys: string[] = [];
  for (const key of Object.keys(echo)) {
    if (!(key in WORKSTREAM_PARAMETERS.properties)) keys.push(`${key}(unknown key)`);
  }
  for (const [key, rawValue] of Object.entries(raw)) {
    if (rawValue === null) continue;
    if (!(key in echo)) {
      keys.push(`${key}(missing from echo)`);
      continue;
    }
    if (!echoFieldMatches(key, rawValue, echo[key])) keys.push(key);
  }
  return keys.length > 0 ? { ok: false, keys } : { ok: true };
}

/** The two coercions one field of an echo is allowed to be. */
function echoFieldMatches(key: string, raw: unknown, echo: unknown): boolean {
  if (Array.isArray(raw)) {
    if (!Array.isArray(echo) || echo.length !== raw.length) return false;
    return raw.every((item, i) => echoScalarMatches(key, item, echo[i]));
  }
  if (typeof raw === "string") {
    // A single string may have been normalised into a one-element array.
    if (Array.isArray(echo)) {
      return echo.length === 1 && echoScalarMatches(key, raw, echo[0]);
    }
    return echoScalarMatches(key, raw, echo);
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    if (Array.isArray(echo)) {
      return echo.length === 1 && echoScalarMatches(key, raw, echo[0]);
    }
    return echoScalarMatches(key, raw, echo);
  }
  // Anything else (a nested object, a function) is not a shape a schema field
  // holds, so an echo carrying one describes something the model never sent.
  return false;
}

/** `id` is identity: an echo may not rename the workstream it reports on. */
function echoScalarMatches(key: string, raw: unknown, echo: unknown): boolean {
  if (key === "id" && typeof raw === "string") return echo === raw;
  if (typeof raw === "string") return echo === raw;
  if (typeof raw === "number" || typeof raw === "boolean") {
    return echo === raw || echo === String(raw);
  }
  return echo === raw;
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

/**
 * Shared fixtures for the two #1756 round-2 files, which split the concern the
 * way #1744's fence tests split: `test-plan-coercion-1756.ts` judges the READER
 * (what `workstreamCallsOf` does with a result), and
 * `test-plan-echo-binding-1756.ts` judges the BINDING RULE itself
 * (`echoMatchesCall`, pure). Both build the same transcripts, so the builders
 * live here rather than being copied where they could drift.
 *
 * A call and its result, placed by hand rather than through
 * lib/plan-workstream-calls.ts, because these files must control the carrier
 * precisely: one with it, one without, one whose payload is not a params object.
 * The helper always writes what the real companion would have written, which is
 * the right default for every other plan test and the wrong one here.
 */

import { RECORDED_ARGS_DETAILS_KEY } from "../../src/plan-workstream-schema.ts";

/**
 * The model sent `outOfScope` as ONE string. Whether the installed Pi coerced it
 * to an array is exactly the question the parent cannot answer — see
 * `RECORDED_ARGS_DETAILS_KEY` in plan-workstream-schema.ts.
 */
export const RAW_STRING_FENCE = {
  id: "task-a",
  scope: "a",
  paths: ["src/a.ts"],
  outOfScope: "docs/",
};

/** What a companion that DID coerce reports: the same call, fence as a list. */
export const RECORDED_ARRAY_FENCE = { ...RAW_STRING_FENCE, outOfScope: ["docs/"] };

/** The result-entry shape `workstreamCallsOf` reads. */
export type ResultEntry = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  details?: unknown;
};

/** One call's result: an error, a success with no echo, or a success with one. */
export function entry(id: string, result: { error?: string; recorded?: unknown } = {}): ResultEntry {
  if (result.error !== undefined) {
    return { toolCallId: id, toolName: "report_workstream", isError: true, text: result.error };
  }
  return {
    toolCallId: id,
    toolName: "report_workstream",
    isError: false,
    text: "recorded",
    // The key is present exactly when the child said anything, so
    // `recorded: undefined` models "no echo", not an echo of nothing.
    ...(result.recorded === undefined ? {} : { details: { [RECORDED_ARGS_DETAILS_KEY]: result.recorded } }),
  };
}

/** The transcript of one `report_workstream` call, and the result for it. */
export function call(
  id: string,
  args: unknown,
  result: { error?: string; recorded?: unknown } = {},
): { toolUses: unknown[]; toolResults: ResultEntry[] } {
  return {
    toolUses: [{ type: "toolCall", id, name: "report_workstream", arguments: args }],
    toolResults: [entry(id, result)],
  };
}

/** A transcript from several per-call pieces. */
export function transcript(
  ...parts: Array<{ toolUses: unknown[]; toolResults: ResultEntry[] }>
): { toolUses: unknown[]; toolResults: ResultEntry[] } {
  return {
    toolUses: parts.flatMap((p) => p.toolUses),
    toolResults: parts.flatMap((p) => p.toolResults),
  };
}

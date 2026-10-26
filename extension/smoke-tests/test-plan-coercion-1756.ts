#!/usr/bin/env bun
/**
 * #1756 — the plan step's reader judges a `report_workstream` call on the value
 * Pi actually validated, not on the raw arguments.
 *
 * The defect, in one line: `workstreamCallsOf` ran `Value.Check` on the RAW
 * `tu.arguments`, but the child had acknowledged arguments Pi already
 * CONVERTED. Pi's tool validation (`validateToolArguments` in pi-ai
 * `utils/validation.js`) clones the arguments and runs them through TypeBox
 * `Value.Convert` before checking them, so a model that sends an array field as
 * a single string is ACCEPTED in the child — its `execute` records the
 * workstream and returns a success tool result — and then REFUSED by the parent
 * as "arguments do not match the report_workstream schema". The workstream
 * existed in the child and not in the driver; the planner's retry under the same
 * id then drew the duplicate refusal, and the whole workstream's paths were
 * lost. Field evidence: 6 plan-spec-mismatch parks on releases up to v0.14.17,
 * and two more cycles that needed a corrective plan pass because of it.
 *
 * The fix mirrors Pi: a clone of the raw arguments goes through
 * `Value.Convert(WORKSTREAM_PARAMETERS, …)`, the converted value is what
 * `Value.Check` judges, and the converted value is what reaches the path check,
 * the duplicate check, and state.
 *
 * What this file pins, in order:
 *   1. a coerceable call with a SUCCESS result is accepted, and the field
 *      arrives in state as a one-element array (`outOfScope`, `paths`,
 *      `dependsOn` — every array field converts, so the parent must accept
 *      each of them);
 *   2. a call that is STILL invalid after conversion is refused exactly as
 *      before, with the same reason text, and stays a refusal rather than
 *      becoming an unreadable result-channel failure — mirroring the
 *      conversion is not a loosening of the schema;
 *   3. a call whose tool result is an ERROR is refused with the error text,
 *      coerceable arguments or not;
 *   4. the duplicate rule survives the coercion: two coerceable calls under one
 *      id still yield one workstream;
 *   5. the reader never mutates the transcript it was handed — `Value.Convert`
 *      writes through its argument, so a reader that forgot to clone would
 *      leave the replay holding a shape nobody sent.
 *
 * Pure over DispatchResult-shaped objects, like test-plan-workstream-reader.ts
 * (which keeps the reader's other invariants): no child process, no state file.
 * Each block builds its `toolUses`/`toolResults` by hand rather than through
 * lib/plan-workstream-calls.ts, because that helper's `companionOutcome` replays
 * Pi's schema check as `Value.Check` alone, and would report a coerceable call
 * as an error result before this reader ever saw it.
 */

import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One successful `report_workstream` call and its (non-error) result. */
function accepted(args: unknown, toolCallId = "c1") {
  return {
    toolUses: [{ type: "toolCall", id: toolCallId, name: "report_workstream", arguments: args }],
    toolResults: [
      { toolCallId, toolName: "report_workstream", isError: false, text: "recorded" },
    ],
  };
}

// ------------------------------------- 1: a coerceable call is what the child accepted

{
  const report = workstreamCallsOf(
    accepted({ id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: "docs/" }),
  );
  assert(
    report.accepted === 1 && report.refused.length === 0 && report.unreadable === 0,
    "a call whose array field arrived as a string, and whose result is a success, is ACCEPTED",
  );
  assert(
    JSON.stringify(report.workstreams["task-a"]?.outOfScope) === JSON.stringify(["docs/"]),
    `the coerced field reaches state as a ONE-ELEMENT ARRAY (got ${JSON.stringify(report.workstreams["task-a"]?.outOfScope)})`,
  );
  assert(
    JSON.stringify(report.workstreams["task-a"]?.paths) === JSON.stringify(["src/a.ts"]),
    "the fields that were already valid are stored unchanged",
  );
}
{
  // `paths` and the optional arrays convert too — Pi converts every array
  // field, so the parent must accept every one of them.
  const report = workstreamCallsOf(
    accepted({
      id: "task-a",
      scope: "a",
      paths: "src/a.ts",
      outOfScope: [],
      dependsOn: "task-b",
    }),
  );
  assert(
    report.accepted === 1 &&
      JSON.stringify(report.workstreams["task-a"]?.paths) === JSON.stringify(["src/a.ts"]) &&
      JSON.stringify(report.workstreams["task-a"]?.dependsOn) === JSON.stringify(["task-b"]),
    "`paths` and `dependsOn` arriving as single strings are accepted as one-element arrays too",
  );
}

// ------------------------------------- 2: still invalid after conversion → refused as today

{
  const report = workstreamCallsOf({
    toolUses: [
      // No `id` at all: nothing converts a missing required field into one.
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: { scope: "a", paths: ["src/a.ts"], outOfScope: [] },
      },
      // An object where the schema wants a list of strings.
      {
        type: "toolCall",
        id: "c2",
        name: "report_workstream",
        arguments: { id: "task-b", scope: "b", paths: { not: "a string" }, outOfScope: [] },
      },
    ],
    toolResults: [
      { toolCallId: "c1", toolName: "report_workstream", isError: false, text: "recorded" },
      { toolCallId: "c2", toolName: "report_workstream", isError: false, text: "recorded" },
    ],
  });
  assert(
    report.accepted === 0 &&
      report.refused.length === 2 &&
      report.refused.every(
        (r) => r.reason === "arguments do not match the report_workstream schema",
      ),
    "a call still invalid after conversion is refused with the UNCHANGED schema reason",
  );
  assert(
    report.refused[0]?.id === undefined && report.refused[1]?.id === "task-b",
    "the refused calls still record the ids they had (none for the call with no id at all)",
  );
  assert(
    report.unreadable === 0,
    "a genuinely invalid call stays a refusal, never a result-channel failure",
  );
}

// ------------------------------------- 3: an error tool result is refused as today

{
  const report = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: "docs/" },
      },
    ],
    toolResults: [
      {
        toolCallId: "c1",
        toolName: "report_workstream",
        isError: true,
        text: "companion refused",
      },
    ],
  });
  assert(
    report.accepted === 0 &&
      report.refused.length === 1 &&
      report.refused[0]?.id === "task-a" &&
      report.refused[0]?.reason === "companion refused",
    "a call whose tool result is an error is refused with the error text, coerceable arguments or not",
  );
}

// ------------------------------------- 4: the duplicate rule outlives the coercion

{
  // Both calls convert; only the first may be kept. Accepting the converted
  // shape must not quietly widen the id set the child refused on.
  const coerced = { id: "dup", scope: "a", paths: ["src/a.ts"], outOfScope: "docs/" };
  const report = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: structuredClone(coerced),
      },
      {
        type: "toolCall",
        id: "c2",
        name: "report_workstream",
        arguments: structuredClone(coerced),
      },
    ],
    toolResults: [
      { toolCallId: "c1", toolName: "report_workstream", isError: false, text: "recorded" },
      { toolCallId: "c2", toolName: "report_workstream", isError: false, text: "recorded" },
    ],
  });
  assert(
    report.accepted === 1 &&
      report.refused.length === 1 &&
      report.refused[0]?.reason.includes("dup") === true,
    "a second coerceable call with a held id is still refused as a duplicate",
  );
}

// ------------------------------------- 5: the transcript is not rewritten by the read

{
  // `Value.Convert` mutates its argument in place: the clone is what keeps the
  // replay's `arguments` the shape the model actually sent.
  const args = { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: "docs/" };
  const before = JSON.stringify(args);
  workstreamCallsOf(accepted(args));
  assert(
    JSON.stringify(args) === before,
    "the call's raw arguments are left exactly as the replay wrote them (the conversion is on a clone)",
  );
}

process.exit(exit);

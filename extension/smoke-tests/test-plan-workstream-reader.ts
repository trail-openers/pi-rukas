#!/usr/bin/env bun
/**
 * #1652 — the reader of a plan dispatch's `report_workstream` calls
 * (work-driver-plan-calls.ts): only successful calls count, refusals are kept
 * with their reason, and the reader holds its own invariants (uniqueness of
 * accepted ids, a cap on planner-supplied ids). Pure over DispatchResult-shaped
 * objects: no child process, no state file.
 */

import { noWorkstreamCallsEvidence, workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import { planResultFromCalls, planResultFromRawCalls } from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ the transport

{
  const calls = [
    {
      id: "task-a",
      scope: "scope a",
      paths: ["src/a.ts", "src/a2.ts"],
      outOfScope: ["docs/"],
      dependsOn: ["task-c"],
      integrationTest: "test/a.ts",
      introduces: ["fieldA"],
      consumes: ["fieldC"],
    },
    { id: "task-b", scope: "scope b", paths: ["src/b.ts"], outOfScope: [] },
    {
      id: "task-c",
      scope: "scope c",
      paths: ["src/c.ts"],
      outOfScope: ["src/a.ts"],
    },
  ];
  const report = workstreamCallsOf(planResultFromCalls(calls));
  assert(
    report.accepted === 3 && Object.keys(report.workstreams).length === 3,
    "N distinct successful calls → N workstreams",
  );
  assert(
    JSON.stringify(report.workstreams["task-a"]) ===
      JSON.stringify({
        id: "task-a",
        scope: "scope a",
        paths: ["src/a.ts", "src/a2.ts"],
        outOfScope: ["docs/"],
        dependsOn: ["task-c"],
        integrationTest: "test/a.ts",
        introduces: ["fieldA"],
        consumes: ["fieldC"],
      }),
    "each workstream equals its call's fields (the optional fields carried through)",
  );
  assert(
    JSON.stringify(report.workstreams["task-b"]) ===
      JSON.stringify({
        id: "task-b",
        scope: "scope b",
        paths: ["src/b.ts"],
        outOfScope: [],
      }),
    "a call that omits the optional fields adds no keys",
  );
}
{
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      {
        id: "task-a",
        args: { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
      },
      {
        id: "task-a",
        args: {
          id: "task-a",
          scope: "a again",
          paths: ["src/x.ts"],
          outOfScope: [],
        },
      },
      {
        id: "Bad Id",
        args: {
          id: "Bad Id",
          scope: "bad",
          paths: ["src/y.ts"],
          outOfScope: [],
        },
        refused: "schema: id does not match the pattern — refused, adds nothing",
      },
    ]),
  );
  assert(report.accepted === 1, "a duplicate-id call and a schema-invalid call add nothing");
  assert(
    Object.keys(report.workstreams).join() === "task-a" &&
      report.workstreams["task-a"]?.scope === "a",
    "the accepted set is the first task-a only",
  );
  assert(report.refused.length === 2, "both refused calls are reported");
  assert(
    report.refused[0]?.reason.includes("task-a") === true,
    "the duplicate refusal names the duplicate id",
  );
}
{
  // A call whose tool result never arrived is not a success: it is counted as refused.
  const result = planResultFromCalls([
    { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
  ]);
  const report = workstreamCallsOf({
    toolUses: result.toolUses,
    toolResults: [],
  });
  assert(
    report.accepted === 0 && report.refused.length === 1,
    "a call with no recorded result is not counted",
  );
  assert(
    noWorkstreamCallsEvidence(report) === "no successful report_workstream call (1 refused)",
    "the evidence says the calls were made and refused",
  );
  assert(
    noWorkstreamCallsEvidence(workstreamCallsOf({ toolUses: [], toolResults: [] })) ===
      "no report_workstream call",
    "the evidence for a reply with no call is 'no report_workstream call'",
  );
}
{
  // Prose is not read: a markdown block in the reply's text is no workstream.
  const report = workstreamCallsOf({ toolUses: [], toolResults: [] });
  assert(
    report.accepted === 0,
    "a markdown block in the reply's prose is not read for workstreams",
  );
}

// --------------------------- the reader's own invariants (#1652 round 2)

{
  // A replay with calls but NO tool-result messages (the message_end fallback)
  // is not a per-call refusal: the evidence says the results are unavailable.
  const calls = planResultFromCalls([
    { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
  ]);
  const report = workstreamCallsOf({ toolUses: calls.toolUses, toolResults: undefined });
  assert(
    report.accepted === 0 && report.refused.length === 1,
    "no results carried: the calls are not counted",
  );
  assert(
    noWorkstreamCallsEvidence(report).startsWith(
      "report_workstream results unavailable (1 call(s)",
    ),
    "no results carried: the evidence names unavailable results, not a refusal",
  );
}
{
  // The reader refuses a second accepted call with an id it already holds.
  const report = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: { id: "dup", scope: "a", paths: ["x"], outOfScope: [] },
      },
      {
        type: "toolCall",
        id: "c2",
        name: "report_workstream",
        arguments: { id: "dup", scope: "b", paths: ["y"], outOfScope: [] },
      },
    ],
    toolResults: [
      { toolCallId: "c1", toolName: "report_workstream", isError: false, text: "ok" },
      { toolCallId: "c2", toolName: "report_workstream", isError: false, text: "ok" },
    ],
  });
  assert(
    report.accepted === 1 && report.workstreams.dup?.scope === "a",
    "a second accepted call with a held id is refused, not overwritten",
  );
}
{
  // A planner-supplied id is capped before it reaches state.
  const long = "x".repeat(5000);
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      {
        id: long,
        args: { id: long, scope: "s", paths: ["p"], outOfScope: [] },
        refused: "schema: refused",
      },
    ]),
  );
  assert((report.refused[0]?.id?.length ?? 0) <= 80, "a refused id is truncated to 80 characters");
}

process.exit(exit);

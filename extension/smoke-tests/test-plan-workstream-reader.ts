#!/usr/bin/env bun
/**
 * #1652 — the reader of a plan dispatch's `report_workstream` calls
 * (work-driver-plan-calls.ts): only successful calls count, refusals are kept
 * with their reason, and the reader holds its own invariants (uniqueness of
 * accepted ids, a cap on planner-supplied ids). Pure over DispatchResult-shaped
 * objects: no child process, no state file.
 */

import { Value } from "@sinclair/typebox/value";
import {
  WORKSTREAM_PARAMETERS,
  WORKSTREAM_SCOPE_MAX,
  workstreamCallRefusal,
} from "../src/plan-workstream-schema.ts";
import {
  appendPlanDispatchOutcome,
  noWorkstreamCallsEvidence,
  workstreamCallsOf,
} from "../src/work-driver-plan-calls.ts";
import { correctiveNoWorkstreamCallsSteer } from "../src/work-driver-plan-steers.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";
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
  // A call whose tool result is missing is not a success, and it is not a
  // refusal either: the result channel failed, so the call is unreadable.
  const result = planResultFromCalls([
    { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
  ]);
  const report = workstreamCallsOf({
    toolUses: result.toolUses,
    toolResults: [],
  });
  assert(
    report.accepted === 0 && report.refused.length === 0 && report.unreadable === 1,
    "a call with no recorded result is unreadable, not counted and not a refusal",
  );
  assert(
    noWorkstreamCallsEvidence(workstreamCallsOf({ toolUses: [], toolResults: [] })).startsWith(
      "no accepted report_workstream call: the reply made none",
    ) &&
      noWorkstreamCallsEvidence(workstreamCallsOf({ toolUses: [], toolResults: [] })).includes(
        "tool list",
      ),
    "the evidence for a reply with no call names both causes (no call, or the tool not registered)",
  );
  assert(
    noWorkstreamCallsEvidence(
      workstreamCallsOf(
        planResultFromRawCalls([
          {
            id: "Bad A",
            args: { id: "Bad A", scope: "x", paths: ["p"], outOfScope: [] },
            refused: "schema: refused",
          },
        ]),
      ),
    ).startsWith("no accepted report_workstream call: 1 call(s) refused —"),
    "calls made and refused: the evidence counts the refusals",
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
  // is not a per-call refusal: every call is unreadable.
  const calls = planResultFromCalls([
    { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
  ]);
  const report = workstreamCallsOf({ toolUses: calls.toolUses, toolResults: undefined });
  assert(
    report.accepted === 0 && report.refused.length === 0 && report.unreadable === 1,
    "no results carried: the calls are unreadable, not counted and not refused",
  );
}
{
  // Paths are refused by the same rules the companion applies.
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      {
        id: "task-a",
        args: { id: "task-a", scope: "a", paths: ["/etc/passwd"], outOfScope: [] },
      },
      {
        // outOfScope is free text: a `..` in prose is an exclusion, not a path.
        id: "task-b",
        args: {
          id: "task-b",
          scope: "b",
          paths: ["src/ok.ts"],
          outOfScope: ["the ../escape folder"],
        },
      },
      {
        id: "task-c",
        args: { id: "task-c", scope: "c", paths: ["src/c.ts (new)", "src/d.ts"], outOfScope: [] },
      },
    ]),
  );
  assert(
    Object.keys(report.workstreams).join() === "task-b,task-c",
    "absolute, traversing and whitespace-carrying paths are refused; prose outOfScope is kept; a trailing annotation is stripped",
  );
  assert(
    report.refused.length === 1 && report.refused[0]?.id === "task-a",
    "a refused path is recorded with its reason, not silently dropped",
  );
}
{
  // The parent judges args the child would have refused, even if Pi let them through.
  const report = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: { id: "Bad Id", scope: "a", paths: ["x"], outOfScope: [] },
      },
    ],
    toolResults: [{ toolCallId: "c1", toolName: "report_workstream", isError: false, text: "ok" }],
  });
  assert(
    report.accepted === 0 && report.refused.length === 1,
    "an accepted-by-Pi call that fails the schema here is refused, not kept",
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
  assert((report.refused[0]?.id?.length ?? 0) <= 64, "a refused id is truncated to 64 characters");
  assert(
    (report.refused[0]?.reason.length ?? 0) <= 300,
    "a refusal reason is capped at 300 characters",
  );
}
{
  // An accepted-looking id longer than the schema's 80 is refused, not kept.
  const long = "a".repeat(81);
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      { id: long, args: { id: long, scope: "s", paths: ["p"], outOfScope: [] } },
    ]),
  );
  assert(
    report.accepted === 0 && report.refused.length === 1,
    "an 81-character id is refused by the schema, not accepted",
  );
}
{
  // Refusals beyond the recorded cap are counted, not stored.
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `Bad ${i}`,
    args: { id: `Bad ${i}`, scope: "s", paths: ["p"], outOfScope: [] },
    refused: "schema: refused",
  }));
  const state = appendPlanDispatchOutcome(
    initialState(1652, 1),
    "plan",
    workstreamCallsOf(planResultFromRawCalls(many)),
    { kind: "step-completed", step: "plan", at: 2 } as unknown as WorkEvent,
  );
  const event = state.eventLog.find((e) => e.kind === "workstream-calls-refused");
  assert(
    event?.kind === "workstream-calls-refused" &&
      event.refused.length === 20 &&
      event.omitted === 5,
    "25 refusals: 20 are recorded and 5 are counted as omitted",
  );
  assert(
    state.eventLog.at(-1)?.kind === "step-completed",
    "the completion event stays the tail after the refusals",
  );
}
{
  // The schema is closed: a misspelled key is refused, not dropped, so the fence
  // the planner meant to write cannot silently vanish.
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      {
        id: "task-a",
        args: { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfscope: ["docs"] },
      },
    ]),
  );
  assert(
    report.accepted === 0 && report.refused.length === 1,
    "a misspelled outOfScope key is refused by the schema, not silently dropped",
  );
}
{
  // Git pathspec magic and globs are refused in `paths`; prose is not checked there.
  const report = workstreamCallsOf(
    planResultFromRawCalls([
      { id: "task-a", args: { id: "task-a", scope: "a", paths: [":(top)x"], outOfScope: [] } },
      { id: "task-b", args: { id: "task-b", scope: "b", paths: ["src/*.ts"], outOfScope: [] } },
      { id: "task-c", args: { id: "task-c", scope: "c", paths: ["src/c.ts"], outOfScope: ["no"] } },
    ]),
  );
  assert(
    Object.keys(report.workstreams).join() === "task-c" && report.refused.length === 2,
    "a leading ':' and a glob character are refused in paths",
  );
}
{
  // The companion's refusal rules, called directly: prose fences are accepted.
  const prose = {
    id: "task-p",
    scope: "prose fence",
    paths: ["src/p.ts"],
    outOfScope: ["the public API of foo, not its internals"],
  };
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, prose) &&
      workstreamCallRefusal(prose, new Set<string>()) === undefined,
    "prose outOfScope is accepted by the schema and the refusal rules",
  );
  assert(
    Value.Check(WORKSTREAM_PARAMETERS, {
      ...prose,
      scope: "x".repeat(WORKSTREAM_SCOPE_MAX + 1),
    }) === false,
    "an over-long scope is refused by the schema",
  );
}

// ------------------------------------------------ the planner's path grammar

{
  // #1652 — real repo paths the old markdown parser accepted must stay accepted.
  const accepted = [
    "app/[id]/page.tsx",
    "app/(group)/page.tsx",
    "docs/my file.md",
    "src/a.ts (new)",
    ".github/workflows/ci.yml(new)",
  ];
  const refused = [
    // The annotation is stored and rendered raw, so it is checked raw too.
    "src/a.ts (`id`)",
    "src/a.ts ($HOME)",
    "src/a.ts (edits; rm -rf x)",
    "/etc/passwd",
    "a/../b",
    "-rf",
    ":(top)x",
    "src/*.ts",
    "src/a?.ts",
    "src/a!.ts",
    "a`b`",
    "a$b",
    "a;b",
    "a&b",
    "a|b",
    "a<b",
    "a>b",
    "a{b}",
    "a\\b",
    'a"b',
    "a'b",
    "a\tb",
    "x\u0000y",
  ];
  const ok = (p: string) =>
    workstreamCallRefusal(
      { id: "task-a", scope: "a", paths: [p], outOfScope: [] },
      new Set<string>(),
    ) === undefined;
  assert(
    accepted.every(ok),
    "paths with [ ] ( ) or a space are accepted (argv/data consumers only)",
  );
  assert(
    refused.every((p) => !ok(p)),
    "absolute, '..', leading '-' or ':', glob, shell and whitespace-other-than-space paths are still refused",
  );
  assert(
    ok("src/a.ts (new)") && ok("app/(group)") && workstreamCallRefusal(
      { id: "task-a", scope: "a", paths: ["app/(group)"], outOfScope: [] },
      new Set<string>(),
    ) === undefined,
    "a trailing annotation is stripped, but a directory ending in (group) keeps its name",
  );
}

// ------------------------------------- refused-only evidence names the reasons

{
  // #1652 — refused calls prove the tool registered: the evidence quotes the
  // refusal reasons and never suggests the registration cause.
  const refusedOnly = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: { id: "task-a", scope: "a", paths: ["/abs"], outOfScope: [] },
      },
    ],
    toolResults: [{ toolCallId: "c1", toolName: "report_workstream", isError: true, text: "nope" }],
  });
  const evidence = noWorkstreamCallsEvidence(refusedOnly);
  assert(
    evidence.includes("1 call(s) refused") &&
      evidence.includes("task-a:") &&
      !evidence.includes("did not register") &&
      !evidence.includes("tool list"),
    "a refused-only park's evidence names the refusals and not the tool registration",
  );
  assert(
    noWorkstreamCallsEvidence(workstreamCallsOf({ toolUses: [], toolResults: [] })).includes(
      "did not register",
    ),
    "a zero-call park keeps the two-cause evidence",
  );
}

// ----------------------------------- refused ids are validated before recording

{
  const report = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: { id: "Bad Id\n## x", scope: "a", paths: ["x"], outOfScope: [] },
      },
    ],
    toolResults: [{ toolCallId: "c1", toolName: "report_workstream", isError: true, text: "no" }],
  });
  assert(
    report.refused[0]?.id === "(invalid id)",
    "a refused id that does not match the id pattern is recorded as '(invalid id)'",
  );
  const steer = correctiveNoWorkstreamCallsSteer([
    { id: "task-a`x", reason: "bad `path`\n## injected" },
  ]);
  assert(
    !steer.split("\n").some((line) => line.startsWith("## injected")) &&
      steer.includes("bad 'path'") &&
      steer.includes("`task-a'x`"),
    "the corrective steer neutralises refused id and reason before interpolation",
  );
}

process.exit(exit);

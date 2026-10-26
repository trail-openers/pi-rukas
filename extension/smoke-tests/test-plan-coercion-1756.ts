#!/usr/bin/env bun
/**
 * #1756 — the plan step's READER judges the workstream the CHILD says it
 * recorded, never a value the parent derived for itself.
 *
 * The defect, in one line: `workstreamCallsOf` ran `Value.Check` on the RAW
 * `tu.arguments`, but the child had acknowledged arguments Pi already CONVERTED,
 * so a model that sends an array field as a single string can be ACCEPTED in the
 * child — its `execute` records the workstream and returns a success tool result
 * — and then REFUSED by the parent as "arguments do not match the
 * report_workstream schema". The workstream existed in the child and not in the
 * driver; the planner's retry under the same id then drew the duplicate refusal,
 * and the whole workstream's paths were lost. Field evidence: 6
 * plan-spec-mismatch parks on releases up to v0.14.17, plus two cycles that
 * needed a corrective plan pass.
 *
 * This file's FIRST fix attempt mirrored Pi: the parent cloned the raw arguments
 * and ran `Value.Convert` on them. The adversarial review measured that the
 * mirror is wrong in both directions — see the header of
 * `RECORDED_ARGS_DETAILS_KEY` in plan-workstream-schema.ts, which owns that
 * explanation and is the only place it is written.
 *
 * So the parent stops deriving: the companion echoes the params object its
 * `execute` recorded (workstream-reporter.ts) and the reader judges THAT — but
 * only after `echoMatchesCall` has bound the echo to the call it claims to
 * describe. An echo that widens `paths`, empties `outOfScope` or renames the
 * workstream is not a report of the call, so the reader refuses it rather than
 * storing what it says. The RULE itself, judged pure in both directions, is the
 * other half: test-plan-echo-binding-1756.ts.
 *
 * What this file pins, in order:
 *   1. a raw call whose array field arrived as a string, with a SUCCESS result
 *      echoing the recorded array, is ACCEPTED and stored as the echoed array;
 *   2. the same raw call with a success result that carries NO echo is refused
 *      exactly as before this branch — the parent never guesses — and a
 *      `details.recordedArgs` that is not a params object (null, a string, an
 *      array, an absent key) is NO echo, never a judged value;
 *   3. an echoed value the schema or the path rule rejects is refused by the
 *      parent's own checks: the echo is untrusted input, not a passport;
 *   3b. an echo that is NOT a coercion of its own call is refused with the
 *      binding reason and stores nothing — widened `paths`, an emptied
 *      `outOfScope`, an id nobody sent — while a real coercion is accepted;
 *   4. an ERROR result is refused with the error text, echoed value or not;
 *   5. duplicates still collapse to one workstream on the echoed ids;
 *   6. the read does not rewrite the transcript it was handed (a regression pin,
 *      not a claim about `Value.Convert`, which this reader no longer calls);
 *   7. the CHILD side: the companion's accepted result carries the one bound
 *      carrier and its refused call carries none.
 *
 * Pure over DispatchResult-shaped objects, like test-plan-workstream-reader.ts
 * (which keeps the reader's other invariants): no child process, no state file.
 * Blocks 1-6 place the carrier by hand through lib/plan-echo-fixtures-1756.ts,
 * because they must model a result with it, without it, and with a payload that
 * is not a params object.
 */

import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RECORDED_ARGS_DETAILS_KEY } from "../src/plan-workstream-schema.ts";
import workstreamReporter from "../src/workstream-reporter.ts";
import { ECHO_MISMATCH_REASON, workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import {
  RAW_STRING_FENCE,
  RECORDED_ARRAY_FENCE,
  call,
  transcript,
} from "./lib/plan-echo-fixtures-1756.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------- 1: the child's echo is what lands, and what is judged

{
  // The model sent `outOfScope` as one string; whichever TypeBox the installed
  // Pi ran turned it into an array, and the child says so. The parent accepts on
  // the report, and stores the reported value.
  const report = workstreamCallsOf(
    call("c1", RAW_STRING_FENCE, { recorded: RECORDED_ARRAY_FENCE }),
  );
  assert(
    report.accepted === 1 && report.refused.length === 0 && report.unreadable === 0,
    "a raw call the parent cannot validate, whose result echoes a valid recorded value, is ACCEPTED",
  );
  assert(
    JSON.stringify(report.workstreams["task-a"]?.outOfScope) === JSON.stringify(["docs/"]),
    `the echoed value is what reaches state (got ${JSON.stringify(report.workstreams["task-a"]?.outOfScope)})`,
  );
  assert(
    JSON.stringify(report.workstreams["task-a"]?.paths) === JSON.stringify(["src/a.ts"]),
    "the fields the child did not change are stored unchanged",
  );
}
{
  // A `scope` the child received as a number, reported as its string: the scalar
  // coercion a normalisation does, and still the same workstream.
  const report = workstreamCallsOf(
    call("c1", { id: "task-a", scope: 7, paths: ["src/a.ts"], outOfScope: ["docs/"] }, {
      recorded: { id: "task-a", scope: "7", paths: ["src/a.ts"], outOfScope: ["docs/"] },
    }),
  );
  assert(
    report.accepted === 1 && report.workstreams["task-a"]?.scope === "7",
    "a number scope reported as its string is accepted",
  );
}
{
  // The echo also decides fields the raw arguments cannot: `dependsOn` written
  // as a string, reported as a list.
  const report = workstreamCallsOf(
    call("c1", { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [], dependsOn: "b" }, {
      recorded: { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [], dependsOn: ["b"] },
    }),
  );
  assert(
    report.accepted === 1 &&
      JSON.stringify(report.workstreams["task-a"]?.dependsOn) === JSON.stringify(["b"]),
    "`dependsOn` arrives as the child reported it, as a list",
  );
}

// --------------------- 2: no echo → the parent refuses rather than guesses

{
  // The identical raw call, but the result carries no `details` at all (an older
  // companion, or a channel that dropped the payload). This is the pre-#1756
  // behaviour, and it is a REFUSAL — not an acceptance on a shape the parent
  // invented, and not a result-channel failure.
  const report = workstreamCallsOf(call("c1", RAW_STRING_FENCE, {}));
  assert(
    report.accepted === 0 &&
      report.refused.length === 1 &&
      report.refused[0]?.id === "task-a" &&
      report.refused[0]?.reason === "arguments do not match the report_workstream schema",
    "with NO echo the reader checks the raw arguments and refuses, exactly as before this branch",
  );
  assert(
    report.unreadable === 0,
    "a success result with no echo is a refusal, never an unreadable-result park",
  );
}
{
  // A `details` whose `recordedArgs` is present but is not a params object is NO
  // echo, never a judged value: the reader falls back to the raw arguments and
  // refuses them, exactly as with no carrier at all.
  for (const [label, payload] of [
    ["null", null],
    ["a string", "task-a"],
    ["an array", ["task-a"]],
    ["undefined (a present-but-undefined key)", undefined],
  ] as Array<[string, unknown]>) {
    const report = workstreamCallsOf({
      toolUses: [
        { type: "toolCall", id: "c1", name: "report_workstream", arguments: RAW_STRING_FENCE },
      ],
      toolResults: [
        {
          toolCallId: "c1",
          toolName: "report_workstream",
          isError: false,
          text: "recorded workstream task-a",
          details: { [RECORDED_ARGS_DETAILS_KEY]: payload },
        },
      ],
    });
    assert(
      report.accepted === 0 &&
        report.refused.length === 1 &&
        report.unreadable === 0 &&
        report.refused[0]?.reason === "arguments do not match the report_workstream schema",
      `a \`recordedArgs\` that is ${label} is NO echo — the raw arguments are judged (not accepted, not unreadable)`,
    );
  }
  {
    // A `details` that is itself an array cannot hold an echo either.
    const report = workstreamCallsOf({
      toolUses: [
        { type: "toolCall", id: "c1", name: "report_workstream", arguments: RAW_STRING_FENCE },
      ],
      toolResults: [
        {
          toolCallId: "c1",
          toolName: "report_workstream",
          isError: false,
          text: "recorded",
          details: [RECORDED_ARRAY_FENCE],
        },
      ],
    });
    assert(
      report.accepted === 0 && report.refused.length === 1,
      "a `details` that is an array is NO echo",
    );
  }
}

// --------------------- 3: an invalid echo is refused by the parent's checks

{
  // The child claims it recorded shapes the schema never accepts — whether from
  // an older companion or a Pi whose Convert stringified them, the parent does
  // not pass any of them through.
  const invalid = [
    { args: RAW_STRING_FENCE, recorded: { ...RECORDED_ARRAY_FENCE, id: 5 } },
    { args: RAW_STRING_FENCE, recorded: { ...RECORDED_ARRAY_FENCE, paths: ["../secrets/.env"] } },
    { args: RAW_STRING_FENCE, recorded: { ...RECORDED_ARRAY_FENCE, paths: "src/a.ts" } },
  ];
  for (const [i, c] of invalid.entries()) {
    const report = workstreamCallsOf(call(`c${i + 1}`, c.args, { recorded: c.recorded }));
    assert(
      report.accepted === 0 && report.refused.length === 1,
      `an echoed value the schema or the path rule rejects is REFUSED (case ${i + 1})`,
    );
  }
  const schemaCase = workstreamCallsOf(
    call("c1", RAW_STRING_FENCE, { recorded: { ...RECORDED_ARRAY_FENCE, id: 5 } }),
  );
  assert(
    schemaCase.refused[0]?.reason === ECHO_MISMATCH_REASON ||
      schemaCase.refused[0]?.reason === "arguments do not match the report_workstream schema",
    `an echoed \`id: 5\` is refused, not accepted because a child said so (got ${schemaCase.refused[0]?.reason})`,
  );
  // A `..` path the CALL did not send is caught by the binding before the path
  // rule ever sees it — the stronger guarantee: an echo cannot put a traversing
  // path into the authorised set at all.
  const pathCase = workstreamCallsOf(
    call("c1", RAW_STRING_FENCE, {
      recorded: { ...RECORDED_ARRAY_FENCE, paths: ["../secrets/.env"] },
    }),
  );
  assert(
    pathCase.refused[0]?.reason === ECHO_MISMATCH_REASON,
    "an echo whose `paths` differ from the call's is refused by the binding, so no traversing path enters through it",
  );
  const pathRuleCase = workstreamCallsOf(
    call(
      "c1",
      { id: "task-a", scope: "a", paths: ["../secrets/.env"], outOfScope: ["docs/"] },
      { recorded: { id: "task-a", scope: "a", paths: ["../secrets/.env"], outOfScope: ["docs/"] } },
    ),
  );
  assert(
    pathRuleCase.refused[0]?.reason.startsWith("paths:") === true &&
      pathRuleCase.refused[0]?.reason.includes("..") === true,
    "a call whose OWN path traverses is refused by the path rule, bound echo or not",
  );
}

// --------------------- 3b: an echo that is not its own call is refused

{
  // The lens HIGH + MEDIUM cases: each is a VALID schema value, so the schema
  // check cannot see it — only the comparison to the call can. None may store
  // anything.
  const notTheCall = [
    ["widened paths", { ...RECORDED_ARRAY_FENCE, paths: ["src/a.ts", "src/secret.ts"] }],
    ["replaced paths", { ...RECORDED_ARRAY_FENCE, paths: ["src/other.ts"] }],
    ["emptied outOfScope", { ...RECORDED_ARRAY_FENCE, outOfScope: [] }],
    ["replaced outOfScope", { ...RECORDED_ARRAY_FENCE, outOfScope: ["nothing at all"] }],
    ["an id nobody sent", { ...RECORDED_ARRAY_FENCE, id: "task-z" }],
    ["an added key", { ...RECORDED_ARRAY_FENCE, extra: "x" }],
    ["a dropped key", { id: "task-a", paths: ["src/a.ts"], outOfScope: ["docs/"] }],
    ["a required key nulled", { ...RECORDED_ARRAY_FENCE, scope: null }],
  ] as Array<[string, unknown]>;
  for (const [label, recorded] of notTheCall) {
    const report = workstreamCallsOf(call("c1", RAW_STRING_FENCE, { recorded }));
    assert(
      report.accepted === 0 &&
        report.refused.length === 1 &&
        report.refused[0]?.reason === ECHO_MISMATCH_REASON &&
        Object.keys(report.workstreams).length === 0,
      `an echo that is ${label} is refused as not-the-call and stores nothing (got ${JSON.stringify(report.refused)})`,
    );
  }
}

// --------------------- 4: an error result is refused with its text

{
  const report = workstreamCallsOf(
    call("c1", RAW_STRING_FENCE, { error: "companion refused: duplicate id" }),
  );
  assert(
    report.accepted === 0 &&
      report.refused.length === 1 &&
      report.refused[0]?.id === "task-a" &&
      report.refused[0]?.reason === "companion refused: duplicate id",
    "a call whose tool result is an error is refused with the error text, echoed value or not",
  );
}

// --------------------- 5: the duplicate rule outlives the echo

{
  // Both echoes are faithful reports of their OWN calls (each call's scope
  // matches its own echo), so it is the DUPLICATE rule that refuses the second —
  // not the binding. Two calls cannot share one echo.
  const report = transcript(
    call("c1", RAW_STRING_FENCE, { recorded: RECORDED_ARRAY_FENCE }),
    call(
      "c2",
      { ...RAW_STRING_FENCE, scope: "again" },
      { recorded: { ...RECORDED_ARRAY_FENCE, scope: "again" } },
    ),
  );
  const read = workstreamCallsOf(report);
  assert(
    read.accepted === 1 &&
      read.refused.length === 1 &&
      read.refused[0]?.reason.includes("task-a") === true &&
      read.refused[0]?.reason.includes("already reported") === true,
    `a second call whose echoed id is already held is refused as a duplicate (got ${JSON.stringify(read.refused)})`,
  );
}

// --------------------- 6: the read rewrites nothing it was handed

{
  // The carrier is not written through, so the replay keeps holding the shape
  // the model actually sent. Regression pin for the reader — the parent no
  // longer calls `Value.Convert` at all, so this is not a claim about it.
  const args = structuredClone(RAW_STRING_FENCE);
  const recorded = structuredClone(RECORDED_ARRAY_FENCE);
  const before = JSON.stringify(args);
  const beforeRecorded = JSON.stringify(recorded);
  workstreamCallsOf(transcript(call("c1", args, { recorded })));
  assert(
    JSON.stringify(args) === before,
    "the call's raw arguments are left exactly as the replay wrote them",
  );
  assert(
    JSON.stringify(recorded) === beforeRecorded,
    "the echoed value in the result is left exactly as the child wrote it",
  );
}

// --------------------- 7: the child side — accepted echoes, refusals do not

{
  const registered: RegisteredTool[] = [];
  workstreamReporter({
    registerTool(t: RegisteredTool) {
      registered.push(t);
    },
  } as unknown as ExtensionAPI);
  const tool = registered[0];
  assert(
    registered.length === 1 &&
      registered[0]?.name === "report_workstream" &&
      Value.Check(registered[0]?.parameters as never, {
        id: "task-a",
        scope: "s",
        paths: ["src/a.ts"],
        outOfScope: [],
      }),
    "canary: the companion still registers report_workstream on the shared schema",
  );
  const VALID = { id: "task-a", scope: "the fix", paths: ["src/a.ts"], outOfScope: ["docs/"] };

  const ok = await tool?.execute("1", VALID);
  assert(
    ok?.content[0]?.text.split("\n")[0] === "recorded workstream task-a",
    "the companion still answers an accepted call with its record line",
  );
  assert(
    JSON.stringify((ok?.details as Record<string, unknown>)?.[RECORDED_ARGS_DETAILS_KEY]) ===
      JSON.stringify(VALID),
    "an accepted result's `details` echo the exact params object execute was handed",
  );
  assert(
    Object.keys((ok?.details as Record<string, unknown>) ?? {}).join() ===
      RECORDED_ARGS_DETAILS_KEY,
    "`details` carries the one key the reader reads — nothing else rides the channel",
  );
  // The echo the companion writes is the shape the reader judges, end to end.
  const roundTrip = workstreamCallsOf({
    toolUses: [{ type: "toolCall", id: "c1", name: "report_workstream", arguments: VALID }],
    toolResults: [
      {
        toolCallId: "c1",
        toolName: "report_workstream",
        isError: false,
        text: ok?.content[0]?.text ?? "",
        details: ok?.details,
      },
    ],
  });
  assert(
    roundTrip.accepted === 1 && roundTrip.refused.length === 0,
    "what the companion writes, the reader reads: the accepted call round-trips",
  );

  // A refused call records nothing, so it has nothing to report. The companion
  // refuses by THROWING (Pi turns that into an error tool result with no
  // `details`), so the throw is what is checked.
  let refusal = "";
  try {
    await tool?.execute("2", { ...VALID, scope: "again" });
  } catch (err) {
    refusal = (err as Error).message;
  }
  assert(
    refusal.includes("'task-a'") && refusal.includes("refused"),
    "a duplicate id still throws a tool error that names the duplicate",
  );
  let badPath: unknown = "NO THROW — the call was accepted";
  try {
    badPath = await tool?.execute("3", {
      id: "task-b",
      scope: "s",
      paths: ["../etc/passwd"],
      outOfScope: [],
    });
  } catch {
    badPath = undefined;
  }
  assert(
    badPath === undefined || JSON.stringify(badPath).includes(RECORDED_ARGS_DETAILS_KEY) === false,
    "a call the companion refuses carries no echo — nothing was recorded",
  );
}

/** What the companion registers: the tool Pi hands arguments to. */
interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (
    id: string,
    raw: unknown,
  ) => Promise<{ content: { text: string }[]; details: unknown }>;
}

process.exit(exit);

#!/usr/bin/env bun
/**
 * #1756 — the plan step's reader judges the workstream the CHILD says it
 * recorded, never a value the parent derived for itself.
 *
 * The defect, in one line: `workstreamCallsOf` ran `Value.Check` on the RAW
 * `tu.arguments`, but the child had acknowledged arguments Pi already
 * CONVERTED. Pi's tool validation (`validateToolArguments` in pi-ai
 * `utils/validation.js`) clones the arguments and runs `normalizeOptionalNulls`
 * plus TypeBox `Value.Convert` before checking them, so a model that sends an
 * array field as a single string can be ACCEPTED in the child — its `execute`
 * records the workstream and returns a success tool result — and then REFUSED by
 * the parent as "arguments do not match the report_workstream schema". The
 * workstream existed in the child and not in the driver; the planner's retry
 * under the same id then drew the duplicate refusal, and the whole workstream's
 * paths were lost. Field evidence: 6 plan-spec-mismatch parks on releases up to
 * v0.14.17, plus two cycles that needed a corrective plan pass.
 *
 * This file's FIRST fix attempt mirrored Pi: the parent cloned the raw arguments
 * and ran `Value.Convert` on them. The adversarial review measured that the
 * mirror is wrong in both directions, because the conversion is done by whichever
 * TypeBox package the INSTALLED Pi ships — the dev-pinned pi-ai validates with
 * `typebox` 1.3.x, whose `Convert` does NOT coerce string→array or number→string
 * (so six shapes like `id: 5` or `paths: "x"` became acceptable to the parent
 * although the pinned Pi refuses them), while field runs on newer installed Pi
 * versions DID coerce a string `outOfScope` into an array. The mirror also
 * omitted Pi's `normalizeOptionalNulls` step entirely. There is no
 * version-independent answer to "what did Pi pass the child".
 *
 * So the parent stops deriving: the companion echoes the params object its
 * `execute` recorded (workstream-reporter.ts) and the reader judges THAT. Both
 * carriers are exercised below — `details` (Pi's `createToolResultMessage`
 * copies `result.details` onto the replayed `toolResult` message, which is the
 * channel `collapseEvents` reads) and the text line the companion appends for a
 * Pi that ever drops `details`.
 *
 * What this file pins, in order:
 *   1. a raw call whose array field arrived as a string, with a SUCCESS result
 *      echoing the recorded array, is ACCEPTED and stored as the echoed array;
 *   2. the same raw call with a success result that carries NO echo is refused
 *      exactly as before this branch — the parent never guesses;
 *   3. an echoed value that is itself invalid (`id: 5`, a `..` path) is refused
 *      by the parent's own checks: the echo is untrusted input, not a passport;
 *   4. an ERROR result is refused with the error text, echoed value or not;
 *   5. duplicates still collapse to one workstream on the echoed ids;
 *   6. the read does not rewrite the transcript it was handed (neither carrier
 *      is written through — this is a regression pin, not a claim about
 *      `Value.Convert`, which this reader no longer calls);
 *   7. the CHILD side: the companion's accepted result carries the echo in BOTH
 *      carriers and its refused call carries none.
 *
 * Pure over DispatchResult-shaped objects, like test-plan-workstream-reader.ts
 * (which keeps the reader's other invariants): no child process, no state file.
 * Blocks 1-6 build their `toolUses`/`toolResults` by hand rather than through
 * lib/plan-workstream-calls.ts, because they must place the two carriers
 * independently — one with `details` only, one with the text line only, one with
 * neither — and the helper always writes both.
 */

import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RECORDED_ARGS_DETAILS_KEY,
  RECORDED_ARGS_TEXT_PREFIX,
} from "../src/plan-workstream-schema.ts";
import workstreamReporter from "../src/workstream-reporter.ts";
import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type ResultEntry = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  details?: Record<string, unknown>;
};

/** The transcript of one `report_workstream` call, and the result for it. */
function call(
  id: string,
  args: unknown,
  result: { error?: string; recorded?: unknown } = {},
) {
  return {
    toolUses: [{ type: "toolCall", id, name: "report_workstream", arguments: args }],
    toolResults: [entry(id, result)],
  };
}

function entry(id: string, result: { error?: string; recorded?: unknown } = {}): ResultEntry {
  if (result.error !== undefined) {
    return { toolCallId: id, toolName: "report_workstream", isError: true, text: result.error };
  }
  const text = `recorded workstream\n${RECORDED_ARGS_TEXT_PREFIX}${JSON.stringify(result.recorded)}`;
  return {
    toolCallId: id,
    toolName: "report_workstream",
    isError: false,
    // The two carriers arrive separately so a test can drop one of them.
    text: result.recorded === undefined ? "recorded" : text,
    ...(result.recorded === undefined
      ? {}
      : { details: { [RECORDED_ARGS_DETAILS_KEY]: result.recorded } }),
  };
}

/** A transcript from several per-call pieces. */
function transcript(
  ...parts: Array<{ toolUses: unknown[]; toolResults: ResultEntry[] }>
) {
  return {
    toolUses: parts.flatMap((p) => p.toolUses),
    toolResults: parts.flatMap((p) => p.toolResults),
  };
}

const RAW_STRING_FENCE = { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: "docs/" };
const RECORDED_ARRAY_FENCE = { ...RAW_STRING_FENCE, outOfScope: ["docs/"] };

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
  // Same judgement through the TEXT carrier alone: a Pi that ever drops
  // `details` must not change the verdict.
  const viaTextOnly = {
    toolUses: [{ type: "toolCall", id: "c1", name: "report_workstream", arguments: RAW_STRING_FENCE }],
    toolResults: [
      {
        toolCallId: "c1",
        toolName: "report_workstream",
        isError: false,
        text: `recorded workstream task-a\n${RECORDED_ARGS_TEXT_PREFIX}${JSON.stringify(RECORDED_ARRAY_FENCE)}`,
      },
    ],
  };
  const report = workstreamCallsOf(viaTextOnly);
  assert(
    report.accepted === 1 &&
      JSON.stringify(report.workstreams["task-a"]?.outOfScope) === JSON.stringify(["docs/"]),
    "the same echo carried as one text line instead of `details` is judged identically",
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
  // The identical raw call, but the result carries neither carrier (an older
  // companion, or a channel that dropped both). This is the pre-#1756
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
  // A malformed echo (truncated by the text bound, or not JSON) is NO echo.
  const report = workstreamCallsOf({
    toolUses: [
      {
        type: "toolCall",
        id: "c1",
        name: "report_workstream",
        arguments: RAW_STRING_FENCE,
      },
    ],
    toolResults: [
      {
        toolCallId: "c1",
        toolName: "report_workstream",
        isError: false,
        text: `recorded workstream task-a\n${RECORDED_ARGS_TEXT_PREFIX}{"id":"task-a","outOfSc`,
      },
    ],
  });
  assert(
    report.accepted === 0 && report.refused.length === 1 && report.unreadable === 0,
    "a truncated or unparseable echo is treated as no echo, so the raw arguments are judged",
  );
}

// --------------------- 3: an invalid echo is refused by the parent's checks

{
  // `id: 5`: the child claims it recorded something the schema never accepts —
  // whether from an older companion or a Pi whose Convert stringified it, the
  // parent does not pass it through.
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
    schemaCase.refused[0]?.reason === "arguments do not match the report_workstream schema",
    "an echoed `id: 5` is refused with the schema reason, not accepted because a child said so",
  );
  const pathCase = workstreamCallsOf(
    call("c1", RAW_STRING_FENCE, {
      recorded: { ...RECORDED_ARRAY_FENCE, paths: ["../secrets/.env"] },
    }),
  );
  assert(
    pathCase.refused[0]?.reason.startsWith("paths:") === true &&
      pathCase.refused[0]?.reason.includes("..") === true,
    "an echoed path with a `..` segment is refused by the path rule",
  );
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
  // The two calls ask with different raw shapes; both report the same id, so
  // only the first may be kept.
  const report = transcript(
    call("c1", RAW_STRING_FENCE, { recorded: RECORDED_ARRAY_FENCE }),
    call("c2", { ...RAW_STRING_FENCE, scope: "again" }, { recorded: RECORDED_ARRAY_FENCE }),
  );
  const read = workstreamCallsOf(report);
  assert(
    read.accepted === 1 &&
      read.refused.length === 1 &&
      read.refused[0]?.reason.includes("task-a") === true,
    "a second call whose echoed id is already held is refused as a duplicate",
  );
}

// --------------------- 6: the read rewrites nothing it was handed

{
  // Neither carrier is written through, so the replay keeps holding the shape
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
    ok?.content[0]?.text.startsWith("recorded workstream task-a") === true,
    "the companion still answers an accepted call with its record line",
  );
  assert(
    JSON.stringify((ok?.details as Record<string, unknown>)?.[RECORDED_ARGS_DETAILS_KEY]) ===
      JSON.stringify(VALID),
    "an accepted result's `details` echo the exact params object execute was handed",
  );
  assert(
    ok?.content[0]?.text.includes(`${RECORDED_ARGS_TEXT_PREFIX}${JSON.stringify(VALID)}`) === true,
    "the same value is on the result's text line, for a channel that drops `details`",
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
        details: ok?.details as Record<string, unknown>,
      },
    ],
  });
  assert(
    roundTrip.accepted === 1 && roundTrip.refused.length === 0,
    "what the companion writes, the reader reads: the accepted call round-trips",
  );

  // A refused call records nothing, so it has nothing to report. The companion
  // refuses by THROWING (Pi turns that into an error tool result with no
  // `details`), so both refusal shapes are checked: the throw carries no echo,
  // and the only result the process produced is the accepted one.
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
    badPath === undefined || !JSON.stringify(badPath).includes(RECORDED_ARGS_TEXT_PREFIX),
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

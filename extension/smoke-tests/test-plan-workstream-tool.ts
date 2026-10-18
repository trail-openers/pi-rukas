#!/usr/bin/env bun
/**
 * #1652 — the /work plan step reports workstreams through `report_workstream`.
 *
 * The companion tool (schema, in-child duplicate refusal) and runPlan end to
 * end: the one corrective budget, zero-call parks, refusal recording, killed-
 * primary calls, the preflight. The reader's own invariants live in
 * test-plan-workstream-reader.ts. Fully offline: injected dispatchFn,
 * PI_ENSEMBLE_RESUME=0.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { reporterPathFromArgs } from "../src/reporter-preflight.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import {
  PLAN_WORKSTREAM_EXTRA_ARGS,
  WORKSTREAM_REPORTER_PATH,
  checkWorkstreamReporter,
  setWorkstreamReporterStatForTestForTest,
} from "../src/work-driver-plan-calls.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { inlinePlanPrompt } from "../src/work-driver-prompts-early.ts";
import { PLAN_WORKSTREAM_CALL_RULE } from "../src/work-driver-prompts-plan.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import workstreamReporter from "../src/workstream-reporter.ts";
import { planResultFromCalls, planResultFromRawCalls } from "./lib/plan-workstream-calls.ts";

process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

// ------------------------------------------------ the companion, for real

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (id: string, raw: unknown) => Promise<{ content: { text: string }[] }>;
}
const registered: RegisteredTool[] = [];
workstreamReporter({
  registerTool(t: RegisteredTool) {
    registered.push(t);
  },
} as unknown as ExtensionAPI);
const tool = registered[0];
assert(
  registered.length === 1 && tool?.name === "report_workstream",
  "the companion registers report_workstream",
);

const schema = tool?.parameters as Parameters<typeof Value.Check>[0];
const VALID = {
  id: "task-a",
  scope: "the fix",
  paths: ["src/a.ts"],
  outOfScope: ["docs/"],
};
assert(Value.Check(schema, VALID), "schema: a complete call validates");
assert(
  !Value.Check(schema, { ...VALID, id: "Task A" }),
  "schema: an id with a space or capitals is refused",
);
assert(
  !Value.Check(schema, { ...VALID, paths: undefined }),
  "schema: a call without paths is refused",
);
assert(
  !Value.Check(schema, { ...VALID, paths: "src/a.ts" }),
  "schema: paths must be a list, not prose",
);
assert(
  Value.Check(schema, {
    ...VALID,
    dependsOn: ["task-b"],
    integrationTest: "t.ts",
    introduces: ["x"],
  }),
  "schema: the optional fields validate",
);

{
  const ok = await tool?.execute("1", VALID);
  assert(ok?.content[0]?.text === "recorded workstream task-a", "a first call is recorded");
  let refusal = "";
  try {
    await tool?.execute("2", { ...VALID, scope: "again" });
  } catch (err) {
    refusal = (err as Error).message;
  }
  assert(
    refusal.includes("'task-a'") && refusal.includes("refused"),
    "a duplicate id throws a tool error that names the duplicate",
  );
  const distinct = await tool?.execute("3", { ...VALID, id: "task-b" });
  assert(
    distinct?.content[0]?.text === "recorded workstream task-b",
    "a distinct id after a refusal is recorded",
  );
}

// -------------------------------------------------- the plan step

function stateWithBody(dir: string, body: string): WorkState {
  const artifact = path.join(dir, "issue-body.txt");
  writeFileSync(artifact, body);
  const s0 = initialState(1652, 1_000_000);
  return {
    ...s0,
    pipelineState: { ...s0.pipelineState, issueBodyArtifact: artifact },
  };
}

function replyOf(result: Partial<DispatchResult>): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-plan-workstream-tool.json",
    ...result,
  };
}

/** Run runPlan with dispatch replies in order; the last one repeats. */
async function runWith(
  replies: DispatchResult[],
  body = "Make the fix.",
): Promise<{
  state: WorkState;
  dispatches: Array<{ label?: string; extraArgs?: string[] }>;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-workstream-tool-"));
  const dispatches: Array<{ label?: string; extraArgs?: string[] }> = [];
  try {
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 1652,
      dispatchFn: async (_pi, _spec, opts) => {
        dispatches.push({ label: opts?.label, extraArgs: opts?.extraArgs });
        return replies[Math.min(dispatches.length - 1, replies.length - 1)] ?? replyOf({});
      },
    };
    const state = await runPlan(ctx, stateWithBody(dir, body), 1_000_000);
    return { state, dispatches };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONE_CALL = planResultFromCalls([
  { id: "default", scope: "the fix", paths: ["src/a.ts"], outOfScope: [] },
]);
const TWO_BLOCKS_AND_ONE_CALL = {
  ...ONE_CALL,
  text: "## Workstreams\n\n### task-a — one\n- paths: src/a.ts\n\n## Workstreams\n\n### task-b — two\n- paths: src/b.ts\n",
};

{
  // A reply with two `## Workstreams` blocks in its prose and valid calls is no
  // longer ambiguous: the prose is not read, and the calls are the plan.
  const { state, dispatches } = await runWith([replyOf(TWO_BLOCKS_AND_ONE_CALL)]);
  assert(dispatches.length === 1, "two prose blocks plus valid calls: no corrective");
  assert(
    state.pipelineState.planQuality?.reason !== "plan-spec-mismatch" &&
      Object.keys(state.pipelineState.workstreams ?? {}).join() === "default",
    "two prose blocks plus valid calls: no plan-spec-mismatch, the call is the plan",
  );
}
{
  // Zero accepted calls: one corrective, whose calls REPLACE the first set.
  const { state, dispatches } = await runWith([
    replyOf({ text: "I thought about it but made no call." }),
    replyOf(
      planResultFromCalls([{ id: "task-c", scope: "fixed", paths: ["src/c.ts"], outOfScope: [] }]),
    ),
  ]);
  assert(
    dispatches.length === 2 && dispatches[1]?.label === "plan:corrective",
    "zero calls → exactly one corrective",
  );
  assert(
    Object.keys(state.pipelineState.workstreams ?? {}).join() === "task-c",
    "the corrective's calls replace the first set (no merge)",
  );
  assert(
    dispatches.every((d) => d.extraArgs?.includes(WORKSTREAM_REPORTER_PATH)),
    "the primary and the corrective both load the report_workstream companion",
  );
}
{
  // Zero again → park, with the evidence that no call was made.
  const { state, dispatches } = await runWith([replyOf({ text: "prose only" })]);
  assert(dispatches.length === 2, "zero calls twice → the corrective is the last dispatch");
  assert(
    state.pipelineState.planQuality?.reason === "plan-spec-mismatch",
    "zero calls twice → parks as plan-spec-mismatch",
  );
  const cap = state.eventLog.findLast((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.evidence.includes("no report_workstream call"),
    "the park's evidence says 'no report_workstream call'",
  );
}
{
  // Calls made and every one refused → the evidence counts the refusals.
  const refused = planResultFromRawCalls([
    {
      id: "Bad A",
      args: { id: "Bad A", scope: "x", paths: [], outOfScope: [] },
      refused: "schema: refused",
    },
    {
      id: "Bad B",
      args: { id: "Bad B", scope: "x", paths: [], outOfScope: [] },
      refused: "schema: refused",
    },
  ]);
  const { state } = await runWith([replyOf(refused)]);
  const cap = state.eventLog.findLast((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" &&
      cap.evidence.includes("no successful report_workstream call (2 refused)"),
    "every call refused → the evidence says 'no successful report_workstream call (2 refused)'",
  );
  const refusedEvent = state.eventLog.find((e) => e.kind === "workstream-calls-refused");
  assert(
    refusedEvent?.kind === "workstream-calls-refused" && refusedEvent.refused.length === 2,
    "the refused calls are recorded in the event log",
  );
  assert(
    state.eventLog.at(-1)?.kind !== "workstream-calls-refused",
    "the refusal event is not the tail (nextStep routes on the completion)",
  );
}
{
  // One budget: a plan-quality corrective that lands on zero calls parks.
  const defect = planResultFromCalls([
    { id: "task-a", scope: "the fix", paths: [], outOfScope: [] },
  ]);
  const { state, dispatches } = await runWith([replyOf(defect), replyOf({ text: "nothing" })]);
  assert(dispatches.length === 2, "a quality defect spends the one corrective");
  assert(
    state.pipelineState.planQuality?.reason === "plan-spec-mismatch",
    "…and an empty corrective parks",
  );
}
{
  // The other way round: a zero-call primary spends the budget on its corrective,
  // and a quality defect in the corrective's calls does NOT buy a second one.
  const defect = planResultFromCalls([
    { id: "task-a", scope: "the fix", paths: [], outOfScope: [] },
  ]);
  const { state, dispatches } = await runWith([replyOf({ text: "no call" }), replyOf(defect)]);
  assert(
    dispatches.length === 2,
    "a zero-call primary and a defective corrective: still exactly one corrective",
  );
  assert(
    state.pipelineState.planQuality?.reason !== "plan-spec-mismatch" &&
      Object.keys(state.pipelineState.workstreams ?? {}).join() === "task-a",
    "…the defective corrective is kept as the plan (its defect is recorded, not re-dispatched)",
  );
}
{
  // A killed primary: calls it made before the kill are ignored. The recovery
  // corrective's calls are the plan.
  const killed = replyOf({
    ok: false,
    text: "",
    exitCode: 143,
    killCause: "timeout",
    killBudgetMs: 30 * 60_000,
    ...planResultFromCalls([
      { id: "stale", scope: "before the kill", paths: ["src/s.ts"], outOfScope: [] },
    ]),
  });
  const { state, dispatches } = await runWith([
    killed,
    replyOf(
      planResultFromCalls([{ id: "task-k", scope: "after", paths: ["src/k.ts"], outOfScope: [] }]),
    ),
  ]);
  assert(
    dispatches.length === 2,
    "a killed primary → the recovery corrective is the second dispatch",
  );
  assert(
    Object.keys(state.pipelineState.workstreams ?? {}).join() === "task-k",
    "a killed primary's calls are ignored: the recovery corrective's calls are the plan",
  );
}
{
  // A recovery corrective with zero calls parks rather than building a default.
  const { state } = await runWith([
    replyOf({ ok: false, exitCode: 143, killCause: "timeout", killBudgetMs: 60_000 }),
    replyOf({ text: "still nothing" }),
  ]);
  assert(
    state.pipelineState.planQuality?.reason === "plan-spec-mismatch" &&
      Object.keys(state.pipelineState.workstreams ?? {}).length === 0,
    "a recovery corrective with no call parks with no workstreams",
  );
}

// ------------------------------------------------ the reporter preflight

// biome-ignore lint/complexity/noUselessLoneBlockStatements: grouped test section
{
  assert(
    reporterPathFromArgs(PLAN_WORKSTREAM_EXTRA_ARGS) === WORKSTREAM_REPORTER_PATH,
    "the plan's extra args load the companion path",
  );
  assert(
    (await checkWorkstreamReporter()) === undefined,
    "the companion file exists, so the preflight passes",
  );
  setWorkstreamReporterStatForTestForTest(async () => {
    throw new Error("ENOENT");
  });
  try {
    const missing = await checkWorkstreamReporter();
    assert(
      missing?.startsWith("reporter extension missing: ") === true &&
        missing.includes("workstream-reporter"),
      "a missing companion is a named preflight error",
    );
    const { state, dispatches } = await runWith([replyOf(ONE_CALL)]);
    const failed = state.eventLog.find((e) => e.kind === "dispatch-failed");
    assert(dispatches.length === 0, "a missing companion spawns no plan child");
    assert(
      failed?.kind === "dispatch-failed" &&
        (failed.errorTail ?? "").includes("reporter extension missing"),
      "a missing companion ends the plan step with a dispatch-failed carrying the named error",
    );
  } finally {
    setWorkstreamReporterStatForTestForTest(undefined);
  }
}

// ---------------------------------------------- the prompt and the handoff

{
  const p = inlinePlanPrompt([1652], "/tmp/scratch");
  assert(
    p.includes(PLAN_WORKSTREAM_CALL_RULE),
    "the planner prompt states the one-call-per-workstream rule",
  );
  assert(
    !/`## Workstreams`/.test(p),
    "the planner prompt no longer asks for a `## Workstreams` section",
  );
}
{
  // The handoff of a parked cycle names the refused calls, so the operator can
  // see what the planner got wrong without reading the state file.
  const state = {
    ...initialState(1652, 1),
    eventLog: [
      {
        kind: "workstream-calls-refused",
        step: "plan",
        label: "plan:corrective",
        at: 1,
        accepted: 0,
        refused: [{ id: "Bad A", reason: "schema: id does not match the pattern" }],
      },
    ],
  } as unknown as WorkState;
  const md = renderHandoffMarkdown(state);
  assert(
    md.includes("### Workstream calls the planner had refused") &&
      md.includes("plan:corrective") &&
      md.includes("schema: id does not match the pattern"),
    "the handoff names the refused calls, their dispatch, and the reason",
  );
}

// ------------------------------------- a failed dispatch is not a silent planner

{
  // A non-kill provider failure on the primary: its completion is the tail and
  // the plan step ends there. No zero-call corrective, no plan-spec-mismatch.
  const failed = replyOf({ ok: false, exitCode: 1, text: "" });
  const { state, dispatches } = await runWith([failed]);
  assert(dispatches.length === 1, "a failed primary (no kill) gets no corrective");
  const tail = state.eventLog.at(-1);
  assert(
    tail?.kind === "dispatch-failed" && state.pipelineState.planQuality === undefined,
    "a failed primary ends the step on its dispatch-failed tail, with no plan-quality verdict",
  );
}
{
  // A zero-call primary whose one corrective fails without a kill: the corrective's
  // failure is the tail, not a zero-call verdict.
  const { state, dispatches } = await runWith([
    replyOf({ text: "no call" }),
    replyOf({ ok: false, exitCode: 1, text: "" }),
  ]);
  assert(dispatches.length === 2, "a failed corrective spends the one corrective and stops");
  const tail = state.eventLog.at(-1);
  assert(
    tail?.kind === "dispatch-failed" &&
      state.pipelineState.planQuality?.reason !== "plan-spec-mismatch",
    "a failed corrective ends on dispatch-failed, not on the zero-call verdict",
  );
}

process.exit(exit);

#!/usr/bin/env bun
/**
 * The result's tool counts and its `driver` field.
 *
 *   - a child's tool calls are counted from `tool_execution_start`, a codemode
 *     script's nested calls included, and its errors from `tool_execution_end`
 *   - the counts survive `reconcileObservedCounts` whichever source wins the tokens
 *   - the fold sums them; a dispatch with no usage adds none; one whose usage
 *     lacks them makes the total unknown (absent), never low
 *   - lean's step log keeps them through the loader, and an old row without them loads
 *   - `work` names `driver: "classic"`, `work-lean` names `driver: "lean"`
 *   - `--capabilities` publishes `usageTools`
 *
 * Offline and pure.
 */
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { projectIssue } from "../src/headless/result.ts";
import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { dispatchesProblem, validatedDispatches } from "../src/lean/state-dispatches.ts";
import { createRun } from "../src/lean/state.ts";
import { leanUsage } from "../src/lean/usage-sum.ts";
import { emptyRunningState, ingestEvent } from "../src/progress.ts";
import { reconcileObservedCounts } from "../src/spawn-support.ts";
import { foldUsage } from "../src/usage-fold.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const usage = (calls?: number, errors?: number) => ({
  input: 10,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.5,
  turns: 2,
  ...(calls === undefined ? {} : { toolCalls: calls }),
  ...(errors === undefined ? {} : { toolErrors: errors }),
});

// ── The live ingest counts every execution, nested ones included.
{
  const s = emptyRunningState("developer");
  const events = [
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "a", isError: true },
    { type: "tool_execution_start", toolCallId: "b", toolName: "codemode" },
    { type: "tool_execution_start", toolCallId: "b/1", parentToolCallId: "b", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "b/1", isError: false },
    { type: "tool_execution_end", toolCallId: "b" },
  ];
  for (const e of events) ingestEvent(s, e as Parameters<typeof ingestEvent>[1], 0);
  assert(
    s.usage.toolCalls === 3,
    `three executions, one nested, count 3 (got ${s.usage.toolCalls})`,
  );
  assert(
    s.usage.toolErrors === 1,
    `only isError: true counts as an error (got ${s.usage.toolErrors})`,
  );

  // The replay won the tokens (it saw more turns): the live counts still land.
  const replayWins = { usage: { ...usage(), turns: 9 }, toolUses: [] as unknown[] };
  reconcileObservedCounts(replayWins, s);
  assert(
    replayWins.usage.toolCalls === 3 && replayWins.usage.toolErrors === 1,
    "counts carried when the replay's tokens are kept",
  );
  // The live state won: its usage, counts included, replaces the replay's.
  s.usage.turns = 20;
  const liveWins = { usage: usage(), toolUses: [] as unknown[] };
  reconcileObservedCounts(liveWins, s);
  assert(liveWins.usage.toolCalls === 3, "counts carried when the live usage is kept");
}

// ── The fold: sums, a child that never ran, and an uncounted child.
{
  const f = foldUsage([
    { role: "developer", usage: usage(4, 1) },
    { role: "developer", usage: usage(2, 0) },
    { role: "adversarial", usage: undefined },
  ]);
  assert(f.total.toolCalls === 6 && f.total.toolErrors === 1, "totals sum the rows");
  assert(f.byRole.developer?.toolCalls === 6, "byRole sums the role's rows");
  assert(f.byRole.adversarial?.toolCalls === 0, "a dispatch with no usage adds no tool calls");
  const unknown = foldUsage([
    { role: "developer", usage: usage(4, 1) },
    { role: "developer", usage: usage() },
  ]);
  assert(
    unknown.total.toolCalls === undefined &&
      !("toolCalls" in JSON.parse(JSON.stringify(unknown.total))),
    "one uncounted child makes the total absent from the document, not low",
  );
}

// ── `work`'s result: the counts per role, and the driver.
{
  let s = initialState(7);
  const events: WorkEvent[] = [
    { kind: "step-started", step: "develop", at: 1 },
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer",
      ms: 10,
      at: 2,
      ok: true,
      usage: usage(5, 2),
    },
  ];
  for (const e of events) s = appendEvent(s, e);
  const r = projectIssue(s, "f");
  assert(r.driver === "classic", `work names driver classic (got ${r.driver})`);
  assert(
    r.usage?.toolCalls === 5 && r.usage?.byRole.developer?.toolErrors === 2,
    "work's usage and byRole carry the counts",
  );
}

// ── Lean: the step log keeps the counts, an old row still loads, and the driver.
{
  const row = { role: "developer", ms: 1, ok: true, usage: usage(7, 3) };
  const old = { role: "developer", ms: 1, ok: true, usage: usage() };
  assert(dispatchesProblem([row, old]) === undefined, "rows with and without counts both load");
  assert(
    dispatchesProblem([{ ...row, usage: usage(-1, 0) }]) !== undefined,
    "a negative tool count is refused",
  );
  const loaded = validatedDispatches([row]);
  assert(loaded[0]?.usage.toolCalls === 7, "the loader keeps the counts");

  const run = createRun({
    issue: 7,
    version: "test",
    models: {},
    baseSha: "a".repeat(40),
    branch: "b",
  });
  run.steps.push({
    key: "7:build:0",
    state: "build",
    startedAt: 0,
    endedAt: 1,
    outcome: { kind: "ok", dispatches: validatedDispatches([row, row]) } as never,
  });
  assert(leanUsage(run.steps).total.toolCalls === 14, "lean's fold sums the step log's counts");
  run.state = "handed-back";
  const r = leanIssueResult(run, 10);
  assert(r.driver === "lean", `work-lean names driver lean (got ${r.driver})`);
  assert(r.usage?.toolErrors === 6, "work-lean's usage carries the counts");
}

// ── The feature flag.
assert(buildCapabilities().features.usageTools === true, "features.usageTools is true");

process.exit(exit);

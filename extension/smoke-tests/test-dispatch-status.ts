#!/usr/bin/env bun
/**
 * Rendering + tool tests for dispatch_status / dispatch_kill (#534).
 *
 * The tool's execute() is exercised with a fake ExtensionAPI that captures
 * the registered tools, and the job registry is populated through the real
 * startJob / startBatch (work functions that never settle), exactly as
 * test-async-dispatch.ts does for the snapshot itself.
 *
 *   - dispatch_status renders the empty message when nothing is in flight
 *   - single-job rows: header count, label, formatted elapsed
 *   - batch rows: progress fraction plus the indented member rows
 *   - details carry the raw row count and metadata-only rows (jobId, kind,
 *     role, label, elapsedMs — no content/transcript fields)
 *   - dispatch_kill reports success for a live job and not-found otherwise
 *
 * No Pi process spawned, no network.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearJobsForTesting, jobStatusSnapshot, startBatch, startJob } from "../src/async-jobs.ts";
import { registerDispatchStatusTool } from "../src/dispatch-status.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface StubMessage {
  content: string;
  deliverAs?: string;
}

function makePiStub() {
  const inbox: StubMessage[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: testing seam — match minimum shape the tool needs.
  const pi: any = {
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      inbox.push({ content, deliverAs: options?.deliverAs });
    },
  };
  return { pi, inbox };
}

function neverSettlingWork() {
  return async (): Promise<DispatchResult> => {
    await new Promise<DispatchResult>(() => undefined); // never resolves
  };
}

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    raw: unknown,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}

const tools: RegisteredTool[] = [];
// biome-ignore lint/suspicious/noExplicitAny: stub surface intentionally loose
const fakePi: any = {
  registerTool: (t: RegisteredTool) => tools.push(t),
};
registerDispatchStatusTool(fakePi as unknown as ExtensionAPI);

const statusTool = tools.find((t) => t.name === "dispatch_status");
const killTool = tools.find((t) => t.name === "dispatch_kill");
assert(statusTool !== undefined, "dispatch_status is registered");
assert(killTool !== undefined, "dispatch_kill is registered");
if (!statusTool || !killTool) {
  console.log("\nexit 1");
  process.exit(1);
}

const call = (tool: RegisteredTool, raw: unknown = {}) =>
  tool.execute("t1", raw, new AbortController().signal, () => {}, { cwd: process.cwd() });

// Clean slate. clearJobsForTesting() drains the registry without settling —
// required here because the test jobs never settle on their own.
clearJobsForTesting();

// 1. Nothing in flight → empty message, zero details.
{
  assert(jobStatusSnapshot().length === 0, "registry empty before dispatch");
  const r = await call(statusTool);
  assert(
    r.content[0]?.text === "no async subagents running",
    "empty → 'no async subagents running'",
  );
  assert(r.details.count === 0, "details.count is 0 when empty");
  assert(
    Array.isArray(r.details.rows) && (r.details.rows as unknown[]).length === 0,
    "details.rows is an empty array when empty",
  );
}

// 2. Single in-flight job → header + one row with label and formatted elapsed.
{
  const { pi } = makePiStub();
  const { jobId } = startJob(pi, {
    label: "developer",
    role: "developer",
    work: neverSettlingWork(),
  });
  const r = await call(statusTool);
  const text = r.content[0]?.text ?? "";
  const lines = text.split("\n");
  assert(lines[0]?.startsWith("1 async slot(s) in flight:"), "header counts one in-flight slot");
  assert(
    lines[1]?.startsWith(`[${jobId}] `) && lines[1]?.includes(" developer · "),
    `single row shape '[jobId] <label> · <elapsed>' (got: ${lines[1]})`,
  );
  assert(/ elapsed$/.test(lines[1] ?? ""), "row ends with a formatted elapsed value");
  assert(r.details.count === 1, "details.count is 1");
  const rows = r.details.rows as Array<{
    jobId: string;
    label: string;
    kind: string;
    role: string;
    elapsedMs: number;
  }>;
  assert(rows.length === 1, "details.rows has one row");
  assert(rows[0]?.jobId === jobId, "row carries the jobId");
  assert(rows[0]?.label === "developer", "row carries the label");
  assert(rows[0]?.kind === "single" && rows[0]?.role === "developer", "row carries kind + role");
  assert(
    typeof rows[0]?.elapsedMs === "number" && rows[0]?.elapsedMs >= 0,
    "row carries non-negative elapsedMs",
  );
  const keys = new Set(Object.keys(rows[0] ?? {}));
  assert(
    !keys.has("text") && !keys.has("lastText") && !keys.has("transcriptPath"),
    "row is metadata-only (no content/transcript fields)",
  );
  clearJobsForTesting();
}

// 3. Elapsed formatting across the three fmtElapsed tiers, via backdated
//    registry entries (startedAt is a plain field, so a fresh registry write
//    with a past timestamp is a valid in-memory state).
{
  const { jobs } = await import("../src/async-jobs-registry.ts");
  const t0 = Date.now();
  const mk = (jobId: string, startedAt: number) => {
    jobs.set(jobId, {
      kind: "single",
      jobId,
      role: "ops",
      label: "ops",
      startedAt,
      abort: new AbortController(),
      ownerKind: "pm",
    });
  };
  // Each row is asserted from its own registry state so a single slow assert
  // cannot push the others across a tier boundary (the ms tier is 1s wide).
  mk("job-ms", t0 - 500);
  {
    const text = (await call(statusTool)).content[0]?.text ?? "";
    assert(text.startsWith("1 async slot(s) in flight:"), "header counts the single backdated job");
    assert(text.includes("500ms"), "elapsed < 1s renders in ms");
  }
  jobs.delete("job-ms");
  mk("job-s", t0 - 30_500); // 30.5s — well inside the seconds tier
  {
    const text = (await call(statusTool)).content[0]?.text ?? "";
    assert(/30\.[05]s/.test(text), "elapsed ≥ 1s but < 1min renders in s with one decimal");
  }
  jobs.delete("job-s");
  mk("job-min", t0 - (6 * 60_000 + 42_000));
  {
    const text = (await call(statusTool)).content[0]?.text ?? "";
    assert(text.includes("6m42s"), "elapsed ≥ 7m renders as mNs (zero-padded seconds)");
  }
  jobs.delete("job-min");
}

// 4. Batch: orchestrator row shows progress, members are indented under it.
{
  const { pi } = makePiStub();
  startBatch(pi, {
    batchLabel: "explore×2",
    members: [
      { label: "explore", role: "explore", work: neverSettlingWork() },
      { label: "explore", role: "explore", work: neverSettlingWork() },
    ],
  });
  const r = await call(statusTool);
  const text = r.content[0]?.text ?? "";
  const lines = text.split("\n");
  assert(
    text.startsWith("3 async slot(s) in flight:"),
    "batch = 1 orchestrator + 2 members → 3 slots",
  );
  const orchRow = lines.find((l) => l.includes("children done"));
  assert(orchRow !== undefined, "an orchestrator row carries the progress suffix");
  assert(orchRow?.includes("explore×2"), "orchestrator row carries the batch label");
  assert(orchRow?.includes("0/2 children done"), "progress starts at 0/2");
  const memberRows = lines.filter((l) => l.startsWith("  ↳ "));
  assert(memberRows.length === 2, "two member rows are indented under the batch");
  assert(
    memberRows.every((l) => l.includes("(in batch ")),
    "member rows name their batch id",
  );
  assert(r.details.count === 3, "details.count includes batch orchestrator and members");
  clearJobsForTesting();
}

// 5. dispatch_kill: live job → SIGTERM message, details.killed true.
{
  const { pi } = makePiStub();
  const { jobId } = startJob(pi, {
    label: "developer",
    role: "developer",
    work: neverSettlingWork(),
  });
  const r = await call(killTool, { jobId });
  assert(
    r.content[0]?.text.includes(`Sent SIGTERM to job ${jobId}`),
    "kill of live job reports SIGTERM",
  );
  assert(
    r.content[0]?.text.includes("FAILED report will arrive shortly"),
    "kill message warns about the FAILED report",
  );
  assert(r.details.killed === true, "details.killed is true for a live job");
  assert(r.details.jobId === jobId, "details echoes the jobId");
  clearJobsForTesting();
}

// 6. dispatch_kill: unknown job → not-found message, details.killed false.
{
  const r = await call(killTool, { jobId: "no-such-job" });
  assert(r.content[0]?.text.includes("No such job no-such-job"), "unknown job reports not-found");
  assert(
    r.content[0]?.text.includes("already finished or never existed"),
    "not-found message names the usual causes",
  );
  assert(r.details.killed === false, "details.killed is false for an unknown job");
}

// 7. Poll-guard (FIX 1, #364): unit-level tests for classifyStatusCall +
//    jobSetKey — no live job registry needed.
{
  const { classifyStatusCall, jobSetKey } = await import("../src/dispatch-status.ts");

  // jobSetKey: order-insensitive, stable string.
  assert(jobSetKey([{ jobId: "a" }, { jobId: "b" }]) === "a,b", "jobSetKey sorts jobId alphabetically");
  assert(jobSetKey([{ jobId: "b" }, { jobId: "a" }]) === "a,b", "jobSetKey is order-insensitive");
  assert(jobSetKey([]) === "", "jobSetKey of empty set is empty string");

  // classifyStatusCall: first call (last.key="", last.at=0) is never a poll.
  const rowsA = [{ jobId: "j1" }];
  assert(
    classifyStatusCall(rowsA, 1000, { at: 0, key: "" }).polling === false,
    "first call is never a poll (fresh state)",
  );

  // Same set within window → poll.
  assert(
    classifyStatusCall(rowsA, 2000, { at: 1000, key: "j1" }).polling === true,
    "same set within 90s window is a poll",
  );

  // Same set outside window → not a poll.
  assert(
    classifyStatusCall(rowsA, 100_000, { at: 1000, key: "j1" }).polling === false,
    "same set outside 90s window is not a poll",
  );

  // Different set (new job added) → not a poll (set grew).
  const rowsAB = [{ jobId: "j1" }, { jobId: "j2" }];
  assert(
    classifyStatusCall(rowsAB, 2000, { at: 1000, key: "j1" }).polling === false,
    "set change (grew) resets the guard — not a poll",
  );

  // Different set (job removed) → not a poll (set shrank).
  const rowsEmpty = [];
  assert(
    classifyStatusCall(rowsEmpty, 2000, { at: 1000, key: "j1" }).polling === false,
    "empty set never triggers poll steer",
  );

  // After empty reset, a new non-empty call is fresh (key differs). 
  assert(
    classifyStatusCall(rowsA, 3000, { at: 2000, key: "" }).polling === false,
    "new non-empty set after empty reset is not a poll",
  );
}

// 8. Poll-guard: end-to-end via the registered tool (repeat same set → steer).
{
  const { pi } = makePiStub();
  const { jobId } = startJob(pi, {
    label: "developer",
    role: "developer",
    work: neverSettlingWork(),
  });

  // First call: normal status.
  const r1 = await call(statusTool);
  assert(r1.details.polling === false, "first call after dispatch: polling=false");
  assert(r1.details.count === 1, "first call returns normal status (count=1)");

  // Second call immediately: same set → poll steer.
  const r2 = await call(statusTool);
  assert(r2.details.polling === true, "second consecutive call: polling=true");
  assert(
    r2.content[0]?.text.includes("You are polling"),
    "poll steer text is returned",
  );
  assert(
    r2.content[0]?.text.includes("END YOUR TURN NOW"),
    "poll steer instructs to end the turn",
  );
  assert(
    r2.content[0]?.text.includes("[ensemble:async]"),
    "poll steer names the auto-delivery mechanism",
  );

  // Set changes (job removed from registry) → next call is fresh.
  clearJobsForTesting(); // simulates the job settling and being deleted
  const r3 = await call(statusTool);
  // After drain, empty set → not a poll, normal status.
  assert(r3.details.polling === false, "call after set change: polling=false");
  assert(r3.content[0]?.text === "no async subagents running", "post-drain call renders empty status");

  // After drain, a new dispatch → fresh call (key changed from empty).
  const { jobId2 } = startJob(pi, {
    label: "explore",
    role: "explore",
    work: neverSettlingWork(),
  });
  const r4 = await call(statusTool);
  assert(r4.details.polling === false, "new dispatch after drain: polling=false");
  assert(r4.details.count === 1, "new dispatch renders normal status");
  assert(
    r4.content[0]?.text?.startsWith("1 async slot(s) in flight:"),
    "new dispatch shows in-flight header",
  );
  assert(r4.details.rows !== undefined, "new dispatch carries row details");
  clearJobsForTesting();
}

console.log(`\nexit ${exit}`);
process.exit(exit);

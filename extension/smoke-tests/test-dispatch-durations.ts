#!/usr/bin/env bun
/**
 * #799 — per-dispatch durations in the status + handoff renderers.
 *
 * The three-hour silent incident (the lens-fix step running while a 6-way
 * adversarial fan-out produced no per-child signal) was reconstructed by
 * hand from event timestamps. The fix is observability in the operator
 * surfaces: `/work-status` (running + terminal) and the handoff markdown
 * must list every dispatch with its own duration, so a slow cycle shows
 * where the time went without opening the state file.
 *
 * These tests cover:
 *  - the `dispatchDurations()` helper returns one row per dispatch (not per step)
 *  - the `/work-status` running + terminal renderers show the per-dispatch block
 *  - the handoff markdown uses the same shared source (no drift)
 *  - failed dispatches appear with a ` (failed)` marker
 *  - a cycle with no dispatch rows renders nothing (no empty section)
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import {
  dispatchDurations,
  renderDispatchDurations,
} from "../src/work-status-dispatch-durations.ts";
import { renderStatus } from "../src/work-status.ts";
import type { WorkStep } from "../src/workflow-state-events.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/tmp/fake-repo";

/** Build a minimal state with the given event log (the fixture sets the
 * status/step fields the renderers read; the rest rides the real schema). */
function mkState(
  status: WorkState["pipelineState"]["status"],
  events: WorkState["eventLog"],
  issue = 799,
): WorkState {
  const base = initialState(issue, 1_000_000);
  return {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      status,
      currentStep: "handoff",
      lastCompletedStep: "ci",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-799-task-c",
    },
    eventLog: events,
  };
}

/** A dispatch-completed event with the given fields. */
function completed(
  step: WorkStep,
  label: string,
  ms: number,
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): WorkState["eventLog"][number] {
  return {
    kind: "dispatch-completed",
    step,
    role: "developer",
    jobId: `j-${label}`,
    label,
    ok: true,
    ms,
    at: 2_000_000,
    ...(usage ? { usage } : {}),
  } as WorkState["eventLog"][number];
}

/** A dispatch-failed event with the given fields. */
function failed(step: WorkStep, label: string, ms: number): WorkState["eventLog"][number] {
  return {
    kind: "dispatch-failed",
    step,
    role: "developer",
    jobId: `j-${label}`,
    label,
    ms,
    at: 2_000_000,
    exitCode: 1,
  } as WorkState["eventLog"][number];
}

// ---------------------------------------------------------------------------
// 1. dispatchDurations() returns one row per dispatch, in chronological order.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    completed("explore", "explore", 31_000),
    completed("develop", "task-a", 460_000),
    completed("develop", "task-b", 120_000),
    completed("adversarial", "adversarial[base]", 600_000),
    completed("ci", "ops", 90_000),
  ];
  const rows = dispatchDurations(events);
  assert(rows.length === 5, "dispatchDurations: one row per dispatch (5 events → 5 rows)");
  assert(rows[0]?.step === "explore", "row 0: step = explore");
  assert(rows[1]?.label === "task-a", "row 1: label = task-a");
  assert(rows[2]?.label === "task-b", "row 2: label = task-b");
  assert(rows[3]?.step === "adversarial", "row 3: step = adversarial");
  assert(rows[4]?.step === "ci", "row 4: step = ci");
}

// ---------------------------------------------------------------------------
// 2. A 6-way fan-out: per-dispatch rows are distinct from per-step rollup.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [];
  for (let i = 1; i <= 6; i++) {
    events.push(completed("develop", `task-${String.fromCharCode(96 + i)}`, i * 100_000));
  }
  const rows = dispatchDurations(events);
  assert(rows.length === 6, "fan-out: 6 dispatches → 6 rows (not 1 rolled-up step row)");
  assert(
    rows.every((r) => r.step === "develop"),
    "all 6 rows are step=develop",
  );
  assert(rows[0]?.ms === 100_000 && rows[5]?.ms === 600_000, "ms values preserved in order");
}

// ---------------------------------------------------------------------------
// 3. Failed dispatches appear with a failed=true flag.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    completed("explore", "explore", 30_000),
    failed("develop", "developer (attempt 0)", 45_000),
    completed("develop", "developer (attempt 1)", 50_000),
  ];
  const rows = dispatchDurations(events);
  assert(rows.length === 3, "mixed: 3 rows (1 completed, 1 failed, 1 completed)");
  assert(rows[1]?.failed === true, "row 1: failed=true for the dispatch-failed event");
  assert(rows[0]?.failed === false, "row 0: failed=false for the dispatch-completed event");
  assert(rows[2]?.failed === false, "row 2: failed=false for the second dispatch-completed event");
}

// ---------------------------------------------------------------------------
// 4. No dispatch events → empty array (renderers omit the section).
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [{ kind: "step-started", step: "explore", at: 1_000_000 }];
  const rows = dispatchDurations(events);
  assert(rows.length === 0, "no dispatches → empty array");
  const rendered = renderDispatchDurations(events);
  assert(rendered.length === 0, "renderDispatchDurations: empty array when no dispatches");
}

// ---------------------------------------------------------------------------
// 5. renderDispatchDurations: correct line format.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    completed("explore", "explore", 31_000, { input: 1000, output: 200 }),
    completed("develop", "task-a", 460_000),
    failed("develop", "task-b", 120_000),
  ];
  const lines = renderDispatchDurations(events);
  assert(lines.length === 3, "renderDispatchDurations: 3 lines for 3 dispatches");
  assert(lines[0]?.includes("explore"), "line 0: contains step name");
  assert(lines[0]?.includes("explore"), "line 0: contains label");
  assert(lines[0]?.includes("31.0s"), "line 0: formatted duration");
  assert(lines[0]?.includes("1.2k tokens"), "line 0: token column populated");
  assert(lines[2]?.includes("(failed)"), "line 2: failed marker present");
  assert(!lines[1]?.includes("(failed)"), "line 1: no failed marker for completed dispatch");
}

// ---------------------------------------------------------------------------
// 6. /work-status RUNNING: per-dispatch block is present.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    completed("explore", "explore", 31_000),
    completed("develop", "task-a", 460_000),
    completed("develop", "task-b", 120_000),
  ];
  const state = mkState("running", events);
  const out = renderStatus(state, REPO);
  assert(out.includes("dispatch durations:"), "running: per-dispatch section present");
  assert(out.includes("explore"), "running: first dispatch label visible");
  assert(out.includes("task-a"), "running: second dispatch label visible");
  assert(out.includes("task-b"), "running: third dispatch label visible");
}

// ---------------------------------------------------------------------------
// 7. /work-status TERMINAL: per-dispatch block is present.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    completed("explore", "explore", 31_000),
    completed("develop", "task-a", 460_000),
    { kind: "cap-hit", at: 2_000_000, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  ];
  const state = mkState("handoff", events);
  const out = renderStatus(state, REPO);
  assert(out.includes("Dispatch durations:"), "terminal: per-dispatch section present");
  assert(out.includes("explore"), "terminal: first dispatch label visible");
  assert(out.includes("task-a"), "terminal: second dispatch label visible");
}

// ---------------------------------------------------------------------------
// 8. /work-status: no dispatches → no per-dispatch section (no empty block).
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [{ kind: "step-started", step: "explore", at: 1_000_000 }];
  const state = mkState("running", events);
  const out = renderStatus(state, REPO);
  assert(!out.includes("dispatch durations:"), "running (no dispatches): no per-dispatch section");
  assert(
    !out.includes("Dispatch durations:"),
    "running (no dispatches): no terminal per-dispatch section",
  );
}

// ---------------------------------------------------------------------------
// 9. Handoff markdown: per-dispatch rows appear under "What was attempted".
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    completed("explore", "explore", 28_000),
    completed("develop", "developer", 240_000),
    { kind: "cap-hit", at: 2_000_000, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  ];
  const state = mkState("handoff", events);
  const md = renderHandoffMarkdown(state, REPO);
  assert(md.includes("What was attempted"), "handoff: 'What was attempted' section present");
  assert(md.includes("explore"), "handoff: explore dispatch row present");
  assert(md.includes("developer"), "handoff: developer dispatch row present");
  // The row format: `- <step.padEnd(14)> <fmtElapsed(ms)> · <label>`
  // (28_000ms → `28.0s`, 240_000ms → `4m00s` via the shared fmtElapsed)
  assert(/- explore\s+28\.0s · explore/.test(md), "handoff: explore row has correct format");
  assert(/- develop\s+4m00s · developer/.test(md), "handoff: developer row has correct format");
}

// ---------------------------------------------------------------------------
// 10. Handoff markdown: failed dispatches carry the (failed) marker.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    failed("develop", "developer (attempt 0)", 45_000),
    completed("develop", "developer (attempt 1)", 50_000),
    { kind: "cap-hit", at: 2_000_000, cap: "round-cap", reviewRound: 0, nextStep: "handoff" },
  ];
  const state = mkState("handoff", events);
  const md = renderHandoffMarkdown(state, REPO);
  assert(md.includes("(failed)"), "handoff: failed marker present for the failed dispatch");
  assert(md.includes("developer (attempt 1)"), "handoff: the successful retry is also listed");
}

// ---------------------------------------------------------------------------
// 11. Handoff markdown: no dispatches → no "What was attempted" rows.
// ---------------------------------------------------------------------------
{
  const events: WorkState["eventLog"] = [
    { kind: "cap-hit", at: 1_000_000, cap: "intent-park", reviewRound: 0, nextStep: "handoff" },
  ];
  const state = mkState("handoff", events);
  const md = renderHandoffMarkdown(state, REPO);
  // The section header is still present (it's part of the static template),
  // but it should have no dispatch rows under it.
  const section = md.split("### What was attempted")[1] ?? "";
  const rows = section.split("\n").filter((l) => l.startsWith("- ") && /\d+(ms|s|m\d{2}s)/.test(l));
  assert(rows.length === 0, "handoff (no dispatches): no duration rows under 'What was attempted'");
}

// ---------------------------------------------------------------------------
// 12. The three surfaces agree: same dispatch → same ms value in all three.
// ---------------------------------------------------------------------------
{
  const ms = 460_000; // 7.67 minutes
  const events: WorkState["eventLog"] = [
    completed("develop", "task-a", ms),
    { kind: "cap-hit", at: 2_000_000, cap: "round-cap", reviewRound: 0, nextStep: "handoff" },
  ];
  const state = mkState("handoff", events);
  const runningOut = renderStatus(mkState("running", events), REPO);
  const terminalOut = renderStatus(state, REPO);
  const handoffMd = renderHandoffMarkdown(state, REPO);
  const formatted = "7m40s"; // fmtElapsed(460000ms) = "7m40s"
  assert(runningOut.includes(formatted), "running: ms value rendered");
  assert(terminalOut.includes(formatted), "terminal: ms value rendered");
  // All three surfaces share fmtElapsed now — the handoff must render the
  // same `7m40s` as the status renderers, not its own `460.0s` format.
  assert(
    handoffMd.includes(formatted),
    "handoff: ms value rendered identically to status surfaces",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

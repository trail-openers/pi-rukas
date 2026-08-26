#!/usr/bin/env bun
/**
 * #534 — tokens on the status surfaces.
 *
 * stepTotals.tokens is now populated (input+output+cacheRead+cacheWrite,
 * matching async-jobs-report.ts totalTokens) and rendered in BOTH
 * step-durations sections alongside the ms column, with the cycle total
 * (raw sum across ALL dispatch-completed + dispatch-failed* events, retries
 * included, no deduplication) on one shared-helper line. The shared helper
 * is exercised here too: a retry re-run is a second row and is summed as-is,
 * and a failed dispatch's flushed spend counts.
 */

import { formatCycleTotal } from "../src/work-driver-cycle-total.ts";
import { renderStatus } from "../src/work-status.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Minimal state file shaped like the real one (status renderer needs inFlightJobIds). */
function mkState(status: WorkState["pipelineState"]["status"], cap?: string): WorkState {
  const eventLog: WorkState["eventLog"] = [
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer",
      ms: 1,
      at: 2,
      summary: "ok",
    } as WorkState["eventLog"][number],
  ];
  if (cap) {
    eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap,
      reviewRound: 0,
      nextStep: "handoff",
    } as WorkState["eventLog"][number]);
  }
  return {
    schemaVersion: 1,
    issue: 777,
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the renderer reads matter
    pipelineState: {
      status,
      currentStep: "develop",
      lastCompletedStep: "branch",
      inFlightJobIds: [],
    } as any,
    eventLog,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

{
  const fakeRoot = "/tmp/fake-repo";
  const usageA = { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 100 } as const;
  const usageB = { input: 100, output: 50, cacheRead: 950, cacheWrite: 0 } as const;

  const mk = (status: "running" | "handoff") => {
    const s = mkState(status, status === "handoff" ? "round-cap" : undefined);
    const completed = s.eventLog.find(
      (e): e is WorkState["eventLog"][number] => e.kind === "dispatch-completed",
    );
    if (completed) (completed as { usage?: unknown }).usage = usageA;
    // a retry that failed — its spend counts too, as a separate row
    s.eventLog.push({
      kind: "dispatch-failed",
      step: "develop",
      role: "developer",
      jobId: "jf",
      label: "developer (attempt 0)",
      ms: 5,
      at: 3,
      exitCode: 1,
      usage: usageB,
    } as WorkState["eventLog"][number]);
    return s;
  };

  // RUNNING surface: token column + cycle total.
  const runningOut = renderStatus(mk("running"), fakeRoot);
  assert(runningOut.includes("step durations:"), "running: step-durations section present");
  assert(
    /develop\s+\S+\s+· 4\.3k tokens/.test(runningOut),
    "running: per-step token column populated (input+output+cacheRead+cacheWrite)",
  );
  assert(
    /\(cycle total\)\s+·\s+\d+(\.\d+)?k tokens/.test(runningOut),
    "running: cycle total line rendered (4.3k completed + 1.1k failed = 5.4k)",
  );

  // TERMINAL surface: same shape.
  const terminalOut = renderStatus(mk("handoff"), fakeRoot);
  assert(
    /develop\s+\S+\s+· 4\.3k tokens/.test(terminalOut),
    "terminal: per-step token column populated",
  );
  assert(
    /\(cycle total\)\s+·\s+\d+(\.\d+)?k tokens/.test(terminalOut),
    "terminal: cycle total line rendered",
  );
}

{
  // Cycle total = raw sum across ALL dispatch-completed AND dispatch-failed*
  // events: a retry re-run is a second row and is summed as-is (no dedup),
  // and a failed dispatch's flushed spend counts.
  const row = (
    kind: "dispatch-completed" | "dispatch-failed-provider",
    jobId: string,
    input: number,
  ): WorkState["eventLog"][number] =>
    ({
      kind,
      step: "develop",
      role: "developer",
      jobId,
      label: `attempt ${jobId}`,
      ok: true,
      ms: 1,
      at: 1,
      usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    }) as WorkState["eventLog"][number];

  // Replace the fixture's completed dispatch (no usage) with the rows we sum over.
  const s = mkState("handoff", "round-cap");
  s.eventLog = [];
  s.eventLog.push(row("dispatch-failed-provider", "jf", 100));
  s.eventLog.push(row("dispatch-completed", "j1", 100));
  s.eventLog.push(row("dispatch-completed", "j2", 100));
  assert(
    formatCycleTotal(s.eventLog) === " · 300 tokens",
    "cycle total sums completed + failed rows as-is (no deduplication): 100+100+100=300",
  );

  // Pre-#534 state files (no usage anywhere) render nothing, not "0".
  const bare = mkState("handoff", "round-cap");
  assert(formatCycleTotal(bare.eventLog) === "", "no usage anywhere → empty string, not '0'");
  const bareOut = renderStatus(bare, "/tmp/fake-repo");
  assert(!bareOut.includes("(cycle total)"), "no cycle-total line for a usage-less cycle");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #456 — the lens review is the most thorough review in the pipeline and was
 * the one nobody saw. Its evidence was silently discarded: `computeVerdict`
 * retains `summary.findings` at every severity, but `lens-approved` carried
 * none of them, per-lens timing was never persisted, no code path read
 * findings into the PR body, and a lens waiting behind the spawn semaphore
 * was indistinguishable from a slow one. This locks in the four fixes.
 */

import { lensTimingsOf } from "../src/work-driver-lens.ts";
import { applyLensVerdict } from "../src/work-driver-lens-verdicts.ts";
import { renderLensFindingsSection } from "../src/work-driver-pr-sections.ts";
import {
  __resetSpawnSemaphore,
  lensWaitTraceMessage,
  withSpawnSlot,
} from "../src/spawn-semaphore.ts";
import { initialState } from "../src/workflow-state-update.ts";
import type { Finding, LensReviewSummary } from "../src/lens-review.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const mkFinding = (
  lens: Finding["lens"],
  severity: Finding["severity"],
  filePath: string,
  title: string,
  line?: number,
): Finding => ({ lens, severity, path: filePath, title, line, description: "", suggestion: "" });

// ------------------------------------------------ (1) lens-approved findings

{
  const summary: LensReviewSummary = {
    verdict: "APPROVED",
    totalFindings: 1,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
    lenses: [],
    findings: [mkFinding("SIMPLICITY", "MEDIUM", "a.ts", "duplicate locks", 85)],
  };
  const next = await applyLensVerdict(
    summary,
    "job-1",
    1,
    {} as unknown as DriverContext,
    initialState(456),
  );
  const approved = next.eventLog.find((e) => e.kind === "lens-approved");
  assert(approved?.kind === "lens-approved", "the verdict bank appends lens-approved on APPROVED");
  const carried = (approved as Extract<WorkEvent, { kind: "lens-approved" }>).findings;
  assert(typeof carried === "string", "lens-approved carries a findings blob");
  const parsed = carried ? (JSON.parse(carried) as Finding[]) : [];
  assert(
    parsed.length === 1 && parsed[0]?.title === "duplicate locks",
    "...and the blob round-trips the computed (sub-threshold) findings",
  );
}

// ---------------------------------------------- (2) per-lens timing persisted

{
  const timings = lensTimingsOf([
    { lens: "SECURITY", startMs: 1000, ms: 42 },
    { lens: "SIMPLICITY", startMs: 2000, ms: 17 },
  ]);
  assert(timings.length === 2, "lensTimingsOf maps every lens result");
  assert(
    timings[0]?.lens === "SECURITY" && timings[0]?.startMs === 1000 && timings[0]?.ms === 42,
    "lens/startMs/ms are carried verbatim",
  );
  assert(
    lensTimingsOf([{ lens: "ARCHITECTURE", ms: 9 }])[0]?.startMs === 0,
    "a result without an explicit startMs degrades safely (additive field)",
  );
}

// --------------------------------------------- (3) PR body lens section

{
  const blob = JSON.stringify([
    mkFinding("SECURITY", "CRITICAL", "src/mod.rs", "config root deleted", 10),
    mkFinding("SIMPLICITY", "MEDIUM", "src/session.rs", "duplicate locks", 85),
  ]);
  const log: WorkEvent[] = [
    {
      kind: "lens-issues-found",
      at: 1,
      jobId: "j1",
      round: 1,
      verdict: "ISSUES_FOUND",
      findings: blob,
    },
  ];
  const rendered = renderLensFindingsSection(log);
  assert(rendered.includes("## Lens review — findings"), "the section has a top-level heading");
  assert(rendered.includes("CRITICAL"), "...carries the severity");
  assert(
    rendered.includes("`SECURITY`") && rendered.includes("src/mod.rs:10"),
    "...the lens and path:line",
  );
  assert(/blocking threshold/i.test(rendered), "...says whether the issues blocked");
  // sub-threshold APPROVED: findings retained but explicitly did not block.
  const approvedLog: WorkEvent[] = [
    {
      kind: "lens-approved",
      at: 1,
      jobId: "j1",
      round: 1,
      findings: JSON.stringify([mkFinding("PERFORMANCE", "LOW", "b.ts", "tiny")]),
    },
  ];
  const approvedRendered = renderLensFindingsSection(approvedLog);
  assert(approvedRendered.includes("APPROVED"), "an APPROVED pass names its verdict");
  assert(
    /did not block/i.test(approvedRendered),
    "...and says sub-threshold findings did not block",
  );
  assert(
    renderLensFindingsSection([]) === "",
    "no lens verdict → nothing rendered (clean PR body unchanged)",
  );
}

// --------------------------------------------------- (4) semaphore trace

{
  assert(
    lensWaitTraceMessage(0) === "spawn-semaphore: lens waited behind 0 queued spawn(s)",
    "wait-trace format (0 queued)",
  );
  assert(
    lensWaitTraceMessage(3) === "spawn-semaphore: lens waited behind 3 queued spawn(s)",
    "wait-trace format (N queued)",
  );
}

// ------------------------------------------------------------------ queueing

{
  const prev = process.env.PI_ENSEMBLE_SPAWN_CAP;
  process.env.PI_ENSEMBLE_SPAWN_CAP = "1"; // spawnCap() reads env at call time
  __resetSpawnSemaphore();
  const runs: string[] = [];
  const hold = new Promise<void>((res) => setTimeout(res, 10));
  const p1 = withSpawnSlot(async () => {
    runs.push("a-start");
    await hold;
    runs.push("a-end");
  });
  await new Promise<void>((res) => setTimeout(res, 5)); // let p1 take the slot
  const p2 = withSpawnSlot(async () => {
    runs.push("b");
  });
  await Promise.all([p1, p2]);
  assert(
    runs.join(",") === "a-start,a-end,b",
    "cap 1 serialises: the second lens queues behind the first (the traced branch is reachable)",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_SPAWN_CAP;
  else process.env.PI_ENSEMBLE_SPAWN_CAP = prev;
  __resetSpawnSemaphore();
}

console.log(`\nexit ${exit}`);
process.exit(exit);

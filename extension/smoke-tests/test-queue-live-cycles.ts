#!/usr/bin/env bun
/**
 * A cycle that never started is not a cycle that failed.
 *
 * `runWorkDriver` returned `Promise<void>`, and five of its exits resolve in
 * ~0 ms without running anything: a claim conflict with another cycle in this
 * session, another live process owning the state file, an already-terminal
 * status, a `needs-human-attention` label, and state-file inconsistencies.
 *
 * The queue could not tell those apart from a cycle that ran and parked. So it
 * read whatever state file was on disk — which, in the two interesting cases,
 * belongs to the cycle that is ACTUALLY RUNNING — took its most recent
 * `cap-hit` as this group's park reason, and recommended `--restart`. That
 * would wipe a live cycle's state file and start a second driver on the same
 * issue: precisely the interleaving the claim check exists to prevent.
 *
 * Reported from the field as *"the queue announced finished — 0 merged, 2
 * parked while both explores were still alive; state files showed
 * status: running with populated inFlightJobIds, and updatedAt only 1.3s after
 * startedAt."* The 1.3s is the tell — that is the refusal path, not a cycle.
 *
 * Two independent guards, because a running state file can be read by more
 * than one route: the queue refuses to interpret a state file at all when the
 * driver reports `started: false`, and `parkReason` independently refuses to
 * call a running cycle with a live owner "parked".
 */

import { renderQueueSummary, runWorkQueue } from "../src/work-queue.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const group = (id: string, issues: number[]) => ({
  id,
  scope: `issues ${issues.join(", ")}`,
  paths: [],
  outOfScope: [],
  issues,
});

/** A state file belonging to a cycle that is mid-flight, with a real cap in its log. */
const liveState = (issue: number): WorkState =>
  ({
    issue,
    // A live cycle legitimately accumulates cap-hits from earlier rounds; the
    // old parkReason took the LAST one as a terminal verdict.
    eventLog: [{ kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 1, nextStep: "handoff" }],
    owner: { pid: process.pid, at: Date.now() },
    pipelineState: {
      currentStep: "develop",
      lastCompletedStep: "plan",
      status: "running",
      reviewRound: 1,
      plumbReports: [],
      inFlightJobIds: ["abc-123"],
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only read fields matter
  }) as any;

// -------------------- a refused group is not reported as parked

{
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [group("group-a", [686]), group("group-b", [693])],
    concurrency: 1,
    // Both refuse — the shape when a prior queue is still live on these issues.
    runGroup: async (primary) => ({
      started: false,
      reason: `another live process owns the cycle for #${primary}`,
    }),
    readStateFn: async (_root, issue) => liveState(issue),
  });

  assert(
    summary.parked === 0,
    `canary: a refused group is NOT counted as parked (got parked=${summary.parked})`,
  );
  assert(summary.refused === 2, `...it is counted as refused (got ${summary.refused})`);
  assert(summary.merged === 0, "and not as merged");
  assert(
    summary.entries.every((e) => e.outcome === "not-started"),
    `canary: both entries carry the not-started outcome (got ${JSON.stringify(summary.entries.map((e) => e.outcome))})`,
  );

  const text = renderQueueSummary(summary);
  assert(
    !/--restart/.test(text),
    // Invariant, not a canary: this fixture's cap produces no --restart advice
    // pre-fix either. It guards the consequence that made the defect dangerous
    // rather than merely wrong — restarting a live cycle races two drivers on
    // one issue.
    `the summary never advises --restart for a live cycle (got ${JSON.stringify(text.slice(0, 160))})`,
  );
  assert(
    !/halted here/.test(text),
    "nor does it render a refusal as a halt — 'not-started' would fall through to the halt branch",
  );
  assert(/did not start/.test(text), "the summary says plainly that these did not start");
  assert(
    /round-cap/.test(text) === false,
    "canary: the LIVE cycle's cap-hit does not surface as this group's reason",
  );
}

// ----------------- a group that really ran and parked still parks

{
  const parked = (issue: number): WorkState =>
    ({
      issue,
      eventLog: [{ kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "handoff" }],
      owner: { pid: 999_999, at: Date.now() },
      pipelineState: {
        currentStep: "handoff",
        lastCompletedStep: "lens-review",
        status: "handoff",
        reviewRound: 3,
        plumbReports: [],
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    }) as any;

  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [group("group-a", [700])],
    concurrency: 1,
    runGroup: async () => ({ started: true }),
    readStateFn: async (_root, issue) => parked(issue),
  });
  assert(
    summary.parked === 1,
    `a cycle that ran and parked is still parked (got ${summary.parked})`,
  );
  assert(summary.refused === 0, "...and is not miscounted as refused");
  assert(
    /round-cap/.test(renderQueueSummary(summary)),
    "...with its real cap reported, exactly as before",
  );
}

// ------- and a merged cycle is unaffected by any of this

{
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [group("group-a", [701])],
    concurrency: 1,
    runGroup: async () => ({ started: true }),
    readStateFn: async (_root, issue) =>
      ({
        issue,
        eventLog: [],
        pipelineState: {
          currentStep: "merged",
          status: "merged",
          reviewRound: 0,
          plumbReports: [],
        },
        // biome-ignore lint/suspicious/noExplicitAny: partial fixture
      }) as any,
  });
  assert(summary.merged === 1, "a merged cycle still reports merged");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

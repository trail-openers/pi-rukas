#!/usr/bin/env bun
/**
 * #368 — a failed group parks; the queue continues.
 *
 * The regression this locks down is the most operator-visible failure the
 * harness has: `/work` over 13 issues died on #279 and left **11 unrelated
 * groups unstarted**. A three-issue batch halted on its second item while the
 * third was independently ready. Since 69% of the triggering failures are
 * provider infrastructure (#366), the queue was usually stopped by something
 * with no bearing on the remaining work.
 */

import {
  type IssueGroup,
  isSystemicFailure,
  renderQueueSummary,
  runWorkQueue,
} from "../src/work-queue.ts";
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

const groups = (n: number): IssueGroup[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `group-${String.fromCharCode(97 + i)}`,
    scope: "",
    paths: [],
    outOfScope: [],
    issues: [100 + i],
  }));

/** Minimal state file shaped like the real one. */
function mkState(
  issue: number,
  status: WorkState["pipelineState"]["status"],
  opts: { cap?: string; providerMessage?: string } = {},
): WorkState {
  const eventLog: WorkState["eventLog"] = [];
  if (opts.providerMessage) {
    eventLog.push({
      kind: "dispatch-failed-provider",
      step: "develop",
      role: "developer",
      jobId: "j",
      label: "developer",
      ms: 1,
      at: 1,
      providerMessage: opts.providerMessage,
    } as WorkState["eventLog"][number]);
  }
  if (opts.cap) {
    eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: opts.cap,
      reviewRound: 0,
      nextStep: "handoff",
    } as WorkState["eventLog"][number]);
  }
  return {
    schemaVersion: 1,
    issue,
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the queue reads matter
    pipelineState: { status, currentStep: "develop", lastCompletedStep: "branch" } as any,
    eventLog,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

// --------------------------------------------- the headline: park, continue

{
  const ran: number[] = [];
  const states = new Map<number, WorkState>([
    [100, mkState(100, "merged")],
    [101, mkState(101, "handoff", { cap: "round-cap" })], // group-b fails
    [102, mkState(102, "merged")],
    [103, mkState(103, "merged")],
    [104, mkState(104, "merged")],
  ]);
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(5),
    restart: false,
    runGroup: async (primary) => {
      ran.push(primary);
    },
    readStateFn: async (_r, issue) => states.get(issue),
  });

  assert(
    ran.join(",") === "100,101,102,103,104",
    "group 2 of 5 fails and groups 3-5 STILL RUN — the #279 regression",
  );
  assert(summary.merged === 4 && summary.parked === 1, "summary counts 4 merged, 1 parked");
  assert(summary.notStarted.length === 0, "nothing is left unstarted by an issue-scoped failure");
  const parked = summary.entries.find((e) => e.outcome === "parked");
  assert(parked?.groupId === "group-b", "the parked entry names the group that failed");
  assert(/round-cap/.test(parked?.reason ?? ""), "the parked entry carries the cap that fired");
  assert(
    parked?.failedStep === "branch",
    "the parked entry carries the step, so the group can be re-driven",
  );
  assert(
    /review the findings/.test(parked?.humanAction ?? ""),
    "the parked entry names a human ACTION, not just a failure",
  );
}

// ------------------------------------------------- systemic failures halt

{
  const ran: number[] = [];
  const states = new Map<number, WorkState>([
    [100, mkState(100, "merged")],
    [
      101,
      mkState(101, "aborted", {
        providerMessage:
          "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
      }),
    ],
  ]);
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(5),
    restart: false,
    runGroup: async (primary) => {
      ran.push(primary);
    },
    readStateFn: async (_r, issue) => states.get(issue),
  });
  assert(
    ran.join(",") === "100,101",
    "a quota window HALTS the queue — the rest would only burn attempts against the same limit",
  );
  assert(summary.notStarted.length === 3, "the summary names the 3 groups it did not start");
  assert(
    /quota window/.test(summary.entries.at(-1)?.reason ?? ""),
    "the halt reason explains WHY continuing was pointless",
  );
}

{
  // A spend cap is the other systemic class: waiting does not clear it.
  const state = mkState(1, "aborted", {
    providerMessage: "429 status code — monthly spend cap reached",
  });
  assert(isSystemicFailure(state).systemic, "spend cap is systemic");
}
{
  // A burst 429 that exhausted its retries is NOT systemic — the next group
  // may well succeed a minute later.
  const state = mkState(1, "aborted", {
    providerMessage: "Server requested 60s retry delay (max: 10s). 429 status code (no body)",
  });
  assert(
    !isSystemicFailure(state).systemic,
    "an exhausted burst 429 is issue-scoped — the next group gets its chance",
  );
}
{
  assert(
    !isSystemicFailure(mkState(1, "handoff", { cap: "round-cap" })).systemic,
    "a review cap is issue-scoped",
  );
  assert(!isSystemicFailure(undefined).systemic, "a missing state file is not treated as systemic");
}

// -------------------------------------------------------- driver throw

{
  const ran: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(4),
    restart: false,
    runGroup: async (primary) => {
      ran.push(primary);
      if (primary === 101) throw new Error("boom");
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(
    ran.join(",") === "100,101",
    "a driver THROW still halts — unknown shape is not safe to continue past",
  );
  assert(
    /driver crashed/.test(summary.entries.at(-1)?.reason ?? ""),
    "the halt entry says the driver crashed",
  );
}

// ------------------------------------------------------- escape hatch

{
  const prev = process.env.PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE;
  process.env.PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE = "1";
  try {
    const ran: number[] = [];
    await runWorkQueue({
      repoRoot: "/repo",
      groups: groups(4),
      restart: false,
      runGroup: async (primary) => {
        ran.push(primary);
      },
      readStateFn: async (_r, issue) =>
        mkState(issue, issue === 101 ? "handoff" : "merged", { cap: "round-cap" }),
    });
    assert(
      ran.join(",") === "100,101",
      "PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE=1 restores halt-on-first-failure",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE;
    else process.env.PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE = prev;
  }
}

// ----------------------------------------------------------- the report

{
  const text = renderQueueSummary({
    entries: [
      { groupId: "group-a", issues: [1], outcome: "merged" },
      {
        groupId: "group-b",
        issues: [2, 3],
        outcome: "parked",
        reason: "cap round-cap",
        failedStep: "lens-review",
        humanAction: "review the findings on #2's PR",
      },
    ],
    merged: 1,
    parked: 1,
    notStarted: [],
  });
  assert(/1 merged, 1 parked/.test(text), "summary headline counts both outcomes");
  assert(/#2, #3/.test(text), "summary names every issue in a multi-issue group");
  assert(/→ review the findings/.test(text), "summary surfaces the human action");
  assert(!/queue halted/.test(text), "no halt language when nothing halted");
}

// ============================================================ #289 pool

/**
 * The pool. `finish()` used to compute notStarted as
 * `groups.slice(lastIndex + 1)` — a positional assumption that only holds for
 * a strictly sequential walk. With K workers, groups finish out of order and
 * that slice reports groups which actually ran as skipped, and misses ones
 * that genuinely were.
 */
{
  const started: number[] = [];
  let live = 0;
  let peak = 0;
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(6),
    restart: false,
    concurrency: 3,
    runGroup: async (primary) => {
      started.push(primary);
      live += 1;
      peak = Math.max(peak, live);
      // Deliberately uneven: the LAST group finishes first, so any positional
      // reasoning about completion order breaks.
      await new Promise((r) => setTimeout(r, primary === 105 ? 5 : 40));
      live -= 1;
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(peak === 3, `concurrency 3 ran three groups at once (peak ${peak})`);
  assert(started.length === 6, "every group ran exactly once");
  assert(new Set(started).size === 6, "no group was claimed twice");
  assert(summary.merged === 6, "all six merged");
  assert(summary.notStarted.length === 0, "nothing reported as not-started when all ran");
  assert(
    summary.entries.map((e) => e.groupId).join(",") ===
      "group-a,group-b,group-c,group-d,group-e,group-f",
    "the report is ordered by original group index despite out-of-order completion",
  );
}

{
  // A halt must stop CLAIMING new groups while letting in-flight ones drain —
  // abandoning a group halfway through commit-pr leaves exactly the debris
  // the halt exists to avoid.
  const finished: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(6),
    restart: false,
    concurrency: 2,
    runGroup: async (primary) => {
      await new Promise((r) => setTimeout(r, primary === 100 ? 5 : 40));
      finished.push(primary);
    },
    readStateFn: async (_r, issue) =>
      issue === 100
        ? mkState(issue, "aborted", {
            providerMessage: "Server requested 86399s retry delay. 429 status code",
          })
        : mkState(issue, "merged"),
  });
  assert(
    finished.includes(101),
    "the group already in flight when the halt fired ran to completion (drained)",
  );
  assert(summary.notStarted.length > 0, "groups never claimed are reported as not-started");
  assert(
    !summary.notStarted.some((n) => n.includes("group-b")),
    "a group that DID run is never listed as not-started (the positional-slice bug)",
  );
}

{
  // A systemic fault hits every in-flight group at once, so K workers can each
  // record a halt for the same cause. The operator should be told once.
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(4),
    restart: false,
    concurrency: 3,
    runGroup: async () => {
      await new Promise((r) => setTimeout(r, 5));
    },
    readStateFn: async (_r, issue) =>
      mkState(issue, "aborted", {
        providerMessage: "Server requested 86399s retry delay. 429 status code",
      }),
  });
  assert(
    summary.entries.filter((e) => e.outcome === "halted").length === 1,
    "duplicate halt entries for one systemic cause are deduped",
  );
}

{
  // concurrency 1 must reproduce the sequential behaviour exactly.
  const started: number[] = [];
  let live = 0;
  let peak = 0;
  await runWorkQueue({
    repoRoot: "/repo",
    groups: groups(4),
    restart: false,
    concurrency: 1,
    runGroup: async (primary) => {
      started.push(primary);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(peak === 1, "concurrency 1 is strictly sequential");
  assert(started.join(",") === "100,101,102,103", "and runs groups in order");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

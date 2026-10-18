#!/usr/bin/env bun
/**
 * #1101 fix-round — the queue's ordering gate had no production caller.
 *
 * The feature shipped complete and correct one layer down: `runWorkQueue` took
 * `dependencies` and `cyclic`, the scheduler obeyed them, and every case in
 * `test-work-queue-ordering.ts` handed the edges over by hand. The one function
 * that actually starts a `/work` queue — `runGroupedIssues` in `work-entry.ts` —
 * passed neither. So every real `/work 12 13` where 13 said `Depends-on: #12`
 * started the two groups side by side, and the suite stayed green because it
 * tested the executor and never the entry point.
 *
 * This file is the test that could not have passed before the wiring existed,
 * which is the only reason to trust it: it drives `runGroupedIssues` end to
 * end — bodies from a temp repo, groups decided by `groupIssues()`, edges
 * computed by `queueOrderingPlan()` — and asserts the ORDER the groups ran in.
 * Delete the `dependencies:` / `cyclic:` arguments in `work-entry.ts` and case
 * 1 goes red. That mutation check is the whole contract.
 *
 * Pinned alongside it, because each is the same class of defect — a queue-side
 * park described in words that only fit a cycle that ran:
 *
 *  - `PI_ENSEMBLE_QUEUE_ORDERING=0` drops the edges AND the cycle park (a cycle
 *    is an ordering claim, and the operator just said ordering is off);
 *  - a queue-side `cross-group-conflict` renders as never-dispatched while a
 *    plan-time one keeps its step (provenance, not name);
 *  - a halt does not strand a still-waiting group with no reason and no action;
 *  - while the queue runs, a same-process sibling's plan-time claim does not
 *    park its own sibling at plan — `setSiblingClaimWait`'s whole job.
 *
 * No Pi spawn, no network, no `gh`: only the two outermost calls of the entry
 * path are swapped (see `EntrySeams`), so grouping, the ordering plan, the
 * queue, and the `startJob` completion-await the overlap gate depends on all
 * run for real.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearJobsForTesting } from "../src/async-jobs.ts";
import {
  readClaims,
  registerClaim,
  releaseClaim,
  siblingClaimWaitSnapshot,
} from "../src/work-driver-path-claims.ts";
import { queueOrderingPlan } from "../src/work-entry-ordering.ts";
import { type EntrySeams, type WorkInvocation, runGroupedIssues } from "../src/work-entry.ts";
import { renderQueueSummary } from "../src/work-queue.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- harness

interface RunRecord {
  issue: number;
  at: number;
  parallelCycles: number | undefined;
  issuesArg: number[] | undefined;
}

/**
 * A temp repo whose ISSUE BODIES ARE THE INPUT, plus the state files the queue
 * reads back.
 *
 * `runGroupedIssues` normally fetches bodies through the forge adapter (`gh`);
 * here they are written under `.pi/` and surfaced through the seam. The state
 * file is written by the stub driver on the group's way out, because the state
 * file is the queue's ONLY evidence of what a group became — a group with no
 * file reports `cycle produced no state file`, which would make every `merged`
 * assertion below a lie about the happy path.
 */
function harness(opts: {
  bodies: Record<number, string>;
  holdMs?: number;
  /** Per-issue terminal status; default `merged`. */
  status?: Record<number, "merged" | "handoff">;
  /** An issue whose driver throws — the halt route. */
  throwOn?: number;
}) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "pi-1101-entry-"));
  mkdirSync(path.join(repoRoot, ".pi", "work-state"), { recursive: true });
  for (const [n, body] of Object.entries(opts.bodies)) {
    writeFileSync(path.join(repoRoot, `.pi/issue-${n}.md`), body, "utf8");
  }
  const started: RunRecord[] = [];
  const claimReads: number[] = [];
  /** The sibling set observed from INSIDE a running group (see case 5). */
  const setsDuringQueue: number[][] = [];

  const seams: EntrySeams = {
    // Every group of this invocation, in one map: the real path reads the whole
    // invocation's bodies in a single `fetchIssueBodies` call, and a per-issue
    // read that returned only the requested issue would leave `groupIssues()`
    // blind to the issue it did not ask for — which silently empties
    // `depsByIssue` and reproduces the very bug this file exists to catch.
    fetchBodies: async (_repo, requested) => {
      const out: Record<number, string> = {};
      for (const n of Object.keys(opts.bodies).map(Number)) {
        try {
          out[n] = readFileSync(path.join(repoRoot, `.pi/issue-${n}.md`), "utf8");
        } catch {
          out[n] = "";
        }
      }
      void requested;
      return out;
    },
    runDriver: async (primary, ctx) => {
      // Read the registry from INSIDE a running group: the sibling set has to be
      // active for the whole life of the queue, not merely installed at start-up.
      claimReads.push((await readClaims(repoRoot)).length);
      setsDuringQueue.push(siblingClaimWaitSnapshot());
      if (opts.throwOn === primary) throw new Error(`stub driver threw for #${primary}`);
      started.push({
        issue: primary,
        at: Date.now(),
        parallelCycles: ctx.parallelCycles,
        issuesArg: ctx.issues,
      });
      await new Promise((r) => setTimeout(r, opts.holdMs ?? 30));
      const status = opts.status?.[primary] ?? "merged";
      const state = {
        schemaVersion: 1,
        issue: primary,
        pipelineState: {
          status,
          currentStep: status === "merged" ? "merged" : "plan",
          lastCompletedStep: status === "merged" ? "ci" : "branch",
        },
        eventLog:
          status === "merged"
            ? []
            : [{ kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 1, nextStep: "handoff" }],
      };
      writeFileSync(
        path.join(repoRoot, ".pi", "work-state", `${primary}.json`),
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
    },
  };
  return { repoRoot, started, claimReads, setsDuringQueue, seams };
}

const host = {
  sendUserMessage: (_text: string, _options: { deliverAs: "steer" }) => undefined,
  emit: () => undefined,
};
const flags: Omit<WorkInvocation, "issues"> = {
  restart: false,
  mergeGrant: false,
  protectedGrant: [],
  headless: false,
};
const notify = (_t: string) => undefined;

async function drive(
  repoRoot: string,
  issues: number[],
  seams: EntrySeams,
): Promise<string> {
  return runGroupedIssues(host, repoRoot, issues, { ...flags } as WorkInvocation, notify, seams);
}

/** The renderer's own classification, reached through the reason string. */
function neverDispatched(reason: string): boolean {
  return /never dispatched/.test(
    renderQueueSummary({
      entries: [{ groupId: "group-b", issues: [2], outcome: "parked", reason, failedStep: "plan" }],
      merged: 0,
      parked: 1,
      refused: 0,
      notStarted: [],
    }),
  );
}

// ------------------------------------------------------------------ env

const envBackup = {
  ordering: process.env.PI_ENSEMBLE_QUEUE_ORDERING,
  parallel: process.env.PI_ENSEMBLE_PARALLEL_GROUPS,
  work: process.env.PI_ENSEMBLE_PARALLEL_WORK,
};
function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

try {
  // Concurrency must be ≥2 or none of this means anything: at K=1 the queue is
  // sequential whatever the gate decides, and every ordering case below would
  // pass with the gate deleted.
  setEnv("PI_ENSEMBLE_PARALLEL_GROUPS", "3");
  setEnv("PI_ENSEMBLE_PARALLEL_WORK", undefined);
  setEnv("PI_ENSEMBLE_QUEUE_ORDERING", undefined);

  // ==================== 1. THE wiring test: B starts only after A settles ===
  {
    // "Split: separate" is load-bearing. `Depends-on: #N` is ALSO an R1 link
    // marker, so R1 unions the pair into ONE group and the queue sees one
    // workstream — a correct outcome (they ship together) that makes the
    // ordering edge moot. R3 pulls them apart the way a real invocation pulls
    // apart two issues that must not share a PR, and only then is there a queue
    // ordering question at all. `orderingDependencies` deliberately reads the
    // raw body rather than R1's union decisions, which is what keeps the edge
    // alive across the split.
    const h = harness({
      bodies: {
        100: "title: Build the API\n\nNothing depends on this one.\nSplit: separate",
        101: "title: Build the client\n\nDepends-on: #100\n\nPointless before the API exists.\nSplit: separate",
      },
      holdMs: 60,
    });
    const rendered = await drive(h.repoRoot, [100, 101], h.seams);
    assert(h.started.length === 2, "both groups ran — the ordering wait consumed neither");
    assert(
      h.started.map((s) => s.issue).join(",") === "100,101",
      "B (#101) started only after A (#100) — the wiring the queue was missing",
    );
    const gap = (h.started[1]?.at ?? 0) - (h.started[0]?.at ?? 0);
    assert(
      gap >= 55,
      `B started after A's 60ms hold closed, not inside it (observed gap ${gap}ms)`,
    );
    assert(/2 merged/.test(rendered), "the report agrees with the state files: both merged");
    assert(
      h.started.every((s) => s.parallelCycles !== undefined && s.parallelCycles >= 1),
      `the entry point still threads parallelCycles through to the driver (got ${h.started.map((s) => s.parallelCycles).join(", ")})`,
    );
    rmSync(h.repoRoot, { recursive: true, force: true });
  }

  // ===== 2. The order holds when B is invoked FIRST (edges are not positional)
  {
    const h = harness({
      bodies: {
        101: "title: Build the client\n\nDepends-on: #100\nSplit: separate",
        100: "title: Build the API\nSplit: separate",
      },
      holdMs: 60,
    });
    await drive(h.repoRoot, [101, 100], h.seams);
    assert(
      h.started.map((s) => s.issue).join(",") === "100,101",
      "the dependency runs first even when the dependent was invoked first (cursor order is not dependency order)",
    );
    rmSync(h.repoRoot, { recursive: true, force: true });
  }

  // ============ 3. A parked dependency parks its dependent, without dispatch
  {
    // THE mutation canary. With the wiring present the dependent never enters
    // `runDriver` at all — the ordering gate stops it at the scheduler. With
    // the wiring deleted the queue dispatches it immediately and this assertion
    // is the one that goes red. Case 1's timing check is a corollary (it caught
    // the removal only as a 0ms gap); this one is a call-count assertion, so it
    // does not depend on the scheduler's wake cadence landing inside the hold
    // window. An ordering wait that never even delays the dependent it blocks is
    // the same fact: `at` differences alone are not evidence the gate ran.
    const h = harness({
      bodies: {
        100: "title: Build the API\nSplit: separate",
        101: "title: Build the client\n\nDepends-on: #100\nSplit: separate",
      },
      holdMs: 20,
      status: { 100: "handoff" },
    });
    const rendered = await drive(h.repoRoot, [100, 101], h.seams);
    assert(
      !h.started.some((s) => s.issue === 101),
      "the dependent never dispatched — a dependency that did not merge cannot release it",
    );
    assert(
      /dependency-parked:#100/.test(rendered),
      "the dependent parks, naming the dependency that failed to merge",
    );
    assert(
      /never dispatched/.test(rendered),
      "the report says the group produced nothing, rather than offering a park to salvage",
    );
    rmSync(h.repoRoot, { recursive: true, force: true });
  }

  // ====== 4. The escape hatch removes the edges AND the cycle park, together
  {
    // A CYCLE is the case R1 cannot absorb: `Depends-on: #N` unions A with B
    // and B with A, but a group-size split (MAX_ISSUES_PER_GROUP) and R3 both
    // exist to pull an over-linked set apart, and once the two sit in different
    // groups the loop is a queue-level question with no valid answer. R3 forces
    // exactly that, so the cycle survives the grouping pass and reaches the
    // pre-flight — which is the only place a loop can be caught.
    const bodies = {
      100: "title: A\n\nDepends-on: #101\nSplit: separate",
      101: "title: B\n\nDepends-on: #100\nSplit: separate",
    };
    // Ordering ON: the cycle is found and both groups park before any dispatch.
    // A call-count assertion again, for the reason in case 3: with the wiring
    // gone both groups run inside their own 10ms holds and a timing check would
    // still read as "in order". This one cannot.
    const on = harness({ bodies, holdMs: 10 });
    const onText = await drive(on.repoRoot, [100, 101], on.seams);
    assert(
      /dependency-cycle/.test(onText),
      "with ordering on, a declared cycle parks every member before dispatch",
    );
    assert(on.started.length === 0, "and no cycle member ran");

    // Ordering OFF, same bodies and same repo: a cycle IS an ordering claim, so
    // the switch removes it rather than honouring it half-way.
    setEnv("PI_ENSEMBLE_QUEUE_ORDERING", "0");
    const off = harness({ bodies, holdMs: 10 });
    const offText = await drive(off.repoRoot, [100, 101], off.seams);
    assert(
      !/dependency-cycle|dependency-parked|dependency-timeout/.test(offText),
      "PI_ENSEMBLE_QUEUE_ORDERING=0 parks nothing for an ordering claim",
    );
    assert(off.started.length === 2, "and both groups run, which is what the hatch is for");
    setEnv("PI_ENSEMBLE_QUEUE_ORDERING", envBackup.ordering);
    rmSync(on.repoRoot, { recursive: true, force: true });
    rmSync(off.repoRoot, { recursive: true, force: true });
  }

  // ===== 5. The sibling claim wait is live for the queue, and cleared after
  {
    const h = harness({
      bodies: {
        100: "title: A\nSplit: separate",
        101: "title: B\n\nDepends-on: #100\nSplit: separate",
      },
      holdMs: 30,
    });
    // A plan-declared claim held by a group of THIS queue. Before the wiring,
    // `readClaims` saw it as foreign and the dependent parked at plan with
    // `cross-group-conflict` — after explore + plan had already been paid for.
    await registerClaim(h.repoRoot, 100, ["src/api.ts"]);
    // The negative control, taken BEFORE the queue: with no sibling set in
    // force the same claim is foreign, and a filter that simply answered
    // "sibling" for everything would pass the assertions below for the wrong
    // reason.
    assert(
      (await readClaims(h.repoRoot)).length === 1,
      "outside a queue a same-process claim is foreign — the filter is not always-on",
    );
    const rendered = await drive(h.repoRoot, [100, 101], h.seams);
    assert(
      !/cross-group-conflict/.test(rendered),
      "a sibling's plan-declared claim did not park its own sibling at plan",
    );
    assert(
      h.claimReads.length === 2 && h.claimReads.every((n) => n === 0),
      "while the queue ran, every same-process sibling claim was filtered out",
    );
    assert(
      h.setsDuringQueue.every((s) => s.join(",") === "100,101"),
      "and the set in force was the whole invocation, read from inside a running group",
    );
    assert((await readClaims(h.repoRoot)).length === 1, "after the queue, the claim is visible again");
    assert(
      siblingClaimWaitSnapshot().length === 0,
      "the `finally` cleared the set, so a later cycle is not left blind to its own siblings",
    );
    await releaseClaim(h.repoRoot, 100);
    rmSync(h.repoRoot, { recursive: true, force: true });
  }

  // ========== 6. A queue-side cross-group-conflict is not a plan-time one
  {
    // The two routes write different strings, and the renderer classifies on
    // that difference — not on the shared cap name, which would strip the step
    // off a cycle that really did reach plan.
    const queueSide =
      "cap cross-group-conflict: in-flight sibling(s) group-a held the overlapping claim";
    assert(neverDispatched(queueSide), "the queue's cross-group-conflict is never-dispatched");
    assert(
      !neverDispatched("cap cross-group-conflict"),
      "a bare cross-group-conflict keeps the running-cycle shape (step and all)",
    );
  }

  // ============ 7. A halt does not strand the group that was still waiting
  {
    const h = harness({
      bodies: {
        100: "title: A\nSplit: separate",
        101: "title: B\n\nDepends-on: #100\nSplit: separate",
      },
      holdMs: 10,
      throwOn: 100,
    });
    const rendered = await drive(h.repoRoot, [100, 101], h.seams);
    assert(/halted/.test(rendered), "a driver throw still halts the queue (unchanged)");
    assert(
      /#101/.test(rendered),
      "the dependent the queue was holding is named in the report, not silently dropped",
    );
    assert(
      /queue-stranded|Not started/.test(rendered),
      "and it carries a park reason naming why it never started",
    );
    rmSync(h.repoRoot, { recursive: true, force: true });
  }

  // ========== 8. queueOrderingPlan: the graph the entry point hands over
  {
    // The pure half, asserted on the object the queue receives — so a change to
    // how the plan is built is caught even where the order still happens to work.
    const groups = {
      "group-a": { id: "group-a", scope: "issue #100", paths: [], outOfScope: [], issues: [100] },
      "group-b": { id: "group-b", scope: "issue #101", paths: [], outOfScope: [], issues: [101] },
    };
    const plan = queueOrderingPlan({ groups, depsByIssue: { 101: [100] } });
    assert(
      plan.byGroup["group-b"]?.blockingGroupIds.join(",") === "group-a",
      "the declared statement becomes a cross-group edge keyed by the dependent",
    );
    assert(plan.cyclic.length === 0, "a one-way edge is not a cycle");
    setEnv("PI_ENSEMBLE_QUEUE_ORDERING", "0");
    const offPlan = queueOrderingPlan({ groups, depsByIssue: { 101: [100] } });
    assert(
      Object.keys(offPlan.byGroup).length === 0 && offPlan.cyclic.length === 0,
      "the escape hatch returns an empty plan, not a graph the queue then ignores",
    );
    setEnv("PI_ENSEMBLE_QUEUE_ORDERING", envBackup.ordering);
  }
} finally {
  setEnv("PI_ENSEMBLE_QUEUE_ORDERING", envBackup.ordering);
  setEnv("PI_ENSEMBLE_PARALLEL_GROUPS", envBackup.parallel);
  setEnv("PI_ENSEMBLE_PARALLEL_WORK", envBackup.work);
  clearJobsForTesting();
}

console.log(exit === 0 ? "\nALL PASS" : `\nFAILURES: ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #1295 — the headless client's "is a report still coming to the PM" contract.
 *
 * Part 1: the `pi-rukas-jobs` status (pending-jobs-signal.ts). In RPC mode
 * every change in the number of PM-owned reports still owed is sent through
 * `ctx.ui.setStatus("pi-rukas-jobs", "<n>")`, including the drop to "0";
 * driver-owned jobs never count, a batch counts once, a kill and
 * session_shutdown both bring it down, and "0" is never sent before the
 * report it waited for has been handed to Pi.
 *
 * Part 2: the older contract clients already read from the stream — the
 * dispatch tools' `details.async === true` with a `jobId`/`batchId`, and the
 * `[ensemble:async] … (job <id>)` / `(batch <id>)` report header. Pinned so
 * a change to either fails here before it breaks a client.
 *
 * #1389 — the two ways that last clause was false, pinned in code: a host
 * whose `sendUserMessage` throws (the swallow in `deliverReport` published
 * "0" for a report nobody received — now it warns, and the batch answers with
 * a stand-in), and `session_shutdown` publishing "0" while the jobs it had
 * just aborted were still settling. The failed-send delivery cases, both
 * `session_shutdown` bound cases and the half-started-batch teardown live in
 * test-pending-jobs-signal-honest-zero.ts, which is where they went when this
 * file reached the 500-line cap (test-file-size-limit.ts).
 *
 * The session_shutdown case below that stays here is the one that predates
 * #1389 and whose assertion had to change: it slept 30 ms and read "nothing is
 * sent after shutdown", which locked in the lost report rather than catching
 * it. See the honest-zero file for the two cases that pin the bound itself.
 *
 * No Pi process spawned, no network.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliverOrStandIn, deliverStandIn } from "../src/async-jobs-lifecycle.ts";
import {
  clearJobsForTesting,
  killJob,
  registerAsyncJobsLifecycle,
  startBatch,
  startJob,
} from "../src/async-jobs.ts";
import * as pendingJobs from "../src/pending-jobs-signal.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One ordered log of everything the client would see: reports and statuses. */
const wire: string[] = [];
const statuses = () => wire.filter((w) => w.startsWith("status:")).map((w) => w.slice(7));
const reports = () => wire.filter((w) => w.startsWith("report:")).map((w) => w.slice(7));

let shutdownHandler: ((event?: { reason?: string }) => void) | undefined;
const pi = {
  sendUserMessage(content: string) {
    wire.push(`report:${content}`);
  },
  on(event: string, handler: (event?: { reason?: string }) => void) {
    if (event === "session_shutdown") shutdownHandler = handler;
  },
} as unknown as ExtensionAPI;
registerAsyncJobsLifecycle(pi);

function rpcCtx(mode: "rpc" | "tui" = "rpc") {
  return {
    mode,
    ui: {
      setStatus(key: string, text: string | undefined) {
        if (key === pendingJobs.PENDING_JOBS_STATUS_KEY) wire.push(`status:${text}`);
      },
    },
  } as const;
}

function fakeResult(role: string, text: string, extra: Partial<DispatchResult> = {}) {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    ...extra,
  } as DispatchResult;
}

/** A job that finishes when told to, and reports a kill when aborted. */
function controlled(role: string) {
  let finish: () => void = () => undefined;
  const work = (signal: AbortSignal) =>
    new Promise<DispatchResult>((resolve) => {
      finish = () => resolve(fakeResult(role, `${role} done`));
      signal.addEventListener("abort", () =>
        resolve(fakeResult(role, "", { ok: false, killCause: "abort" })),
      );
    });
  return { work, finish: () => finish() };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

pendingJobs.attach(rpcCtx());
assert(
  statuses().join(",") === "0",
  `attach in RPC mode publishes an initial 0 (got ${statuses()})`,
);
wire.length = 0;

// --- Two PM jobs: '1', '2'; one settles → '1'; the other is killed → '0' ---
{
  const a = controlled("explore");
  const b = controlled("explore");
  const ja = startJob(pi, { label: "explore", role: "explore", work: a.work });
  const jb = startJob(pi, { label: "explore", role: "explore", work: b.work });
  assert(statuses().join(",") === "1,2", `two PM jobs start → 1,2 (got ${statuses()})`);

  a.finish();
  await until(() => statuses().length === 3);
  assert(statuses()[2] === "1", `one settles → 1 (got ${statuses()})`);
  const r = reports();
  assert(
    r.length === 1 && r[0].startsWith("[ensemble:async]") && r[0].includes(`(job ${ja.jobId})`),
    "a finished job's report starts [ensemble:async] and names (job <id>)",
  );
  assert(
    wire.indexOf(`report:${r[0]}`) < wire.lastIndexOf("status:1"),
    "the count drops only after the report was handed to Pi",
  );

  killJob(jb.jobId);
  await until(() => statuses().length === 4);
  assert(statuses()[3] === "0", `the other is killed → 0 (got ${statuses()})`);
  const killed = reports()[1] ?? "";
  assert(
    killed.startsWith("[ensemble:async]") && killed.includes(`(job ${jb.jobId})`),
    "a killed job's report starts [ensemble:async] and names (job <id>)",
  );
}

// --- A rejected PM job still reports, and still brings the count down ---
{
  wire.length = 0;
  const j = startJob(pi, {
    label: "explore",
    role: "explore",
    work: async () => {
      throw new Error("spawn failed");
    },
  });
  await until(() => statuses().length === 2);
  assert(statuses().join(",") === "1,0", `a rejected job → 1,0 (got ${statuses()})`);
  const r = reports()[0] ?? "";
  assert(
    r.startsWith("[ensemble:async]") && r.includes(`(job ${j.jobId})`),
    "a failed job's report starts [ensemble:async] and names (job <id>)",
  );
}

// --- A single-job settle that throws before its report is built still owes one report ---
{
  wire.length = 0;
  const bad = fakeResult("explore", "x");
  // totalTokens reads usage inside emitCompleted, before the report is built.
  Object.defineProperty(bad, "usage", {
    get() {
      throw new Error("usage unreadable");
    },
  });
  const j = startJob(pi, { label: "explore", role: "explore", work: async () => bad });
  await until(() => statuses().length === 2);
  assert(statuses().join(",") === "1,0", `a throwing settle still drops to 0 (got ${statuses()})`);
  const r = reports();
  assert(
    r.length === 1 &&
      r[0].startsWith("[ensemble:async]") &&
      r[0].includes("FAILED") &&
      r[0].includes(`(job ${j.jobId})`),
    `a throwing settle delivers exactly one FAILED stand-in naming the job (got ${r.length})`,
  );
}

// --- The stand-in helpers never throw, even when the stand-in itself fails ---
{
  wire.length = 0;
  const boom = (): string => {
    throw new Error("stand-in boom");
  };
  let threw = false;
  try {
    deliverStandIn(pi, "probe", new Error("original"), boom);
    deliverOrStandIn(
      pi,
      "probe",
      () => {
        throw new Error("build boom");
      },
      boom,
    );
  } catch {
    threw = true;
  }
  assert(!threw, "deliverStandIn / deliverOrStandIn never throw");
  assert(reports().length === 0, "a failing stand-in sends nothing (and does not throw)");
}

// --- A developer report waits for its git-state line; "0" waits for the report ---
{
  wire.length = 0;
  const dev = startJob(pi, {
    label: "developer",
    role: "developer",
    gitLineFor: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "git: clean";
    },
    work: async () => fakeResult("developer", "implemented"),
  });
  await until(() => statuses().length === 2);
  assert(
    wire.length === 3 && wire[1].includes(`(job ${dev.jobId})`) && wire[2] === "status:0",
    `developer: 1, report, then 0 (got ${wire.map((w) => w.slice(0, 20))})`,
  );
}

// --- Driver-owned jobs change nothing ---
{
  wire.length = 0;
  const d = controlled("developer");
  const h = startJob(pi, {
    label: "developer",
    role: "developer",
    ownerKind: "driver",
    work: d.work,
  });
  d.finish();
  await h.completion;
  await new Promise((r) => setTimeout(r, 20));
  assert(wire.length === 0, `a driver-owned job sends no status and no report (got ${wire})`);
}

// --- A batch counts once, not per member ---
{
  wire.length = 0;
  const m1 = controlled("explore");
  const m2 = controlled("explore");
  const { batchId } = startBatch(pi, {
    batchLabel: "dispatch_parallel",
    members: [
      { label: "explore[a]", role: "explore", work: m1.work },
      { label: "explore[b]", role: "explore", work: m2.work },
    ],
  });
  assert(statuses().join(",") === "1", `a 2-member batch starts → 1 (got ${statuses()})`);
  m1.finish();
  await new Promise((r) => setTimeout(r, 20));
  assert(statuses().join(",") === "1", "one member settling changes nothing");
  m2.finish();
  await until(() => statuses().length === 2);
  assert(statuses().join(",") === "1,0", `the batch reports → 0 (got ${statuses()})`);
  const r = reports();
  assert(
    r.length === 1 && r[0].startsWith("[ensemble:async]") && r[0].includes(`(batch ${batchId})`),
    "the batch's one report starts [ensemble:async] and names (batch <id>)",
  );
  assert(
    wire.indexOf(`report:${r[0]}`) < wire.lastIndexOf("status:0"),
    "the batch's 0 comes after its report",
  );
}

// --- Setup that throws after the job is registered never leaves it owed ---
{
  wire.length = 0;
  const bad = controlled("explore");
  let threw = false;
  try {
    startJob(pi, {
      label: "explore",
      role: "explore",
      work: bad.work,
      get deckLabel(): string {
        throw new Error("setup boom");
      },
    });
  } catch {
    threw = true;
  }
  assert(threw, "a setup throw surfaces to the caller");
  assert(statuses().length === 0, `a setup throw sends no status (got ${statuses()})`);
}

// --- A batch whose member setup throws never becomes owed; an empty batch is refused ---
{
  wire.length = 0;
  let threw = false;
  try {
    startBatch(pi, {
      batchLabel: "dispatch_parallel",
      members: [
        {
          get label(): string {
            throw new Error("member setup boom");
          },
          role: "explore",
          work: controlled("explore").work,
        },
      ],
    });
  } catch {
    threw = true;
  }
  assert(threw, "a batch member setup throw surfaces to the caller");
  assert(statuses().length === 0, `a batch member setup throw sends no status (got ${statuses()})`);
  let emptyRefused = false;
  try {
    startBatch(pi, { batchLabel: "dispatch_parallel", members: [] });
  } catch {
    emptyRefused = true;
  }
  assert(emptyRefused, "an empty batch is refused");
  assert(statuses().length === 0, `an empty batch sends no status (got ${statuses()})`);
}

// --- A batch whose settle body throws still hands Pi a report before the count drops ---
{
  // session_shutdown above detached the context; re-attach so the status channel is live.
  pendingJobs.attach(rpcCtx());
  wire.length = 0;
  const bad = controlled("explore");
  const { batchId } = startBatch(pi, {
    batchLabel: "dispatch_parallel",
    members: [
      {
        label: "explore[a]",
        role: "explore",
        work: async (signal, hooks) => {
          const r = await bad.work(signal, hooks);
          // totalTokens reads usage inside the settle body, after the members have settled.
          return Object.defineProperty(r, "usage", {
            get() {
              throw new Error("usage boom");
            },
          });
        },
      },
    ],
  });
  bad.finish();
  await until(() => statuses().length === 2);
  const r = reports();
  assert(
    r.length === 1 && r[0].startsWith("[ensemble:async]") && r[0].includes(`(batch ${batchId})`),
    "a settle-body throw still hands Pi one [ensemble:async] report naming (batch <id>)",
  );
  assert(
    r[0].includes("FAILED") && r[0].includes("usage boom"),
    "the stand-in report says the batch failed and why",
  );
  assert(
    statuses().join(",") === "1,0",
    `the count drops to 0 only after that report (got ${statuses()})`,
  );
  assert(
    wire.indexOf(`report:${r[0]}`) < wire.lastIndexOf("status:0"),
    "the stand-in report precedes the 0",
  );
}

// --- TUI mode: no status at all ---
{
  wire.length = 0;
  pendingJobs.attach(rpcCtx("tui"));
  const t = controlled("explore");
  startJob(pi, { label: "explore", role: "explore", work: t.work });
  t.finish();
  await until(() => reports().length === 1);
  await new Promise((r) => setTimeout(r, 20));
  assert(statuses().length === 0, `TUI mode sends no pi-rukas-jobs status (got ${statuses()})`);
}

// --- Part 2: every tool that starts a report-delivering job says so ---
// The tools are pinned by source: executing them would spawn real children.
// A NEW tool that calls startJob/startBatch fails here until it is added
// below — and it must return `details.async: true` with its id.
{
  const srcDir = join(import.meta.dir, "..", "src");
  const expected: Record<string, number> = {
    "dispatch.ts": 2,
    "lens-review-tool.ts": 1,
    "adversarial-tool.ts": 1,
    "work-tool.ts": 1,
    // #1044 — the two compiled plan/research drivers joined the async set: a
    // dry-run spec or a research artifact is 5–45 minutes of work, and holding
    // the PM's turn for it locked the operator out of the session.
    "plan-tool.ts": 1,
    "research-tool.ts": 1,
  };
  const found: string[] = [];
  for (const f of readdirSync(srcDir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(srcDir, f), "utf8");
    if (!src.includes("registerTool") || !/start(Job|Batch)\(pi,/.test(src)) continue;
    found.push(f);
    const asyncDetails = [...src.matchAll(/details:\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .filter((body) => /\basync: true\b/.test(body) && /\b(jobId|batchId)\b/.test(body));
    assert(
      asyncDetails.length === expected[f],
      `${f}: ${expected[f] ?? "?"} result(s) carry details.async + jobId/batchId (got ${asyncDetails.length})`,
    );
  }
  assert(
    found.sort().join(",") === Object.keys(expected).sort().join(","),
    `the tools that start jobs are exactly the pinned set (got ${found})`,
  );
}

clearJobsForTesting();
clearSlowWatchesForTesting();
pendingJobs.resetForTesting();
process.exit(exit);

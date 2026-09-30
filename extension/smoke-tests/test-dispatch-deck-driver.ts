#!/usr/bin/env bun
/**
 * #838 — driver dispatches in the dispatch deck.
 *
 * Covers the deck option on `dispatchCore`/`startJob` (one deck entry
 * keyed by the jobId, the per-cycle batchKey, label `#<issue> <step> ·
 * <tag>`; zero PM steer-backs for driver jobs), the driver's per-cycle
 * header lifecycle (created on cycle start, cleared on every terminal
 * path — merged, handoff, thrown error — via the try/finally), quiet-mode
 * atomic suppression (header + members, matching PM jobs), the steer path
 * (steerChild/steerFromDeck to a driver-shaped job, source `deck-ui`),
 * the counter-less header rendering (size-0 batch row), the second-cycle
 * ownership token (no clobber), and the agent-list projection (a driver
 * row in buildAgentListLines). All dispatch is faked (startJob-level for
 * the deck option — the spawn layer cannot be faked, FORBID_LIVE_SPAWN
 * blocks it; the driver's dispatchFn injection for the cycle tests), no
 * real Pi spawn.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAgentListLines } from "../src/agent-list.ts";
import { childHandles } from "../src/async-jobs-registry.ts";
import { clearJobsForTesting, jobStatusSnapshot, startJob } from "../src/async-jobs.ts";
import { steerFromDeck } from "../src/dispatch-deck-interactive.ts";
import { formatBatchRow } from "../src/dispatch-deck-rows.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import { steerChild } from "../src/dispatch-steer.ts";
import { dispatchCore } from "../src/dispatch.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  acquireWorkDeckHeader,
  driverDeckOpts,
  headerToken,
  workDeckKey,
} from "../src/work-driver-deck-header.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState } from "../src/workflow-state.ts";
import {
  EXPLORE_REPLY,
  branchExecStub,
  mkCycleCtx,
  mkDispatchResult,
} from "./helpers-dispatch-deck-driver.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Offline-suite safety net (skeleton-test precedent): cap any accidental
// live spawn so the suite stays deterministic.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
// PR17 — the verify gate is off globally; the cycle tests mock branch via
// a fake exec.
process.env.PI_ENSEMBLE_VERIFY = "0";
// #297 — zero the transient retry backoff (failure tests below).
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
// #378 — the intent gate is OFF for these cycle tests: the faked explore
// reply carries the legacy single-token verdict + ## Spec block; the intent
// gate (default on) reads a richer shape and parks otherwise. Intent tests
// cover that path separately.
process.env.PI_ENSEMBLE_INTENT = "0";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makePiStub() {
  const inbox: { content: string; deliverAs?: string }[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: testing seam — the minimum shape startJob needs.
  const pi: any = {
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      inbox.push({ content, deliverAs: options?.deliverAs });
    },
  };
  return { pi, inbox };
}

function fakeResult(role: string, text = "done", ok = true): DispatchResult {
  return {
    role,
    ok,
    text,
    toolUses: [],
    ms: 10,
    exitCode: ok ? 0 : 1,
    transcriptPath: `/tmp/fake-${role}.json`,
  };
}

// 1. dispatchCore with the deck option: the entry is registered under the
//    cycle key (the spawn guard fires before a live spawn; settle clears
//    it); WITHOUT the option the deck is untouched (skipDeck unchanged).
{
  dispatchDeck.reset();
  clearJobsForTesting();
  const { pi, inbox } = makePiStub();
  let rejection: unknown;
  dispatchCore(pi, { role: "developer", prompt: "work", cwd: "/tmp" } as never, {
    deck: { cycleKey: "work:42", label: "#42 develop · default" },
    timeoutMs: 100,
  }).then(
    () => undefined,
    (err: unknown) => {
      rejection = err;
    },
  );
  await sleep(50);
  assert(
    rejection instanceof Error && rejection.message.includes("FORBID_LIVE_SPAWN"),
    "deck option: the spawn guard fired as expected (no live spawn)",
  );
  assert(
    dispatchDeck.snapshot().length === 0,
    "deck option: deck empty after the guard rejection settles (settle path clears)",
  );
  assert(inbox.length === 0, "deck option: NO PM steer-back emitted (ownerKind driver)");
  // WITHOUT the deck option (skipDeck true): deck untouched.
  clearJobsForTesting();
  const p2 = dispatchCore(pi, { role: "explore", prompt: "work", cwd: "/tmp" } as never, {
    skipDeck: true,
    timeoutMs: 100,
  });
  p2.catch(() => undefined);
  await sleep(10);
  assert(dispatchDeck.snapshot().length === 0, "no deck option: deck untouched (skipDeck path)");
  dispatchDeck.reset();
  clearJobsForTesting();
}

// 2. A driver job WITH a deck entry emits ZERO PM steers end-to-end (the
//    ownerKind=="pm" steer-back gate is untouched by the deck option).
{
  dispatchDeck.reset();
  clearJobsForTesting();
  const { pi, inbox } = makePiStub();
  // Resolve path (startJob direct — the spawn layer cannot be faked; also
  // proves the entry shape: keyed by jobId, batchKey the cycle key).
  const r1 = startJob(pi, {
    label: "#7 develop · default",
    role: "developer",
    ownerKind: "driver",
    batchKey: "work:7",
    work: async () => {
      await sleep(20);
      return fakeResult("developer", "finished the work");
    },
  });
  await sleep(5);
  const snap = dispatchDeck.snapshot();
  assert(snap.length === 1, "driver job: exactly ONE deck entry created");
  assert((snap[0]?.key ?? "").length > 5, "driver job: entry keyed by the startJob jobId");
  assert(snap[0]?.batchKey === "work:7", "driver job: batchKey is the cycle key");
  assert(snap[0]?.label === "#7 develop · default", "driver job: label is #<issue> <step> · <tag>");
  await r1.completion;
  assert(inbox.length === 0, "driver job (deck entry): ZERO PM steers after a successful settle");
  // Reject path: a driver job that throws — the rejection must NOT steer.
  const r2 = startJob(pi, {
    label: "#7 develop · default",
    role: "developer",
    ownerKind: "driver",
    batchKey: "work:7",
    work: async () => {
      throw new Error("spawn-level failure");
    },
  });
  await r2.completion.catch(() => undefined);
  assert(inbox.length === 0, "driver job (deck entry): ZERO PM steers after a failed settle");
  dispatchDeck.reset();
  clearJobsForTesting();
}

// 2b. #838 lens fix — the JOB label and the DECK row label are decoupled.
//    A develop dispatch with the deck option: the job label (what the
//    driver's completion/failure events and the cap checkpoint's
//    `developer[<id>]` parse see) is the caller's label; the deck entry's
//    display label is the row label from driverDeckOpts.
{
  dispatchDeck.reset();
  clearJobsForTesting();
  const { pi } = makePiStub();
  dispatchCore(pi, { role: "developer", prompt: "work", cwd: "/tmp" } as never, {
    label: "developer[task-a]",
    deck: {
      cycleKey: "work:838",
      label: "#838 develop · task-a",
      deckLabel: "#838 develop · task-a",
    },
    timeoutMs: 100,
  }).catch(() => undefined);
  await sleep(50);
  // The deck entry (display) carried the row label under the cycle key.
  const deckSnap = dispatchDeck.snapshot();
  assert(
    deckSnap.length === 0,
    "job/deck label split: deck cleared after the guard rejection settles",
  );
  // The JOB label (events + registry): captured via jobStatusSnapshot while
  // in flight; the completion event's label is the SAME string — assert the
  // registry row, which startJob stamped verbatim, alongside the deck
  // entry's display label read mid-flight.
  clearJobsForTesting();
  let jobRowLabel = "(unset)";
  let deckRowLabel = "(unset)";
  let deckRowKey = "(unset)";
  const r3 = startJob(pi, {
    label: "developer[task-a]",
    deckLabel: "#838 develop · task-a",
    batchKey: "work:838",
    role: "developer",
    ownerKind: "driver",
    work: async () => {
      await sleep(30);
      // In-flight: the registry row is the JOB label; the deck entry is the
      // DECK label.
      const snapNow = jobStatusSnapshot();
      const jobRow = snapNow.find((j) => j.label === "developer[task-a]");
      const deckRow = dispatchDeck.snapshot();
      jobRowLabel = jobRow?.label ?? "(none)";
      deckRowLabel = deckRow[0]?.label ?? "(none)";
      deckRowKey = deckRow[0]?.batchKey ?? "(none)";
      return fakeResult("developer", "finished the work");
    },
  });
  await r3.completion;
  assert(
    jobRowLabel === "developer[task-a]",
    `job/deck label split: the job label is the caller's ("developer[task-a]") — the events + cap-checkpoint parse see this (got: ${jobRowLabel})`,
  );
  assert(
    deckRowLabel === "#838 develop · task-a",
    `job/deck label split: the deck entry shows the row label (got: ${deckRowLabel})`,
  );
  assert(
    deckRowKey === "work:838",
    `job/deck label split: the deck entry keeps the cycle batch key (got: ${deckRowKey})`,
  );
  dispatchDeck.reset();
  clearJobsForTesting();
}

// 3. The per-cycle header via the acquire/release seam: created with the
//    right label, counter-less (size 0), cleared by release (the
//    try/finally path runWorkDriver uses).
{
  dispatchDeck.reset();
  const header = acquireWorkDeckHeader(42, "cycle-A");
  const batches = dispatchDeck.batchSnapshot();
  assert(batches.length === 1, "header: startBatchEntry created the per-cycle row");
  assert(batches[0]?.key === "work:42", "header: key is work:<issue>");
  assert(batches[0]?.label === "/work #42", "header: label is /work #<issue>");
  assert(batches[0]?.size === 0, "header: size 0 (counter-less)");
  // Counter-less rendering: no "done" / "running" fragments.
  // biome-ignore lint/style/noNonNullAssertion: test seam — assert already verified length.
  const row = formatBatchRow(batches[0]!, 1000);
  assert(row.includes("batch[/work #42]"), "header row renders the /work #42 label");
  assert(!row.includes("done"), "counter-less header: no 'done' counter");
  assert(!row.includes("running"), "counter-less header: no 'running' counter");
  // A member row with the batchKey renders (grouped under the header).
  dispatchDeck.startEntry("mem-1", {
    label: "#42 explore · explore",
    role: "explore",
    batchKey: "work:42",
  });
  const lines = dispatchDeck.buildLines(2000);
  assert(
    lines.some((l) => l.includes("batch[/work #42]")),
    "member + header: header row in buildLines",
  );
  // A member with a live batchKey is a batch member: buildLines (the
  // top-level projection) EXCLUDES it — the composite renders members as
  // per-job rows; only batchKey-less or orphaned entries are top-level.
  assert(
    !lines.some((l) => l.includes("#42 explore · explore")),
    "member + header: live batch member is NOT a top-level buildLines row",
  );
  // ...but the composite's member projection (the snapshot) does carry it.
  assert(
    dispatchDeck
      .snapshot()
      .some((e) => e.key === "mem-1" && e.label.includes("#42 explore · explore")),
    "member + header: the member row IS in the deck snapshot",
  );
  header.release();
  assert(dispatchDeck.batchSnapshot().length === 0, "header: release clears the batch row");
  dispatchDeck.clearEntry("mem-1");
  dispatchDeck.reset();

  // 3b. Second cycle on the same issue does NOT clobber the first's
  //     header: a different owner token refuses the create (header stays
  //     singular) and its release is a no-op; the FIRST owner's release
  //     still clears.
  const h1 = acquireWorkDeckHeader(99, "owner-1");
  assert(dispatchDeck.batchSnapshot().length === 1, "ownership: first cycle created the header");
  const h2 = acquireWorkDeckHeader(99, "owner-2");
  assert(
    dispatchDeck.batchSnapshot().length === 1,
    "ownership: second cycle did NOT create a second header",
  );
  h2.release();
  assert(
    dispatchDeck.batchSnapshot().length === 1,
    "ownership: second cycle's release did NOT clear the header",
  );
  h1.release();
  assert(
    dispatchDeck.batchSnapshot().length === 0,
    "ownership: first cycle's release cleared the header",
  );
  dispatchDeck.reset();

  // 3c. The unique-token shape the driver mints per invocation (#838 lens
  //     fix): token A acquires, token B's acquire is a no-op, releasing B
  //     leaves the header in place; releasing A clears it.
  const hA = acquireWorkDeckHeader(101, "tok-A");
  const hB = acquireWorkDeckHeader(101, "tok-B");
  hB.release();
  assert(
    dispatchDeck.batchSnapshot().length === 1,
    "unique token: release of the non-owning token left the header in place",
  );
  hA.release();
  assert(
    dispatchDeck.batchSnapshot().length === 0,
    "unique token: release of the owning token cleared the header",
  );
  // headerToken() itself: per-invocation unique (module counter), and
  // every token carries the pid prefix (cross-process non-collision).
  const t1 = headerToken();
  const t2 = headerToken();
  assert(t1 !== t2, `headerToken: consecutive tokens differ (got ${t1} / ${t2})`);
  assert(
    t1.startsWith(`pid:${process.pid}:`) && t2.startsWith(`pid:${process.pid}:`),
    "headerToken: tokens carry the pid prefix (cross-process uniqueness)",
  );
  dispatchDeck.reset();
}

// 4. Quiet mode: PI_ENSEMBLE_QUIET_STATUS=1 suppresses the header AND the
//    member entries atomically (matching PM jobs — startEntry/startBatch
//    are both quiet-gated; release on an absent header is a no-op, never
//    a throw).
{
  dispatchDeck.reset();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  const header = acquireWorkDeckHeader(55, "quiet-owner");
  assert(dispatchDeck.batchSnapshot().length === 0, "quiet: header suppressed (no batch entry)");
  dispatchDeck.startEntry("q-1", {
    label: "#55 explore · explore",
    role: "explore",
    batchKey: "work:55",
  });
  assert(dispatchDeck.snapshot().length === 0, "quiet: member entry suppressed (no single entry)");
  header.release(); // must be a no-op (header never registered)
  assert(
    dispatchDeck.batchSnapshot().length === 0,
    "quiet: release on an absent header is a no-op",
  );
  process.env.PI_ENSEMBLE_QUIET_STATUS = undefined;
  dispatchDeck.startEntry("q-2", {
    label: "#55 explore · explore",
    role: "explore",
    batchKey: "work:55",
  });
  assert(dispatchDeck.snapshot().length === 1, "unquiet: deck resumes when the env var is unset");
  dispatchDeck.clearEntry("q-2");
  dispatchDeck.reset();
}

// 5. Steer to a driver-shaped job: steerChild/steerFromDeck deliver to the
//    child's stdin with the {type:'steer', message} envelope, tagged
//    source "deck-ui" (the deck-UI steer path's lifecycle tag).
{
  const lines: string[] = [];
  const fakeStdin = {
    write(s: string) {
      lines.push(s);
    },
  };
  childHandles.set("j-driver-838", {
    stdin: fakeStdin as unknown as NodeJS.WritableStream,
    label: "#42 develop · default",
    role: "developer",
  });
  const r = steerChild("j-driver-838", "stop and report status", "deck-ui");
  assert(r.delivered === true, "steerChild: delivered to a driver-shaped job");
  assert(r.label === "#42 develop · default", "steerChild: returns the driver row's label");
  assert(lines.length === 1, "steerChild: exactly one stdin write");
  // biome-ignore lint/style/noNonNullAssertion: test seam — assert already verified length.
  const parsed = JSON.parse(lines[0]!);
  assert(
    parsed.type === "steer" && parsed.message === "stop and report status",
    "steerChild: stdin line is the {type:'steer', message} envelope",
  );
  const ui = { notify: () => {}, editor: undefined, setStatus: () => {}, editorValue: "" };
  const r2 = await steerFromDeck(ui as never, "j-driver-838", "hello from deck");
  assert(r2.delivered === true, "steerFromDeck: delivered to the driver row");
  assert(lines.length === 2, "steerFromDeck: a second stdin write (total 2)");
  // biome-ignore lint/style/noNonNullAssertion: test seam — assert already verified length.
  const parsed2 = JSON.parse(lines[1]!);
  assert(
    parsed2.type === "steer" && parsed2.message === "hello from deck",
    "steerFromDeck: envelope carries the message",
  );
  childHandles.delete("j-driver-838");
}

// 6. A driver row appears in buildAgentListLines (the #914 agent list
//    projects the deck's snapshot; a driver member is a deck entry).
{
  dispatchDeck.reset();
  dispatchDeck.startEntry("j-agent-1", {
    label: "#42 develop · default",
    role: "developer",
    batchKey: "work:42",
  });
  dispatchDeck.startBatchEntry("work:42", { label: "/work #42", size: 0 });
  const entries = dispatchDeck.snapshot();
  const rows = buildAgentListLines(entries, 80, Date.now());
  const jobRow = rows.find((r) => r.key === "j-agent-1");
  assert(jobRow !== undefined, "agent list: driver row is present");
  assert(
    jobRow?.text.includes("#42 develop · default") === true,
    "agent list: row carries the driver label",
  );
  assert(jobRow?.selectable === true, "agent list: driver row is selectable");
  dispatchDeck.clearEntry("j-agent-1");
  dispatchDeck.clearBatchEntry("work:42");
  dispatchDeck.reset();
}

// 7. runWorkDriver end-to-end (faked dispatch + faked exec): the /work
//    header exists DURING the cycle with member dispatches for
//    explore/plan/develop, and is CLEARED at cycle end.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-838-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    dispatchDeck.reset();
    const optsSeen: { label?: string }[] = [];
    let headerSeen = false;
    const ctx = mkCycleCtx(
      dir,
      838,
      async (_pi: unknown, spec: { role: string; prompt: string }, opts?: { label?: string }) => {
        optsSeen.push(opts ?? {});
        if (dispatchDeck.batchSnapshot().some((b) => b.label === "/work #838")) headerSeen = true;
        return mkDispatchResult(spec, opts);
      },
    );
    ctx.verifyExecFn = branchExecStub;
    ctx.lensReviewFn = async () => mkLensSummary();
    await runWorkDriver(ctx);
    assert(headerSeen, "cycle (merged): /work #838 header present DURING the cycle");
    // The lens step's diff read cannot succeed under the faked exec; the
    // merged-step shape is covered by test-work-driver-merged-flow.ts —
    // THIS test's contract is the header: present during, cleared at end.
    const labels = optsSeen.map((o) => o.label ?? "").join(", ");
    assert(
      labels.includes("explore") && labels.includes("plan") && labels.includes("developer"),
      `cycle (merged): member dispatches for explore/plan/develop ran (labels: ${labels})`,
    );
    assert(dispatchDeck.batchSnapshot().length === 0, "cycle: header cleared at cycle end");
    assert(dispatchDeck.snapshot().length === 0, "cycle: no member rows remain at cycle end");
    const after = await readState(dir, 838);
    const terminal7 =
      after?.pipelineState.status === "merged" || after?.pipelineState.status === "handoff";
    assert(terminal7 === true, `cycle: status is terminal (status=${after?.pipelineState.status})`);
    dispatchDeck.reset();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dispatchDeck.reset();
  }
}

// 8. runWorkDriver — the handoff end path: a dispatch failure routes to
//    handoff; the header is cleared at cycle end.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-838-hand-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    dispatchDeck.reset();
    let headerSeen = false;
    const ctx = mkCycleCtx(
      dir,
      839,
      async (_pi: unknown, spec: { role: string; prompt: string }, opts?: { label?: string }) => {
        if (dispatchDeck.batchSnapshot().some((b) => b.label === "/work #839")) headerSeen = true;
        if (spec.role === "explore") return mkDispatchResult(spec, opts);
        throw new Error("smoke: forced plan failure");
      },
    );
    ctx.verifyExecFn = branchExecStub;
    await runWorkDriver(ctx);
    assert(headerSeen, "handoff path: /work #839 header existed during the cycle");
    assert(dispatchDeck.batchSnapshot().length === 0, "handoff path: header cleared at cycle end");
    const after = await readState(dir, 839);
    const terminal =
      after?.pipelineState.status === "handoff" || after?.pipelineState.status === "aborted";
    assert(
      terminal === true,
      `handoff path: cycle terminalized (status=${after?.pipelineState.status})`,
    );
    dispatchDeck.reset();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dispatchDeck.reset();
  }
}

// 9. runWorkDriver — a thrown error mid-cycle: the header is still
//    cleared (the try/finally, not per-path calls).
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-838-throw-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    dispatchDeck.reset();
    let headerSeen = false;
    const ctx = mkCycleCtx(
      dir,
      840,
      async (_pi: unknown, spec: { role: string; prompt: string }, opts?: { label?: string }) => {
        if (dispatchDeck.batchSnapshot().some((b) => b.label === "/work #840")) headerSeen = true;
        return mkDispatchResult(spec, opts);
      },
    );
    // explore/plan succeed; the BRANCH step's exec THROWS → the runStep
    // catch marks the cycle aborted → the try/finally releases the header.
    ctx.verifyExecFn = async (cmd) => {
      if (cmd.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
      if (cmd.includes("git rev-parse")) return { stdout: "feature/issue-840\n" };
      throw new Error("smoke: forced branch exec failure");
    };
    let rejected = false;
    try {
      await runWorkDriver(ctx);
    } catch {
      rejected = true;
    }
    assert(headerSeen, "throw path: /work #840 header existed during the cycle");
    assert(
      dispatchDeck.batchSnapshot().length === 0,
      "throw path: header cleared after the thrown error",
    );
    assert(
      rejected === false,
      "throw path: runWorkDriver itself does not reject (internal routing)",
    );
    dispatchDeck.reset();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dispatchDeck.reset();
  }
}

// 10. The driverDeckOpts helper: label grammar + cycle key.
{
  const o1 = driverDeckOpts(42, "develop", "default");
  assert(o1.cycleKey === "work:42", "driverDeckOpts: cycleKey is work:<issue>");
  assert(o1.label === "#42 develop · default", "driverDeckOpts: label is #<issue> <step> · <tag>");
  const o2 = driverDeckOpts(7, "explore", "explore");
  assert(o2.label === "#7 explore · explore", "driverDeckOpts: explore step label");
  assert(workDeckKey(7) === "work:7", "workDeckKey: work:<issue>");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

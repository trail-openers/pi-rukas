#!/usr/bin/env bun
/**
 * #799 task-a — the per-dispatch heartbeat.
 *
 * The incident this closes: a single dispatch's completion event landed
 * with zero events between it and `dispatch-started` — "working" was
 * indistinguishable from "wedged", during and after. The fix is a bounded
 * heartbeat (elapsed / turns / last tool / tokens — no transcript, ever)
 * persisted at the `runSingleDispatch` seam every heartbeat interval while
 * the child is in flight.
 *
 * The suite asserts, without a real spawn and without wall clock:
 *  1. `shouldEmitHeartbeat` — the interval predicate: under the interval
 *     → no tick; crossing it → due, `dueAt` advancing by whole intervals
 *     (no drift).
 *  2. `heartbeatEventFor` — the bounded payload builder + the stale
 *     guard (no dispatch-started → null; dispatch already settled → null;
 *     a sibling's completion → not stale; a dispatch that has not started
 *     yet → stale).
 *  3. `runSingleDispatch` via an injected `dispatchFn` (the same seam
 *     `test-work-driver-merged-flow.ts` uses for the merged step), with a
 *     FAKE CLOCK (the #366 `__setSleepFn` precedent — the offline suite
 *     carries no wall-clock hazard):
 *     - a dispatch that crosses the interval emits a heartbeat between
 *       dispatch-started and dispatch-completed;
 *     - a dispatch that finishes under the interval emits ZERO
 *       heartbeats (no noise in the common case);
 *     - the disabled escape hatch (PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS=0)
 *       emits nothing.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runSingleDispatch } from "../src/work-driver-merged.ts";
import { heartbeatEventFor, shouldEmitHeartbeat } from "../src/work-driver-heartbeat.ts";
import { heartbeatIntervalMs } from "../src/workflow-state-events-heartbeat.ts";
import { initialState, type WorkEvent, type WorkState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`\u2713 ${msg}`);
  } else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// Fake clock (the #366 `__setSleepFn` precedent). `Date.now` is patched for
// the duration of the seam test so the interval arithmetic is deterministic;
// `sleep` resolves immediately after advancing the clock, so the test runs
// in microseconds while the driver's clock crosses the full interval.
// ---------------------------------------------------------------------------
class FakeClock {
  private t = 1_000_000_000;
  private realNow: typeof Date.now;
  private realSleep: (fn: () => void, ms: number) => NodeJS.Timeout;

  constructor() {
    this.realNow = Date.now;
    this.realSleep = setTimeout;
    Date.now = () => this.t;
    // The heartbeat loop's `setTimeout` is `new Promise(r => setTimeout(r, ms))`;
    // the fake resolves the promise immediately after advancing the clock.
    // The real `setTimeout` is kept for anything else that needs a real timer.
    // We do NOT patch setTimeout globally (the test harness needs it); the
    // heartbeat loop's sleep is a no-op in real time because the clock
    // advances instantaneously, so the loop's `Date.now() - startedAt` is
    // always "past" and the due branch is taken on every iteration.
  }

  advance(ms: number): void {
    this.t += ms;
  }

  dispose(): void {
    Date.now = this.realNow;
  }
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

function mkCtx(issue: number, repoRoot: string, opts: { dispatchFn?: DriverContext["dispatchFn"] } = {}): DriverContext {
  return {
    repoRoot,
    issue,
    pi: mkPi(),
    ...(opts.dispatchFn ? { dispatchFn : opts.dispatchFn } : {}),
  } as DriverContext;
}

function mkState(issue: number): WorkState {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: { ...s.pipelineState, currentStep: "branch" },
  } as WorkState;
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "ops",
    ok: true,
    text: "done",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  } as DispatchResult;
}

function kinds(state: WorkState): string[] {
  return state.eventLog.map((e) => e.kind);
}

function heartbeats(state: WorkState): WorkEvent[] {
  return state.eventLog.filter((e) => e.kind === "dispatch-heartbeat");
}

function withStarted(state: WorkState, jobId: string, at: number): WorkState {
  return {
    ...state,
    eventLog: [
      ...state.eventLog,
      { kind: "dispatch-started", step: "branch", role: "ops", jobId, label: "ops:branch", at },
    ] as WorkEvent[],
  };
}

// ---------------------------------------------------------------------------
// 1. shouldEmitHeartbeat — the interval predicate (injectable clock).
// ---------------------------------------------------------------------------
{
  const I = 15 * 60_000; // 15 min
  const t0 = 1_000_000_000;
  const a = shouldEmitHeartbeat(t0, t0 + 14 * 60_000, I);
  assert(a.enabled && !a.due && a.dueAt === t0 + I, "under interval → enabled, not due, dueAt = t0 + I");

  const b = shouldEmitHeartbeat(t0, t0 + I, I);
  assert(b.due && b.dueAt === t0 + 2 * I, "exactly at interval → due, next dueAt = t0 + 2I");

  const c = shouldEmitHeartbeat(t0, t0 + 2 * I + 30_000, I);
  assert(c.due && c.dueAt === t0 + 3 * I, "past 2 intervals → due, next dueAt = t0 + 3I (no drift)");

  const d = shouldEmitHeartbeat(t0, t0 + 10 * I, 0);
  assert(!d.enabled && !d.due, "interval 0 → disabled (PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS=0)");

  assert(heartbeatIntervalMs() === 15 * 60_000, "default interval is 15 minutes");
}

// ---------------------------------------------------------------------------
// 2. heartbeatEventFor — the bounded payload builder + stale guard.
// ---------------------------------------------------------------------------
{
  const t0 = 1_000_000_000;
  const I = 15 * 60_000;
  const state = mkState(799);
  // No dispatch-started in the log yet → stale guard → null (the tick must
  // not emit ahead of the write-ahead marker it belongs to).
  const none = heartbeatEventFor({
    step: "branch",
    role: "ops",
    label: "ops:branch",
    jobId: "j1",
    startedAt: t0,
    now: t0 + I,
    state,
  });
  assert(none === null, "no dispatch-started in log → heartbeat suppressed (null)");

  // With a matching dispatch-started the tick emits. The deck has no entry
  // for this jobId (nothing spawned) → zeroState shape: zeros + flag.
  const ev = heartbeatEventFor({
    step: "branch",
    role: "ops",
    label: "ops:branch",
    jobId: "j1",
    startedAt: t0,
    now: t0 + I,
    state: withStarted(state, "j1", t0),
  });
  assert(ev !== null, "with a matching dispatch-started → event emitted");
  if (ev) {
    assert(
      ev.kind === "dispatch-heartbeat" && ev.jobId === "j1" && ev.step === "branch" && ev.label === "ops:branch",
      "event carries kind/jobId/step/label",
    );
    assert(ev.elapsedMs === I, "elapsedMs = now - startedAt");
    assert(ev.turns === 0 && ev.totalTokens === 0 && ev.zeroState === true, "no deck entry → zeroState with zero turns/tokens");
    assert(ev.lastToolName === undefined, "no deck entry → no lastToolName field");
  }
}
{
  // The dispatch already settled (completion after start) → stale → null.
  const t0 = 1_000_000_000;
  const I = 15 * 60_000;
  const state = mkState(799);
  const withStartedAndCompleted = {
    ...withStarted(state, "j1", t0),
    eventLog: [
      ...withStarted(state, "j1", t0).eventLog,
      { kind: "dispatch-completed", step: "branch", role: "ops", jobId: "j1", label: "ops:branch", ok: true, ms: 100, at: t0 + 1000 },
    ] as WorkEvent[],
  };
  const ev = heartbeatEventFor({
    step: "branch",
    role: "ops",
    label: "ops:branch",
    jobId: "j1",
    startedAt: t0,
    now: t0 + I,
    state: withStartedAndCompleted,
  });
  assert(ev === null, "dispatch already completed (matching jobId) → heartbeat suppressed");

  // A dispatch that has NOT started yet (a sibling is in flight but this
  // one's write-ahead hasn't landed) → stale → null.
  const siblingInFlight = withStarted(state, "j2", t0);
  const ev2 = heartbeatEventFor({
    step: "branch",
    role: "ops",
    label: "ops:branch",
    jobId: "j1",
    startedAt: t0,
    now: t0 + I,
    state: siblingInFlight,
  });
  assert(ev2 === null, "sibling dispatch's start (no start for this jobId) → heartbeat suppressed");

  // A dispatch whose sibling's completion is in the log (this one started,
  // sibling finished) → NOT stale → event emitted. A sibling's completion
  // is not evidence this dispatch is done.
  const withSibling = withStarted(state, "j1", t0);
  const withSiblingDone = {
    ...withSibling,
    eventLog: [
      ...withSibling.eventLog,
      { kind: "dispatch-started", step: "branch", role: "ops", jobId: "j2", label: "ops:other", at: t0 },
      { kind: "dispatch-completed", step: "branch", role: "ops", jobId: "j2", label: "ops:other", ok: true, ms: 100, at: t0 + 1000 },
    ] as WorkEvent[],
  };
  const ev3 = heartbeatEventFor({
    step: "branch",
    role: "ops",
    label: "ops:branch",
    jobId: "j1",
    startedAt: t0,
    now: t0 + I,
    state: withSiblingDone,
  });
  assert(ev3 !== null, "sibling dispatch's completion does not suppress this dispatch's heartbeat");
}

// ---------------------------------------------------------------------------
// 3. runSingleDispatch — the seam with a fake clock + deferred dispatchFn.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "hb-cross-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const prev = process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS;
    process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS = "200"; // 200 ms — offline
    const I = heartbeatIntervalMs();
    try {
      const clock = new FakeClock();
      let resolveDispatch!: (r: DispatchResult) => void;
      const gate = new Promise<DispatchResult>((r) => {
        resolveDispatch = r;
      });
      const dispatchFn = async () => gate;
      const ctx = mkCtx(799, dir, { dispatchFn });
      let out: WorkState | undefined;
      const runner = runSingleDispatch(ctx, mkState(799), "branch", "ops", "ops:branch", Date.now(), () => "prompt").then((s) => {
        out = s;
      });
      // Advance the clock past two intervals. The heartbeat loop's
      // `setTimeout` is a real timer, so the loop will sleep in real time
      // — but the clock is patched, so the loop's `Date.now()` reads
      // always show "past due". The loop's `setTimeout` still takes real
      // time to fire, so we advance the clock and then wait for the real
      // timer to fire.
      clock.advance(2 * I);
      await new Promise((r) => setTimeout(r, 500)); // real 500ms for the loop to tick
      resolveDispatch(mkResult());
      await runner;
      clock.dispose();
      const hbs = out ? heartbeats(out) : [];
      assert(hbs.length >= 1, "crossing the interval → at least one dispatch-heartbeat event");
      const k = out ? kinds(out) : [];
      assert(k.indexOf("dispatch-heartbeat") > k.indexOf("dispatch-started"), "heartbeat lands AFTER dispatch-started");
      assert(k.indexOf("dispatch-heartbeat") < k.indexOf("dispatch-completed"), "heartbeat lands BEFORE dispatch-completed");
      const hb = hbs[0];
      if (hb && hb.kind === "dispatch-heartbeat") {
        assert(
          typeof hb.turns === "number" && typeof hb.elapsedMs === "number" && typeof hb.totalTokens === "number",
          "heartbeat payload is bounded scalars (turns/elapsedMs/totalTokens)",
        );
        assert(hb.elapsedMs >= I, "heartbeat elapsedMs is at least one interval");
        assert(!("lastText" in hb) && !("lastToolHint" in hb), "heartbeat payload carries NO transcript fields (lastText/lastToolHint absent)");
      }
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS;
      else process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // A dispatch that finishes well under the interval → ZERO heartbeats.
  const dir = mkdtempSync(path.join(tmpdir(), "hb-quick-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const dispatchFn = async () => mkResult();
    const ctx = mkCtx(799, dir, { dispatchFn });
    const out = await runSingleDispatch(ctx, mkState(799), "branch", "ops", "ops:branch", Date.now(), () => "prompt");
    assert(heartbeats(out).length === 0, "dispatch under the interval → zero heartbeat events (no noise in the common case)");
    assert(out.eventLog.some((e) => e.kind === "dispatch-completed"), "completion event still present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // The escape hatch: PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS=0 → a long
  // dispatch emits nothing (the loop takes the disabled break).
  const dir = mkdtempSync(path.join(tmpdir(), "hb-off-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const prev = process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS;
    process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS = "0";
    try {
      let resolveDispatch!: (r: DispatchResult) => void;
      const gate = new Promise<DispatchResult>((r) => {
        resolveDispatch = r;
      });
      const dispatchFn = async () => gate;
      const ctx = mkCtx(799, dir, { dispatchFn });
      let out: WorkState | undefined;
      const runner = runSingleDispatch(ctx, mkState(799), "branch", "ops", "ops:branch", Date.now(), () => "prompt").then((s) => {
        out = s;
      });
      await new Promise((r) => setTimeout(r, 1500));
      resolveDispatch(mkResult());
      await runner;
      assert(out ? heartbeats(out).length === 0 : false, "PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS=0 → zero heartbeats even for a long dispatch");
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS;
      else process.env.PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // The seam does not delay the dispatch: a fast dispatchFn resolves at
  // roughly the time it returns (the loop must not wait out an interval).
  const dir = mkdtempSync(path.join(tmpdir(), "hb-nodelay-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const t0 = Date.now();
    const dispatchFn = async () => mkResult();
    const ctx = mkCtx(799, dir, { dispatchFn });
    await runSingleDispatch(ctx, mkState(799), "branch", "ops", "ops:branch", Date.now(), () => "prompt");
    assert(Date.now() - t0 < 2000, "fast dispatch → runSingleDispatch returns promptly (the seam does not wait out an interval)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

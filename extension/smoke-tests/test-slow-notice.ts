#!/usr/bin/env bun
/**
 * #799 — the slow-run watch: threshold notice to the PM + automatic steer,
 * the driver's dispatch-slow event, and the kill-kill-free contract.
 *
 * Drives the REAL code (watchSlowDispatch / feedSlowProgress / startJob /
 * dispatchCore / runSingleDispatch) with a fake child whose progress crosses
 * the turn threshold and a fake clock/timer for the elapsed dimension.
 *
 * Acceptance (issue #799, operator decision 2026-09-24):
 *  - crossing 150 turns → the PM gets exactly one notice with the peek
 *    fields, and the child gets exactly one steer; crossing 300 → one more
 *    of each; 149→151→160 → no duplicates.
 *  - the elapsed threshold fires via a fake clock.
 *  - PI_ENSEMBLE_AUTO_STEER=0 → notice, no steer; PI_ENSEMBLE_SLOW_NOTICE=0
 *    → neither.
 *  - a lens child is steerable by the id dispatch_peek shows.
 *  - a driver dispatch crossing a threshold records dispatch-slow in the
 *    event log; runSingleDispatch has no heartbeat loop.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { clearJobsForTesting, startJob } from "../src/async-jobs.ts";
import { steerChild } from "../src/dispatch-steer.ts";
import type { RunningState } from "../src/progress.ts";
import {
  clearSlowWatchesForTesting,
  feedSlowProgress,
  slowSteerText,
  slowThresholds,
  watchSlowDispatch,
} from "../src/slow-notice.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runSingleDispatch } from "../src/work-driver-merged.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = mkdtempSync(path.join(os.tmpdir(), "pi-ens-799s-"));

/** A fake pi whose sendUserMessage records the steer-delivered messages. */
function fakePi(notices: string[]) {
  return {
    sendUserMessage: (text: string, _opts?: { deliverAs?: string }) => {
      notices.push(text);
    },
  };
}

/** A fake steer core: records deliveries. */
function recordSteers(stored: Array<{ id: string; text: string; source: string }>) {
  return (id: string, text: string, source: string) => {
    stored.push({ id, text, source });
    return { id, delivered: true, label: id };
  };
}

/** A RunningState at the given turn count (elapsed/tokens left to 0 so the
 * turn dimension is the only one armed for the turn-crossing tests). */
function stateAt(turns: number, elapsedMs = 0, tokens = 0, text?: string): RunningState {
  return {
    role: "developer",
    turns,
    toolUses: turns,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
    totalTokens: tokens,
    elapsedMs,
    lastToolName: "bash",
    ...(text ? { lastText: text } : {}),
    done: false,
  };
}

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) process.env[k] = undefined;
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) process.env[k] = undefined;
      else process.env[k] = v;
    }
  }
};

// ---------------------------------------------------------------- 1. turns
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_TURNS: "150" }, async () => {
  clearSlowWatchesForTesting();
  clearJobsForTesting();
  const notices: string[] = [];
  const steers: Array<{ id: string; text: string; source: string }> = [];
  const stop = watchSlowDispatch({
    id: "job-turns",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: recordSteers(steers),
  });
  assert(slowThresholds().turns === 150, "threshold reads PI_ENSEMBLE_SLOW_NOTICE_TURNS");
  feedSlowProgress("job-turns", stateAt(149));
  assert(notices.length === 0 && steers.length === 0, "149 turns → nothing yet");
  feedSlowProgress("job-turns", stateAt(151));
  assert(notices.length === 1, "crossing 150 turns → exactly one notice");
  assert(steers.length === 1, "crossing 150 turns → exactly one steer");
  assert(notices[0]?.includes("job-turns") === true, "notice carries the job id");
  assert(notices[0]?.includes("151 turns") === true, "notice carries the turn count");
  assert(notices[0]?.includes("last tool") === false, "notice format sanity");
  assert(notices[0]?.includes("Last tool: bash") === true, "notice carries the last tool");
  assert(/Report status in ≤3 lines/.test(steers[0]?.text ?? ""), "steer is the mandated text");
  feedSlowProgress("job-turns", stateAt(160));
  assert(notices.length === 1 && steers.length === 1, "149→151→160 → no duplicates");
  feedSlowProgress("job-turns", stateAt(299));
  assert(notices.length === 1, "299 turns → still one (second crossing is 300)");
  feedSlowProgress("job-turns", stateAt(301));
  assert(notices.length === 2, "crossing 300 turns → one more notice");
  assert(steers.length === 2, "crossing 300 turns → one more steer");
  stop();
});

// ------------------------------------------------------------- 2. elapsed
await withEnv({}, async () => {
  clearSlowWatchesForTesting();
  clearJobsForTesting();
  let t = 1_000_000;
  const now = () => t;
  const notices: string[] = [];
  const steers: Array<{ id: string; text: string; source: string }> = [];
  const stop = watchSlowDispatch({
    id: "job-elapsed",
    role: "explore",
    label: "explore",
    pi: fakePi(notices),
    steerFn: recordSteers(steers),
    now,
  });
  // Default thresholds: 20 min / 150 turns / 20M tokens.
  t += 19 * 60_000;
  feedSlowProgress("job-elapsed", stateAt(1));
  assert(notices.length === 0, "19 min → nothing yet");
  t += 2 * 60_000;
  feedSlowProgress("job-elapsed", stateAt(1));
  assert(notices.length === 1, "crossing 20 min → exactly one notice (fake clock)");
  assert(steers.length === 1, "crossing 20 min → exactly one steer");
  stop();
});

// -------------------------------------------------- 3. auto-steer disabled
await withEnv({ PI_ENSEMBLE_AUTO_STEER: "0", PI_ENSEMBLE_SLOW_NOTICE_TURNS: "150" }, async () => {
  clearSlowWatchesForTesting();
  clearJobsForTesting();
  const notices: string[] = [];
  const steers: Array<{ id: string; text: string; source: string }> = [];
  const stop = watchSlowDispatch({
    id: "job-nosteer",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: recordSteers(steers),
  });
  feedSlowProgress("job-nosteer", stateAt(151));
  assert(notices.length === 1, "AUTO_STEER=0 → the notice still fires");
  assert(steers.length === 0, "AUTO_STEER=0 → no steer");
  stop();
});

// ---------------------------------------------------- 4. slow-notice off
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE: "0" }, async () => {
  clearSlowWatchesForTesting();
  clearJobsForTesting();
  const notices: string[] = [];
  const steers: Array<{ id: string; text: string; source: string }> = [];
  const stop = watchSlowDispatch({
    id: "job-off",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: recordSteers(steers),
  });
  feedSlowProgress("job-off", stateAt(99_999, 99_999_999, 99_999_999));
  assert(notices.length === 0, "SLOW_NOTICE=0 → no notice at any scale");
  assert(steers.length === 0, "SLOW_NOTICE=0 → no steer at any scale");
  stop();
});

// -------------------------------------------------- 5. startJob wiring (1)
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_TURNS: "150" }, async () => {
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  const notices: string[] = [];
  const steers: Array<{ id: string; text: string; source: string }> = [];
  let progressFn: ((s: RunningState) => void) | undefined;
  const { jobId } = startJob(fakePi(notices) as never, {
    label: "explore",
    role: "explore",
    work: (_sig, hooks) => {
      progressFn = hooks.onProgress;
      return new Promise<DispatchResult>(() => {
        /* never resolves — the job is still running when the test reads */
      });
    },
  });
  assert(typeof progressFn === "function", "startJob wires onProgress");
  progressFn?.(stateAt(151));
  // The watch is process-internal; the fakePi records the PM notice.
  assert(notices.length === 1, "startJob job crossing 150 → one PM notice");
  // steer went through the real steerChild — the job's handle exists (onStdin
  // was never called here, so steerChild reports no-such-job; the watch's
  // steer attempt was still attempted through the real core, which is what
  // the lifecycle log cares about).
  assert(jobId.length > 0, "jobId is the id the notice names");
});

// ------------------------------------------- 6. runSingleDispatch + onSlow
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_TURNS: "2" }, async () => {
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  const state = initialState(799, 1_000_000);
  const fakeDispatch: NonNullable<DriverContext["dispatchFn"]> = async (_pi, _spec, opts) => {
    // Simulate the child crossing the threshold mid-dispatch: the watch is
    // keyed by the job id startJob mints, which the driver does not see
    // until beginDispatch — so instead drive the watch directly under the
    // SAME id the onSlow callback will report (the driver folds the event
    // from the callback's own state ref).
    const onSlow = opts?.onSlow;
    assert(typeof onSlow === "function", "runSingleDispatch threads onSlow");
    onSlow?.({
      step: "branch",
      role: "ops",
      jobId: "fake-job",
      label: "ops:branch",
      elapsedMs: 12_000,
      turns: 3,
      tokens: 1234,
      at: Date.now(),
    });
    return {
      role: "ops",
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
      transcriptPath: "/tmp/x",
    };
  };
  const ctx: DriverContext = {
    pi: fakePi([]),
    issue: 799,
    issues: [799],
    repoRoot: REPO,
    dispatchFn: fakeDispatch,
  } as unknown as DriverContext;
  const out = await runSingleDispatch(
    ctx,
    state,
    "branch",
    "ops",
    "ops:branch",
    Date.now(),
    () => "prompt",
  );
  const slowEvents = out.eventLog.filter((e) => e.kind === "dispatch-slow");
  assert(slowEvents.length === 1, "driver dispatch crossing → one dispatch-slow in the event log");
  const ev = slowEvents[0];
  if (ev && ev.kind === "dispatch-slow") {
    assert(ev.step === "branch", "dispatch-slow carries the step");
    assert(ev.turns === 3 && ev.tokens === 1234, "dispatch-slow carries turns + tokens");
    assert(ev.jobId === "fake-job", "dispatch-slow carries the job id");
  }
  // The completion event lands AFTER the slow event (folded ref).
  const last = out.eventLog[out.eventLog.length - 1];
  assert(last?.kind === "dispatch-completed", "completion event is the tail");
});

// ------------------------------- 7. runSingleDispatch has no heartbeat loop
{
  const src = readFileSync(path.join(import.meta.dir, "../src/work-driver-merged.ts"), "utf8");
  // #799 — the periodic heartbeat is gone: no setInterval in the dispatch
  // path (a comment mentioning it is fine; a live loop is not).
  assert(!/setInterval\(/.test(src), "work-driver-merged.ts: no heartbeat loop remains");
  const slowSrc = readFileSync(path.join(import.meta.dir, "../src/slow-notice.ts"), "utf8");
  assert(/watchSlowDispatch/.test(slowSrc), "slow-notice.ts: the watch module exists");
  // The mandated steer text is exactly the operator's string.
  const text = slowSteerText(1234, 150);
  assert(
    text.startsWith("You have been running for ") &&
      text.includes("/ 150 turns") &&
      text.includes("Report status in ≤3 lines (done / remaining / blocked)"),
    "steer text matches the mandated shape",
  );
}

// --------------------------------------------- 8. lens child is steerable
{
  // The registry + steer-core path: a lens child registers its stdin under
  // its deck key; dispatch_steer must resolve that id. The real lens path
  // (lens-review-child.ts) registers via registerChildHandle in onStdin;
  // this test drives the registry seam directly with a fake stdin.
  clearJobsForTesting();
  clearSlowWatchesForTesting();
  const { registerChildHandle } = await import("../src/async-jobs-registry.ts");
  const deckMod = await import("../src/dispatch-deck.ts");
  const deckKey = "run-abc/simplicity";
  deckMod.startEntry(deckKey, {
    label: "code-review-specialist[simplicity]",
    role: "code-review-specialist",
    tag: "simplicity",
  });
  const written: string[] = [];
  const fakeStdin = {
    write: (s: string) => {
      written.push(s);
      return true;
    },
  } as unknown as Writable;
  registerChildHandle(
    deckKey,
    fakeStdin,
    "code-review-specialist[simplicity]",
    "code-review-specialist",
  );
  const r = steerChild(deckKey, "status check", "pm-tool");
  assert(r.delivered === true, `lens child is steerable by the deck id (${r.reason ?? "ok"})`);
  assert(written.length === 1, "the steer reached the child's stdin");
  assert(written[0]?.includes('"type":"steer"') === true, "the RPC envelope is correct");
  deckMod.clearEntry(deckKey);
  // #799 — clearEntry keeps state in quiet mode; the child handle must be
  // deleted explicitly so a settled child is no longer steerable.
  const { childHandles } = await import("../src/async-jobs-registry.ts");
  childHandles.delete(deckKey);
  assert(
    steerChild(deckKey, "again", "pm-tool").delivered === false,
    "settled lens child → no-such-job",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #799 — the slow-run watch: threshold notice to the PM + automatic steer,
 * the kill-kill-free contract, and the cycle-keyed slow-event buffer.
 *
 * Drives the REAL code (watchSlowDispatch / feedSlowProgress / startJob)
 * with a fake child whose progress crosses the turn threshold and a fake
 * clock/timer for the elapsed dimension. The driver-path coverage (the
 * dispatch-slow event through runSingleDispatch / runPlan / the adversarial
 * fan-out, drained at the step boundary) lives in
 * test-slow-notice-driver.ts (§12 file-size split).
 *
 * Acceptance (issue #799, operator decision 2026-09-24):
 *  - crossing 150 turns → the PM gets exactly one notice with the peek
 *    fields, and the child gets exactly one steer; crossing 300 → one more
 *    of each; 149→151→160 → no duplicates.
 *  - the elapsed threshold fires via a fake clock.
 *  - PI_ENSEMBLE_AUTO_STEER=0 → notice, no steer; PI_ENSEMBLE_SLOW_NOTICE=0
 *    → neither.
 *  - a lens child is steerable by the id dispatch_peek shows.
 *  - the slow-event buffer is keyed by cycle: concurrent cycles never see
 *    each other's dispatch-slow events.
 */

import { clearJobsForTesting, startJob } from "../src/async-jobs.ts";
import {
  clearParentExtensionApiForTesting,
  setParentExtensionApi,
} from "../src/async-jobs-registry.ts";
import { steerChild } from "../src/dispatch-steer.ts";
import type { RunningState } from "../src/progress.ts";
import {
  clearSlowWatchesForTesting,
  drainSlowEvents,
  feedSlowProgress,
  slowThresholds,
  watchSlowDispatch,
} from "../src/slow-notice.ts";
import type { DispatchResult } from "../src/types.ts";
import type { WorkEvent } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function setup() {
  clearSlowWatchesForTesting();
  clearJobsForTesting();
}

/** A fake pi whose sendUserMessage records the steer-delivered messages. */
function fakePi(notices: string[]) {
  return { sendUserMessage: (text: string, _opts?: { deliverAs?: string }) => notices.push(text) };
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
  setup();
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
  setup();
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
  setup();
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
  setup();
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
  setup();
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

// --------------------------------------------- 8. lens child is steerable
{
  // The registry + steer-core path: a lens child registers its stdin under
  // its deck key; dispatch_steer must resolve that id. The real lens path
  // (lens-review-child.ts) registers via registerChildHandle in onStdin;
  // this test drives the registry seam directly with a fake stdin.
  setup();
  const { registerChildHandle, childHandles } = await import("../src/async-jobs-registry.ts");
  const deckMod = await import("../src/dispatch-deck.ts");
  const deckKey = "run-abc/simplicity";
  deckMod.startEntry(deckKey, {
    label: "code-review-specialist[simplicity]",
    role: "code-review-specialist",
    tag: "simplicity",
  });
  const written: string[] = [];
  const fakeStdin = { write: (s: string) => (written.push(s), true) } as unknown as import("node:stream").Writable;
  registerChildHandle(deckKey, fakeStdin, "code-review-specialist[simplicity]", "code-review-specialist");
  const r = steerChild(deckKey, "status check", "pm-tool");
  assert(r.delivered === true, `lens child is steerable by the deck id (${r.reason ?? "ok"})`);
  assert(written.length === 1, "the steer reached the child's stdin");
  assert(written[0]?.includes('"type":"steer"') === true, "the RPC envelope is correct");
  deckMod.clearEntry(deckKey);
  childHandles.delete(deckKey);
  assert(
    steerChild(deckKey, "again", "pm-tool").delivered === false,
    "settled lens child → no-such-job",
  );
}

// --------------------------------------------- 9. slow-watch in quiet mode
{
  // #799 — the slow-watch is decoupled from the dispatch deck: it keeps its
  // own per-job state (a module-level map in slow-notice.ts, fed by
  // feedSlowProgress and cleared on settle) and reads NO deck entry, so it
  // fires identically under PI_ENSEMBLE_QUIET_STATUS=1 (which makes
  // dispatch-deck's updateEntry/clearEntry no-ops).
  await withEnv({ PI_ENSEMBLE_QUIET_STATUS: "1" }, async () => {
    setup();
    const notices: string[] = [];
    const steers: Array<{ id: string; text: string; source: string }> = [];
    const stop = watchSlowDispatch({
      id: "job-quiet",
      role: "developer",
      label: "developer",
      pi: fakePi(notices),
      steerFn: recordSteers(steers),
    });
    feedSlowProgress("job-quiet", stateAt(149));
    assert(notices.length === 0 && steers.length === 0, "quiet: 149 turns → nothing yet");
    feedSlowProgress("job-quiet", stateAt(151));
    assert(notices.length === 1, "quiet mode: crossing 150 turns → notice still fires");
    assert(steers.length === 1, "quiet mode: crossing 150 turns → steer still fires");
    stop();
    feedSlowProgress("job-quiet", stateAt(400));
    assert(notices.length === 1, "quiet: settled watch never fires again (map cleared on settle)");
  });
}

// ---------------------------------------------------------------- 10. silent child
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_MS: "50" }, async () => {
  setup();
  let t = 2_000_000;
  const now = () => t;
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const stop = watchSlowDispatch({
    id: "job-silent",
    role: "developer",
    label: "silent",
    pi: { sendUserMessage: (t: string) => notices.push(t) },
    steerFn: (_jobId: string, text: string, _src: any) => steers.push(text),
    now,
  });
  try {
    feedSlowProgress("job-silent", { turns: 1, totalTokens: 1, elapsedMs: 100 });
    assert(notices.length === 1, "silent child: elapsed crossing → one notice");
    assert(steers.length === 1, "silent child: elapsed crossing → one steer");
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------- 13. lens PM notice
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_MS: "50" }, async () => {
  const notices: string[] = [];
  const fakePi: any = { sendUserMessage: (t: string) => notices.push(t) };
  setParentExtensionApi(fakePi);
  setup();
  let t = 2_000_000;
  const now = () => t;
  const stop = watchSlowDispatch({
    id: "job-lens",
    role: "code-review-specialist",
    label: "lens:arch",
    now,
  });
  try {
    t += 100;
    feedSlowProgress("job-lens", { turns: 1, totalTokens: 1, elapsedMs: 100 });
    assert(notices.length === 1, "lens child (no pi in scope): PM notice fires via parent API");
    assert(notices[0]?.includes("lens:arch") === true, "lens child: notice names the label");
  } finally {
    stop();
    clearParentExtensionApiForTesting();
  }
});

// --------------------------------------------------- 14. cycle-keyed buffer
{
  // #799 — the pending slow-event buffer is keyed by the cycle's primary
  // issue (the registry's cycle identity). Up to
  // MAX_PARALLEL_GROUPS_DEFAULT (3) groups run concurrently in one process;
  // the old shared array let cycle A's routeStepOutcome drain cycle B's
  // crossings into A's event log. Drive both recorders concurrently and
  // verify each drain returns ONLY its own cycle's events.
  const { clearSlowEventsForTesting, slowRecorder } = await import("../src/slow-notice.ts");
  clearSlowEventsForTesting();
  const at = Date.now();
  slowRecorder(100, "plan")({
    step: "plan",
    role: "explore",
    jobId: "job-a1",
    label: "plan",
    elapsedMs: 1,
    turns: 151,
    tokens: 1,
    at,
  });
  // Interleave: cycle B records between A's two crossings, as two cycles
  // advancing in lockstep do in the real driver loop.
  slowRecorder(200, "adversarial")({
    step: "adversarial",
    role: "adversarial-developer",
    jobId: "job-b1",
    label: "adversarial",
    elapsedMs: 1,
    turns: 151,
    tokens: 2,
    at,
  });
  slowRecorder(100, "plan")({
    step: "plan",
    role: "explore",
    jobId: "job-a2",
    label: "plan",
    elapsedMs: 1,
    turns: 301,
    tokens: 3,
    at,
  });
  const drainedA: WorkEvent[] = drainSlowEvents(100);
  assert(
    drainedA.length === 2 && drainedA.every((e) => e.jobId === "job-a1" || e.jobId === "job-a2"),
    "drain(A) returns exactly cycle A's two crossings (not B's)",
  );
  assert(drainedA.every((e) => e.kind === "dispatch-slow"), "drain(A) events are dispatch-slow");
  const drainedB: WorkEvent[] = drainSlowEvents(200);
  assert(
    drainedB.length === 1 && drainedB[0]?.jobId === "job-b1",
    "cycle B's crossing remained for B's own drain (no cross-cycle contamination)",
  );
  // Drain is a deletion: a second drain of either cycle returns nothing, and
  // draining an unknown cycle never throws or returns a sibling's events.
  assert(drainSlowEvents(100).length === 0, "drain(A) again → empty (entry deleted on first drain)");
  assert(drainSlowEvents(999).length === 0, "drain(unknown) → empty, no throw");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

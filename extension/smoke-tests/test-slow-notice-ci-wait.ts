#!/usr/bin/env bun
/**
 * #907 — the CI-wait exclusion for the slow-run watch's elapsed dimension.
 *
 * Time the child has an in-flight CI-watch tool call (bash command matching
 * `gh pr checks … --watch` / `gh run watch` / `glab ci status --live` /
 * `glab ci view`, tolerant of leading `timeout`/`env`/`nice`
 * wrappers) does not count toward the elapsed threshold: the notice is
 * DELAYED, never suppressed. Both the progress-driven check
 * (feedSlowProgress) and the timer-driven check (tickElapsed) use the
 * adjusted elapsed (wall minus excluded), and the absolute re-arm is
 * shifted by the excluded time.
 *
 * Drives the REAL watch (watchSlowDispatch / feedSlowProgress) with a
 * fake clock + fake scheduler; the span feed is driven through the
 * watch's raw-event seam (the toolCall block opens, the matching
 * toolResult closes).
 */

import type { RunningState } from "../src/progress.ts";
import {
  clearSlowWatchesForTesting,
  feedSlowProgress,
  watchSlowDispatch,
} from "../src/slow-notice.ts";
import { isCiWatchCommand } from "../src/slow-notice-ci-wait.ts";

let exit = 0;
const assert = (cond: boolean, msg: string): void =>
  cond ? console.log(`✓ ${msg}`) : (console.error(`✗ ${msg}`), (exit = 1));

const setup = (): void => clearSlowWatchesForTesting();

/** A fake pi whose sendUserMessage records the notices. */
function fakePi(notices: string[]) {
  return { sendUserMessage: (text: string) => notices.push(text) };
}

/** A fake scheduler that records its arms and lets the test fire them in
 * order (the elapsed timer runs deterministically). */
function fakeScheduler() {
  const arms: Array<{ ms: number; fire: () => void }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const a = { ms, fired: false };
    a.fire = () => {
      if (a.fired) return;
      a.fired = true;
      fn();
    };
    arms.push(a);
    return () => (a.fired = true);
  };
  return { arms, schedule };
}

/** A RunningState at the given turn count (elapsed/tokens default to 0). */
function stateAt(turns: number, elapsedMs = 0, tokens = 0): RunningState {
  return {
    role: "developer",
    turns,
    toolUses: turns,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
    totalTokens: tokens,
    elapsedMs,
    lastToolName: "bash",
    done: false,
  };
}

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

type Feed = (event: unknown) => void;
const MIN = 60_000;

/** The per-section watch harness: one watch armed with `now` (plus an
 * optional scheduler) and the span-feed seam captured into `feed`. */
function harness(id: string, now: () => number, opts: { schedule?: (fn: () => void, ms: number) => () => void } = {}) {
  const notices: string[] = [];
  const rawRef: { feed?: Feed } = {};
  const watch = watchSlowDispatch({
    id,
    role: "ops",
    label: "ops",
    pi: fakePi(notices),
    now,
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
    onRawEvent: () => {},
  });
  rawRef.feed = watch.onRawEvent;
  return { watch, notices, feed: rawRef, stop: watch.stop };
}

/** The span open/close fixtures shared by the span-driven sections. */
const openSpan = (feed: Feed | undefined, id: string, cmd: string): void =>
  feed?.({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: cmd } }] } });
const closeSpan = (feed: Feed | undefined, id: string, isError = false): void =>
  feed?.({ type: "message_end", message: { role: "toolResult", toolName: "bash", toolCallId: id, isError } });

// --------------------------------------------------------- 1. the classifier
// Accepts the four CI-watch shapes (tolerant of flag order); rejects the
// near-misses (plain `gh pr checks N` without --watch, `gh run list`,
// `gh api …`) and every shell-wrapped or chained variant except the allowed
// wrappers.
{
  const accepted = [
    "gh pr checks 12 --watch",
    "gh pr checks --watch 12",
    "gh run watch",
    "gh run watch 999",
    "glab ci status --live",
    "glab ci view",
    "timeout 1800 gh pr checks 906 --watch",
    "timeout 600 gh run watch 123",
    "timeout 10m gh run watch",
    "timeout -k 5 1800 gh pr checks 12 --watch",
    "env FOO=bar gh pr checks 12 --watch",
    "nice gh run watch 999",
    "timeout 60s glab ci status --live",
  ];
  for (const cmd of accepted) assert(isCiWatchCommand(cmd) === true, `accepts ${JSON.stringify(cmd)}`);
  const rejected = [
    "gh pr checks 12",
    "gh run list",
    "gh api repos/o/r/actions/runs",
    "gh pr checks 12 --watch && echo done",
    "gh run watch; gh run watch",
    "gh run watch | tee log",
    "gh pr checks 12 && gh pr checks 13 --watch",
    "timeout 60 gh pr checks 12",
    "sleep 10",
    "echo gh run watch",
    "watch -n 5 gh run watch",
    "bash -c 'gh run watch'",
    "gh pr views 12 --watch",
    "gh ci status --live",
  ];
  for (const cmd of rejected) assert(isCiWatchCommand(cmd) === false, `rejects ${JSON.stringify(cmd)}`);
}

// ---------------------------------- 2. progress path: excluded elapsed never fires
// A child that has spent its first 25 minutes in ONE `gh pr checks 12
// --watch` span and 5 minutes elsewhere is 30 minutes wall but only 5
// minutes ADJUSTED: the progress-driven check must not fire the level-1
// (20 min) elapsed notice at 25 minutes wall.
await withEnv({}, async () => {
  setup();
  let t = 1_000_000;
  const { watch, notices, feed, stop } = harness("job-excl-progress", () => t);
  assert(typeof watch.onRawEvent === "function", "an onRawEvent input installs the span-feed seam");
  try {
    // 25 minutes inside one CI-watch span, then the span closes.
    openSpan(feed.feed, "ci-1", "gh pr checks 12 --watch");
    t += 25 * MIN;
    closeSpan(feed.feed, "ci-1");
    // 5 minutes elsewhere: wall is 30 min, adjusted is 5 min.
    t += 5 * MIN;
    feedSlowProgress("job-excl-progress", stateAt(1, 30 * MIN));
    assert(notices.length === 0, "25m in CI-watch + 5m elsewhere → NO level-1 notice at 30m wall");
  } finally {
    stop();
  }
});

// ------------------------------ 3. progress path: the same child without exclusion
// The identical schedule in a NON-CI bash command (`sleep 1500`) must get
// exactly one level-1 elapsed notice when its wall crosses 20 minutes.
await withEnv({}, async () => {
  setup();
  let t = 2_000_000;
  const { notices, feed, stop } = harness("job-excl-nonci", () => t);
  try {
    openSpan(feed.feed, "nc-1", "sleep 1500");
    t += 19 * MIN;
    feedSlowProgress("job-excl-nonci", stateAt(1, 19 * MIN));
    assert(notices.length === 0, "non-CI: 19m wall → nothing yet");
    t += 2 * MIN;
    feedSlowProgress("job-excl-nonci", stateAt(1, 21 * MIN));
    assert(notices.length === 1, "non-CI: crossing 20m wall → exactly one level-1 notice");
    assert(notices[0]?.includes("triggered by: elapsed") === true, "non-CI: notice names elapsed");
    // No exclusion → no suffix (byte-identical to today's metrics segment).
    assert(notices[0]?.includes("CI wait excluded") === false, "non-CI: zero exclusion → no suffix");
  } finally {
    stop();
  }
});

// ------------------------------------------ 4. post-span: the notice is DELAYED
// The 25m span + 5m elsewhere: at 30m wall the adjusted elapsed crosses 20m
// (30 − 10… no — 30 wall, 25 excluded… wait). The authoritative shape: a
// 25m span followed by 5m elsewhere means the span closed at 25m, so by 30m
// wall the child has 5m of post-span time. The adjusted elapsed is wall −
// excluded = 30m − 25m = 5m → NO notice. The crossing (adjusted = 20m) comes
// at 45m wall (30 + 15). This is the "delayed, never suppressed" contract.
await withEnv({}, async () => {
  setup();
  let t = 3_000_000;
  const { notices, feed, stop } = harness("job-excl-delayed", () => t);
  try {
    openSpan(feed.feed, "dl-1", "gh pr checks 12 --watch");
    t += 25 * MIN;
    closeSpan(feed.feed, "dl-1");
    // 5 minutes elsewhere: wall 30m, adjusted 5m → nothing (the 20m crossing
    // is delayed, not reached).
    t += 5 * MIN;
    feedSlowProgress("job-excl-delayed", stateAt(1, 30 * MIN));
    assert(notices.length === 0, "post-span: 30m wall (adjusted 5m) → nothing");
    // 15 more minutes: wall 45m, adjusted 20m → the crossing: exactly ONE
    // level-1 notice (delayed from 20m to 45m wall, not suppressed).
    t += 15 * MIN;
    feedSlowProgress("job-excl-delayed", stateAt(1, 45 * MIN));
    assert(notices.length === 1, "post-span: exactly ONE level-1 notice at 45m wall (adjusted 20m)");
    // The notice's metrics segment carries the exclusion, right after the
    // elapsed value: `… 45m0s (+25m0s CI wait excluded) · …`.
    assert(notices[0]?.includes("45m0s (+25m0s CI wait excluded)") === true, "post-span: suffix (+25m0s CI wait excluded) after the elapsed value");
  } finally {
    stop();
  }
});

// ------------------------------------ 5. timer path: a silent child in a span
// A silent child (no progress feeds after the first) sitting inside a
// 25-minute CI-watch span: at 25m wall the elapsed TIMER fires, but the
// adjusted elapsed (25m − 25m = 0) has not crossed 20m → no notice.
await withEnv({}, async () => {
  setup();
  let t = 4_000_000;
  const sched = fakeScheduler();
  const { watch, notices, feed, stop } = harness("job-excl-timer", () => t, { schedule: sched.schedule });
  try {
    // The first (and only) progress feed at 1m wall; the span is already open.
    openSpan(feed.feed, "tm-1", "gh pr checks 12 --watch");
    t += 1 * MIN;
    feedSlowProgress("job-excl-timer", stateAt(1, 1 * MIN));
    // At 25m wall the initial timer (armed for 20m) fires.
    t += 24 * MIN;
    sched.arms[0]?.fire();
    assert(notices.length === 0, "timer: 25m wall inside a 25m span → NO notice (adjusted 0m)");
    const rearm = sched.arms.slice(1);
    assert(rearm.length === 1, "timer: re-armed exactly once after the silent tick");
    // Re-arm is the absolute 20m crossing shifted by the excluded 25m:
    // fires at 45m wall → 20m from now.
    assert(
      rearm[0] && Math.abs(rearm[0].ms - 20 * MIN) < 2,
      `timer: re-arm shifted by the excluded time (45m wall = +${rearm[0]?.ms}ms)`,
    );
    // 35m wall the re-armed tick fires (the shift made sense while the span
    // was open): adjusted 10m → still nothing.
    t += 10 * MIN;
    sched.arms[1]?.fire();
    assert(notices.length === 0, "timer: 35m wall (adjusted 10m) → still nothing");
  } finally {
    stop();
  }
});

// ------------------------------------ 6. timer path: the same silent child, no exclusion
// The identical silent schedule in a NON-CI command: the initial timer
// fires at 20m wall → one notice (no shift, no exclusion).
await withEnv({}, async () => {
  setup();
  let t = 5_000_000;
  const sched = fakeScheduler();
  const { notices, feed, stop } = harness("job-excl-timer-plain", () => t, { schedule: sched.schedule });
  try {
    openSpan(feed.feed, "tp-1", "sleep 1200");
    t += 1 * MIN;
    feedSlowProgress("job-excl-timer-plain", stateAt(1, 1 * MIN));
    t += 19 * MIN;
    sched.arms[0]?.fire();
    assert(notices.length === 1, "timer: silent non-CI child fires at 20m wall (unshifted)");
    assert(notices[0]?.includes("20m0s · 1 turns · 0 tokens") === true, "timer: zero exclusion → byte-identical metrics segment");
    assert(notices[0]?.includes("CI wait excluded") === false, "timer: zero exclusion → no suffix");
  } finally {
    stop();
  }
});

// ---------------------------------------------- 7. per-toolCallId concurrent spans
// Two overlapping CI-watch spans (different toolCallIds) are tracked per id;
// each closes on its OWN toolResult. The exclusion is the per-span sum (an
// open span measures live from its own open time; closed spans freeze).
await withEnv({}, async () => {
  setup();
  let t = 6_000_000;
  const { notices, feed, stop } = harness("job-excl-concurrent", () => t);
  try {
    openSpan(feed.feed, "a1", "gh run watch 1");
    t += 10 * MIN;
    openSpan(feed.feed, "a2", "gh pr checks 2 --watch");
    t += 10 * MIN;
    // Close both at 20m wall: a1 (opened at 0) is 20m, a2 (opened at 10m)
    // is 10m → excluded 30m, wall 21m → adjusted clamps to 0 → no notice.
    closeSpan(feed.feed, "a1");
    closeSpan(feed.feed, "a2");
    t += 1 * MIN;
    feedSlowProgress("job-excl-concurrent", stateAt(1, 21 * MIN));
    assert(notices.length === 0, "concurrent spans: overlapping watch time does not fire early");
    // 40 more minutes of work: adjusted 61 − 30 = 31m → one notice naming
    // the excluded 30m.
    t += 40 * MIN;
    feedSlowProgress("job-excl-concurrent", stateAt(1, 61 * MIN));
    assert(notices.length === 1, "concurrent spans: crossing fires once after the spans close");
    assert(notices[0]?.includes("30m0s CI wait excluded") === true, "concurrent spans: exclusion is the sum of both spans");
  } finally {
    stop();
  }
});

// ----------------------------------------------- 8. an isError result still closes
// A `gh run watch` that errors (CI run cancelled) still counts as CI-wait
// (the classifier keys on the opening command); the isError closes the span
// exactly like a clean one, and the exclusion is the span's full duration.
await withEnv({}, async () => {
  setup();
  let t = 7_000_000;
  const { notices, feed, stop } = harness("job-excl-err", () => t);
  try {
    openSpan(feed.feed, "er-1", "gh run watch 42");
    t += 25 * MIN;
    closeSpan(feed.feed, "er-1", true);
    t += 5 * MIN;
    feedSlowProgress("job-excl-err", stateAt(1, 30 * MIN));
    assert(notices.length === 0, "isError result: the span still closed (no notice at 30m wall)");
    // At 45m wall the adjusted is 20m → one notice naming the 25m exclusion.
    t += 15 * MIN;
    feedSlowProgress("job-excl-err", stateAt(1, 45 * MIN));
    assert(notices.length === 1, "isError result: the notice fires once at the adjusted crossing");
    assert(notices[0]?.includes("45m0s (+25m0s CI wait excluded)") === true, "isError result: the exclusion is the span's full duration");
  } finally {
    stop();
  }
});

// ----------------------------------------- 9. a killed child's span dies with the watch
// A child killed while inside a CI-watch span never emits its toolResult.
// The span state lives on the watch, so stopping the watch disposes the
// tracker: a LATER watch (or a re-fed id) cannot inherit the dead span.
await withEnv({}, async () => {
  setup();
  let t = 8_000_000;
  const now = () => t;
  const { feed, stop } = harness("job-excl-killed", now);
  try {
    openSpan(feed.feed, "kl-1", "gh run watch 7");
    t += 25 * MIN;
    // The child is killed: no toolResult arrives.
    stop();
  } finally {
    stop();
  }
  // A fresh watch at the same wall clock: the dead span must not exclude
  // anything (the tracker was disposed with the first watch).
  const { notices, stop: stop2 } = harness("job-excl-killed-2", now);
  try {
    // 15 more minutes of (non-CI) work: adjusted 15m → below 20m.
    t += 15 * MIN;
    feedSlowProgress("job-excl-killed-2", stateAt(1, 15 * MIN));
    assert(notices.length === 0, "killed span: no inherited exclusion (15m adjusted → nothing)");
    t += 6 * MIN;
    feedSlowProgress("job-excl-killed-2", stateAt(1, 21 * MIN));
    assert(notices.length === 1, "killed span: the plain 20m crossing fires (no phantom exclusion)");
  } finally {
    stop2();
  }
});

// ---------------------------------------------------- 10. non-bash / malformed input
// A toolCall that is not bash, whose arguments lack `command`, or whose
// block has no id opens no span (a fresh watch at 30m wall then fires a
// plain, suffix-free crossing).
await withEnv({}, async () => {
  setup();
  let t = 9_000_000;
  const now = () => t;
  const { feed, stop } = harness("job-excl-malformed", now);
  try {
    const f = feed.feed;
    f?.({ type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", id: "mf-1", name: "read", arguments: { command: "gh run watch" } },
    ] } });
    f?.({ type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", id: "mf-2", name: "bash", arguments: { notCommand: "gh run watch" } },
    ] } });
    f?.({ type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", name: "bash", arguments: { command: "gh run watch" } },
    ] } });
    t += 30 * MIN; // no span opened — see the fresh watch below
  } finally {
    stop();
  }
  const { notices: notices2, stop: stop3 } = harness("job-excl-malformed-2", now);
  try {
    feedSlowProgress("job-excl-malformed-2", stateAt(1, 30 * MIN));
    assert(notices2.length === 1, "malformed blocks: no span → plain crossing fires");
    assert(notices2[0]?.includes("CI wait excluded") === false, "malformed blocks: zero exclusion → no suffix");
  } finally {
    stop3();
  }
});

// -------------------------------------------------------- 11. no seam → no exclusion
// A watch armed WITHOUT an onRawEvent has no span feed: nothing can be
// excluded, and the 20m plain crossing fires as before (the second-tier
// sites that cannot feed events keep their existing behaviour).
await withEnv({}, async () => {
  setup();
  let t = 10_000_000;
  const now = () => t;
  const notices: string[] = [];
  const watch = watchSlowDispatch({ id: "job-excl-noseam", role: "ops", label: "ops", pi: fakePi(notices), now });
  assert(watch.onRawEvent === undefined, "no onRawEvent input → no seam installed");
  try {
    t += 21 * MIN;
    feedSlowProgress("job-excl-noseam", stateAt(1, 21 * MIN));
    assert(notices.length === 1, "no seam: plain 20m crossing still fires");
    assert(notices[0]?.includes("21m0s · 1 turns · 0 tokens") === true, "no seam: byte-identical metrics segment");
  } finally {
    watch.stop();
  }
});

console.log(`\nexit ${exit}`);
process.exit(exit);

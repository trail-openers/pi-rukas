#!/usr/bin/env bun
/**
 * #884 — the slow-run watch's LEVEL rule: ONE level per watch.
 *
 * The old code (per-dimension re-arming, #799) fired a notice + auto-steer
 * for each dimension's FIRST crossing, so one run crossing 150 turns,
 * 20 min and 20M tokens a few minutes apart fired three notices and three
 * steers (#873). The new rule: `level` counts the levels already fired (0
 * initially); the NEXT fire happens when ANY dimension meets
 * `base·2^level` (level 0: 20 min / 150 turns / 20M tokens; level 1:
 * 40 / 300 / 40M; and so on). On a fire the level jumps to the HIGHEST
 * level any dimension has now reached (no catch-up burst), the notice names
 * the triggering dimension(s), and the elapsed timer re-arms ABSOLUTELY
 * for start + msBase·2^level.
 *
 * Drives the REAL watchSlowDispatch / feedSlowProgress with a fake clock +
 * fake scheduler (the timer path runs deterministically). The driver-path
 * coverage (the dispatch-slow event, one per level) lives in
 * test-slow-notice-driver.ts.
 */

import type { RunningState } from "../src/progress.ts";
import {
  clearSlowWatchesForTesting,
  feedSlowProgress,
  levelReached,
  levelThresholds,
  watchSlowDispatch,
} from "../src/slow-notice.ts";

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
}

/** A fake pi whose sendUserMessage records the notices. */
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

/** A fake scheduler that records its arms and lets the test fire them in
 * order (the elapsed timer is driven deterministically). */
function fakeScheduler() {
  const arms: Array<{ ms: number; fire: () => void }> = [];
  return {
    arms,
    schedule: (fn: () => void, ms: number) => {
      const state = { live: true };
      const arm = {
        ms,
        fire: () => {
          if (!state.live) return;
          state.live = false;
          fn();
        },
      };
      arms.push(arm);
      return () => {
        state.live = false;
      };
    },
  };
}

/** A RunningState with all three dimensions set. */
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

const MIN = 60_000;
const M20 = 20 * MIN;
const M40 = 40 * MIN;
const M80 = 80 * MIN;
const K20M = 20_000_000;
const K40M = 40_000_000;
const K80M = 80_000_000;

// ------------------------------------------------------- 1. one level per watch
// 151 turns → level 1 (naming turns); 21 min + 21M tokens stay below level 2
// (no notice); 300 turns → level 2.
await withEnv({}, async () => {
  setup();
  let t = 1_000_000;
  const now = () => t;
  const notices: string[] = [];
  const steers: Array<{ id: string; text: string; source: string }> = [];
  const sched = fakeScheduler();
  const slowEvents: Array<{ turns: number }> = [];
  const stop = watchSlowDispatch({
    id: "job-levels",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: recordSteers(steers),
    now,
    schedule: sched.schedule,
    onSlow: (i) => slowEvents.push({ turns: i.turns }),
  });
  try {
    feedSlowProgress("job-levels", stateAt(149, 0, 0));
    assert(notices.length === 0 && steers.length === 0, "L1: 149 turns → nothing yet");
    feedSlowProgress("job-levels", stateAt(151, 0, 0));
    assert(notices.length === 1, "L1: turns cross 150 → exactly one notice");
    assert(steers.length === 1, "L1: exactly one steer");
    assert(slowEvents.length === 1, "L1: exactly one dispatch-slow event");
    assert(notices[0]?.includes("level 1") === true, "L1: notice says level 1");
    assert(notices[0]?.includes("triggered by: turns") === true, "L1: notice names turns");
    // The #873 burst: elapsed passes 20 min, then tokens pass 20M. Advance
    // the watch's clock alongside the snapshot's elapsed — the watch computes
    // elapsed from `now() - startedAt`, not from the snapshot field.
    t += 21 * MIN;
    feedSlowProgress("job-levels", stateAt(151, 21 * MIN, 0));
    t += 2 * MIN;
    feedSlowProgress("job-levels", stateAt(155, 23 * MIN, 21 * 1_000_000));
    assert(
      notices.length === 1,
      "L1→L2: elapsed 21 min + tokens 21M below level 2 → still one notice",
    );
    assert(steers.length === 1, "L1→L2: still one steer (no catch-up)");
    // Level 2: 300 turns (39 min / 39.9M are still below).
    t += 16 * MIN;
    feedSlowProgress("job-levels", stateAt(299, 39 * MIN, 39_999_999));
    assert(notices.length === 1, "L2: 299 turns below level 2 → still one");
    feedSlowProgress("job-levels", stateAt(300, 39 * MIN, 39_999_999));
    assert(notices.length === 2, "L2: 300 turns → exactly one more notice");
    assert(steers.length === 2, "L2: exactly one more steer");
    assert(slowEvents.length === 2, "L2: exactly one more dispatch-slow event");
    assert(notices[1]?.includes("level 2") === true, "L2: notice says level 2");
    assert(notices[1]?.includes("triggered by: turns") === true, "L2: notice names turns");
    // The elapsed timer re-armed absolutely for start + 80 min, i.e. 80 min
    // minus the 39 min already elapsed (the clock above tracks the
    // snapshots' elapsed).
    const rearm = sched.arms.slice(2);
    assert(rearm.length === 1, "timer: re-armed exactly once after the level-2 fire");
    const expected = M80 - (t - 1_000_000);
    assert(
      rearm[0] && Math.abs(rearm[0].ms - expected) < 2,
      `timer: re-armed absolutely for start+80min (${rearm[0]?.ms} vs ${expected})`,
    );
  } finally {
    stop();
  }
});

// --------------------------------------------- 2. overshoot fires once, to the top
// A single feed crossing ALL three dimensions fires exactly ONCE, names all
// three, and jumps to the highest level any dimension reached (tokens 45M →
// level 2). The next fire is at level 2's thresholds (80 min / 600 turns /
// 80M) — NOT before.
await withEnv({}, async () => {
  setup();
  let t = 2_000_000;
  const now = () => t;
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const sched = fakeScheduler();
  const stop = watchSlowDispatch({
    id: "job-overshoot",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: (_id, _text, _src) => steers.push({ id: _id, text: _text, source: _src }),
    now,
    schedule: sched.schedule,
  });
  try {
    t += 21 * MIN;
    feedSlowProgress("job-overshoot", stateAt(160, 21 * MIN, 45 * 1_000_000));
    assert(notices.length === 1, "overshoot: single feed crossing all three → exactly ONE notice");
    assert(steers.length === 1, "overshoot: exactly ONE steer");
    assert(
      notices[0]?.includes("triggered by: elapsed, turns, tokens") === true,
      "overshoot: names all three",
    );
    assert(
      notices[0]?.includes("level 2") === true,
      "overshoot: level jumps to 2 (tokens 45M ≥ 40M)",
    );
    // Nothing until level 2's thresholds: 80 min / 600 turns / 80M.
    t += 58 * MIN;
    feedSlowProgress("job-overshoot", stateAt(299, 79 * MIN, 79_999_999));
    assert(notices.length === 1, "overshoot: below level-2 values do not fire");
    feedSlowProgress("job-overshoot", stateAt(599, 79 * MIN, 79_999_999));
    assert(notices.length === 1, "overshoot: 599 turns below 600 → still one");
    feedSlowProgress("job-overshoot", stateAt(600, 79 * MIN, 79_999_999));
    assert(notices.length === 2, "overshoot: 600 turns → one more notice, next fire only there");
    assert(notices[1]?.includes("level 3") === true, "overshoot: the next fire is level 3");
    // arms[0] is the initial arm (20 min); arms[1] the post-level-2 re-arm
    // (80 min − 21 min = 59 min); arms[2] the post-level-3 re-arm.
    const rearm = sched.arms.slice(2);
    assert(rearm.length === 1, "overshoot: timer re-armed exactly once after the level-3 fire");
    // 79 min elapsed (21 + 58) → re-arm for 160 − 79 = 81 min.
    const expected = M80 * 2 - (t - 2_000_000);
    assert(
      rearm[0] && Math.abs(rearm[0].ms - expected) < 2,
      `overshoot: timer re-armed absolutely for start+160min (${rearm[0]?.ms} vs ${expected})`,
    );
  } finally {
    stop();
  }
});

// ------------------------------------------------- 3. silent child, absolute timer
// A child that is silent (no progress events after the first) crosses only
// via the elapsed timer. With a small PI_ENSEMBLE_SLOW_NOTICE_MS (20ms),
// the timer fires at 1× (level 1) and again at 2× absolute (level 2) — and
// not in between: a feed at 1.5× does not fire.
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_MS: "20" }, async () => {
  setup();
  let t = 3_000_000;
  const now = () => t;
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const sched = fakeScheduler();
  const stop = watchSlowDispatch({
    id: "job-silent2x",
    role: "developer",
    label: "silent",
    pi: fakePi(notices),
    steerFn: (_id, _text, _src) => steers.push({ id: _id, text: _text, source: _src }),
    now,
    schedule: sched.schedule,
  });
  try {
    assert(
      levelThresholds(0).ms === 20 && levelThresholds(1).ms === 40,
      "small MS override: level 0 is 20ms, level 1 is 40ms (base 20 × 2)",
    );
    feedSlowProgress("job-silent2x", {
      role: "developer",
      turns: 1,
      toolUses: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      totalTokens: 1,
      elapsedMs: 0,
      done: false,
    });
    assert(notices.length === 0, "silent 2×: nothing before the first timer fire");
    assert(
      sched.arms.length === 1 && sched.arms[0]?.ms === 20,
      "silent 2×: first timer armed at 1× (20ms)",
    );
    t += 20;
    sched.arms[0]?.fire(); // t = +20ms → 1×: level 1
    assert(notices.length === 1, "silent 2×: timer fires at 1× → one notice");
    assert(steers.length === 1, "silent 2×: one steer");
    assert(notices[0]?.includes("triggered by: elapsed") === true, "silent 2×: names elapsed");
    const rearm = sched.arms.slice(1);
    assert(
      rearm.length === 1 && rearm[0]?.ms === 20,
      `silent 2×: timer re-armed for 2× ABSOLUTE (now at 1×, next fire 20ms later → ${rearm[0]?.ms})`,
    );
    // A feed at 1.5× (30ms) must not fire — below level 1's threshold (40ms).
    t += 10;
    feedSlowProgress("job-silent2x", {
      role: "developer",
      turns: 1,
      toolUses: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      totalTokens: 1,
      elapsedMs: 30,
      done: false,
    });
    assert(notices.length === 1, "silent 2×: a feed at 1.5× (30ms) → no fire (below 2×)");
    t += 20;
    sched.arms[1]?.fire(); // t = +40ms → 2×: level 2
    assert(notices.length === 2, "silent 2×: timer fires again at 2× absolute → exactly one more");
    assert(steers.length === 2, "silent 2×: exactly one more steer");
    assert(notices[1]?.includes("level 2") === true, "silent 2×: the second fire is level 2");
  } finally {
    stop();
  }
});

// ------------------------------------------------- 4. steers off / notices off
await withEnv({ PI_ENSEMBLE_AUTO_STEER: "0" }, async () => {
  setup();
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const sched = fakeScheduler();
  const slowEvents: unknown[] = [];
  const stop = watchSlowDispatch({
    id: "job-nosteer2",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: (_id, _text, _src) => steers.push({ id: _id, text: _text, source: _src }),
    schedule: sched.schedule,
    onSlow: (i) => slowEvents.push(i),
  });
  try {
    feedSlowProgress("job-nosteer2", stateAt(151, 0, 0));
    assert(notices.length === 1, "AUTO_STEER=0: the notice still fires");
    assert(steers.length === 0, "AUTO_STEER=0: no steer");
    assert(slowEvents.length === 1, "AUTO_STEER=0: the dispatch-slow event still fires");
  } finally {
    stop();
  }
});

await withEnv({ PI_ENSEMBLE_SLOW_NOTICE: "0" }, async () => {
  setup();
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const sched = fakeScheduler();
  const slowEvents: unknown[] = [];
  const stop = watchSlowDispatch({
    id: "job-off2",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: (_id, _text, _src) => steers.push({ id: _id, text: _text, source: _src }),
    schedule: sched.schedule,
    onSlow: (i) => slowEvents.push(i),
  });
  try {
    feedSlowProgress("job-off2", stateAt(99_999, 99_999_999, 99_999_999));
    sched.arms.forEach((a) => a.fire());
    assert(notices.length === 0, "SLOW_NOTICE=0: no notice at any scale (level rule stays inert)");
    assert(steers.length === 0, "SLOW_NOTICE=0: no steer at any scale");
    assert(slowEvents.length === 0, "SLOW_NOTICE=0: no dispatch-slow event");
  } finally {
    stop();
  }
});

// ------------------------------------- 5. high turns threshold (effectively
// "disabled" for the test range): a turns-only value below the threshold
// never fires, while the finite elapsed dimension follows the level rule.
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_TURNS: "1000000" }, async () => {
  setup();
  let t = 5_000_000;
  const now = () => t;
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const sched = fakeScheduler();
  const stop = watchSlowDispatch({
    id: "job-highturns",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: (_id, _text, _src) => steers.push({ id: _id, text: _text, source: _src }),
    now,
    schedule: sched.schedule,
  });
  try {
    // 999 turns is below the 1M threshold → turns never fires.
    feedSlowProgress("job-highturns", stateAt(999, 0, 0));
    assert(notices.length === 0, "high turns: 999 turns below 1M → no fire");
    // The watch's clock crosses 20 min → the timer fires level 1 (elapsed).
    t += 20 * MIN;
    sched.arms[0]?.fire();
    assert(notices.length === 1, "high turns: timer fires level 1 at 20 min");
    assert(
      notices[0]?.includes("triggered by: elapsed") === true,
      "high turns: names only elapsed",
    );
    // 39 min elapsed is below level 2 (40 min) → no second fire.
    t += 19 * MIN;
    feedSlowProgress("job-highturns", stateAt(999, 39 * MIN, 0));
    assert(notices.length === 1, "high turns: 39 min below 40 min → still one");
  } finally {
    stop();
  }
});

// ------------------------------------------------- 6. threshold table sanity
await withEnv({}, async () => {
  const l1 = levelThresholds(1);
  const l2 = levelThresholds(2);
  const l3 = levelThresholds(3);
  assert(
    l1.ms === M40 && l1.turns === 300 && l1.tokens === K40M,
    "level 1: 40 min / 300 turns / 40M",
  );
  assert(l2.ms === M80 && l2.turns === 600 && l2.tokens === K80M, "level 2: 80 min / 600 turns / 80M");
  assert(
    l3.ms === 160 * MIN && l3.turns === 1200 && l3.tokens === K80M * 2,
    "level 3: 160 min / 1200 turns / 160M",
  );
  assert(
    M20 === 20 * MIN && K20M === 20_000_000,
    "level 0 bases: 20 min / 150 turns / 20M",
  );
});

// ------------------------------------------------- 7. levelReached boundaries
// A pure unit test of the level helper at the exact boundaries (base 150):
// 149 → 0, 150 → 1, 299 → 1, 300 → 2, 599 → 2, 600 → 3.
await withEnv({}, async () => {
  assert(levelReached(149, 150) === 0, "levelReached: 149 < base 150 → 0");
  assert(levelReached(150, 150) === 1, "levelReached: 150 = base → 1");
  assert(levelReached(299, 150) === 1, "levelReached: 299 < 2·base → 1");
  assert(levelReached(300, 150) === 2, "levelReached: 300 = 2·base → 2");
  assert(levelReached(599, 150) === 2, "levelReached: 599 < 4·base → 2");
  assert(levelReached(600, 150) === 3, "levelReached: 600 = 4·base → 3");
  // Integer doubling, not floating log: exact powers stay exact.
  assert(levelReached(1_200, 150) === 4, "levelReached: 1200 = 8·base → 4");
  assert(levelReached(20, 20) === 1, "levelReached: exact base → 1");
  assert(levelReached(19, 20) === 0, "levelReached: one below base → 0");
  assert(levelReached(1, 0) === 0, "levelReached: base ≤ 0 → 0 (disabled dimension)");
});

// -------------------------------------------------
// 8. #884 — env changes AFTER arming never move a live watch's thresholds.
// watchSlowDispatch snapshots the level-0 bases once at arm time; every
// per-level threshold is base·2^level arithmetic from there. Set a turns
// base of 1M, arm, then set 150 — the watch still fires at 1M / 2M, not at
// 150 / 300 (the exported helpers still read the env and now say 150).
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_TURNS: "1000000" }, async () => {
  setup();
  const notices: string[] = [];
  const steers: Array<{ id: string }> = [];
  const sched = fakeScheduler();
  const stop = watchSlowDispatch({
    id: "job-rearm-env",
    role: "developer",
    label: "developer",
    pi: fakePi(notices),
    steerFn: (_id, _text, _src) => steers.push({ id: _id, text: _text, source: _src }),
    schedule: sched.schedule,
  });
  try {
    process.env.PI_ENSEMBLE_SLOW_NOTICE_TURNS = "150";
    // The env-reading helper agrees with the new env…
    assert(levelThresholds(0).turns === 150, "rearm: env helper now reports the new base");
    // …but the armed watch's thresholds are frozen at 1M / 2M.
    feedSlowProgress("job-rearm-env", stateAt(300, 0, 0));
    assert(notices.length === 0, "rearm: 300 turns (≥ the NEW 150/300 base) → no fire on the old watch");
    feedSlowProgress("job-rearm-env", stateAt(999_999, 0, 0));
    assert(notices.length === 0, "rearm: 999_999 turns (< the OLD 1M base) → still no fire");
    feedSlowProgress("job-rearm-env", stateAt(1_000_000, 0, 0));
    assert(notices.length === 1, "rearm: 1M turns (the OLD base) → one notice");
    assert(notices[0]?.includes("triggered by: turns") === true, "rearm: names turns");
    // The next fire is at the OLD base doubled: 2M, not the new base's 300.
    feedSlowProgress("job-rearm-env", stateAt(300, 0, 0));
    assert(notices.length === 1, "rearm: 300 (< the OLD 2M) → no second fire");
    feedSlowProgress("job-rearm-env", stateAt(2_000_000, 0, 0));
    assert(notices.length === 2, "rearm: 2M (the OLD base doubled) → second notice");
  } finally {
    stop();
    delete process.env.PI_ENSEMBLE_SLOW_NOTICE_TURNS;
  }
});

console.log(`\nexit ${exit}`);
process.exit(exit);

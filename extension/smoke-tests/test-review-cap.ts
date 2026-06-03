#!/usr/bin/env bun
/**
 * Pure unit test for the wall-clock review-cap state machine (#4).
 *
 * Exercises the bare checkReviewCap function (the tool's execute() is a
 * thin wrapper around it). Tests are time-sensitive in two cases — we use
 * a real timer for the "first call sets timestamp" path, and time-mock
 * via Date.now stubbing for the elapsed-time path so we don't have to
 * sleep 90 minutes per assertion.
 */

import { checkReviewCap, reset, snapshot } from "../src/review-cap.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Stub Date.now so we can fast-forward past the 90-min cap deterministically.
const realNow = Date.now.bind(Date);
let mockNow: number | null = null;
Date.now = (() => mockNow ?? realNow()) as typeof Date.now;
function setMockNow(ms: number) {
  mockNow = ms;
}
function restoreNow() {
  mockNow = null;
}

// 1. First call sets the timer and returns ok with elapsed=0.
{
  reset();
  setMockNow(1_000_000);
  const r = checkReviewCap("issue-42");
  assert(r.ok === true, "first call returns ok=true");
  assert(r.startedAt === 1_000_000, "startedAt matches the first-call timestamp");
  assert(r.elapsedMs === 0, "elapsedMs is zero on first call");
  assert(r.reset === true, "first call marks reset=true (timer just initialised)");
  assert(r.capMs === 90 * 60 * 1000, "capMs is 90 minutes");
  assert(snapshot().length === 1, "one timer is now in the map");
}

// 2. Subsequent call within cap: ok, elapsed reflects time passed.
{
  reset();
  setMockNow(1_000_000);
  checkReviewCap("issue-42"); // sets timer at 1_000_000
  setMockNow(1_000_000 + 30 * 60 * 1000); // +30 min
  const r = checkReviewCap("issue-42");
  assert(r.ok === true, "30 minutes in: still ok");
  assert(r.elapsedMs === 30 * 60 * 1000, "elapsedMs reflects the +30 min");
  assert(r.reset === false, "subsequent call doesn't reset");
  assert(r.startedAt === 1_000_000, "startedAt stays pinned to original start");
}

// 3. Subsequent call past cap: ok=false with cap-exceeded message.
{
  reset();
  setMockNow(2_000_000);
  checkReviewCap("issue-42");
  setMockNow(2_000_000 + 91 * 60 * 1000); // +91 min
  const r = checkReviewCap("issue-42");
  assert(r.ok === false, "91 minutes in: not ok");
  assert(r.elapsedMs > 90 * 60 * 1000, "elapsedMs reflects exceeded cap");
  assert(
    r.message.toLowerCase().includes("cap exceeded"),
    "message clearly says cap exceeded",
  );
  assert(
    r.message.toLowerCase().includes("halt"),
    "message instructs PM to halt and escalate",
  );
}

// 4. reset=true explicitly restarts the timer regardless of state.
{
  reset();
  setMockNow(3_000_000);
  checkReviewCap("issue-99");
  setMockNow(3_000_000 + 100 * 60 * 1000); // way past cap
  const stale = checkReviewCap("issue-99");
  assert(stale.ok === false, "stale timer reports exceeded before reset");

  setMockNow(3_000_000 + 100 * 60 * 1000 + 1000);
  const fresh = checkReviewCap("issue-99", { reset: true });
  assert(fresh.ok === true, "reset: true returns ok regardless of previous state");
  assert(fresh.startedAt === 3_000_000 + 100 * 60 * 1000 + 1000, "startedAt is current now");
  assert(fresh.elapsedMs === 0, "elapsed=0 after reset");
  assert(fresh.reset === true, "reset flag is true");
}

// 5. Different keys are independent timers.
{
  reset();
  setMockNow(4_000_000);
  checkReviewCap("issue-1"); // starts timer for issue-1
  setMockNow(4_000_000 + 100 * 60 * 1000); // past cap for issue-1
  const issue1 = checkReviewCap("issue-1");
  assert(issue1.ok === false, "issue-1 exceeded its cap");
  const issue2 = checkReviewCap("issue-2"); // fresh timer
  assert(issue2.ok === true, "issue-2 has its own timer, fresh start");
  assert(issue2.elapsedMs === 0, "issue-2 elapsed=0 (just started)");
  assert(snapshot().length === 2, "both timers coexist in the map");
}

// 6. Reset only the named key (other timers untouched).
{
  reset();
  setMockNow(5_000_000);
  checkReviewCap("a");
  checkReviewCap("b");
  setMockNow(5_000_000 + 30 * 60 * 1000);
  checkReviewCap("a", { reset: true }); // reset only `a`
  const aAfter = checkReviewCap("a");
  const bAfter = checkReviewCap("b");
  assert(aAfter.elapsedMs === 0, "a's elapsed is fresh after reset");
  assert(bAfter.elapsedMs === 30 * 60 * 1000, "b's timer unaffected — still 30m elapsed");
}

restoreNow();
console.log(`\nexit ${exit}`);
process.exit(exit);

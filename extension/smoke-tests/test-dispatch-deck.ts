#!/usr/bin/env bun
/**
 * Pure unit test for the dispatch deck (#117):
 *  - entries inserted in stable insertion order
 *  - update mutates in place without reordering
 *  - clear drops the row at 0s (no linger) AND clears the corresponding
 *    Pi setStatus entry
 *  - one setStatus key PER child (Pi joins them side-by-side on a single
 *    footer line — see #128 follow-up: multi-line text was sanitised away)
 *  - setStatus key is prefixed with a zero-padded insertion sequence so
 *    Pi's alphabetical sort matches dispatch order
 *  - lastToolName + use-count surface in the row; lastText does NOT (kept
 *    out so per-child rows stay compact when Pi packs them side-by-side)
 *  - PI_ENSEMBLE_QUIET_STATUS=1 short-circuits everything
 *
 * No Pi spawns. The deck's setStatus path is exercised by attaching a fake
 * ExtensionContext that records every call.
 */

import {
  attach,
  clearEntry,
  detach,
  formatRow,
  isTicking,
  reset,
  snapshot,
  startEntry,
  updateEntry,
} from "../src/dispatch-deck.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

interface RecordedCall {
  key: string;
  text: string | undefined;
}

function fakeCtx(): {
  calls: RecordedCall[];
  ctx: Parameters<typeof attach>[0];
} {
  const calls: RecordedCall[] = [];
  const ctx = {
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        calls.push({ key, text });
      },
    },
  } as unknown as Parameters<typeof attach>[0];
  return { calls, ctx };
}

// 1. Insertion order is preserved across updates.
{
  reset();
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  startEntry("c", { label: "ops", role: "ops" });

  updateEntry("b", makeState("explore", { elapsedMs: 5000, lastToolName: "grep" }));
  updateEntry("a", makeState("developer", { elapsedMs: 8000, lastToolName: "bash", toolUses: 3 }));

  const keys = snapshot().map((e) => e.key);
  assert(
    JSON.stringify(keys) === '["a","b","c"]',
    "insertion order preserved after interleaved updates",
  );
}

// 2. Update mutates in place; clear removes immediately AND clears the status.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("x", { label: "developer", role: "developer" });
  updateEntry("x", makeState("developer", { elapsedMs: 12000, lastToolName: "bash" }));
  assert(snapshot()[0]?.state.lastToolName === "bash", "update set lastToolName");

  clearEntry("x");
  assert(snapshot().length === 0, "clear drops the entry immediately (no 0s linger)");
  const lastCall = calls[calls.length - 1];
  assert(lastCall?.text === undefined, "clear calls setStatus(<key>, undefined) on the entry's key");
  detach();
}

// 3. formatRow renders compact single line: icon + label + elapsed + tool.
//    Elapsed is computed from startedAt (NOT state.elapsedMs) — supplying `now`
//    pins it for the test.
{
  const startedAt = 1_000_000;
  const out = formatRow(
    {
      key: "df8a-2k",
      label: "developer",
      seq: "000001",
      startedAt,
      state: makeState("developer", {
        elapsedMs: 999, // STALE — must not be used at render time
        lastToolName: "bash",
        toolUses: 7,
      }),
    },
    startedAt + 134000,
  );
  assert(out.startsWith("⏳"), "row starts with hourglass icon");
  assert(out.includes("developer"), "row includes label");
  assert(out.includes("2m14s"), "row includes elapsed computed from now − startedAt");
  assert(!out.includes("999"), "stale state.elapsedMs is NOT rendered (uses startedAt instead)");
  assert(out.includes("bash (#7)"), "row includes tool name + use-count when >1");
  assert(!out.includes("\n"), "row is single-line (no newlines — Pi's footer sanitises them)");
}

// 4. formatRow shows tool name without count when only 1 use.
{
  const startedAt = 2_000_000;
  const out = formatRow(
    {
      key: "x",
      label: "explore",
      seq: "000002",
      startedAt,
      state: makeState("explore", { lastToolName: "grep", toolUses: 1 }),
    },
    startedAt + 4000,
  );
  assert(out.includes(" grep"), "single-use tool includes name");
  assert(!out.includes("(#1)"), "no use-count when only 1 use");
}

// 5. formatRow omits tool when lastToolName not set.
{
  const startedAt = 3_000_000;
  const out = formatRow(
    {
      key: "x",
      label: "ops",
      seq: "000003",
      startedAt,
      state: makeState("ops"),
    },
    startedAt + 1000,
  );
  assert(out === "⏳ ops 1.0s", "no tool → just icon + label + elapsed");
}

// 6. formatRow does NOT include lastText (footer is single-line; detail goes to dispatch_peek).
{
  const startedAt = 4_000_000;
  const out = formatRow(
    {
      key: "x",
      label: "developer",
      seq: "000004",
      startedAt,
      state: makeState("developer", {
        lastToolName: "bash",
        lastText: "Running tests in worktree-A",
      }),
    },
    startedAt + 1000,
  );
  assert(!out.includes("Running tests"), "lastText is NOT rendered in the row");
  assert(!out.includes("worktree"), "lastText is NOT rendered in the row");
}

// 6b. The self-tick is armed when entries exist; stopped when the deck drains (#131).
{
  reset();
  assert(!isTicking(), "ticker is not armed when no entries");
  startEntry("a", { label: "developer", role: "developer" });
  assert(isTicking(), "ticker arms when first entry registers");
  startEntry("b", { label: "explore", role: "explore" });
  assert(isTicking(), "ticker stays armed across additional entries");
  clearEntry("a");
  assert(isTicking(), "ticker still armed while at least one entry remains");
  clearEntry("b");
  assert(!isTicking(), "ticker stops when the last entry drains");
}

// 7. Multiple entries → one setStatus call per entry, each with its own key.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  await new Promise((r) => setImmediate(r));

  const lastTwo = calls.slice(-2);
  assert(lastTwo.length === 2, "two startEntries → two setStatus calls in last render");
  assert(
    new Set(lastTwo.map((c) => c.key)).size === 2,
    "each entry uses a unique setStatus key",
  );
  assert(
    lastTwo.every((c) => c.key.startsWith("ensemble:deck:")),
    "all keys use ensemble:deck: prefix",
  );
  detach();
}

// 8. setStatus keys are prefixed with zero-padded insertion sequence → alphabetical sort
//    matches dispatch order. Pi sorts statuses by key.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  // Use jobIds that would sort in REVERSE alphabetical order if sorted by jobId alone.
  startEntry("zzz-first", { label: "developer", role: "developer" });
  startEntry("aaa-second", { label: "explore", role: "explore" });
  await new Promise((r) => setImmediate(r));

  const renderedKeys = calls.slice(-2).map((c) => c.key).sort((a, b) => a.localeCompare(b));
  // First-inserted should sort first under alphabetical sort.
  assert(
    renderedKeys[0]?.includes("zzz-first"),
    "insertion-order sequence prefix makes first-inserted sort first regardless of jobId order",
  );
  assert(
    renderedKeys[1]?.includes("aaa-second"),
    "second-inserted sorts second",
  );
  detach();
}

// 9. PI_ENSEMBLE_QUIET_STATUS=1 short-circuits start/update.
{
  reset();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  startEntry("muted", { label: "developer", role: "developer" });
  updateEntry("muted", makeState("developer", { elapsedMs: 9000 }));
  assert(snapshot().length === 0, "quiet env var prevents entry registration");
  delete process.env.PI_ENSEMBLE_QUIET_STATUS;
  startEntry("audible", { label: "developer", role: "developer" });
  assert(snapshot().length === 1, "deck resumes when env var unset");
}

// 10. detach clears every entry's status and drops the context reference.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  await new Promise((r) => setImmediate(r));

  const callsBeforeDetach = calls.length;
  detach();
  const callsAfterDetach = calls.length;
  // detach should have issued setStatus(<key>, undefined) for each entry — at least 2 new calls.
  assert(
    callsAfterDetach >= callsBeforeDetach + 2,
    "detach clears every entry's status (≥2 new setStatus calls)",
  );
  const clearCalls = calls.slice(callsBeforeDetach);
  assert(
    clearCalls.every((c) => c.text === undefined),
    "all post-detach calls pass undefined text",
  );
  assert(snapshot().length === 0, "detach drains entries");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

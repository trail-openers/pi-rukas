#!/usr/bin/env bun
/**
 * #914 — the Enter-on-job view-opener guard (the openJob try/catch +
 * .catch in agent-list.ts's Enter branch).
 *
 * A synchronous throw (or a rejected promise) from the view opener must
 * not escape the TUI input handler — the guard wraps the call in try/catch
 * with a trace and attaches `.catch` to a returned promise. This test
 * drives the REAL `createAgentListComponent` handleInput with a throwing
 * and a rejecting opener and asserts the throw is contained and the
 * rejection never becomes an unhandled rejection.
 *
 * Split from test-dispatch-deck-list.ts (the 500-line hard limit). The
 * row projection and harness fixtures mirror that file's `entry` /
 * `fixtureEntries` helpers — the guard under test is the component's
 * Enter branch, not the projection.
 */

import {
  type AgentListLine,
  buildAgentListLines,
  createAgentListComponent,
} from "../src/agent-list.ts";
import { killJobs } from "../src/async-jobs-lifecycle.ts";
import type { DeckEntry } from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NOW = 2_000_000;

function entry(key: string, label: string, role: string, seq: number): DeckEntry {
  return {
    key,
    label,
    seq,
    startedAt: NOW - 60_000 - seq * 1000,
    state: {
      role,
      done: false,
      lastToolName: undefined,
      toolUses: 0,
      lastToolHint: undefined,
      lastEventAt: undefined,
      elapsedMs: undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      totalTokens: 100 + seq * 37,
    },
  };
}

function fixtureEntries(): DeckEntry[] {
  return [entry("job-a", "A", "developer", 0), entry("job-b", "B", "explore", 1)];
}

// A harness whose view opener is injectable (the throwing / rejecting
// variants are the two arms of the guard).
function makeHarness(
  entries: DeckEntry[],
  width: number,
  openJob: (key: string) => void | Promise<void>,
): { comp: ReturnType<typeof createAgentListComponent>; opens: string[] } {
  const h = { comp: undefined as unknown, opens: [] as string[] };
  let rows: AgentListLine[] = [];
  h.comp = createAgentListComponent(
    () => {
      rows = buildAgentListLines(entries, width, NOW);
      return rows;
    },
    () => width,
    (key) => {
      h.opens.push(key);
      return openJob(key);
    },
    () => {},
    () => ({ selected: (t) => t, muted: (t) => t }),
    () => {},
    killJobs,
  );
  h.comp.render(width);
  return h;
}

// ---------------------------------------------------------------------------
// 1. A THROWING view opener cannot escape the TUI input handler (the Enter
//    branch's try/catch arm — the opener is called, the throw is traced,
//    handleInput returns normally).
// ---------------------------------------------------------------------------
{
  const h = makeHarness(fixtureEntries(), 80, () => {
    throw new Error("sync boom");
  });
  h.comp.handleInput("\x1b[B"); // down → A (the guard under test is only the Enter branch)
  let threw = false;
  try {
    h.comp.handleInput("\r"); // Enter on A — the opener throws synchronously
  } catch {
    threw = true;
  }
  assert(!threw, "1a: a throwing view opener does not escape handleInput (try/catch guard)");
  assert(h.opens.length === 1 && h.opens[0] === "job-a", "1b: the opener was called with A's key before the throw");
}

// ---------------------------------------------------------------------------
// 2. A REJECTING view opener never becomes an unhandled rejection (the
//    .catch arm — the rejection is attached to the guard's `.catch`, so it
//    is handled and never surfaces to the process).
// ---------------------------------------------------------------------------
{
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => {
    unhandled.push(r);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = makeHarness(fixtureEntries(), 80, () =>
      new Promise<void>((_, reject) => reject(new Error("async boom"))),
    );
    h.comp.handleInput("\x1b[B"); // down → A
    h.comp.handleInput("\r"); // Enter on A — the opener rejects
    // Let the microtask queue drain so an unguarded rejection would surface
    // as an unhandledRejection before the listener is removed.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert(unhandled.length === 0, "2a: a rejecting view opener never becomes an unhandled rejection");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

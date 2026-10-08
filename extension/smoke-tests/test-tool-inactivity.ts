#!/usr/bin/env bun
/**
 * #951 — the inactivity watchdog must not kill a child whose silence is an
 * in-flight tool call.
 *
 * The #296 watchdog reset its clock on ANY stdout line, so a child whose last
 * event was a toolCall whose toolResult never arrived (a silent in-flight
 * bash — a full offline gate, a CI watch) read as a hang and was killed. The
 * fix: ONE poll, two budgets. While the in-flight set (spawn-inflight.ts) is
 * non-empty the tool-inactivity bound applies; when it is empty the
 * model-silence bound applies. Exactly one budget is armed at any poll.
 *
 * Fake-`pi`-on-PATH harness, same pattern as test-cancel.ts (a shell script
 * emitting JSONL then sleeping, test-shortened knobs). The fake child emits
 * one assistant message_end containing a toolCall block, then stays silent.
 * The env knobs are set per-case and saved/restored across the file.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSpecialist } from "../src/spawn.ts";
import { assert } from "./lib/test-cancel-probes.ts";

let exit = 0;
function assertLocal(cond: boolean, msg: string) {
  assert(cond, msg);
  if (!cond) exit = 1;
}

const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-951-"));
const savedPath = process.env.PATH;
const savedInactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;
const savedToolInactivity = process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS;
const savedSpawnTimeout = process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS;
const savedDispatchCaps = process.env.PI_ENSEMBLE_DISPATCH_CAPS;
const savedCapGrace = process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS;
const savedStale = process.env.PI_ENSEMBLE_STALE_THRESHOLD_MS;

process.env.PATH = `${fakeDir}:${savedPath}`;
// #1017 — the offline gate (verify-loop.sh) exports
// PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 for every offline test, and the guard fires
// before the fork, so even the fake-`pi`-on-PATH children below would fail on
// it. They cost no tokens (the `pi` on PATH is a shell script), so this test
// opts out of the guard locally — the same escape hatch the `*-live.ts`
// tests use for real children.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "300000"; // 5-min wall-clock cap, far above all case bounds
process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0"; // caps off: the subject is the watchdog
process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = "0";
// The two watchdog knobs must be VISIBLE to each child (they are read at
// child startup, not at the parent's spawn). The fake `pi` script exports
// the current parent values AT WRITE TIME (writeFakePi is called before each
// case sets its env), so each case's override lands in the child.
function writeFakePi(body: string) {
  const inactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS ?? "";
  const toolInactivity = process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS ?? "";
  const exportKnobs = `export PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS=${inactivity} PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS=${toolInactivity}`;
  writeFileSync(join(fakeDir, "pi"), ["#!/bin/sh", exportKnobs, body].join("\n"));
  chmodSync(join(fakeDir, "pi"), 0o755);
}

/** The JSONL one-liner an assistant message_end carrying a toolCall block.
 * Wrapped in echo so the shell script emits it as stdout, not executes it. */
const toolCallEnd =
  `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"sleep 30"}}]}}'`;

/** The JSONL one-liner a toolResult message for call_1. */
const toolResultLine =
  `echo '{"type":"message_end","message":{"role":"toolResult","toolName":"bash","toolCallId":"call_1","toolResults":[]}}'`;

/** Restore the process-wide env even when a case above throws. */
function restoreEnv() {
  process.env.PATH = savedPath;
  process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "";
  if (savedInactivity !== undefined) process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = savedInactivity;
  else delete process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;
  if (savedToolInactivity !== undefined)
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = savedToolInactivity;
  else delete process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS;
  if (savedSpawnTimeout !== undefined) process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = savedSpawnTimeout;
  else delete process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS;
  if (savedDispatchCaps !== undefined) process.env.PI_ENSEMBLE_DISPATCH_CAPS = savedDispatchCaps;
  else delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  if (savedCapGrace !== undefined) process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = savedCapGrace;
  else delete process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS;
  if (savedStale !== undefined) process.env.PI_ENSEMBLE_STALE_THRESHOLD_MS = savedStale;
  else delete process.env.PI_ENSEMBLE_STALE_THRESHOLD_MS;
}

try {
  // Case (a) — a child that emits a toolCall then goes silent past the
  // INACTIVITY bound (but under the tool bound) is NOT killed. The
  // in-flight-tool exemption is the whole point of #951.
  {
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = "120000";
    writeFakePi(`${toolCallEnd}\nsleep 10`);
    console.log("\n[test 951a] toolCall then silent past inactivity bound (not tool bound)...");
    const start = Date.now();
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    const elapsed = Date.now() - start;
    assertLocal(
      r.killCause === undefined && r.ok === true,
      `(a) tool-in-flight child NOT killed past inactivity bound (killCause=${r.killCause ?? "none"})`,
    );
    assertLocal(
      elapsed >= 9_000 && elapsed < 15_000,
      `(a) child survived to exit (took ${elapsed}ms)`,
    );
  }

  // Case (b) — the same child, silent past the TOOL bound, IS killed with
  // killCause 'tool-inactivity' and killBudgetMs = the tool bound.
  {
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = "3000";
    writeFakePi(`${toolCallEnd}\nsleep 30`);
    console.log("\n[test 951b] toolCall then silent past tool bound...");
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assertLocal(r.ok === false, "(b) tool-inactivity-killed child reports ok=false");
    assertLocal(
      r.killCause === "tool-inactivity",
      `(b) killCause='tool-inactivity' (got ${r.killCause ?? "none"})`,
    );
    assertLocal(
      r.killBudgetMs === 3000,
      `(b) killBudgetMs = the tool bound (got ${r.killBudgetMs})`,
    );
    assertLocal(
      r.lastActivity?.kind === "toolCall in flight: bash",
      `(b) lastActivity names the in-flight tool (got ${r.lastActivity?.kind})`,
    );
  }

  // Case (c) — a child with NO tool in flight is killed at the inactivity
  // bound with cause 'inactivity' (the #296 behaviour is untouched).
  {
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "1500";
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = "5000";
    writeFakePi(`sleep 30`);
    console.log("\n[test 951c] silent child, no tool in flight...");
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assertLocal(
      r.killCause === "inactivity",
      `(c) silent child carries killCause='inactivity' (got ${r.killCause ?? "none"})`,
    );
    assertLocal(
      r.killBudgetMs === 1500,
      `(c) killBudgetMs = the inactivity bound (got ${r.killBudgetMs})`,
    );
    assertLocal(r.ok === false, "(c) inactivity-killed child reports ok=false");
  }

  // Case (d) — a toolResult closes the span, so subsequent silence kills
  // with cause 'inactivity' (the model-silence bound) again.
  {
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "3000";
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = "6000";
    writeFakePi(`${toolCallEnd}\n${toolResultLine}\nsleep 30`);
    console.log("\n[test 951d] toolResult closes the span...");
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assertLocal(
      r.killCause === "inactivity",
      `(d) post-toolResult silence → 'inactivity' (got ${r.killCause ?? "none"})`,
    );
    assertLocal(
      r.killBudgetMs === 3000,
      `(d) killBudgetMs = the inactivity bound (got ${r.killBudgetMs})`,
    );
  }

  // Case (e) — two concurrent toolCalls where one result arrives keeps the
  // span open (the second tool is still in flight).
  {
    const twoCalls =
      `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"a"}},{"type":"toolCall","id":"call_2","name":"read","arguments":{"path":"x"}}]}}'`;
    const res1 =
      `echo '{"type":"message_end","message":{"role":"toolResult","toolName":"bash","toolCallId":"call_1","toolResults":[]}}'`;
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "1500";
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = "3000";
    writeFakePi(`${twoCalls}\n${res1}\nsleep 30`);
    console.log("\n[test 951e] two toolCalls, one result arrives...");
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assertLocal(
      r.killCause === "tool-inactivity",
      `(e) second tool still in flight → 'tool-inactivity' (got ${r.killCause ?? "none"})`,
    );
    assertLocal(
      r.lastActivity?.kind === "toolCall in flight: read",
      `(e) lastActivity names the surviving tool (got ${r.lastActivity?.kind})`,
    );
  }

  // Case (f) — PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS=0 alone still leaves the
  // tool bound armed: a tool-in-flight child is killed at the tool bound.
  {
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0";
    process.env.PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS = "3000";
    writeFakePi(`${toolCallEnd}\nsleep 30`);
    console.log("\n[test 951f] inactivity=0 alone, tool bound armed...");
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" });
    assertLocal(
      r.killCause === "tool-inactivity",
      `(f) tool-inactivity bound still fires with inactivity=0 (got ${r.killCause ?? "none"})`,
    );
    assertLocal(
      r.killBudgetMs === 3000,
      `(f) killBudgetMs = the tool bound (got ${r.killBudgetMs})`,
    );
  }
} finally {
  restoreEnv();
  rmSync(fakeDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

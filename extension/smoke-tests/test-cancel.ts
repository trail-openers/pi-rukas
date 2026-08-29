#!/usr/bin/env bun
/**
 * Verify the two new escape hatches in spawnSpecialist:
 *   1. AbortSignal — Esc cancellation kills the child within a few seconds
 *   2. timeoutMs default — runaway children get SIGTERM'd at the deadline
 *
 * Both are critical: without them an entire Pi session can deadlock on a
 * hung child (observed in the wild — overnight stuck session).
 */

import { spawnSpecialist } from "../src/spawn.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Test 1 — AbortSignal cancels mid-flight.
{
  console.log("[test] firing explore child, will abort after 1500ms...");
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(() => controller.abort(), 1500);
  const r = await spawnSpecialist(
    {
      role: "explore",
      // Force the model to take a few seconds (the actual prompt doesn't
      // matter — we abort before it finishes).
      prompt:
        "Think step by step about prime numbers under 100, list them all with explanations of why each is prime. Take your time.",
    },
    { signal: controller.signal, timeoutMs: 60_000 },
  );
  const elapsed = Date.now() - start;
  assert(elapsed < 10_000, `aborted child returned within 10s (took ${elapsed}ms)`);
  assert(r.ok === false, "aborted child reports ok=false");
  console.log(`  → exit=${r.exitCode} text="${r.text.slice(0, 80)}"`);
}

// Test 2 — timeoutMs caps a runaway child.
{
  console.log("\n[test] firing explore child with 2000ms timeout...");
  const start = Date.now();
  const r = await spawnSpecialist(
    {
      role: "explore",
      prompt:
        "Carefully reason through 10 different math problems and explain each step. Take your time.",
    },
    { timeoutMs: 2000 },
  );
  const elapsed = Date.now() - start;
  assert(elapsed < 12_000, `timed-out child returned within 12s (took ${elapsed}ms)`);
  assert(r.ok === false, "timed-out child reports ok=false");
  console.log(`  → exit=${r.exitCode} text="${r.text.slice(0, 80)}"`);
}

// Tests 3-4 (#296) — inactivity watchdog, fully offline via a fake `pi`
// binary on PATH (getPiInvocation falls back to PATH lookup outside a real
// pi process, which is exactly the smoke-test context).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-"));
const savedPath = process.env.PATH;
const savedInactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;

// Test 3 — a totally silent child is killed by the inactivity watchdog long
// before the wall-clock cap.
{
  writeFileSync(join(fakeDir, "pi"), "#!/bin/sh\nexec sleep 300\n");
  chmodSync(join(fakeDir, "pi"), 0o755);
  process.env.PATH = `${fakeDir}:${savedPath}`;
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
  console.log("\n[test] silent fake child, 2000ms inactivity budget...");
  const start = Date.now();
  const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 60_000 });
  const elapsed = Date.now() - start;
  assert(elapsed < 15_000, `inactivity-killed child returned early (took ${elapsed}ms)`);
  assert(r.ok === false, "#296: inactivity-killed child reports ok=false");
  assert(r.killCause === "inactivity", "#296: silent child carries killCause='inactivity'");
  assert(r.killBudgetMs === 2000, "#296: inactivity killBudgetMs records the budget");
}

// Test 4 — a child that keeps streaming stdout OUTLIVES the inactivity
// window unharmed (any output resets the watchdog; only true silence kills).
{
  writeFileSync(
    join(fakeDir, "pi"),
    [
      "#!/bin/sh",
      "i=0",
      'while [ $i -lt 10 ]; do echo "noise $i"; i=$((i+1)); sleep 0.5; done',
      `echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"survived"}]}]}'`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(fakeDir, "pi"), 0o755);
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
  console.log("\n[test] streaming fake child (5s of 500ms-spaced output, 2000ms budget)...");
  const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 60_000 });
  assert(r.killCause === undefined, "#296: streaming child is NOT killed by the watchdog");
  assert(r.exitCode === 0 && r.ok === true, "#296: streaming child completes cleanly");
  assert(r.text.includes("survived"), "#296: streaming child's final text survives");
}

// Test 5 (#296) — wall-clock cap kill carries killCause='timeout' + budget.
// Deterministic: silent fake child, inactivity watchdog disabled.
{
  writeFileSync(join(fakeDir, "pi"), "#!/bin/sh\nexec sleep 300\n");
  chmodSync(join(fakeDir, "pi"), 0o755);
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0";
  console.log("\n[test] silent fake child, 1500ms wall-clock cap, watchdog off...");
  const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 1500 });
  assert(r.ok === false, "#296: cap-killed child reports ok=false");
  assert(r.killCause === "timeout", "#296: cap-killed child carries killCause='timeout'");
  assert(r.killBudgetMs === 1500, "#296: killBudgetMs records the expired wall-clock budget");
}

process.env.PATH = savedPath;
if (savedInactivity) process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = savedInactivity;
else process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = undefined;
rmSync(fakeDir, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);

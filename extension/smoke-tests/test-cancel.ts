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

console.log(`\nexit ${exit}`);
process.exit(exit);

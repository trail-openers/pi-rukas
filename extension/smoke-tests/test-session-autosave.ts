#!/usr/bin/env bun
/**
 * Pure unit test for session-autosave (#23).
 *
 * Exercises the deterministic-extract module plus the writeToVipune failure
 * modes that the audit (#171) flagged as previously uncovered. We verify:
 *   - hadMeaningfulWork() reflects accumulated dispatches
 *   - buildSessionSummary() produces a one-line, bounded extract that
 *     names roles, totals, and outcomes faithfully
 *   - elapsed formatting handles s / m / h ranges
 *   - 1000-char truncation kicks in for pathological inputs
 *   - writeToVipune() returns false when vipune is not on PATH (ENOENT)
 *   - writeToVipune() returns false when vipune hangs past VIPUNE_TIMEOUT_MS
 *
 * Failure modes are tested by manipulating $PATH rather than mocking
 * execFileSync — the real spawn-and-fail path is what production hits,
 * so we exercise it directly. The attach()/handler-wiring path is still
 * exercised indirectly by the shutdown flow during live spawn tests.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSessionSummary,
  hadMeaningfulWork,
  recordDispatch,
  recordOutcome,
  reset,
  snapshot,
  writeToVipune,
} from "../src/session-autosave.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. Fresh state: no meaningful work, summary still extractable but trivial.
{
  reset();
  assert(hadMeaningfulWork() === false, "fresh state: no meaningful work");
  const snap = snapshot();
  assert(snap.outcomes.completed === 0 && snap.outcomes.failed === 0, "fresh outcomes are zero");
  assert(Object.keys(snap.dispatchesByRole).length === 0, "fresh dispatch map is empty");
}

// 2. recordDispatch accumulates per-role counts.
{
  reset();
  recordDispatch("developer");
  recordDispatch("developer");
  recordDispatch("ops");
  recordDispatch("explore");
  assert(hadMeaningfulWork() === true, "had work after dispatches");
  const snap = snapshot();
  assert(snap.dispatchesByRole.developer === 2, "developer count is 2");
  assert(snap.dispatchesByRole.ops === 1, "ops count is 1");
  assert(snap.dispatchesByRole.explore === 1, "explore count is 1");
}

// 3. recordOutcome accumulates ok/fail counters.
{
  reset();
  recordOutcome(true);
  recordOutcome(true);
  recordOutcome(false);
  const snap = snapshot();
  assert(snap.outcomes.completed === 2, "completed count is 2");
  assert(snap.outcomes.failed === 1, "failed count is 1");
}

// 4. buildSessionSummary names roles, total, and outcome status.
{
  reset();
  recordDispatch("developer");
  recordDispatch("developer");
  recordDispatch("ops");
  recordOutcome(true);
  recordOutcome(true);
  recordOutcome(true);
  const s = buildSessionSummary();
  assert(s.includes("3 dispatches"), `summary names total: "${s}"`);
  assert(s.includes("2 developer"), `summary names developer count: "${s}"`);
  assert(s.includes("1 ops"), `summary names ops count: "${s}"`);
  assert(s.includes("all completed cleanly"), `clean outcome shown: "${s}"`);
}

// 5. Mixed outcomes show breakdown rather than "all clean".
{
  reset();
  recordDispatch("developer");
  recordDispatch("developer");
  recordOutcome(true);
  recordOutcome(false);
  const s = buildSessionSummary();
  assert(s.includes("1 ok, 1 failed"), `mixed outcome breakdown shown: "${s}"`);
  assert(!s.includes("all completed cleanly"), "no 'all clean' when failures exist");
}

// 6. Singular vs plural "dispatch"/"dispatches".
{
  reset();
  recordDispatch("developer");
  const s = buildSessionSummary();
  assert(s.includes("1 dispatch (1 developer)"), `singular form for single dispatch: "${s}"`);
  assert(!s.includes("1 dispatches"), "no 'dispatches' when count is 1");
}

// 7. No-dispatch summary is still safe to build (though attach() filters it).
{
  reset();
  const s = buildSessionSummary();
  assert(s.includes("no dispatches"), `no-work summary still extractable: "${s}"`);
  assert(!s.includes("· ·"), "no orphaned separator when total=0");
}

// 8. Elapsed formatting: seconds vs minutes vs hours.
{
  reset();
  recordDispatch("developer");
  const start = snapshot().startedAt;
  // 45 seconds
  const sSec = buildSessionSummary(start + 45_000);
  assert(sSec.includes("(45s)"), `<60s shows seconds: "${sSec}"`);

  // 5 minutes 30 seconds
  const sMin = buildSessionSummary(start + 5 * 60_000 + 30_000);
  assert(sMin.includes("(5m30s)"), `>1m shows m+s: "${sMin}"`);

  // 2 hours 15 minutes
  const sHr = buildSessionSummary(start + (2 * 60 + 15) * 60_000);
  assert(sHr.includes("(2h15m)"), `>1h shows h+m: "${sHr}"`);
}

// 9. Summary is bounded — pathologically many distinct roles still ≤1000 chars.
{
  reset();
  // 200 distinct synthetic roles
  for (let i = 0; i < 200; i++) recordDispatch(`role-with-medium-name-${i}`);
  const s = buildSessionSummary();
  assert(s.length <= 1000, `summary truncated to ≤1000 chars (actual: ${s.length})`);
  if (s.length === 1000) assert(s.endsWith("…"), "truncation marker present at boundary");
}

// 10. roleBreakdown is sorted by descending count (highest first).
{
  reset();
  recordDispatch("ops");
  recordDispatch("developer");
  recordDispatch("developer");
  recordDispatch("developer");
  recordDispatch("explore");
  recordDispatch("explore");
  const s = buildSessionSummary();
  const breakdown = s.slice(s.indexOf("("), s.indexOf(")") + 1);
  // developer (3) should appear before explore (2) which should appear before ops (1)
  const devIdx = s.indexOf("3 developer");
  const expIdx = s.indexOf("2 explore");
  const opsIdx = s.indexOf("1 ops");
  assert(devIdx > -1 && expIdx > -1 && opsIdx > -1, `all three roles present: "${breakdown}"`);
  assert(devIdx < expIdx && expIdx < opsIdx, "roles sorted by count descending");
}

// 11. writeToVipune returns false when the binary path doesn't exist (ENOENT).
// Pass an absolute path to a non-existent file rather than rely on PATH
// manipulation — Bun's child_process resolves PATH at process startup so
// runtime overrides don't reach the spawn. opts.binaryPath bypasses PATH
// entirely (execFileSync takes the path verbatim when it contains a slash).
{
  const result = writeToVipune("test session summary — ENOENT path", {
    binaryPath: "/nonexistent-pi-ensemble-test-vipune",
  });
  assert(result === false, "writeToVipune returns false when binary doesn't exist (ENOENT)");
}

// 12. writeToVipune returns false when the binary exceeds VIPUNE_TIMEOUT_MS.
// Write a stub shell script that sleeps longer than the 5s timeout; the
// execFileSync call kills it and throws, which writeToVipune catches and
// converts to false.
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ensemble-autosave-test-"));
  const stub = path.join(dir, "vipune");
  writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
  chmodSync(stub, 0o755);
  const t0 = Date.now();
  const result = writeToVipune("test session summary — timeout path", {
    binaryPath: stub,
  });
  const elapsed = Date.now() - t0;
  assert(result === false, "writeToVipune returns false when vipune hangs past VIPUNE_TIMEOUT_MS");
  // Should bail close to the 5s cap, not run the full 30s sleep.
  assert(elapsed < 10_000, `writeToVipune bailed inside the 10s budget (actual: ${elapsed}ms)`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);

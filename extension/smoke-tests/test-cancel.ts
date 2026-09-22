#!/usr/bin/env bun
/**
 * Verify the two escape hatches in spawnSpecialist (AbortSignal / timeoutMs)
 * plus the #296 inactivity watchdog — fully offline.
 *
 * #809 — the two REAL-spawn sections that used to live here (an abort probe
 * and a 2000ms-timeout probe against genuine `pi` children, asserting
 * `elapsed < 10s` / `elapsed < 12s`) are timing-flaky and cost two false
 * parks (cycles #777 and #798: 496954ms against a 10s bound). The wall clock
 * measured parent + child + provider round-trip under up to 6 concurrent Pi
 * processes, and on a laptop that may sleep — the 497s observation is a
 * process that was descheduled, not an abort path that is slow. They moved to
 * `test-cancel-realspawn-live.ts`, which keeps the same two spawns (token cost
 * unchanged) but asserts the SEMANTIC outcome (killCause attribution) instead
 * of elapsed seconds. It is `*-live.ts` (excluded from the offline gate) —
 * CI does not install `pi`, and a real-spawn section glob-matched into the
 * offline suite would crash there on a missing binary rather than skip.
 *
 * The abort-path semantics they covered are now ALSO exercised deterministically
 * here (tests 1–2) against a fake `pi` on PATH — the same pattern as tests
 * 3–5 — so the offline suite kills a real child via the exact `onAbort`
 * code path and checks the result, with no wall-clock bound to flake on and
 * no provider involved.
 *
 * Self-check (bottom of file): the abort probe's predicate is asserted
 * against fabricated results so this test goes RED when a broken abort path
 * would stop attributing — the same shape test-file-size-limit.ts applies
 * to itself.
 */

import { spawnSpecialist } from "../src/spawn.ts";
import {
  ABORT_PROMPT,
  runAbortProbe,
  type AbortProbeResult,
} from "./lib/test-cancel-probes.ts";

/**
 * The abort probe's pass/fail predicate, isolated so the self-check at the
 * bottom can prove it discriminates: a correctly attributed abort passes,
 * and any broken-path shape (no attribution, ok=true, wrong cause) fails —
 * the same shape test-file-size-limit.ts applies to itself.
 */
function abortProbePasses(p: AbortProbeResult): boolean {
  return p.killCause === "abort" && p.ok === false;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-"));
const savedPath = process.env.PATH;
const savedInactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;

/** A fake `pi` that stays alive until killed (TERM-trapping variant included). */
function writeFakePi(trapTerm = false) {
  writeFileSync(
    join(fakeDir, "pi"),
    ["#!/bin/sh", trapTerm ? "trap '' TERM" : "true", "exec sleep 300"].join("\n"),
  );
  chmodSync(join(fakeDir, "pi"), 0o755);
}

process.env.PATH = `${fakeDir}:${savedPath}`;
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0"; // abort tests: pure abort path

// Test 1 — AbortSignal kills the child mid-flight (deterministic fake child).
// Uses the same SIGTERM→SIGKILL kill function the #296 watchdog uses (the
// subject is the attribution; the watchdog poll loop itself is tests 3–4).
// The wall clock is logged for observability and never fails.
{
  writeFakePi();
  console.log("[test] fake child, abort after 1500ms...");
  const p = await runAbortProbe(ABORT_PROMPT);
  assert(p.ok, "aborted fake child: killCause='abort' + ok=false");
  p.lines.forEach((l) => console.log(l));
}

// Test 2 — the SIGTERM→SIGKILL escalation: a child that IGNORES SIGTERM is
// still killed by the 5s SIGKILL timer. This was previously uncovered — the
// real-spawn sections could not demonstrate it, because a healthy real child
// exits on SIGTERM before the escalation ever matters.
{
  writeFakePi(true);
  console.log("\n[test] fake child traps SIGTERM; SIGKILL escalation expected...");
  const p = await runAbortProbe(ABORT_PROMPT);
  assert(p.ok, "TERM-trapping child: killCause='abort' + ok=false");
  p.lines.forEach((l) => console.log(l));
  assert(
    p.elapsedMs >= 5_000,
    `SIGKILL escalation fired (wall ${p.elapsedMs}ms ≥ 5000ms; TERM was trapped)`,
  );
  assert(
    p.exitCode === null || p.exitCode === -9,
    `TERM-trapping child died to SIGKILL (exit=${p.exitCode})`,
  );
}

// Test 3 — a totally silent child is killed by the inactivity watchdog long
// before the wall-clock cap.
{
  writeFileSync(join(fakeDir, "pi"), "#!/bin/sh\nexec sleep 300\n");
  chmodSync(join(fakeDir, "pi"), 0o755);
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

// Self-check — the abort probe's own predicate must discriminate: a
// correctly attributed abort passes, and each broken-path shape (no
// attribution, ok=true, wrong cause) fails. Same shape test-file-size-limit.ts
// applies to itself: a test that cannot go RED is decorative.
{
  const fabricated = (killCause: string | undefined, ok: boolean) =>
    abortProbePasses({ ok, lines: [], killCause, exitCode: null, elapsedMs: 0 });
  assert(fabricated("abort", false) === true, "self-check: attributed abort (killCause + ok=false) passes");
  assert(fabricated(undefined, false) === false, "self-check: missing killCause fails");
  assert(fabricated("timeout", false) === false, "self-check: wrong cause fails");
  assert(fabricated("abort", true) === false, "self-check: ok=true abort fails");
}

process.env.PATH = savedPath;
if (savedInactivity) process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = savedInactivity;
else process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = undefined;
rmSync(fakeDir, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);

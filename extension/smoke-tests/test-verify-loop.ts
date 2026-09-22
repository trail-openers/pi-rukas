#!/usr/bin/env bun
/**
 * Issue #803 — verify-loop: run-all smoke-test loop.
 *
 * Tests the shared loop at smoke-tests/lib/verify-loop.sh against the
 * fixture scripts in smoke-tests/fixtures/verify-loop/.
 *
 * Cases:
 *   1. Five fixtures where 1, 3, 5 fail: all three named in the summary,
 *      exit non-zero, final line is the summary marker.
 *   2. All-pass fixture set: exit 0, no summary marker.
 *   3. Truncation: a failure set whose details exceed 800 chars;
 *      extractAttributedTail(output, 800) still yields the summary line.
 *   4. Single-execution: a fixture that appends to a counter file;
 *      assert it ran exactly once despite failing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(__dirname, "fixtures", "verify-loop");
const SCRIPT = path.join(__dirname, "lib", "verify-loop.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function runLoop(files: string[]): { status: number; stdout: string } {
  const result = spawnSync("bash", [SCRIPT, ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout };
}

// --- Case 1: 5 fixtures, 1/3/5 fail ---
{
  const files = [1, 2, 3, 4, 5].map((n) => path.join(FIXTURES, `fixture-${n}.ts`));
  const { status, stdout } = runLoop(files);
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];

  assert(status !== 0, "case 1: exit non-zero when any test fails");
  assert(lastLine.startsWith("FAILED: 3 test(s) —"), "case 1: final line is summary marker with count 3");
  assert(
    lastLine.includes("fixture-1.ts") && lastLine.includes("fixture-3.ts") && lastLine.includes("fixture-5.ts"),
    "case 1: summary names all three failing fixtures",
  );
  assert(!lastLine.includes("fixture-2.ts") && !lastLine.includes("fixture-4.ts"), "case 1: summary does not name passing fixtures");

  // Per-failure markers retained
  const markers = stdout.split("\n").filter((l) => /^FAILED: .*fixture-\d\.ts$/.test(l) && !/test\(s\)/.test(l));
  assert(markers.length === 3, `case 1: 3 per-failure FAILED markers (got ${markers.length})`);
}

// --- Case 2: all-pass ---
{
  const files = [path.join(FIXTURES, "allpass-a.ts"), path.join(FIXTURES, "allpass-b.ts")];
  const { status, stdout } = runLoop(files);
  assert(status === 0, "case 2: exit 0 when all pass");
  assert(!stdout.includes("FAILED:"), "case 2: no FAILED marker on all-pass run");
}

// --- Case 3: truncation via extractAttributedTail ---
{
  // Use the verbose fixture (produces ~2000 chars) plus the 3 failing fixtures
  // so the total output well exceeds 800 chars.
  const files = [
    path.join(FIXTURES, "fixture-1.ts"),
    path.join(FIXTURES, "fixture-3.ts"),
    path.join(FIXTURES, "fixture-verbose.ts"),
    path.join(FIXTURES, "fixture-5.ts"),
  ];
  const { stdout } = runLoop(files);
  assert(stdout.length > 800, `case 3: output exceeds 800 chars (${stdout.length})`);

  const { tail, attributed } = extractAttributedTail(stdout, 800);
  assert(attributed, "case 3: tail is attributed (anchored on a FAILED marker)");
  assert(tail.startsWith("FAILED: 4 test(s) —"), "case 3: summary marker survives truncation");
  assert(tail.includes("fixture-1.ts"), "case 3: leading name survives truncation");
  assert(tail.length <= 800, `case 3: tail respects maxLen 800 (got ${tail.length})`);
}

// --- Case 4: single-execution ---
{
  const counterFile = path.join(tmpdir(), `verify-loop-counter-${process.pid}`);
  rmSync(counterFile, { force: true });
  writeFileSync(counterFile, "");

  try {
    const files = [path.join(FIXTURES, "fixture-counter.ts")];
    // Pass the counter file path via env
    const result = spawnSync("bash", [SCRIPT, ...files], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, FIXTURE_COUNTER_FILE: counterFile },
    });
    const lines = readFileSync(counterFile, "utf-8").split("\n").filter((l) => l.trim());
    assert(lines.length === 1, `case 4: fixture ran exactly once (got ${lines.length} invocations)`);
  } finally {
    rmSync(counterFile, { force: true });
  }
}

console.log(exit === 0 ? "\nAll verify-loop checks passed." : "\nFAILED");
process.exit(exit);

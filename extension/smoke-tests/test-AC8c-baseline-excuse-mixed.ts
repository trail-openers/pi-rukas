#!/usr/bin/env bun
/**
 * #2042 — one pytest line poisoning an otherwise excusable pair refuses the excuse.
 *
 * The excuse reads pytest's `path::name` identities and nothing else, and a stream
 * that carries a failing line this module cannot name is not evidence about which
 * tests failed: a TAP description or a go test name folds two different checks onto
 * one token in ways three reviews each found a new instance of. So one such line in
 * either stream refuses the WHOLE excuse — the pytest names it printed beside it do
 * not get to excuse the unnamed ones — and today's red stands.
 *
 * The pytest pair below is the control that keeps this from being a blanket refusal.
 */
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC8-baseline-excuse-tap.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
/** Two trees that are definitely different directories. */
const HEAD_ROOT = "/tmp/pi-rukas-2042-tap/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2042-tap/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'prove -r t'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

{
  const PY = "FAILED tests/x_test.py::test_a - AssertionError";
  assert(excuseOf([PY], [PY]).kind === "excused", "(mixed) the pytest pair alone still excuses");
  assert(
    excuseOf([PY, "not ok 1 - a bats check"], [PY]).kind === "refused",
    "(mixed) one TAP line in the HEAD stream refuses the whole excuse",
  );
  assert(
    excuseOf([PY], [PY, "--- FAIL: TestSolo (0.01s)"]).kind === "refused",
    "(mixed) one go line in the BASE stream refuses it too",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);

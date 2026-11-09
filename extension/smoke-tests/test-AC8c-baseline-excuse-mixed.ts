#!/usr/bin/env bun
/**
 * #2064 / #2100 — one unreadable line poisons an otherwise excusable pair, in any dialect.
 *
 * Whole-line matching is runner-agnostic across the shapes the shared classifier
 * recognises, so a pytest pair, a TAP pair and a go pair each excuse on their own —
 * those are the controls that keep this from being a blanket refusal. What still refuses
 * is ANY line the head printed that the base did not, INCLUDING the ones the classifier
 * cannot read: a tally in a dialect the table does not carry, a bare file verdict, a
 * comment line, a shell trace. One such line in either stream poisons the WHOLE excuse,
 * because the lines printed beside it do not get to excuse a line nothing read.
 *
 * And the shape the parser-era tests pinned as a refusal is now a pass: a TAP line
 * beside a pytest line, printed identically on both sides, excuses — the field case
 * this change exists for.
 */
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC8c-baseline-excuse-mixed.ts";
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
const HEAD_ROOT = "/tmp/pi-rukas-2064-mixed/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-mixed/repo.baseline-lean-verify-9";

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

const PY = "FAILED tests/x_test.py::test_a - AssertionError";
const TAP = "not ok 1 - a bats check";
const GO = "--- FAIL: TestSolo (0.01s)";

// ------------------------------------- (control) each recognised dialect excuses on its own
{
  assert(excuseOf([PY], [PY]).kind === "excused", "(control) the pytest pair excuses");
  assert(excuseOf([TAP], [TAP]).kind === "excused", "(control) the TAP pair excuses");
  assert(excuseOf([GO], [GO]).kind === "excused", "(control) the go pair excuses");
  // The mixed-runner pair the parser era refused outright.
  assert(
    excuseOf([PY, TAP], [PY, TAP]).kind === "excused",
    `(control) a pytest line beside a TAP line, both printed at base, excuses (${excuseOf([PY, TAP], [PY, TAP]).kind})`,
  );
}

// --------------------- (unreadable) an unread head-only line poisons the whole excuse
{
  // A tally in a dialect the table does not carry, a bare file verdict, a TAP comment and
  // a shell trace: each declares something and none is readable. The excuse's comparison
  // covers EVERY head line, so a head-only one of these refuses the whole tier — the
  // matching recognised pair beside it does not get to excuse a line nothing read. The
  // control inside each case is the same line printed by BOTH runs, which excuses.
  const HEAD_ONLY_UNREAD = [
    "FAILED a test.sh",
    "ERROR 17 tests blew up",
    "# not ok 9 - /t/brand_new.t - boom",
    "+ not ok 7 - a trace line the table does not carry",
    "killed",
  ];
  for (const unreadable of HEAD_ONLY_UNREAD) {
    assert(
      excuseOf([TAP, unreadable], [TAP]).kind === "refused",
      `(unreadable) "${unreadable}" printed only at head refuses the whole excuse (${excuseOf([TAP, unreadable], [TAP]).kind})`,
    );
    assert(
      excuseOf([TAP, unreadable], [TAP, unreadable]).kind === "excused",
      `(unreadable) "${unreadable}" printed by BOTH runs excuses, so the refusal is the head-only line (${excuseOf([TAP, unreadable], [TAP, unreadable]).kind})`,
    );
    assert(
      excuseOf([TAP], [unreadable]).kind === "refused" &&
        excuseOf([unreadable], [TAP]).kind === "refused",
      `(unreadable) "${unreadable}" as a stream's ONLY line leaves it naming nothing, and refuses (${excuseOf([TAP], [unreadable]).kind}/${excuseOf([unreadable], [TAP]).kind})`,
    );
  }
  assert(
    excuseOf([PY, TAP, GO], [PY, TAP, GO]).kind === "excused",
    "(unreadable) three recognised dialects, no unreadable line, still excuse",
  );
}

// ------------------------------------------- (empty) a stream that names nothing excuses
{
  assert(
    excuseOf(["built 14 packages in 3s"], [PY]).kind === "refused",
    "(empty) a head stream with no recognised failure line excuses nothing",
  );
  assert(
    excuseOf([PY], ["built 14 packages in 3s"]).kind === "refused",
    "(empty) a base stream with none excuses nothing either",
  );
  assert(
    excuseOf([], []).kind === "refused",
    "(empty) and two empty streams are no evidence about either run",
  );
}

// -------------------------------------- (same tree) one tree compares against nothing
{
  const r = baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'prove -r t'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: TAP,
    baseStream: TAP,
    headRoot: HEAD_ROOT,
    probeRoot: HEAD_ROOT,
  });
  assert(r.kind === "refused", `(same tree) one tree printed twice is every line its own echo (${r.kind})`);
}

// ------------------------------------------- (missing deps) an unprovisioned base refuses
{
  const r = excuseOf([PY], ["npm: command not found"]);
  assert(
    r.kind === "refused",
    `(missing deps) a base red shaped like a tree that was never linked excuses nothing (${r.kind})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);

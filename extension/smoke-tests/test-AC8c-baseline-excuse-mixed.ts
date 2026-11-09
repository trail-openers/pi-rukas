#!/usr/bin/env bun
/**
 * #2064 — one unreadable line poisons an otherwise excusable pair, in any dialect.
 *
 * Whole-line matching is runner-agnostic across the shapes the shared classifier
 * recognises, so a pytest pair, a TAP pair and a go pair each excuse on their own —
 * those are the controls that keep this from being a blanket refusal. What still
 * refuses is a line that declares a failing test the classifier does NOT recognise:
 * one such line in either stream refuses the WHOLE excuse, because the lines it
 * printed beside it do not get to excuse the unread one.
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

// ---------------------------- (unreadable) an unread line is inert; an empty set refuses
{
  // A tally in a dialect the table does not carry, and a bare file verdict: both declare
  // a failing test and neither is readable. The excuse reads only recognised lines, so
  // such a line is INERT on either side — what refuses is the EMPTY recognised set, which
  // is what stops a base that named nothing from counting as evidence the base was red.
  const RECORDED = ["FAILED a test.sh", "ERROR 17 tests blew up"];
  for (const unreadable of RECORDED) {
    assert(
      excuseOf([TAP, unreadable], [TAP]).kind === "excused" &&
        excuseOf([TAP], [TAP, unreadable]).kind === "excused",
      `(unreadable) "${unreadable}" is inert on either side beside a matching recognised pair (${excuseOf([TAP, unreadable], [TAP]).kind}/${excuseOf([TAP], [TAP, unreadable]).kind})`,
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

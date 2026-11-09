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
import { preexistingFailuresProblem } from "../src/lean/state-outcome-maps.ts";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
import { baselineExcuse, failureLinesOf } from "../src/lean/verify-baseline-excuse.ts";
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
/** One line the shared classifier reads NOTHING from — prose, not a verdict. */
const UNREAD = "some runner prose the table does not carry";
/** The fixture's marker line, which the shared classifier reads as a TAP failure. */
const MARKER = "not ok 1 - boom from the fast tier";

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
  // The one residue the excuse still discounts is the line the EXECUTOR wrote — `exec.ts`'s
  // `Command failed: <cmd>` — and the discount is anchored to the whole line quoting the
  // command both runs were given. A line that merely shares a prefix with an executor form
  // is not executor writing: `Exit code: 1` is what a run nobody judged leaves behind, so a
  // head-only one is an unread defect and refuses.
  assert(
    excuseOf([TAP, "Exit code: 1"], [TAP]).kind === "refused",
    "(residue) a head-only `Exit code: 1` is not the executor's echo and refuses",
  );
  // The two shape patterns `harnessResidue` used to carry discounted a line BY SHAPE, so a
  // line only the HEAD printed walked free — and neither pattern ever matched anything the
  // EXECUTOR wrote (`exec.ts`'s `execShell` prints one line, `Command failed: <cmd>`). The
  // head-only arms below are the whole of defect 1: the base never printed these lines, so
  // each is a head-only line, and a head-only line excuses nothing.
  for (const shape of ["tier-said-fast", "boom from the fast tier"]) {
    assert(
      excuseOf([TAP, shape], [TAP]).kind === "refused",
      `(residue) a head-only "${shape}" is nobody's echo and refuses (${excuseOf([TAP, shape], [TAP]).kind})`,
    );
  }
  // The fixture's own marker line is a line the classifier READS, so the excuse compares it
  // like any other gate line.
  assert(
    failureLinesOf(MARKER).length === 1,
    `(residue) the fixture marker is a line the classifier reads, so it is comparable evidence (${JSON.stringify(failureLinesOf(MARKER))})`,
  );
  assert(
    excuseOf([TAP, MARKER], [TAP]).kind === "refused",
    "(residue) a head-only fixture marker the base never printed refuses — no pattern excuses a readable line",
  );
  // No excuse may be GRANTED over a stream pair that names no failing check. A head left
  // with only discounted residue has an EMPTY key set, and `head.length === 0` refuses it
  // before the line-for-line comparison runs — which is the right place: a comparison of two
  // empty sets is vacuously true, and a green built on it would be a
  // `## Pre-existing test failures` section claiming "these checks also fail at the base
  // commit" over no check at all. Both arms below pin the behaviour, not the guard's
  // location: the refusal must hold however the unread lines are arranged, and it must NOT
  // spill over into a blanket rule that refuses a head that does name a real check.
  const unreadPair = excuseOf([UNREAD], [UNREAD]);
  assert(
    unreadPair.kind === "refused",
    "(empty) identical unread-only output on both sides names no failure, and refuses",
  );
  assert(
    failureLinesOf(UNREAD).length === 0 &&
      excuseOf([UNREAD, TAP], [UNREAD, TAP]).kind === "excused",
    "(empty) the same head with one classifier-read line excuses — so the refusal is the EMPTY SET, not a blanket rule",
  );
  // The disclosure a granted excuse writes must be the log's own reader's shape: non-empty
  // `names`, a positive `total`. The refusal above is what guarantees the two never disagree.
  assert(
    excuseOf([PY, "Exit code: 1"], [PY, "Exit code: 1"]).kind === "excused" &&
      preexistingFailuresProblem({
        fast: (excuseOf([PY, "Exit code: 1"], [PY, "Exit code: 1"]) as { record: PreexistingTierRecord })
          .record,
      }) === undefined,
    "(empty) every excuse the rule grants carries a non-empty name set the step log accepts",
  );
  assert(
    excuseOf([PY], ["built 14 packages in 3s"]).kind === "refused",
    "(empty) a base stream with none excuses nothing either",
  );
  // The vacuous-excue case the read-set rule speaks to: a head and a base that printed the
  // SAME harness stamps and nothing else. No classifier-read failure means no name for the
  // disclosure, so the excuse cannot be granted. The stamp shapes are the same ones the
  // head-only arms above refuse — here on both sides, where the line-for-line comparison
  // itself cannot be what refuses.
  for (const stamp of ["tier-said-fast", "boom from the fast tier"]) {
    const vacuous = excuseOf([stamp], [stamp]);
    assert(
      vacuous.kind === "refused",
      `(stamp) "${stamp}" on BOTH sides names no classifier-read failure, so nothing can be excused (${vacuous.kind})`,
    );
    assert(
      failureLinesOf(stamp).length === 0,
      `(stamp) "${stamp}" is a line the classifier does not read, so it is no evidence of a failing check`,
    );
  }
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

#!/usr/bin/env bun
/**
 * The roster's tier precedence fires for a runner whose failure line is NOT its JUnit label.
 *
 * The whole-line baseline excuse compares streams verbatim; the roster outranks it for a name it saw
 * PASSING at the base. That outranking only exists if the two spellings meet. `testIdOf` meets them for
 * a runner whose failure line IS its report label (the repo's own smoke roster prints the file path as
 * the testcase name); for a runner that prints a location no report repeats, the line and the label
 * never compared equal and the roster stood aside — which is the bench shape: a pass-to-pass break in a
 * pytest project, excused by the line rule while the roster watched the same test pass at base.
 *
 * The arm that closed it compares a FILE-level identity as well as the full label: a tier line naming a
 * TEST of a file the roster's passing set holds is a test of that file, and the roster watched the file's
 * tests pass. A name that spells no test (no `::`) places nothing, and the base's own file never accuses.
 * Both directions are pinned, because an over-eager file match would turn a tier's unrelated failure into
 * a red.
 */
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { arbitrateTierWithRoster } from "../src/lean/verify-roster.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const SHA = "c".repeat(40);

/** Ask the tier arm what it makes of a head stream, given what the roster saw passing. */
const ask = (roster: ProjectRosterRecord, head: string[], base: string[] = []) =>
  arbitrateTierWithRoster({ roster, headFailed: head, baseFailed: base, baseSha: SHA, cmd: "pytest" });

/** A roster that watched these pass at head; `baseFailed` is the record's base-side list. */
const roster = (passed: string[], baseFailed: string[] = []): ProjectRosterRecord =>
  ({
    baseSha: SHA,
    files: [],
    passed,
    failed: [],
    baseFailed,
    total: passed.length,
    baseTotal: 0,
  }) as unknown as ProjectRosterRecord;

const kindOf = (got: ReturnType<typeof ask>) => got.kind;

// ── (1) THE FIX. The roster watched `test_a.py::test_one` pass at BOTH head and base. A tier now fails
// `test_a.py::test_two` — a sibling in that same file — and the tier's own base probe echoes the line.
// The whole-line rule excuses that echo; the roster watched the file's tests pass, so it is this run's
// regression and the answer is red. Before the file-level match this read `excused`, which is exactly
// the pass-to-pass break that landed.
{
  const r = roster(["tests/test_a.py::test_one"]);
  const line = "FAILED tests/test_a.py::test_two - assert 0 == 1";
  const got = ask(r, [line], [line]);
  assert(
    kindOf(got) === "red" && got.reason.includes("tests.test_a::test_two"),
    `(1) a tier line naming a test of a file the roster saw passing is red, not excused, though the tier's base probe echoed the line (got ${kindOf(got)})`,
  );
}

// ── (2) the negative that keeps (1) honest: a line for a file the roster never named is not the
// roster's to judge, so the line rule keeps its rule over it.
{
  const r = roster(["tests/test_a.py::test_one"]);
  const line = "FAILED tests/test_z.py::test_other - boom";
  assert(
    kindOf(ask(r, [line], [line])) === "excused",
    "(2) a tier line for a file the roster never named is left to the line rule (excused on an echoed base)",
  );
  // …and with no base echo there is nothing for the line rule to excuse either: still the roster's silence.
  assert(
    kindOf(ask(r, [line])) === "uninvolved",
    "(2b) a tier line for an unnamed file with no base echo is uninvolved",
  );
}

// ── (3) the base's own file never accuses: the roster's base run failed that file's test, so a sibling
// failure in it is the mainline's own. The label rule still stands — the exact name the base failed is
// never this run's.
{
  const r = roster(["tests/test_b.py::test_ok", "tests/test_a.py::test_one"], [
    "tests/test_a.py::test_one",
  ]);
  assert(
    kindOf(ask(r, ["FAILED tests/test_a.py::test_two - boom"], [])) === "uninvolved",
    "(3) a file whose roster entry the base already failed accuses nobody",
  );
  assert(
    kindOf(ask(r, ["FAILED tests/test_a.py::test_one - boom"], [])) === "uninvolved",
    "(3b) the exact name the base roster failed is never charged to this run",
  );
}

// ── (4) the label match still holds — the arm this change extends, never replaces.
{
  const r = roster(["tests.x_test.TestC::test_a"]);
  const line = "FAILED tests/x_test.py::TestC::test_a - AssertionError";
  const got = ask(r, [line], [line]);
  assert(
    kindOf(got) === "red" && got.reason.includes("tests.x_test.TestC::test_a"),
    `(4) a line whose label equals a passing label is red (got ${kindOf(got)})`,
  );
}

// ── (5) a name that spells no test (`::`-less) is not a file match: a bare file ERROR accuses nothing,
// even though the roster holds a test from the same file.
{
  const r = roster(["tests/test_a.py::test_one"]);
  assert(
    kindOf(ask(r, ["ERROR tests/test_a.py - import boom"])) === "uninvolved",
    "(5) a line with no test in it is placed by no file and is uninvolved",
  );
}

// ── (6) one runner's two spellings of the SAME test meet, by label and by file alike.
{
  const r = roster(["tests/test_a.py::test_one"]);
  assert(
    kindOf(ask(r, ["FAILED tests/test_a.py::test_one - boom"])) === "red",
    "(6) a report label and the line for the same test meet",
  );
}

// ── (7) the location is the test's own, not a prefix a bare name could supply. A roster name with no
// location before its `::` places nothing, so a runner that labelled a case with a bare name cannot
// have every tier line accuse it.
{
  const r = roster(["::test_one"]);
  const line = "FAILED tests/test_a.py::test_other - boom";
  assert(kindOf(ask(r, [line])) === "uninvolved", "(7) a name with no location places nothing");
  assert(
    kindOf(ask(r, ["FAILED ::test_one - boom"])) === "red",
    "(7b) the label rule is untouched: the exact name still meets its own line",
  );
}

// ── (8) the base-failing list at its cap is a FLOOR: the record cannot say what the cut left out, so
// the LOCATION accusation is withheld and the line rule decides. The LABEL rule is not withheld — an
// exact name the record carries is evidence a cut list cannot blur.
{
  const capped = Array.from({ length: 200 }, (_, i) => `tests/base_capped.py::t${String(i)}`);
  const r = roster(["tests/base_capped.py::fresh"], capped);
  // A SIBLING the record never named: only a location match could accuse it, and a capped base list
  // withholds that. (Naming the same test on both sides is (8b) below — that is the label rule, not a
  // withheld location match, and it stays red.)
  const sibling = "FAILED tests/base_capped.py::never_named - boom";
  assert(
    kindOf(ask(r, [sibling])) === "uninvolved",
    "(8) a capped base-failing list withholds the location accusation against an unnamed sibling",
  );
  assert(
    kindOf(ask(r, ["FAILED tests/base_capped.py::t199 - boom"])) === "uninvolved",
    "(8b) a name the capped base list itself carries is never charged by location",
  );
  assert(
    kindOf(
      ask(roster(["tests/base_capped.py::fresh"], capped), ["FAILED tests/base_capped.py::fresh - boom"]),
    ) === "red",
    "(8c) a capped base list does not withhold the label rule",
  );
}

if (failures() !== 0) process.exit(1);

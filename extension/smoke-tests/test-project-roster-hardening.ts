#!/usr/bin/env bun
/**
 * #2438 — the project-test roster reads what the runner reported, not what it reported first.
 *
 * Four readings the roster must get right: a retried or flaky `<testcase>` is a failure whichever
 * attempt the report lists first, and a skipped-only one ran nowhere; a base whose dependency listing
 * git refused is not a base with nothing to deliver; the tier arm compares a pytest failure line and
 * a report label as the one test they name; and a report is never read from outside its own tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { undeliveredDeps } from "../src/lean/verify-roster-base.ts";
import {
  parseJUnitCases,
  rosterStartProblem,
  runProjectSuite,
} from "../src/lean/verify-roster-command.ts";
import { arbitrateTierWithRoster } from "../src/lean/verify-roster.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import { runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-project-roster-hardening.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const suite = (cases: string) => `<testsuite>\n${cases}\n</testsuite>\n`;
const CASES: [string, string, { passed: string[]; failed: string[] }][] = [
  [
    "a failed attempt listed after a passing one",
    '<testcase classname="t" name="a"/><testcase classname="t" name="a"><failure/></testcase>',
    { passed: [], failed: ["t::a"] },
  ],
  [
    "a rerunFailure-only case",
    '<testcase classname="t" name="a"><rerunFailure message="x">trace</rerunFailure></testcase>',
    { passed: [], failed: ["t::a"] },
  ],
  [
    "a flakyFailure and a rerunError",
    '<testcase name="a"><flakyFailure/></testcase><testcase name="b"><rerunError/></testcase>',
    { passed: [], failed: ["a", "b"] },
  ],
  [
    "a failure nested in a rerunFailure",
    '<testcase name="a"><rerunFailure><failure/></rerunFailure></testcase>',
    { passed: [], failed: ["a"] },
  ],
  [
    "an unrecognised marker",
    '<testcase name="a"><brokenish/></testcase>',
    { passed: [], failed: ["a"] },
  ],
  [
    "a skipped-only case beside a pass",
    '<testcase name="s"><skipped/></testcase><testcase name="s"><skipped/></testcase><testcase name="p"/>',
    { passed: ["p"], failed: [] },
  ],
  [
    "a skipped attempt beside a failed one",
    '<testcase name="a"><skipped/></testcase><testcase name="a"><error/></testcase>',
    { passed: [], failed: ["a"] },
  ],
  [
    "captured output that prints markup",
    '<testcase name="a"><system-out>&lt;ok&gt; <![CDATA[<failure>]]></system-out><properties><property name="k" value="v"/></properties></testcase>',
    { passed: ["a"], failed: [] },
  ],
  [
    "captured CDATA output that closes a tag before more markup",
    '<testcase name="a"><system-out><![CDATA[<br/><div>ok</div></system-out><x>]]></system-out></testcase>',
    { passed: ["a"], failed: [] },
  ],
];
for (const [what, xml, want] of CASES) {
  const got = parseJUnitCases(suite(xml));
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `(parse) ${what} reads as ${JSON.stringify(want)} (got ${JSON.stringify(got)})`,
  );
}

{
  // The dependency listing: a rejection is unknown, an exit-0 empty listing is genuinely none.
  const sha = "a".repeat(40);
  const rejects = (() => Promise.reject(new Error("bad object"))) as unknown as VerifyExec;
  const empty = (() => Promise.resolve({ stdout: "", stderr: "" })) as unknown as VerifyExec;
  const tree = mkdtempSync(path.join(tmpdir(), "roster-deps-"));
  assert(
    (await undeliveredDeps(rejects, tree, sha, tree)) === undefined,
    "(deps) a listing git refused is not read as nothing undelivered",
  );
  const none = await undeliveredDeps(empty, tree, sha, tree);
  assert(none?.length === 0, "(deps) an empty listing still delivers nothing to miss");
  rmSync(tree, { recursive: true, force: true });
}

{
  // The tier arm: a pytest line and the report's dotted label are the same test.
  const sha = "b".repeat(40);
  const roster = {
    passed: ["tests.x_test.TestC::test_a", "tests.x_test::test_b"],
    baseFailed: ["tests.x_test::test_b"],
  } as unknown as ProjectRosterRecord;
  const ask = (head: string[], base: string[]) =>
    arbitrateTierWithRoster({
      roster,
      headFailed: head,
      baseFailed: base,
      baseSha: sha,
      cmd: "pytest",
    });
  const line = "FAILED tests/x_test.py::TestC::test_a - AssertionError";
  const red = ask([line], [line]);
  assert(
    red.kind === "red" &&
      red.reason.includes("tests.x_test.TestC::test_a") &&
      !red.reason.includes("green at"),
    `(arbitrate) a tier failure on a test the roster saw passing is red even when the base printed the same line, without claiming a base pass the record never saw (got ${JSON.stringify(red).slice(0, 160)})`,
  );
  const stale = "FAILED tests/x_test.py::test_b - AssertionError";
  const excused = ask([stale], [stale]);
  assert(
    excused.kind === "excused" && excused.record.names[0] === stale,
    `(arbitrate) a failure the base roster also failed, printed at base too, is excused (got ${excused.kind})`,
  );
  const other = ask(["not ok 1 - other"], []);
  assert(
    other.kind === "uninvolved",
    `(arbitrate) a test the roster never named is uninvolved (got ${other.kind})`,
  );
  const unprintable = ask(["FAILED t::c - \u001b[31mboom"], ["FAILED t::c - \u001b[31mboom"]);
  assert(
    unprintable.kind === "uninvolved",
    `(arbitrate) a record the step log would refuse is never an excuse (got ${unprintable.kind})`,
  );
}

{
  // The report path: a configured --junitxml outside the tree is refused at run start, and a read
  // outside the tree it is asked from finds nothing even when the bytes are there.
  for (const roster of [
    "pytest --junitxml=/tmp/r.xml {dir}",
    "pytest --junitxml {dir}/../r.xml {dir}",
  ])
    assert(
      rosterStartProblem({ roster }) !== undefined,
      `(report) ${roster} is refused at run start`,
    );
  assert(
    rosterStartProblem({ roster: "pytest --junitxml={report} {dir}" }) === undefined,
    "(report) a template naming {report} still starts",
  );
  const root = mkdtempSync(path.join(tmpdir(), "roster-contain-"));
  const tree = path.join(root, "tree");
  mkdirSync(tree);
  const outside = path.join(root, "head.xml");
  writeFileSync(outside, suite('<testcase name="p"/>'));
  const ok = (() => Promise.resolve({ stdout: "", stderr: "" })) as unknown as VerifyExec;
  for (const report of [outside, "../head.xml"]) {
    const r = await runProjectSuite(ok, {
      cwd: tree,
      bin: "x",
      args: [],
      report,
      timeoutMs: 1000,
      reportCwd: tree,
    });
    assert(
      r.ran === false,
      `(report) ${report} outside the tree is not read (${JSON.stringify(r).slice(0, 120)})`,
    );
  }
  rmSync(root, { recursive: true, force: true });
}

const FILE = "tests/test-a.sh";
const NAME = `${FILE}::flaky`;
{
  // End to end: a head report that lists the passing attempt first is still a failure, and the base
  // passed that test, so the run broke it.
  const r = await runVerify({
    issue: 2438,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      basePassed: [NAME],
      headReportXml: suite(
        `<testcase classname="${FILE}" name="flaky"/><testcase classname="${FILE}" name="flaky"><rerunFailure/></testcase>`,
      ),
    },
  });
  assert(
    r.outcome?.kind === "red" && (r.outcome.reason ?? "").includes(NAME),
    `(retried) a retried head failure on a base-green test is red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
}

{
  // End to end: the base listing git refused hands back with its own clause.
  const r = await runVerify({
    issue: 2438,
    implement: true,
    config: { fast: PASS_TIER },
    roster: { files: [FILE], basePassed: [NAME], headFailed: [NAME], baseDepListingRejects: true },
  });
  assert(
    r.outcome === undefined && /dependency listing could not be read/.test(r.threw?.message ?? ""),
    `(listing) an unreadable base dependency listing hands back naming it (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
}

if (exit !== 0) process.exit(exit);

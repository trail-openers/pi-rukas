#!/usr/bin/env bun
/**
 * Lens severity calibration — the shared rubric, and the deterministic cap.
 *
 * In one six-lens pass over a 7-file offline-script PR, 49 of 56 findings were
 * labelled HIGH and about two of them were real (17 simplicity, 13 type-safety,
 * 9 security, 8 architecture). The four uncalibrated ladders define HIGH by an
 * adjective, and the blocking bar is moving to HIGH, so an inflated label is a
 * fix order. Two fixes, both asserted here:
 *
 *   (a) `SEVERITY_RUBRIC` is printed by `lensPromptFor` beside the
 *       `report_finding` field list — the harness's own floor, which a reworded
 *       SKILL.md cannot edit out of the child's context;
 *   (c) `capTestPathFindings` is the executed half, applied on the merge path
 *       (`mergeLensFindings`, after dedup, before the findings-store round is
 *       recorded), so the verdict, the counts, the stored row and any row a
 *       later round carries from it all read the capped severity.
 *
 * The cap is asserted at three levels: the pure function, the merge pass that
 * every lens finding passes through, and a REAL store round (the row a later
 * round carries must be the capped severity, with the harness's provenance on
 * it). Asserting only the pure function would leave the call site deletable.
 *
 * Mutants (b), each observed RED once and then restored — see the PR notes for
 * the red lines: dropping the rubric from the prompt, and removing the cap from
 * the merge pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { lensPromptFor } from "../src/lens-review-format.ts";
import { mergeLensFindings } from "../src/lens-review-merge.ts";
import { runLensReview } from "../src/lens-review.ts";
import {
  SEVERITY_RUBRIC,
  capTestPathFinding,
  capTestPathFindings,
} from "../src/lens-severity-rubric.ts";
import { isLensTestPath } from "../src/lens-test-path.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { LENS_ROSTER, buildLensRoster } from "../src/lens-roster.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import { FULL_DIFF, type StubFinding, setupReviewFixture } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO_ROSTER = buildLensRoster(path.resolve(import.meta.dirname, "..", "..", "skill"));

const f = (severity: Finding["severity"], p: string, title = "t"): Finding => ({
  lens: "SIMPLICITY",
  severity,
  path: p,
  title,
});

// ---------------------------------------------------------------------------
// (a) The rubric reaches the child through the prompt.
// ---------------------------------------------------------------------------
{
  const prompt = lensPromptFor(LENS_ROSTER[0], "diff --git a/a b/a", "ctx", undefined, []);
  assert(prompt.includes(SEVERITY_RUBRIC), "(a) the prompt carries the rubric verbatim");
  for (const [phrase, why] of [
    ["CRITICAL or HIGH requires at least ONE of these four conditions", "HIGH has an evidence floor"],
    ["a concrete, reachable failure on a realistic input", "(a) names the input"],
    ["data loss or corruption", "(b) data loss"],
    ["a security exposure an attacker can actually reach", "(c) reachable exposure"],
    ["a requirement stated in the issue that this diff violates", "(d) violated requirement"],
    ["Cap at MEDIUM or LOW", "the cap list exists"],
    ["duplication and dead code", "duplication/dead code are capped"],
    ["demonstrated hot path", "unmeasured performance claims are capped"],
    ['impedes understanding', "maintainability-only harm is capped"],
    ["This rubric OVERRIDES your lens skill", "it wins over conflicting skill wording"],
  ] as const) {
    assert(prompt.includes(phrase), `(a) the prompt states: ${why}`);
  }
  // Gap-check 4: a finding that meets one of the four conditions keeps its
  // severity wherever the code lives — the cap is for findings that meet none.
  assert(
    /keeps that severity wherever the code lives/.test(prompt),
    "(a) the rubric says a finding meeting (a)-(d) is not capped by its path",
  );
  // Placement: beside the report_finding field list, not buried in the
  // reviewer-lane brief — the child decides severity as it makes the call.
  const fieldList = prompt.indexOf("- severity (required):");
  const rubricAt = prompt.indexOf(SEVERITY_RUBRIC);
  assert(fieldList >= 0, "(a) the report_finding field list is present");
  assert(
    fieldList >= 0 && rubricAt > fieldList && rubricAt - fieldList < 2000,
    "(a) the rubric sits beside the severity field it governs",
  );
  // And on the skill-body caller too — a regression scoping the rubric to the
  // no-skill branch would pass the assert above.
  const withBody = lensPromptFor(
    LENS_ROSTER[0],
    "diff",
    "ctx",
    undefined,
    [],
    undefined,
    "/tmp/skills/x",
    "<lens-skill-body>abc>Apply.</lens-skill-body>",
  );
  assert(withBody.includes(SEVERITY_RUBRIC), "(a) the skill-body prompt carries the rubric too");
}

// ---------------------------------------------------------------------------
// (c) The cap, at the pure function.
// ---------------------------------------------------------------------------
{
  const cap = (severity: Finding["severity"], p: string) =>
    capTestPathFinding({ lens: "SIMPLICITY", severity, path: p, title: "t" });

  assert(cap("HIGH", "tests/x.py").severity === "MEDIUM", "(c) HIGH on tests/x.py → MEDIUM");
  assert(cap("HIGH", "src/x.ts").severity === "HIGH", "(c) HIGH on src/x.ts stays HIGH");
  assert(
    cap("CRITICAL", "test_foo.py").severity === "CRITICAL",
    "(c) CRITICAL on test_foo.py survives",
  );
  assert(cap("HIGH", "a/foo.spec.ts").severity === "MEDIUM", "(c) HIGH on a/foo.spec.ts → MEDIUM");
  assert(
    cap("MEDIUM", "tests/x.py").severity === "MEDIUM",
    "(c) MEDIUM on a test file is unchanged",
  );
  assert(cap("LOW", "tests/x.py").severity === "LOW", "(c) LOW on a test file is unchanged");
  assert(
    cap("HIGH", "extension/smoke-tests/test-a.ts").severity === "MEDIUM",
    "(c) smoke-tests/ caps",
  );
  assert(cap("HIGH", "__tests__/x.js").severity === "MEDIUM", "(c) __tests__/ caps");
  assert(cap("HIGH", "test/x.ts").severity === "MEDIUM", "(c) test/ caps");
  assert(cap("HIGH", "a/b_test.go").severity === "MEDIUM", "(c) *_test.* caps");
  assert(
    cap("HIGH", "smoke-tests/test-lens-review.ts").severity === "MEDIUM",
    "(c) this repo's test-*.ts convention caps",
  );
  assert(
    cap("HIGH", "latest.ts").severity === "HIGH",
    "(c) latest.ts is not a test path (negative case)",
  );
  assert(
    cap("HIGH", "contest/x.ts").severity === "HIGH",
    "(c) a contest/ directory is not a test path (negative case)",
  );

  // Gap-check 2 — the provenance marker: set by the cap, absent otherwise.
  assert(
    cap("HIGH", "tests/x.py").severityCapped === "test-path",
    "(c) a capped row carries severityCapped: 'test-path'",
  );
  assert(
    cap("MEDIUM", "tests/x.py").severityCapped === undefined,
    "(c) a native MEDIUM carries no marker",
  );
  assert(
    cap("CRITICAL", "test_foo.py").severityCapped === undefined,
    "(c) a CRITICAL-on-test row carries no marker",
  );
  assert(
    cap("HIGH", "src/x.ts").severityCapped === undefined,
    "(c) an uncapped HIGH carries no marker",
  );
  const original = f("HIGH", "tests/x.py");
  const capped = capTestPathFinding(original);
  assert(original.severity === "HIGH", "(c) the input finding is not mutated");
  assert(
    !("severityCapped" in original),
    "(c) the input finding gains no marker — only the returned row carries it",
  );
  assert(capped.path === original.path && capped.title === original.title, "(c) only severity moves");
  // `Object.keys` would still see an own property whose value is undefined —
  // the #1469 shape divergence, here on the marker.
  assert(
    !Object.keys(capTestPathFinding(f("MEDIUM", "src/x.ts"))).includes("severityCapped"),
    "(c) an untouched finding has no severityCapped key at all",
  );
}

// ---------------------------------------------------------------------------
// (c, continued) The predicate, on its own (gap-check 3).
// ---------------------------------------------------------------------------
{
  for (const p of [
    "tests/x.py",
    "test/x.ts",
    "smoke-tests/test-a.ts",
    "__tests__/x.js",
    "test_foo.py",
    "a/b_test.go",
    "a/foo.spec.ts",
    "smoke-tests/test-lens-review.ts",
  ]) {
    assert(isLensTestPath(p), `(c) predicate: ${p} is a test path`);
  }
  for (const p of ["latest.ts", "contest/x.ts", "src/x.ts", "", "attest/foo.ts", "README_test"]) {
    assert(!isLensTestPath(p), `(c) predicate: ${p} is NOT a test path`);
  }
}

// ---------------------------------------------------------------------------
// (c, continued) The merge pass — the single point every lens finding passes
// through. Asserting HERE is what keeps the cap deletable only by a RED test.
// ---------------------------------------------------------------------------
{
  const merged = mergeLensFindings(
    [
      f("HIGH", "tests/x.py", "a"),
      f("HIGH", "src/x.ts", "b"),
      f("CRITICAL", "test_foo.py", "c"),
      f("HIGH", "a/foo.spec.ts", "d"),
      f("MEDIUM", "tests/y.py", "e"),
    ],
    REPO_ROSTER,
  );
  const byPath = new Map(merged.map((x) => [x.path, x]));
  assert(merged.length === 5, "(c) the merge kept every finding");
  assert(byPath.get("tests/x.py")?.severity === "MEDIUM", "(c) merge caps HIGH on tests/x.py");
  assert(byPath.get("tests/x.py")?.severityCapped === "test-path", "(c) merge sets the marker");
  assert(byPath.get("src/x.ts")?.severity === "HIGH", "(c) merge leaves src/x.ts HIGH");
  assert(!("severityCapped" in (byPath.get("src/x.ts") ?? {})), "(c) an uncapped row has no key");
  assert(
    byPath.get("test_foo.py")?.severity === "CRITICAL",
    "(c) merge keeps CRITICAL on test_foo.py",
  );
  assert(byPath.get("a/foo.spec.ts")?.severity === "MEDIUM", "(c) merge caps a/foo.spec.ts");
  assert(byPath.get("tests/y.py")?.severity === "MEDIUM", "(c) merge leaves MEDIUM alone");
  assert(
    !("severityCapped" in (byPath.get("tests/y.py") ?? {})),
    "(c) a native MEDIUM on a test path carries no marker",
  );
  // A list nothing caps still comes back as a list of the same rows, in order.
  const untouched = mergeLensFindings([f("HIGH", "src/a.ts", "a"), f("LOW", "src/b.ts", "b")], REPO_ROSTER);
  assert(untouched.map((x) => x.path).join(",") === "src/a.ts,src/b.ts", "(c) merge order preserved");
}

// ---------------------------------------------------------------------------
// (c, continued) End to end: the STORED ROW of a capped finding is MEDIUM, so
// the round that carries it later cannot resurrect the inflated label. Drives
// the real `runLensReview` against a temp clone, the way test-review-findings-*
// does, because "the row the store wrote" is only evidence when the store wrote
// it.
// ---------------------------------------------------------------------------
{
  let reportNow: StubFinding[] = [];
  const fixture = setupReviewFixture({
    prefix: "lens-severity-cap",
    files: { "src/a.ts": "// header\nexport const a = 1;\n" },
    report: () => reportNow,
  });
  try {
    const repo = fixture.repo;
    const head = () => fixture.sh("git rev-parse HEAD");
    reportNow = [
      { severity: "HIGH", path: "smoke-tests/test-a.ts", line: 1, title: "Test helper duplication" },
      { severity: "HIGH", path: "src/a.ts", line: 2, title: "Real production defect" },
    ];
    const summary = await runLensReview({
      cwd: repo,
      branch: "main",
      diff: FULL_DIFF,
      head: head(),
      full: true,
      lensChildFn: fixture.stubLens,
    });
    const rows = await readBranchRows(repo, "main");
    const cappedRow = rows.find((r) => r.path === "smoke-tests/test-a.ts");
    assert(cappedRow !== undefined, "(c) the store recorded the test-path row");
    assert(
      cappedRow?.severity === "MEDIUM",
      `(c) the STORED ROW of a HIGH-on-test finding is MEDIUM (got ${cappedRow?.severity})`,
    );
    assert(
      cappedRow?.severityCapped === "test-path",
      "(c) the stored row carries the cap's provenance marker",
    );
    const prodRow = rows.find((r) => r.path === "src/a.ts");
    assert(prodRow?.severity === "HIGH", "(c) the store kept the production row HIGH");
    assert(
      prodRow !== undefined && !("severityCapped" in prodRow),
      "(c) the production row carries no marker",
    );
    // And the summary the verdict and the operator read is the capped one.
    const inSummary = new Map(summary.findings.map((x) => [x.path, x]));
    assert(
      inSummary.get("smoke-tests/test-a.ts")?.severity === "MEDIUM",
      "(c) the reported findings list the capped severity",
    );
    assert(
      summary.bySeverity.HIGH === 1 && summary.bySeverity.MEDIUM === 1,
      `(c) the severity counts read the capped round (HIGH=${summary.bySeverity.HIGH} MEDIUM=${summary.bySeverity.MEDIUM})`,
    );
  } finally {
    fixture.cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

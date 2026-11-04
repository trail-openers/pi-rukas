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
 *   (c) `capTestFindingSeverity` is the executed half, applied where a lens's
 *       `report_finding` calls become findings (lens-findings-extract.ts).
 *
 * Mutants (each observed RED once, then restored): dropping the rubric from the
 * prompt fails the (a) block; removing the cap fails the (c) block. See the
 * repo PR notes for the red lines.
 */

import { extractFindings } from "../src/lens-findings-extract.ts";
import { lensPromptFor } from "../src/lens-review-format.ts";
import {
  SEVERITY_RUBRIC,
  capTestFindingSeverity,
  isTestFilePath,
} from "../src/lens-severity-rubric.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// (a) The rubric reaches the child through the prompt.
// ---------------------------------------------------------------------------
{
  const prompt = lensPromptFor(LENS_ROSTER[0], "diff --git a/a b/a", "ctx", undefined, []);
  assert(
    prompt.includes(SEVERITY_RUBRIC),
    "(a) the prompt carries the rubric constant verbatim",
  );
  for (const [phrase, why] of [
    ["CRITICAL or HIGH requires at least ONE of these", "HIGH has an evidence floor"],
    ["a concrete, reachable failure on a realistic input", "(a) names the input"],
    ["data loss or corruption", "(b) data loss"],
    ["a security exposure an attacker can actually reach", "(c) reachable exposure"],
    ["a requirement stated in the issue that this diff violates", "(d) violated requirement"],
    ["Cap at MEDIUM or LOW", "the cap list exists"],
    ["duplication and dead code", "duplication/dead code are capped"],
    ["findings about test-only code", "test-only code is capped"],
    ["demonstrated hot path", "unmeasured performance claims are capped"],
    ["impedes understanding", "maintainability-only harm is capped"],
    ["This rubric OVERRIDES your lens skill", "it wins over conflicting skill wording"],
  ] as const) {
    assert(prompt.includes(phrase), `(a) the prompt states: ${why}`);
  }
  // Placement: beside the report_finding field list, not buried after the
  // reviewer-lane brief — the child decides severity as it makes the call.
  const fieldList = prompt.indexOf("- severity (required):");
  const rubricAt = prompt.indexOf(SEVERITY_RUBRIC);
  assert(fieldList >= 0, "(a) the report_finding field list is present");
  assert(
    fieldList >= 0 && rubricAt > fieldList && rubricAt - fieldList < 2000,
    "(a) the rubric sits beside the severity field it governs",
  );
  // And on the skill-body caller too — both builders share this function, but a
  // regression that puts the rubric inside the no-skill branch would pass above.
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
// (c) The deterministic test-only cap.
// ---------------------------------------------------------------------------
{
  const cap = (severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW", path: string) =>
    capTestFindingSeverity({ lens: "SIMPLICITY", severity, path, title: "t" }).severity;

  assert(cap("HIGH", "tests/x.py") === "MEDIUM", "(c) HIGH on tests/x.py → MEDIUM");
  assert(cap("HIGH", "src/x.ts") === "HIGH", "(c) HIGH on src/x.ts stays HIGH");
  assert(cap("CRITICAL", "test_foo.py") === "CRITICAL", "(c) CRITICAL on test_foo.py survives");
  assert(cap("HIGH", "a/foo.spec.ts") === "MEDIUM", "(c) HIGH on a/foo.spec.ts → MEDIUM");
  assert(cap("MEDIUM", "tests/x.py") === "MEDIUM", "(c) MEDIUM on a test file is unchanged");
  assert(cap("LOW", "tests/x.py") === "LOW", "(c) LOW on a test file is unchanged");
  assert(cap("HIGH", "extension/smoke-tests/test-a.ts") === "MEDIUM", "(c) smoke-tests/ caps");
  assert(cap("HIGH", "test/x.ts") === "MEDIUM", "(c) test/ caps");
  assert(cap("HIGH", "src/x_test.go") === "MEDIUM", "(c) *_test.* caps");
  assert(cap("HIGH", "attest/foo.ts") === "HIGH", "(c) a segment merely ENDING in 'test' does not cap");
  assert(cap("HIGH", "src/test-helpers.ts") === "HIGH", "(c) a test-HELPERS name is not a test shape");
  assert(cap("HIGH", "latest.ts") === "HIGH", "(c) 'latest.ts' is not a test shape");
  assert(cap("HIGH", "") === "HIGH", "(c) an empty path is not a test file");

  // The predicate is exported pure, and the cap never mutates its input.
  const original = { lens: "SIMPLICITY", severity: "HIGH" as const, path: "tests/x.py" };
  const capped = capTestFindingSeverity(original);
  assert(original.severity === "HIGH", "(c) the input finding is not mutated");
  assert(capped.severity === "MEDIUM" && capped.path === original.path, "(c) only severity moves");
  assert(isTestFilePath("a/b.spec.ts") && !isTestFilePath("a/b.ts"), "(c) the predicate is pure");
}

// ---------------------------------------------------------------------------
// (c, continued) The cap is applied where a lens finding becomes a Finding:
// `extractFindings`, the single point every lens's report_finding calls pass
// through. Asserting it HERE (rather than only on the pure function above) is
// what keeps the cap from being deleted from the call site while the helper
// still exists and still passes its own unit asserts.
// ---------------------------------------------------------------------------
{
  const calls = [
    { name: "report_finding", arguments: { severity: "HIGH", path: "tests/x.py", title: "t1" } },
    { name: "report_finding", arguments: { severity: "HIGH", path: "src/x.ts", title: "t2" } },
    {
      name: "report_finding",
      arguments: { severity: "CRITICAL", path: "test_foo.py", title: "t3" },
    },
    { name: "report_finding", arguments: { severity: "HIGH", path: "a/foo.spec.ts", title: "t4" } },
    { name: "report_finding", arguments: { severity: "MEDIUM", path: "tests/y.py", title: "t5" } },
  ];
  const { findings, skipped } = extractFindings(calls, "SIMPLICITY");
  assert(skipped === 0 && findings.length === 5, "(c) every call was recorded");
  const byPath = new Map(findings.map((f) => [f.path, f.severity]));
  assert(byPath.get("tests/x.py") === "MEDIUM", "(c) the extractor caps HIGH on tests/x.py");
  assert(byPath.get("src/x.ts") === "HIGH", "(c) the extractor leaves src/x.ts HIGH");
  assert(byPath.get("test_foo.py") === "CRITICAL", "(c) the extractor keeps CRITICAL on test_foo.py");
  assert(byPath.get("a/foo.spec.ts") === "MEDIUM", "(c) the extractor caps HIGH on a/foo.spec.ts");
  assert(byPath.get("tests/y.py") === "MEDIUM", "(c) MEDIUM on a test file passes through");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

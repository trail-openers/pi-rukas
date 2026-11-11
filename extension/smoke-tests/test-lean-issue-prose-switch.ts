#!/usr/bin/env bun
/**
 * #2171 — the `PI_ENSEMBLE_LEAN_ISSUE_PROSE` switch is documented, and off ONLY
 * on `"0"`.
 *
 * The docs row is the deliverable an operator reads, and a `HEADLESS_INPUTS`
 * entry without one is a knob nobody can discover, so this asserts this knob's
 * row exists (and only this knob's — the rest of the table is test-headless-
 * inputs.ts' job). The truth table is the switch's contract: the section is on
 * unless the operator wrote `0`, because the pre-feature behaviour was the
 * oracle answering without the issue and that is what an unset knob must NOT
 * quietly restore.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { leanIssueProseEnabled } from "../src/lean/issue-prose.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else {
    failed++;
    console.log(`✗ ${msg}`);
  }
}

{
  const doc = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "configuration.md"),
    "utf8",
  );
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_ISSUE_PROSE`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_ISSUE_PROSE",
  );

  const saved = process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    if (value === undefined) delete process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
    else process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE = value;
    assert(
      leanIssueProseEnabled() === want,
      `PI_ENSEMBLE_LEAN_ISSUE_PROSE=${JSON.stringify(value)} reads ${String(want)}`,
    );
  }
  if (saved === undefined) delete process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
  else process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE = saved;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

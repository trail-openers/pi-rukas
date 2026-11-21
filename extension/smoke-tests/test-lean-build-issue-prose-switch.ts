#!/usr/bin/env bun
/**
 * #2228 — the `PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE` switch is documented, and off
 * ONLY on `"0"`.
 *
 * Cloned from the per-knob switch-test seam: a `HEADLESS_INPUTS` entry without a
 * docs row is a knob nobody can discover, so this asserts THIS knob's row exists
 * (and only this knob's — the rest of the table is `test-headless-inputs.ts`' job).
 * The truth table is the switch's contract: the builder's section is on unless the
 * operator wrote `0`, because the pre-feature behaviour was the builder working from
 * the problem line alone, and that is what an unset knob must NOT quietly restore.
 *
 * The docs row also has to say this is the only switch in the family: the oracle
 * seats have no knob, so an operator reading this row must not expect a shared one
 * to remove the section from them too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { leanBuildIssueProseEnabled } from "../src/lean/issue-prose.ts";

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
    doc.includes("`PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE",
  );
  const row = doc.split("\n").find((l) => l.includes("`PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE`")) ?? "";
  assert(
    !row.includes("PI_ENSEMBLE_LEAN_ISSUE_PROSE"),
    `that row names no oracle switch — the oracle seats have none, so the builder's is the only one (${row.slice(0, 80)})`,
  );

  const saved = process.env.PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE;
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    if (value === undefined) delete process.env.PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE;
    else process.env.PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE = value;
    assert(
      leanBuildIssueProseEnabled() === want,
      `PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE=${JSON.stringify(value)} reads ${String(want)}`,
    );
  }
  if (saved === undefined) delete process.env.PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE;
  else process.env.PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE = saved;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

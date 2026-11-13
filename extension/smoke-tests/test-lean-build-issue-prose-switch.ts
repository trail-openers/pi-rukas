#!/usr/bin/env bun
/**
 * #2228 — the `PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE` switch is documented, and off
 * ONLY on `"0"`.
 *
 * Cloned from `test-lean-issue-prose-switch.ts` along the same per-knob seam: a
 * `HEADLESS_INPUTS` entry without a docs row is a knob nobody can discover, so
 * this asserts THIS knob's row exists (and only this knob's — the rest of the
 * table is `test-headless-inputs.ts`' job). The truth table is the switch's
 * contract: the builder's section is on unless the operator wrote `0`, because
 * the pre-feature behaviour was the builder working from the problem line alone,
 * and that is what an unset knob must NOT quietly restore.
 *
 * The docs row also has to state the other switch's reach: the section is
 * rendered by the shared renderer, so `PI_ENSEMBLE_LEAN_ISSUE_PROSE=0` takes
 * this seat's section out too, and an operator reading only this row would
 * otherwise expect `=0` here to be the only way.
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
    row.includes("PI_ENSEMBLE_LEAN_ISSUE_PROSE"),
    `that row names the shared switch too, since either one at 0 removes the section (${row.slice(0, 80)})`,
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

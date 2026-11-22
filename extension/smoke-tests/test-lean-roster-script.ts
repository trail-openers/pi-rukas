#!/usr/bin/env bun
/**
 * pi-rukas's own `verify.roster` (`smoke-tests/lib/lean-roster.sh`, named in `.pi/work.json`):
 * it runs smoke-test files through verify-loop and writes a JUnit report whose verdicts the
 * project-test roster reads back — one testcase per file, named by its tree-relative path,
 * failing exactly when the file failed, with verify-loop's exit code passed through.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseJUnitCases } from "../src/lean/verify-roster-command.ts";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}

const repo = path.join(import.meta.dir, "..", "..");
const scratch = mkdtempSync(path.join(tmpdir(), "pi-ens-lean-roster-"));
const report = path.join(scratch, "report.xml");
const pass = "smoke-tests/fixtures/verify-loop/allpass-a.ts";
const fail = "smoke-tests/fixtures/verify-loop/fixture-1.ts";
try {
  // An operator's PI_ENSEMBLE_VERIFY_TIMING=0 turns verify-loop's summary block off; the script
  // reads its verdicts from that block, so it must pin the knob back on.
  const { PI_ENSEMBLE_VERIFY_TIMING: _, ...ambient } = process.env;
  for (const timing of [undefined, "0"]) {
    const env = timing === undefined ? ambient : { ...ambient, PI_ENSEMBLE_VERIFY_TIMING: timing };
    const label = timing === undefined ? "" : ` with PI_ENSEMBLE_VERIFY_TIMING=${timing}`;
    const run = spawnSync(
      "bash",
      [path.join(repo, "extension/smoke-tests/lib/lean-roster.sh"), repo, report, pass, fail],
      { encoding: "utf8", env },
    );
    check(
      run.status === 1,
      `exits with verify-loop's code for a failing file${label} (${run.status})`,
    );
    const cases = parseJUnitCases(readFileSync(report, "utf8"));
    check(
      cases.passed.join(",") === `smoke::${pass}`,
      `the passing file is a passing testcase${label} (${cases.passed})`,
    );
    check(
      cases.failed.join(",") === `smoke::${fail}`,
      `the failing file is a failing testcase${label} (${cases.failed})`,
    );
  }

  const config = JSON.parse(readFileSync(path.join(repo, ".pi/work.json"), "utf8"));
  check(
    config.verify?.roster === "bash extension/smoke-tests/lib/lean-roster.sh {dir} {report}",
    ".pi/work.json names this script as verify.roster",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`FAIL test-lean-roster-script: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("PASS test-lean-roster-script");

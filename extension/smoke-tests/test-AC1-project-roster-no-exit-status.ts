#!/usr/bin/env bun
/**
 * #2428 — a roster run with NO exit status is not a run that exited 0.
 *
 * `runProjectSuite` asks observation first (kill, signal, overflow, could-not-start) and the exit
 * code second, because an absent status read as "exited 0" hands a green to a suite nobody watched.
 * The residue is the case the observation arms do NOT catch: an executor that RESOLVES — no rejection,
 * no kill flag, no signal — and simply carries no numeric `code`. That is what a wrapper that swallowed
 * the status looks like, and the roster's own caller would otherwise record it as a passing run of the
 * project's suite.
 *
 * This is asserted against `runProjectSuite` directly rather than through a whole verify run, because
 * the claim is about what one run's answer means and the fixture would have to imitate an executor
 * shape the real step never produces.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROSTER_REPORT_FILE, runProjectSuite } from "../src/lean/verify-roster-command.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";

const SELF = "test-AC1-project-roster-no-exit-status.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const tree = mkdtempSync(path.join(tmpdir(), "roster-exit-"));
/** A report that names tests, so the ONLY thing wrong with the run is its missing status. */
writeFileSync(
  path.join(tree, ROSTER_REPORT_FILE),
  '<?xml version="1.0" encoding="utf-8"?>\n<testsuite tests="1" failures="0">\n  <testcase name="passes"/>\n</testsuite>\n',
);

/** An executor that resolves with the shape the case declares. */
const execWith = (shape: Record<string, unknown>): VerifyExec =>
  (() => Promise.resolve(shape as never)) as unknown as VerifyExec;

const ask = (shape: Record<string, unknown>) =>
  runProjectSuite(execWith(shape), {
    cwd: tree,
    bin: "pytest",
    args: ["--junitxml", ROSTER_REPORT_FILE, "."],
    report: path.join(tree, ROSTER_REPORT_FILE),
    timeoutMs: 5_000,
    reportCwd: tree,
  });

{
  // The defect: an exec that resolved with no `code`. Read as exit 0 it is a roster of one passing
  // test and, through the roster, a green verify — for a run whose status nobody ever read.
  const r = await ask({ stdout: "", stderr: "" });
  assert(
    r.ran === false,
    `(no code) a roster run that resolved with no exit status did NOT run (got ${JSON.stringify(r).slice(0, 120)})`,
  );
  assert(
    r.ran === false && /exit status/i.test(r.reason),
    `(no code) the answer says the exit status is what is missing (${r.ran === false ? r.reason.slice(0, 120) : ""})`,
  );
}

{
  // A non-integer code is no more an exit than an absent one: `null`, a string and NaN are the shapes
  // a wrapper that lost the status leaves behind, and each would otherwise be compared to zero.
  for (const [label, bad] of [["null", null], ["string 0", "0"], ["NaN", Number.NaN], ["absent", undefined]] as const) {
    const r = await ask({ code: bad, stdout: "", stderr: "" });
    assert(
      r.ran === false,
      `(bad code ${label}) is refused rather than compared to zero (${JSON.stringify(r).slice(0, 100)})`,
    );
  }
}

{
  // The control, so the two above cannot pass on a suite that simply never reports: a real numeric
  // exit still produces the roster, and its names come from the report.
  const green = await ask({ code: 0, stdout: "", stderr: "" });
  assert(
    green.ran === true && JSON.stringify(green.passed) === JSON.stringify(["passes"]),
    `(control) a run that DID report exit 0 still produces its roster (${JSON.stringify(green).slice(0, 120)})`,
  );
}

rmSync(tree, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);

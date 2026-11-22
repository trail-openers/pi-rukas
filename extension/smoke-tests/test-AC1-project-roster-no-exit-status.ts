#!/usr/bin/env bun
/**
 * #2428 / #2547 — what one roster run's exit status means, read through the executor's own contract.
 *
 * `execp` (the production executor, here with `killGroup`) RESOLVES only when the child exited 0 —
 * and then carries no `code` — and REJECTS otherwise, with `code`/`signal`/`killed` and the streams on
 * the error. So a resolution is exit 0, a rejection is observed through its error, and only a rejection
 * that carries no numeric exit is "no exit status". The real executor is driven here for a passing and
 * a failing roster: a fake that resolved `{ code: 0 }` (a shape `execp` never returns) is what let a
 * roster that could never pass in production look green in this suite.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
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
const report = path.join(tree, ROSTER_REPORT_FILE);
const PASSING =
  '<?xml version="1.0" encoding="utf-8"?>\n<testsuite tests="1" failures="0">\n  <testcase name="passes"/>\n</testsuite>\n';
const FAILING =
  '<?xml version="1.0" encoding="utf-8"?>\n<testsuite tests="1" failures="1">\n  <testcase name="breaks"><failure message="x"/></testcase>\n</testsuite>\n';

const run = (exec: VerifyExec, bin: string, args: string[]) =>
  runProjectSuite(exec, { cwd: tree, bin, args, report, timeoutMs: 10_000, reportCwd: tree });

/** The production executor, exactly as the verify step builds it. */
const real = ((cmd: string, opts?: object) => execp(cmd, opts ?? {})) as unknown as VerifyExec;
/** A runner script that writes `xml` to the report and exits with `code`. */
const script = (xml: string, code: number) => {
  const file = path.join(tree, `runner-${code}.sh`);
  writeFileSync(file, `#!/bin/sh\ncat > "$1" <<'XML'\n${xml}XML\nexit ${code}\n`);
  return file;
};

{
  // The defect: a roster that passes, through the real executor, must produce its roster.
  const r = await run(real, "sh", [script(PASSING, 0), report]);
  assert(
    r.ran === true && JSON.stringify(r.passed) === JSON.stringify(["passes"]),
    `(real exec, exit 0) a passing roster produces its roster (${JSON.stringify(r).slice(0, 140)})`,
  );
}

{
  // And a roster that fails, through the real executor, produces a roster naming the failure.
  const r = await run(real, "sh", [script(FAILING, 1), report]);
  assert(
    r.ran === true && JSON.stringify(r.failed) === JSON.stringify(["breaks"]),
    `(real exec, exit 1) a failing roster produces its roster with the failure (${JSON.stringify(r).slice(0, 140)})`,
  );
}

writeFileSync(report, PASSING);
const resolving = (shape: Record<string, unknown>): VerifyExec =>
  (() => Promise.resolve(shape as never)) as unknown as VerifyExec;
const rejecting = (fields: Record<string, unknown>): VerifyExec =>
  (() => Promise.reject(Object.assign(new Error("failed"), fields))) as unknown as VerifyExec;

{
  // A resolution with no code is exit 0 — the executor's contract.
  const r = await run(resolving({ stdout: "", stderr: "" }), "pytest", ["."]);
  assert(
    r.ran === true,
    `(resolved, no code) is a run that exited 0 (${JSON.stringify(r).slice(0, 120)})`,
  );
}

{
  // A rejection that carries no numeric exit is the residue: "did not run", never "passed".
  for (const [label, bad] of [
    ["absent", undefined],
    ["null", null],
    ["NaN", Number.NaN],
  ] as const) {
    const r = await run(rejecting({ code: bad, stdout: "", stderr: "" }), "pytest", ["."]);
    assert(
      r.ran === false && /exit status/i.test(r.reason),
      `(rejected, code ${label}) is refused as no exit status (${r.ran === false ? r.reason.slice(0, 100) : "ran"})`,
    );
  }
  // A resolution whose code is present but not an integer is refused too, never compared to zero.
  for (const [label, bad] of [
    ["null", null],
    ["string 0", "0"],
    ["NaN", Number.NaN],
  ] as const) {
    const r = await run(resolving({ code: bad, stdout: "", stderr: "" }), "pytest", ["."]);
    assert(
      r.ran === false,
      `(resolved, code ${label}) is refused (${JSON.stringify(r).slice(0, 100)})`,
    );
  }
}

rmSync(tree, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);

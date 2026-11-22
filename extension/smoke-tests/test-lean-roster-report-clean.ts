#!/usr/bin/env bun
/**
 * The roster's JUnit report is lean's own file: it is removed before each run, so a report from an
 * earlier run is never read as this one's, and after it, so the tree verify scans next stays clean.
 * Driven through the production executor in a real git tree, with the runner scripts kept outside it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { ROSTER_REPORT_FILE, runProjectSuite } from "../src/lean/verify-roster-command.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

const SELF = "test-lean-roster-report-clean.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const tree = mkdtempSync(path.join(tmpdir(), "roster-clean-"));
const scripts = mkdtempSync(path.join(tmpdir(), "roster-scripts-"));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: tree, encoding: "utf8", env: gitTestEnv() });
git("init", "-q");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
const report = path.join(tree, ROSTER_REPORT_FILE);
const PASSING =
  '<?xml version="1.0" encoding="utf-8"?>\n<testsuite tests="1" failures="0">\n  <testcase name="passes"/>\n</testsuite>\n';
const real = ((cmd: string, opts?: object) => execp(cmd, opts ?? {})) as unknown as VerifyExec;
const script = (name: string, body: string) => {
  const file = path.join(scripts, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  return file;
};
const run = (file: string) =>
  runProjectSuite(real, {
    cwd: tree,
    bin: "sh",
    args: [file, report],
    report,
    timeoutMs: 10_000,
    reportCwd: tree,
  });
const porcelain = () => git("status", "--porcelain", "--untracked-files=all");

{
  const r = await run(script("writes.sh", `cat > "$1" <<'XML'\n${PASSING}XML`));
  assert(
    r.ran === true,
    `a roster that writes its report is read (${JSON.stringify(r).slice(0, 120)})`,
  );
  assert(
    porcelain() === "",
    `the tree is clean after the roster run (${JSON.stringify(porcelain())})`,
  );
}

{
  // A report left from an earlier run, and a runner that writes none: nothing was observed.
  writeFileSync(report, PASSING);
  const r = await run(script("silent.sh", "exit 0"));
  assert(
    r.ran === false,
    `a stale report is not read as this run's (${JSON.stringify(r).slice(0, 120)})`,
  );
  assert(porcelain() === "", `…and the tree is clean afterwards (${JSON.stringify(porcelain())})`);
}

rmSync(tree, { recursive: true, force: true });
rmSync(scripts, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);

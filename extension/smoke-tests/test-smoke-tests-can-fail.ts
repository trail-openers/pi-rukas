#!/usr/bin/env bun
/**
 * #1212 — every smoke test must be able to FAIL.
 *
 * The suite's convention is a local `assert` helper that prints `✗` and
 * records the failure in a variable, then `process.exit(<that variable>)` at
 * the end. A file that records failures and never turns them into an exit
 * status is reported green whatever happens: one such file printed five
 * failing assertions on every run and nobody saw them, because
 * verify-loop.sh and CI only read the exit status.
 *
 * Static scan of smoke-tests/test-*.ts: a file that prints a `✗` failure
 * line must set the process exit status from code (process.exit(…) with a
 * non-literal argument, or process.exitCode = …). Proven in both directions
 * with inline fixtures — a gate never observed to fail is worthless.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** True when the source prints a failure marker (`✗`) from executable code. */
export function recordsFailures(src: string): boolean {
  return /console\.(?:error|log)\(\s*[`'"]✗/.test(src);
}

/**
 * True when the source can end with a non-zero status of its own making:
 * `process.exit(x)` where x is not the literal 0, or an assignment to
 * `process.exitCode`. A thrown error also exits non-zero, but a file that
 * records failures in a variable does not throw on them.
 */
export function setsExitStatus(src: string): boolean {
  if (/process\.exitCode\s*=/.test(src)) return true;
  for (const m of src.matchAll(/process\.exit\(\s*([^)]*?)\s*\)/g)) {
    if (m[1] !== "" && m[1] !== "0") return true;
  }
  return false;
}

export function cannotFail(src: string): boolean {
  return recordsFailures(src) && !setsExitStatus(src);
}

// ---- canaries
const helper =
  "let exit = 0;\nfunction assert(c: boolean, m: string) {\n  if (c) console.log(`✓ ${m}`);\n  else {\n    console.error(`✗ ${m}`);\n    exit = 1;\n  }\n}\n";
assert(
  cannotFail(`${helper}assert(false, "x");\n`),
  "canary: records failures, never exits → caught",
);
assert(
  cannotFail(`${helper}assert(false, "x");\nprocess.exit(0);\n`),
  "canary: exits with a literal 0 → caught",
);
assert(
  !cannotFail(`${helper}assert(false, "x");\nprocess.exit(exit);\n`),
  "canary: process.exit(exit) passes",
);
assert(
  !cannotFail(`${helper}assert(false, "x");\nprocess.exitCode = exit;\n`),
  "canary: process.exitCode = … passes",
);
assert(
  !cannotFail('console.log("no assertions here");\n'),
  "canary: a file with no ✗ line is not in scope",
);

// ---- the real suite
const offenders: string[] = [];
let scanned = 0;
for (const name of readdirSync(DIR).sort()) {
  if (!/^test-.*\.ts$/.test(name)) continue;
  scanned += 1;
  if (cannotFail(readFileSync(path.join(DIR, name), "utf8"))) offenders.push(name);
}
assert(scanned > 100, `the scan saw the suite (${scanned} files)`);
assert(
  offenders.length === 0,
  `every smoke test that records failures sets an exit status${offenders.length ? ` — cannot fail: ${offenders.join(", ")}` : ""}`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #2223 — a suite that reports its own verdict through `makeAssert` must EXIT on
 * the failure COUNT, not on the function object.
 *
 * `makeAssert()` returns `{ assert, failures }` where `failures` is a
 * zero-argument accessor, so an exit expression that reads `.length` off it reads
 * the function's ARITY — always 0 — and a suite whose assertions all failed still
 * exits 0 (or, read the other way, exits 1 while green). Either direction the gate
 * reports a confident wrong answer about its own runs, which is the class of
 * defect AGENTS.md §7 ("silence is never a pass") exists to close, and the
 * verify-loop runs each file under `set -e` where the wrong direction aborts a
 * green gate.
 *
 * The rule is a source-text rule over the whole suite directory, so it catches
 * the mistake in any file that adds one, not only in the file that had it.
 *
 * The canary is the point: a gate nobody has seen red proves nothing, so the
 * same file feeds itself the broken form and asserts the rule rejects it.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The broken shape: `.length` on the accessor rather than a call to it. */
const BROKEN = /process\.exit\(\s*failures\.length/;

const dir = import.meta.dirname;
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .sort();

const offenders: string[] = [];
let inspected = 0;
for (const f of files) {
  const src = readFileSync(path.join(dir, f), "utf8");
  if (!src.includes("makeAssert")) continue;
  // A suite may keep its own `failures` ARRAY (the house shape in most files) and
  // read `.length` off it correctly; only the `makeAssert` accessor — a function,
  // whose `.length` is its arity — makes the broken exit expression wrong. So the
  // rule is scoped to a file that took `failures` from `makeAssert`.
  if (!/\bconst\s*\{[^}]*\bfailures\b[^}]*\}\s*=\s*makeAssert\(\)/.test(src)) continue;
  inspected += 1;
  if (BROKEN.test(src)) offenders.push(f);
}

assert(
  inspected > 5,
  `the scan reaches the makeAssert suites rather than matching nothing (${String(inspected)} files inspected)`,
);
assert(
  offenders.length === 0,
  `no makeAssert suite exits on the accessor's ARITY instead of its count (${offenders.join(", ") || "none"})`,
);

// ── canary: the rule rejects the shape it exists to catch ───────────────────
// Without this arm the regex above is just a string that happens to match
// nothing, and a future edit could delete the check while this file stays green.
// Built by concatenation: written as one literal, this file's own canary would
// match the rule it asserts and the scan above would report itself as an offender.
assert(
  BROKEN.test("process.exit(failures" + ".length > 0 ? 1 : 0);"),
  "canary: the broken form is matched",
);
assert(
  !BROKEN.test("process.exit(failures());") &&
    !BROKEN.test("process.exit(failures() ? 1 : 0);"),
  "canary: the correct forms are not matched",
);

console.log(`\nexit ${String(exit)}`);
process.exit(exit);

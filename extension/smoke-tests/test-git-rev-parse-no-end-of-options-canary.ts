#!/usr/bin/env bun
/**
 * #2162 — the canary: no `rev-parse` in `src/` carries `--end-of-options`.
 *
 * On a git that does not recognise the terminator for `rev-parse`, the command
 * prints the literal to stdout and exits 0, so every reader of that stdout
 * rejects a correct answer. The bug is a command SHAPE, and a command shape is
 * exactly what a refactor quietly puts back, so the source is grepped and the
 * shape asserted — modelled on the `-z` canary in
 * test-work-driver-protected-paths-read-canary.ts.
 *
 * Scope is `rev-parse` only, deliberately. `diff`, `log`, `grep`, `fetch`,
 * `merge-base`, `rev-list`, `cat-file` and `ls-tree` accept the terminator on
 * older gits too, so their uses are correct and out of scope for this issue;
 * an unflagged-command assertion would be a demand to change code that works.
 *
 * Comment lines are stripped first: this repo's prose names the flag
 * constantly (including in the jsdoc of git-oid-read.ts), and a comment is not
 * a call site. The scanner's own control proves it can fail.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A line whose code says `rev-parse` AND the terminator token appears in code, not a comment. */
function revParseFlagLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const code = line.replace(/^\s*(?:\/\/|\/?\*).*/, "");
    return /["'`]rev-parse["'`]/.test(code) && code.includes("--end-of-options");
  });
}

const srcDir = path.join(import.meta.dir, "..", "src");
const offenders: string[] = [];
const seen: string[] = [];

function scan(dir: string, prefix: string): void {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const rel = `${prefix}${entry}`;
    const hits = revParseFlagLines(readFileSync(path.join(dir, entry), "utf8"));
    seen.push(rel);
    for (const line of hits) offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
    if (entry === "lean" || entry === "lib") continue;
  }
}

scan(srcDir, "");
// `lean/` carries its own git reads and is part of the shipped extension.
scan(path.join(srcDir, "lean"), "lean/");

assert(
  seen.length > 50,
  `the scan actually walked src/ (${seen.length} files) — a scan of nothing would pass vacuously`,
);
assert(
  offenders.length === 0,
  `no rev-parse call site passes --end-of-options (${offenders.length}: ${offenders.join(" | ") || "none"})`,
);

// The control: a scanner blind to the shape would report a clean tree forever.
assert(
  revParseFlagLines('  argv: ["rev-parse", "--end-of-options", ref],').length === 1,
  "control: the scanner flags a rev-parse argv that carries the terminator",
);
assert(
  revParseFlagLines('  // argv: ["rev-parse", "--end-of-options", ref],').length === 0,
  "control: a commented-out argv is not a call site",
);
assert(
  revParseFlagLines('  argv: ["diff", "--end-of-options", range],').length === 0,
  "control: the non-rev-parse commands this issue leaves alone are not flagged",
);

console.log(`\nexit ${exit}`);
process.exit(exit);

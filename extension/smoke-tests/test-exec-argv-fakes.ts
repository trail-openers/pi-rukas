#!/usr/bin/env bun
/**
 * The smoke tests' own executors honour the argv form (#1283).
 *
 * `test-exec-argv-contract.ts` holds production to the argv contract
 * (#1279). The tests that stand in for production were not held to it:
 * many built their fake executor as "run `cmd` through `sh -c`", so an
 * argv-form call reaching one ran a bare `git` — usage text, exit 1 — and
 * the driver took its failure path while the test reported success.
 *
 * Two scans over every file under smoke-tests/ (lib/ included):
 *   1. no arrow-function fake executor `(cmd, opts) => …` hands `cmd` to a
 *      shell without looking at `argv` (use `realExec` from lib/exec-fake.ts,
 *      or match via `commandOf`). Scope: two-parameter arrow functions only —
 *      `function` declarations and cmd-only stubs are outside this scan;
 *   2. no bare `promisify(exec)` is handed on as a value.
 * Each scan is also run against inline fixtures, so it is seen to fail.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { argvDroppingFakes, shellOnlyEscapes } from "./lib/exec-argv-scan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const DIR = import.meta.dir;

/**
 * Files whose shell-only executor is deliberate, with why. Only the one
 * that holds the scans' failing fixtures as strings; add an entry only for
 * a test whose subject IS the shell-only behaviour.
 */
const ALLOWED: Record<string, string> = {
  "test-exec-argv-fakes.ts": "its failing-direction fixtures are shell-only by design",
};

const files = ["", "lib"].flatMap((sub) =>
  readdirSync(path.join(DIR, sub))
    .filter((n) => n.endsWith(".ts"))
    .map((n) => path.join(sub, n)),
);

const offenders: string[] = [];
const seen = new Set<string>();
for (const rel of files) {
  const source = readFileSync(path.join(DIR, rel), "utf8");
  const hits = [...argvDroppingFakes(source), ...shellOnlyEscapes(source)];
  if (hits.length === 0) continue;
  seen.add(rel);
  if (!(rel in ALLOWED)) offenders.push(...hits.map((h) => `${rel}:${h}`));
}
assert(
  offenders.length === 0,
  `no smoke test hands driver code an executor that drops argv — use realExec from lib/exec-fake.ts (offenders: ${offenders.join(" | ") || "none"})`,
);
const stale = Object.keys(ALLOWED).filter((f) => !seen.has(f));
assert(
  stale.length === 0,
  `every allowlisted file still needs its entry (stale: ${stale.join(", ") || "none"})`,
);

// ------------------------------------------------- the scan, failing direction
const fakes = [
  // 1 — the #1279 shape: sh -c, argv ignored
  "const realExec: ExecFn = async (cmd, o) => {",
  '  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], { cwd: o?.cwd });',
  "  return { stdout };",
  "};",
  // 6 — a scripted fake forwarding the rest to a promisify(exec)
  "const execP = promisify(exec);",
  "const ctx = { verifyExecFn: async (cmd: string, opts?: Record<string, unknown>) => {",
  '  if (/^gh\\b/.test(cmd)) return { stdout: "" };',
  "  return execP(cmd, opts);",
  "} };",
  // 10 — node's callback exec, argv ignored
  "const execFn = (cmd: string, opts?: { cwd?: string }) =>",
  "  new Promise((res) => exec(cmd, { cwd: opts?.cwd }, (e, out) => res({ stdout: out })));",
  // 12 — argv-aware: not caught
  "const a: ExecFn = async (cmd, o) =>",
  '  o?.argv ? execFileP(cmd, o.argv) : execFileP("/bin/sh", ["-c", cmd]);',
  // 14 — matched via commandOf: not caught
  "const b: ExecFn = async (cmd, o) => {",
  "  cmd = commandOf(cmd, o);",
  '  return execFileP("/bin/sh", ["-c", cmd]);',
  "};",
  // 18 — a fixture's own shell helper, not an executor: not caught
  'const sh = async (cmd: string, cwd: string) => execFileP("sh", ["-c", cmd], { cwd });',
  // 19 — forwarding to the shared executor: not caught
  "const c: ExecFn = async (cmd, o) => realExec(cmd, o);",
  // 20 — a regex's `.exec(line)` is a method call, not node's exec: not caught
  "const d = (line: string, opts?: { re: RegExp }) => opts?.re.exec(line);",
].join("\n");
const caught = argvDroppingFakes(fakes).map((h) => Number(h.split(":")[0]));
assert(
  caught.join(",") === "1,6,10",
  `the scan catches the arrow-function sh -c, promisify(exec) and callback-exec fakes, and nothing else; function declarations and cmd-only stubs are outside its scope (got lines: ${caught.join(",") || "none"})`,
);
assert(
  shellOnlyEscapes("const execp = promisify(exec);\nconst ctx = { verifyExecFn: execp };")
    .length === 1,
  "a bare promisify(exec) handed on as verifyExecFn is caught",
);
assert(
  shellOnlyEscapes('const execp = promisify(exec);\nimport { execp as other } from "./x.ts";')
    .length === 0,
  "an import line naming the same binding is not a hand-on",
);

// defRe matches any promisify(exec*), so the bound name is often an ordinary
// English word. A name that merely APPEARS in prose is not a hand-on: the
// 2282 suite bound a run/promisify(execFile) pair and one prose "run" in a
// comment on a brace line read as a value use, because a leading-marker comment
// check does not cover a comment that trails code. The two positives below keep
// that from being fixed by narrowing the scan until it misses real ones.
assert(
  shellOnlyEscapes(
    "const run = promisify(execFile);\n{ // The interpreter form, run under a PATH without it.",
  ).length === 0,
  "the English word matching a promisify(execFile) binding name in a trailing comment is not a hand-on",
);
assert(
  shellOnlyEscapes(
    "const run = promisify(execFile);\nconst ctx = { verifyExecFn: run }; // counted per run",
  ).length === 1,
  "a real hand-on is still caught on a line whose trailing comment also names the binding",
);
assert(
  shellOnlyEscapes(
    'const execp = promisify(exec);\nconst note = "pass // through";\nconst ctx = { verifyExecFn: execp };',
  ).length === 1,
  "a // inside a string literal does not start a comment that could hide a hand-on",
);
// The comment strip must not eat a regex literal. The first naive strip,
// `/\/\/.*$/`, matched any `//` and truncated `const rx = /a\//; …` to
// `const rx = /a`, hiding a real hand-on that shared the line — the exact shape a
// path-splitting helper writes. A later `\s\/\/.*$` narrowed it only to
// whitespace-preceded slashes, which a regex body also satisfies, so it hid the
// same hand-on. These fixtures are built from char codes rather than escape
// sequences: a fixture typed with `\\\\` in source is a DOUBLED backslash, and a
// scan pointed at that judges a line whose shape it does not have, so the scan
// could pass while asserting on a line nobody writes. `B` is one backslash and
// `S` one slash, so `S + B + S + S` is the `\\//` that closes `p.split(/\\//)`;
// each fixture is pinned by its own shape assertion before the scan is trusted.
const B = String.fromCharCode(92);
const S = String.fromCharCode(47);
const HANDON = "const ctx = { verifyExecFn: run };";
const HANDON_EXEC = "const ctx = { verifyExecFn: execp };";

// A regex whose body holds the pair, with the hand-on on the same line.
const RX_WITH_SLASHES = "const execp = promisify(exec);\nconst rx = " + S + B + S + S + B + S + S + "; " + HANDON_EXEC;
assert(RX_WITH_SLASHES.includes(S + B + S + S + B + S + S + "; " + HANDON_EXEC), "the rx fixture really is /" + B + S + S + B + S + S + " with a hand-on on its line");
assert(
  shellOnlyEscapes(RX_WITH_SLASHES).length === 1,
  "a regex literal containing // on the same line as a hand-on does not hide it",
);

// The path-splitting shape from the report, hand-on sharing the line.
const SPLIT_HANDON = "const run = promisify(execFile);\nconst seg = p.split(" + S + B + S + S + "); " + HANDON;
assert(SPLIT_HANDON.includes("p.split(" + S + B + S + S + "); " + HANDON), "the split fixture really is p.split(/" + B + S + S + ") with a hand-on on its line");
assert(
  shellOnlyEscapes(SPLIT_HANDON).length === 1,
  "a trailing-slash regex on the hand-on's line does not hide it",
);

// The same line with a PROSE comment added: the comment is real and the hand-on
// lives inside it, so the scan must neither truncate before the comment nor read
// the comment's text as a use.
const SPLIT_PROSE = "const run = promisify(execFile);\nconst seg = p.split(" + S + B + S + S + "); // path segments " + HANDON;
assert(SPLIT_PROSE.includes("p.split(" + S + B + S + S + "); // path segments " + HANDON), "the prose fixture really is a split regex followed by a comment holding the hand-on");
assert(
  shellOnlyEscapes(SPLIT_PROSE).length === 0,
  "a hand-on written inside a trailing comment is not counted, whatever precedes it",
);

// A character-class regex: the `/` inside `[/]` is data, not a comment marker,
// so the hand-on after it stays visible.
const CLASS_HANDON = "const run = promisify(execFile);\nconst re = " + S + "[a" + S + "b]" + S + ".test(x); " + HANDON;
assert(CLASS_HANDON.includes(S + "[a" + S + "b]" + S + ".test(x); " + HANDON), "the class fixture really is a slash-in-class regex with a hand-on on its line");
assert(
  shellOnlyEscapes(CLASS_HANDON).length === 1,
  "a slash inside a regex character class does not begin a comment that hides the hand-on",
);

// A URL string: the `//` of `https://` sits inside a string, so it cannot start
// the comment that would delete the hand-on sharing the line.
const URL_HANDON = "const run = promisify(execFile);\nconst u = \"https:" + S + S + "example.com/a\"; " + HANDON + " // counted per run";
assert(URL_HANDON.includes("https:" + S + S + "example.com/a\"; " + HANDON), "the URL fixture really is a https:// string with a hand-on on its line");
assert(
  shellOnlyEscapes(URL_HANDON).length === 1,
  "a URL string plus a trailing comment does not hide the hand-on on that line",
);

// An UNTERMINATED `/` whose body holds the pair: `const a = /a//b`. The naive
// `\s\/\/.*$` strip read that `//` as a comment and deleted the hand-on after
// it, and a scanner that swallows an unterminated literal's tail does the same.
// A `/` with no closing slash is not a literal, so the code after it stays code.
const UNTERMINATED_HANDON =
  "const run = promisify(execFile);\nconst re = /a" + S + S + "b" + HANDON;
assert(
  UNTERMINATED_HANDON.includes("/a" + S + S + "b" + HANDON),
  "the unterminated fixture really is an open /a" + S + S + "b with a hand-on after it",
);
assert(
  shellOnlyEscapes(UNTERMINATED_HANDON).length === 1,
  "an unterminated regex whose body holds // does not hide the hand-on that follows",
);

// Division, not a regex: after `a / b` a slash cannot open a literal, so the
// comment that follows is still a comment and its text is not a use.
const DIVISION_PROSE = "const run = promisify(execFile);\nconst half = 1 " + S + " 2; // the run is counted per run";
assert(DIVISION_PROSE.includes("1 " + S + " 2; // the run"), "the division fixture really is a division followed by a comment naming the binding");
assert(
  shellOnlyEscapes(DIVISION_PROSE).length === 0,
  "a division slash keeps the following comment a comment",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
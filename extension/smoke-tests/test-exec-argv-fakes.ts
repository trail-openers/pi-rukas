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
 *   1. no fake executor hands `cmd` to a shell without looking at `argv`
 *      (use `realExec` from lib/exec-fake.ts, or match via `commandOf`);
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
  `the scan catches the sh -c fake, the forwarding-to-promisify(exec) fake and the callback-exec fake — and nothing else (got lines: ${caught.join(",") || "none"})`,
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

console.log(`\nexit ${exit}`);
process.exit(exit);

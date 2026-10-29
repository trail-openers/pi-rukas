#!/usr/bin/env bun
/**
 * The committed `.pi/work.json` is a gate's text, so it rots the way a gate's
 * text rots: quietly. `verify.test` sat at `bun run {file}`, which asks bun
 * for a package.json SCRIPT named after the test file — no repo has one — and
 * `verify.fast` had lost the smoke-tree typecheck AGENTS.md §1 prescribes.
 * Neither failure announced itself; the commands just did less than they
 * claimed.
 *
 * So this file asserts the committed bytes against the SAME definitions the
 * loader uses (`validateTestRunner` from `src/lean/config.ts`, imported rather
 * than restated — a test that re-spells the rules is the second source of
 * truth this exists to prevent), and reads the fast tier back out of the repo's
 * own `AGENTS.md` §1 instead of hard-coding a copy of the gate.
 *
 * It is deliberately separate from `test-verify-cmd-no-bare-bunx.ts`: that
 * file is already at the §12 line cap, so a second concern belongs in its own
 * module rather than in a squeeze.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { validateTestRunner } from "../src/lean/config.ts";
import { LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint-typecheck.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const WORK_CONFIG_PATH = ".pi/work.json";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface WorkJson {
  version?: unknown;
  autoMerge?: unknown;
  verify?: Record<string, unknown>;
}

let raw: string;
try {
  raw = readFileSync(path.join(REPO_ROOT, WORK_CONFIG_PATH), "utf8");
} catch (err) {
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
  console.error(`✗ ${WORK_CONFIG_PATH} is NOT readable (${code})`);
  process.exit(1);
}

let parsed: WorkJson;
try {
  parsed = JSON.parse(raw) as WorkJson;
  assert(true, `${WORK_CONFIG_PATH} is valid JSON`);
} catch {
  console.error(`✗ ${WORK_CONFIG_PATH} is not valid JSON`);
  process.exit(1);
}

assert(parsed.version === 1, "version is 1 — the value loadWorkConfig requires");

const verify = parsed.verify ?? {};
const fast = verify.fast;
const test = verify.test;

assert(typeof fast === "string" && fast.length > 0, "verify.fast is a non-empty string");
assert(typeof test === "string" && test.length > 0, "verify.test is a non-empty string");

// ------------------------------------------- verify.test: run the FILE, not a script

if (typeof test === "string") {
  assert(
    validateTestRunner(test) === undefined,
    `validateTestRunner accepts verify.test (got: ${validateTestRunner(test) ?? "accepted"})`,
  );
  // `bun run X` looks X up among package.json SCRIPTS; the file is not one, so
  // the runner silently resolves nothing the way its author meant. `bun X`
  // executes the file. The bug is invisible from the exit code alone, which is
  // exactly why it is pinned here rather than left to a human reading the JSON.
  assert(
    !/\bbun\s+run\s+\{file\}/.test(test),
    'verify.test does not route the file through `bun run` (a package.json script lookup)',
  );
  assert(/^bun\s+\{file\}$/.test(test), "verify.test is exactly `bun {file}`");
}

// ------------------------------------------- verify.fast: the whole of AGENTS.md §1

/**
 * The two typecheck invocations of AGENTS.md §1, assembled from the single
 * pinned launcher spelling the driver itself exports (`LOCAL_TSC_CMD`, the
 * #1414 fix) rather than re-typed here. A test that re-spells
 * `node node_modules/typescript/bin/tsc` is the second source of truth this
 * suite exists to prevent, and §1 names only the src project: the smoke tree
 * joined the gate through `.pi/verify-cmd`, so the pair below is the real
 * §1+smoke gate, stated once and asserted against.
 */
const TYPECHECK_SRC = `${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`;
const TYPECHECK_SMOKE = `${LOCAL_TSC_CMD} --noEmit -p tsconfig.smoke-tests.json`;

if (typeof fast === "string") {
  // §1's two typechecks plus the smoke tree the repo's own gate runs: without
  // the second, a type error in `smoke-tests/` is invisible to the develop
  // gate, which is the half #1907 found missing.
  for (const cmd of [TYPECHECK_SRC, TYPECHECK_SMOKE])
    assert(fast.includes(cmd), `verify.fast runs the typecheck \`${cmd}\``);
  assert(
    fast.includes("bun run check"),
    "verify.fast runs biome (`bun run check`) — the §1 lint half",
  );
  // #1414/#1118: a tsc routed through a launcher resolved a GLOBAL TypeScript
  // on one host, printed usage, and exited 0 — a gate that judged nothing.
  assert(
    !/\b(bunx|bun\s+x|npx|yarn|pnpm)\s+[^\n]*\btsc\b/.test(fast),
    "verify.fast runs every tsc through the project's own compiler, never a launcher",
  );
  assert(
    !fast.includes(TYPECHECK_SRC) || fast.includes(TYPECHECK_SMOKE),
    "verify.fast does not keep the src project while dropping the smoke tree",
  );
}

// ------------------------------------------------------- canaries: the gate can fail

function check(text: string): number {
  let obj: WorkJson;
  try {
    obj = JSON.parse(text) as WorkJson;
  } catch {
    return 1;
  }
  const v = obj.verify ?? {};
  const f = v.fast;
  const t = v.test;
  let n = 0;
  if (obj.version !== 1) n++;
  if (typeof f !== "string" || f.length === 0) n++;
  else if (!f.includes(TYPECHECK_SMOKE)) n++;
  if (typeof t !== "string" || t.length === 0) n++;
  else if (/\bbun\s+run\s+\{file\}/.test(t) || validateTestRunner(t) !== undefined) n++;
  return n;
}

const GOOD = JSON.stringify({
  version: 1,
  verify: {
    fast: `cd extension && ${TYPECHECK_SRC} && ${TYPECHECK_SMOKE} && bun run check`,
    test: "bun {file}",
  },
});
for (const [label, text, expected] of [
  ["the fixed shape", GOOD, 0],
  ["verify.test back to `bun run {file}`", GOOD.replace('"bun {file}"', '"bun run {file}"'), 1],
  [
    "verify.fast without the smoke-tree typecheck",
    GOOD.replace(` && ${TYPECHECK_SMOKE}`, ""),
    1,
  ],
  ["version bumped to 2", GOOD.replace('"version":1', '"version":2'), 1],
] as Array<[string, string, number]>) {
  const n = check(text);
  if (n === expected) console.log(`✓ canary ${label}: ${n} failure(s)`);
  else {
    console.error(`✗ GATE-BROKEN: canary ${label} expected ${expected} failure(s), got ${n}`);
    exit = 1;
  }
}

console.log(exit === 0 ? "\nCommitted lean work config is pinned." : "\nFAILED");
process.exit(exit);

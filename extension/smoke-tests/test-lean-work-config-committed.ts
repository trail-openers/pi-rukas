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
 * truth this exists to prevent), and assembles the fast tier from the one
 * pinned compiler spelling the driver itself exports (`LOCAL_TSC_CMD`, the
 * #1414 fix) plus the biome step, then asserts the committed string EQUALS
 * that assembly. Nothing here reads `AGENTS.md`: the §1 gate is what these
 * commands are, not a copy of prose this file would then be duplicating.
 *
 * The bytes are read with `git show HEAD:.pi/work.json`, not the working
 * file: that is the read `loadWorkConfig` performs, and judging a different
 * read from the one the driver makes is how a gate starts passing on bytes
 * nothing ever runs.
 *
 * It is deliberately separate from `test-verify-cmd-no-bare-bunx.ts`: that
 * file is already at the §12 line cap, so a second concern belongs in its own
 * module rather than in a squeeze.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { WORK_CONFIG_FILE, validateTestRunner } from "../src/lean/config.ts";
import { LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint-typecheck.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
/** Imported, not re-spelled: the name this gate reads must be the one loaded. */
const WORK_CONFIG_PATH = WORK_CONFIG_FILE;

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

/**
 * The committed bytes, the way the loader reads them: `git show <ref>:<path>`
 * with cwd at the repo root, argv form, no shell. A working-tree read would
 * judge an edit nobody has committed — and the loader never runs it. The
 * loader's own path constant is the argument, so this gate reads the file
 * `loadWorkConfig` reads rather than a copy of its name.
 */
function committedText(ref: string): string {
  const ran = spawnSync("git", ["show", `${ref}:${WORK_CONFIG_PATH}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (ran.error !== undefined || ran.status !== 0) {
    const why =
      ran.error?.message ??
      (typeof ran.stderr === "string" ? ran.stderr.trim() : String(ran.status));
    console.error(`✗ ${WORK_CONFIG_PATH} is NOT readable at ${ref} (${why})`);
    process.exit(1);
  }
  return ran.stdout;
}

const raw = committedText("HEAD");

let parsed: WorkJson | undefined;
let parseFailure: string | undefined;
try {
  parsed = JSON.parse(raw) as WorkJson;
  assert(true, `${WORK_CONFIG_PATH} is valid JSON`);
} catch (err) {
  parseFailure = (err as Error).message;
  console.error(`✗ ${WORK_CONFIG_PATH} is not valid JSON: ${parseFailure}`);
  exit = 1;
}

if (parsed === undefined) {
  // A file that will not parse has nothing left to judge: the summary below
  // still prints (a run that died mid-way looks different from one that read
  // nothing), and the exit code is the one `assert` already set.
  console.log(exit === 0 ? "\nCommitted lean work config is pinned." : "\nFAILED");
  process.exit(exit);
}
const config: WorkJson = parsed;

assert(config.version === 1, "version is 1 — the value loadWorkConfig requires");
// Read by nothing yet — the land step will read it — but `loadWorkConfig`
// folds an absent field to false, so the committed file says so explicitly
// rather than relying on the default.
assert(config.autoMerge === false, "autoMerge is false (the land step reads it when it lands)");

const verify = config.verify ?? {};
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

// ------------------------------------------- verify.fast: the whole of the local gate

/**
 * The two typecheck invocations, assembled from the single pinned launcher
 * spelling the driver itself exports (`LOCAL_TSC_CMD`, the #1414 fix) rather
 * than re-typed here. A test that re-spells `node node_modules/typescript/bin/tsc`
 * is the second source of truth this suite exists to prevent. The src project
 * is AGENTS.md §1's typecheck and the smoke tree is the one `.pi/verify-cmd`
 * adds; the pair below, with biome, is the real gate, stated once.
 */
const TYPECHECK_SRC = `${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`;
const TYPECHECK_SMOKE = `${LOCAL_TSC_CMD} --noEmit -p tsconfig.smoke-tests.json`;

/** The one spelling the committed file must match, character for character. */
const FAST_EXACT = `cd extension && ${TYPECHECK_SRC} && ${TYPECHECK_SMOKE} && bun run check`;

if (typeof fast === "string") {
  // EXACT equality, not "contains": a substring check passed while the file
  // ran the three commands in a different order (biome first, so a lint
  // violation cost the whole 10-minute bound before the cheap checks answered)
  // and while it carried a fourth command nobody chose.
  assert(
    fast === FAST_EXACT,
    `verify.fast is exactly \`${FAST_EXACT}\` (got: ${fast === undefined ? "absent" : fast})`,
  );
  // #1414/#1118: a tsc routed through a launcher resolved a GLOBAL TypeScript
  // on one host, printed usage, and exited 0 — a gate that judged nothing.
  assert(
    !/\b(bunx|bun\s+x|npx|yarn|pnpm)\s+[^\n]*\btsc\b/.test(fast),
    "verify.fast runs every tsc through the project's own compiler, never a launcher",
  );
}

// ------------------------------------------------------- canaries: the gate can fail

/**
 * How many rules a candidate text breaks. `-1` says the text never reached the
 * rules because it is not JSON: a mutation that breaks the syntax would
 * otherwise "pass" every canary by breaking the gate's own input, and the
 * loop below refuses that answer rather than counting it as a rule failure.
 */
function check(text: string): number {
  let obj: WorkJson;
  try {
    obj = JSON.parse(text) as WorkJson;
  } catch {
    return -1;
  }
  const v = obj.verify ?? {};
  const f = v.fast;
  const t = v.test;
  let n = 0;
  if (obj.version !== 1) n++;
  if (obj.autoMerge !== false) n++;
  if (typeof f !== "string" || f.length === 0) n++;
  else if (f !== FAST_EXACT) n++;
  if (typeof t !== "string" || t.length === 0) n++;
  else if (/\bbun\s+run\s+\{file\}/.test(t) || validateTestRunner(t) !== undefined) n++;
  return n;
}

const GOOD = JSON.stringify({
  version: 1,
  autoMerge: false,
  verify: {
    fast: FAST_EXACT,
    test: "bun {file}",
  },
});

/**
 * The three shapes #1907 found, plus the two the exact-equality assert exists
 * for: the lint step moving ahead of the typechecks (a substring check let it
 * through), and `autoMerge` flipping true (nothing reads it today, so nothing
 * else would say so).
 */
const SWAPPED = GOOD.replace(
  `"${FAST_EXACT}"`,
  `"cd extension && bun run check && ${TYPECHECK_SRC} && ${TYPECHECK_SMOKE}"`,
);
const MUTATIONS: Array<[string, string]> = [
  ["verify.test back to `bun run {file}`", GOOD.replace('"bun {file}"', '"bun run {file}"')],
  ["verify.fast without the smoke-tree typecheck", GOOD.replace(` && ${TYPECHECK_SMOKE}`, "")],
  ["version bumped to 2", GOOD.replace('"version":1', '"version":2')],
  ["autoMerge flipped to true", GOOD.replace('"autoMerge":false', '"autoMerge":true')],
  ["verify.fast with biome moved first", SWAPPED],
];

if (check(GOOD) !== 0) {
  console.error(`✗ GATE-BROKEN: the fixed shape reported ${check(GOOD)} failure(s), expected 0`);
  exit = 1;
} else console.log("✓ canary the fixed shape: 0 failure(s)");

for (const [label, text] of MUTATIONS) {
  // A mutation that did not change the text tests nothing: the replace that
  // silently missed its target would report "0 failures, expected 1" and read
  // as a broken rule rather than a canary that never mutated anything.
  if (text === GOOD) {
    console.error(`✗ GATE-BROKEN: canary ${label} did not change the text (mutation missed)`);
    exit = 1;
    continue;
  }
  const n = check(text);
  if (n === -1) {
    console.error(`✗ GATE-BROKEN: canary ${label} produced text that is not JSON`);
    exit = 1;
    continue;
  }
  if (n === 1) console.log(`✓ canary ${label}: ${n} failure(s)`);
  else {
    console.error(`✗ GATE-BROKEN: canary ${label} expected 1 failure, got ${n}`);
    exit = 1;
  }
}

// The invalid-JSON path answers -1 so a canary cannot pass on unreadable bytes.
const unparseable = check("{ not json");
if (unparseable === -1) console.log("✓ canary unparseable text is reported as -1, not a rule count");
else {
  console.error(`✗ GATE-BROKEN: unparseable text reported ${unparseable} instead of -1`);
  exit = 1;
}

console.log(exit === 0 ? "\nCommitted lean work config is pinned." : "\nFAILED");
process.exit(exit);

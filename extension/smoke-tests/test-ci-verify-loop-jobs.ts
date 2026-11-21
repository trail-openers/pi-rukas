#!/usr/bin/env bun
/**
 * Issue #2426 (epic #2424 item 1a) — CI's offline smoke step runs the pool at
 * width 4, pinned in the workflow text.
 *
 * `.github/workflows/ci.yml`'s last step invokes `verify-loop.sh` with no width
 * flag, so the pool would take the shipped default of 2 on a 4-vCPU runner. The
 * width is carried as a step-level `env:` — `PI_ENSEMBLE_VERIFY_TEST_JOBS: "4"` —
 * and this file keeps it there. The env form (rather than `--jobs-from-host`) is
 * the only shape that works: `host_job_count` answers 2 below 8 CPUs, so the flag
 * CI already has elsewhere would have left the gate at 2 and looked green doing it.
 *
 * The assertion is TEXTUAL, deliberately: the behavioural width seam already exists
 * (`test-verify-loop-jobs-from-host.ts` measures peak overlap against a stubbed
 * `getconf`), and re-running the pool here would inherit its timing window to prove
 * a number written in one YAML line.
 *
 * The reader is scoped by INDENTATION, not by a whole-file regex, because `env:` is a
 * legal key at step, job and workflow level: a pattern that ignores nesting reads a
 * sibling step's env, or the job's, as this step's. A knob that reaches the step's env
 * from the job or from a sibling step is the likeliest way for the file to look pinned
 * while CI runs at the shipped default of 2, and it is the shape that scoping catches.
 *
 * Like every gate here it is observed red — on a mutant of the shipped TEXT, never of
 * the file on disk. `ciStepPoolWidthFailures` is a pure function over workflow text,
 * so the canary writes nothing and cannot leave a mutated workflow behind if the
 * process is killed; the suite runs tests in parallel and other tests read `ci.yml`,
 * so a mutation with a `finally` is not safe here even when it works. The canary
 * asserts the mutation changed the text too — a canary whose mutant did not apply is a
 * red, not a pass.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Absolute, derived from this file — verify-loop.sh runs tests with cwd =
 * extension/, and develop's selected command passes "$PWD/…" paths, so a
 * cwd-relative read would work locally and break in the gate. */
const WORKFLOW = path.resolve(import.meta.dirname, "..", "..", ".github", "workflows", "ci.yml");

/** This file's own entry in `tsconfig.smoke-tests.json`'s `include`, and the entry of
 * the behavioural pool test whose wording this ticket rewords. The entries are read
 * back out of the config rather than assumed, so the pin cannot drift from the
 * registration that makes `tsc` judge these files at all. */
const SELF_ENTRY = "smoke-tests/test-ci-verify-loop-jobs.ts";
const REWORDN_ENTRY = "smoke-tests/test-verify-loop-jobs-from-host.ts";
const TSCONFIG = path.resolve(import.meta.dirname, "..", "tsconfig.smoke-tests.json");

/** The step whose pool width is pinned, named exactly as the workflow names it. */
const STEP_NAME = "Offline smoke tests";
/** The knob, and the width the ticket chose for a 4-vCPU `ubuntu-latest` runner. */
const JOBS_VAR = "PI_ENSEMBLE_VERIFY_TEST_JOBS";
const EXPECTED_JOBS = "4";
/** The env line as the workflow writes it; the canary's mutation target. The
 * `mutant !== shipped` assertion is what turns a reformat having moved the quoting or
 * spacing into a red rather than a gate that quietly pins nothing. */
const ENV_LINE = `          ${JOBS_VAR}: "${EXPECTED_JOBS}"`;
/** A one-step fixture carrying the pinned step's name, ready for an env block. */
const STEP_FIXTURE = `      - name: ${STEP_NAME}\n`;
const envBlock = (value: string) =>
  `${STEP_FIXTURE}        env:\n          ${JOBS_VAR}: ${value}\n        run: bash x\n`;

let exit = 0;
function report(msg: string): void {
  console.error(`✗ ${msg}`);
  exit = 1;
}
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else report(msg);
}

/** `- name: <value>`, unquoting a YAML-quoted name so a step written
 * `- name: "Offline smoke tests"` is still the step this file means. */
function stepNameOf(line: string): string | null {
  const m = /^([ \t]*)-\s+name:\s*(.*)$/.exec(line);
  if (!m) return null;
  return (m[2] ?? "").trim().replace(/^["'](.*)["']$/, "$1");
}

interface Step {
  name: string;
  /** Every line after this `- name:` item up to the next one at the same indentation.
   * Nothing is filtered out here: dropping a line is how a pin vanishes before
   * anything judges it. */
  lines: string[];
  /** The item's own leading whitespace; a line deeper than this belongs to it. */
  indent: string;
}

/** Every step of every job, in file order. */
function parseSteps(lines: string[]): Step[] {
  const steps: Step[] = [];
  for (const line of lines) {
    const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
    const name = stepNameOf(line);
    if (name !== null) steps.push({ name, lines: [], indent: ws });
    else if (steps.length > 0 && ws.length > (steps[steps.length - 1]?.indent.length ?? 0))
      steps[steps.length - 1]?.lines.push(line);
  }
  return steps;
}

/** The `key: value` entries of this step's own `env:` block: the lines indented past
 * `env:` and nothing else. The scan stops at the first line back at `env:`'s column —
 * that is a `run:`/`with:`/`if:`, or a knob that has left this step's env and so belongs
 * to no mapping that reaches `verify-loop.sh`. */
function stepEnv(step: Step): Record<string, string> {
  const entries: Record<string, string> = {};
  const at = step.lines.findIndex((l) => /^[ \t]*env:[ \t]*$/.test(l));
  if (at < 0) return entries;
  const envLine = step.lines[at] as string;
  const envCol = envLine.length - envLine.trimStart().length;
  for (const line of step.lines.slice(at + 1)) {
    const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
    const key = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]*(.*)|)$/.exec(line);
    if (!key || line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // A tab is not YAML indentation, so a tab-indented pin never joins the block.
    if (ws.length > envCol && !ws.includes("\t")) entries[key[1] as string] = (key[2] ?? "").trim();
    else break;
  }
  return entries;
}

/** The digits a YAML scalar carries once its quotes are removed; `""` for anything that
 * is not a bare or quoted scalar (`${{ vars.POOL }}`, an empty value). */
function scalarDigits(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/**
 * The failures for one workflow text. Three kinds, each with its own wording, because
 * they are different mistakes and a reader that reported both the same way would let
 * either pass as the other:
 *
 * - `does not set` — the step has no pin: no env block, or the pin belonging to a
 *   sibling step or to the job rather than to this step.
 * - `want` — a pin is present but is not the literal width: empty, templated,
 *   non-numeric, outside the 1-99 `verify-pool.sh` accepts, or a different number.
 */
export function ciStepPoolWidthFailures(text: string, expected = EXPECTED_JOBS): string[] {
  const matches = parseSteps(text.split("\n")).filter((s) => s.name === STEP_NAME);
  if (matches.length !== 1) {
    return [`step "${STEP_NAME}" appears ${matches.length} time(s) — the pin needs exactly one`];
  }
  const entries = stepEnv(matches[0] as Step);
  const where = `step "${STEP_NAME}":`;

  if (!(JOBS_VAR in entries)) {
    return [
      `${where} does not set ${JOBS_VAR} in its own env — CI would run the offline suite at the shipped default pool width`,
    ];
  }
  const raw = entries[JOBS_VAR] as string;
  if (!/^[1-9][0-9]?$/.test(scalarDigits(raw))) {
    return [
      `${where} ${JOBS_VAR} is ${JSON.stringify(raw)} — want the literal ${expected}, not an empty or templated value (verify-pool.sh falls back to 2 on anything outside 1-99)`,
    ];
  }
  if (scalarDigits(raw) !== expected) {
    return [`${where} ${JOBS_VAR} is ${scalarDigits(raw)}, want ${expected}`];
  }
  return [];
}

let shipped: string;
try {
  shipped = readFileSync(WORKFLOW, "utf8");
} catch (err) {
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
  report(`${WORKFLOW} is NOT readable (${code}) — the CI pool width is unpinned`);
  console.log(`\nexit ${exit}`);
  process.exit(exit);
}

for (const f of ciStepPoolWidthFailures(shipped)) report(f);
if (exit === 0)
  console.log(
    `✓ ${WORKFLOW}: "${STEP_NAME}" runs the offline pool at ${JOBS_VAR}=${EXPECTED_JOBS}`,
  );

// ---- canaries: the gate observed red, on the shipped text and on fixtures.
const mutant = shipped.replace(`${ENV_LINE}\n`, "");
assert(
  ENV_LINE === `          ${JOBS_VAR}: "${EXPECTED_JOBS}"` && mutant !== shipped,
  `canary: the env line ${JSON.stringify(ENV_LINE.trim())} is the shipped shape and was deleted`,
);
const mutantFails = ciStepPoolWidthFailures(mutant);
assert(
  mutantFails.length === 1 && mutantFails[0]?.includes("does not set") === true,
  `canary: the shipped workflow WITHOUT the env line is reported as unpinned (${mutantFails.length})`,
);

// What each shape must say, and the only thing it may say: a case wanting "some
// failure" would be satisfied by either message, so a reader that reported a deleted
// pin as a broken value (or the reverse) would pass all of these.
const NO_PIN = "does not set";
const BAD_VALUE = "want";
const cases: Array<[string, string, "clean" | string]> = [
  ["no env block", `${STEP_FIXTURE}        run: bash x\n`, NO_PIN],
  // The pin present only as a comment: the value never reaches the step's env, so the
  // answer is the missing-pin one. A reader that skipped comments only after matching
  // a key would call this a broken value instead.
  [
    "the width only as a comment",
    `${STEP_FIXTURE}        env:\n          # ${JOBS_VAR}: "${EXPECTED_JOBS}"\n        run: bash x\n`,
    NO_PIN,
  ],
  ["an empty value", envBlock(`""`), BAD_VALUE],
  ["a templated value", envBlock("${{ vars.POOL }}"), BAD_VALUE],
  ["a non-numeric width", envBlock("four"), BAD_VALUE],
  // A wrong number is still a literal width, so the answer must be the WIDTH complaint
  // and never the missing-pin one — otherwise a broken pin and a deleted pin read alike.
  ["the wrong literal", envBlock(`"2"`), BAD_VALUE],
  ["a pinned step", envBlock(`"${EXPECTED_JOBS}"`), "clean"],
  // The reason the lookup is per-step: a sibling step's env carries the same line.
  [
    "a sibling step's env is not this step's",
    `      - name: Something else\n        env:\n          ${JOBS_VAR}: "${EXPECTED_JOBS}"\n${STEP_FIXTURE}        run: bash x\n`,
    NO_PIN,
  ],
];
for (const [label, text, want] of cases) {
  const fails = ciStepPoolWidthFailures(text);
  const phrases = want === "clean" ? [] : want.split("+");
  const ok =
    fails.length === phrases.length &&
    phrases.every((phrase) => fails.some((f) => f.includes(phrase)));
  if (ok) console.log(`✓ canary ${label}: ${want}`);
  else
    report(
      `GATE-BROKEN: canary ${label} want ${want}, got ${fails.length}: ${fails[0]?.slice(-70) ?? "none"}`,
    );
}

// The per-step lookup, judged on the shipped file: move the width line out of the
// step's env to the job's column, byte-identical apart from its indentation, and the
// step must still read as unpinned. A whole-file "does the line exist?" reader would
// call this pinned, which is the whole reason the lookup is scoped by indentation.
const relocated = shipped.replace(`${ENV_LINE}\n`, `      ${JOBS_VAR}: "${EXPECTED_JOBS}"\n`);
const relocatedFails = ciStepPoolWidthFailures(relocated);
assert(
  relocated !== shipped &&
    relocatedFails.length === 1 &&
    relocatedFails[0]?.includes(NO_PIN) === true,
  `canary: the shipped width line at env's OWN column is not read as pinned (${relocatedFails.length} failure(s))`,
);

// `tsc -p tsconfig.smoke-tests.json` exits 0 over an `include` entry that resolves to
// nothing, so a test that was never registered reads as a clean type-check. Both
// directions: the entry is listed, and the file it names exists.
let cfg = "";
try {
  cfg = readFileSync(TSCONFIG, "utf8");
} catch (err) {
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
  report(`${TSCONFIG} is NOT readable (${code}) — neither file's type-check is registered`);
}
for (const entry of [SELF_ENTRY, REWORDN_ENTRY]) {
  assert(cfg.includes(`"${entry}"`), `tsconfig.smoke-tests.json lists ${entry}`);
  assert(existsSync(path.resolve(import.meta.dirname, "..", entry)), `${entry} exists`);
}

console.log(exit === 0 ? "\nAll CI verify-loop pool-width checks passed." : "\nFAILED");
process.exit(exit);

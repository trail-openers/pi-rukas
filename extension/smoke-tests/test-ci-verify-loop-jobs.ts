#!/usr/bin/env bun
/**
 * Issue #2426 (epic #2424 item 1a) and #2449 — CI's offline smoke step runs the pool at
 * width 4 and arms the per-file timing ceiling at 30 s, both pinned in the workflow text.
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
 * Both pins ride the same readers, so the ceiling cannot be armed from a place the
 * loop never reads while this file calls it armed.
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
/** The env lines as the workflow writes them — the canaries' mutation targets, and the
 * fixtures' shipped values. The `mutant !== shipped` assertion is what turns a reformat
 * having moved the quoting or spacing into a red rather than a gate that quietly pins
 * nothing. The ceiling (#2449) is an OPT-IN knob: unset, the loop never reads the
 * allow-list and the ratchet stays off, so the CI ceiling exists only while its line does. */
const ENV_LINE = `          ${JOBS_VAR}: "${EXPECTED_JOBS}"`;
const CEILING_VAR = "PI_ENSEMBLE_VERIFY_TIMING_CEILING_S";
const EXPECTED_CEILING = "30";
const JOBS_LINE = ENV_LINE;
const CEILING_LINE = `          ${CEILING_VAR}: "${EXPECTED_CEILING}"`;
/** A one-step fixture carrying the pinned step's name, ready for an env block. */
const STEP_FIXTURE = `      - name: ${STEP_NAME}\n`;
/** A step carrying BOTH pins at the shipped indentation — the shape the real step has,
 * so a width fixture is never judged while the ceiling is missing and vice versa. */
const PINNED = `${JOBS_LINE}\n${CEILING_LINE}\n`;
const envBlock = (value: string) =>
  `${STEP_FIXTURE}        env:\n${PINNED.replace(JOBS_LINE, `          ${JOBS_VAR}: ${value}`)}        run: bash x\n`;
/** The same fixture builder for the ceiling knob, so both pins are judged by one
 * reader over one shape of step. */
const envBlock2 = (key: string, value: string) =>
  `${STEP_FIXTURE}        env:\n${PINNED.replace(CEILING_LINE, `          ${key}: ${value}`)}        run: bash x\n`;

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
  const failures: string[] = [];

  if (!(JOBS_VAR in entries)) {
    failures.push(
      `${where} does not set ${JOBS_VAR} in its own env — CI would run the offline suite at the shipped default pool width (verify-pool.sh's fallback)`,
    );
  } else {
    const raw = entries[JOBS_VAR] as string;
    if (!/^[1-9][0-9]?$/.test(scalarDigits(raw))) {
      failures.push(
        `${where} ${JOBS_VAR} is ${JSON.stringify(raw)} — want the literal ${expected}, not an empty or templated value (verify-pool.sh falls back to 2 on anything outside 1-99)`,
      );
    } else if (scalarDigits(raw) !== expected) {
      failures.push(`${where} ${JOBS_VAR} is ${scalarDigits(raw)}, want ${expected}`);
    }
  }

  // Same readers, second pin. `verify-timing.sh` accepts 1–4 digits and leaves the
  // ceiling OFF on anything else, naming the bad value on stderr — so a `"3O"` or a
  // templated value here is a green run with no ratchet at all, which is the failure
  // direction this whole file exists to close. Each message names its OWN knob and no
  // other: the fixture cases judge a knob by `failure.includes(thatKnob)`, and a message
  // that quoted its sibling's name would make one failure answer for two.
  if (!(CEILING_VAR in entries)) {
    failures.push(
      `${where} does not set ${CEILING_VAR} in its own env — the per-file timing ratchet (#2449) stays off in CI, so a smoke file that becomes slow stays invisible`,
    );
  } else {
    const raw = entries[CEILING_VAR] as string;
    if (!/^[1-9][0-9]{0,3}$/.test(scalarDigits(raw))) {
      failures.push(
        `${where} ${CEILING_VAR} is ${JSON.stringify(raw)} — want the literal ${EXPECTED_CEILING}, not an empty, zero, templated or non-numeric value (verify-timing.sh keeps this ceiling OFF on anything outside 1-4 digits)`,
      );
    } else if (scalarDigits(raw) !== EXPECTED_CEILING) {
      failures.push(`${where} ${CEILING_VAR} is ${scalarDigits(raw)}, want ${EXPECTED_CEILING}`);
    }
  }
  return failures;
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
    `✓ ${WORKFLOW}: "${STEP_NAME}" runs the offline pool at ${JOBS_VAR}=${EXPECTED_JOBS} with ${CEILING_VAR}=${EXPECTED_CEILING}`,
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
// pin as a broken value (or the reverse) would pass all of these. Each case names the
// knob it is about — that name selects WHICH failures it is judged on, so a ceiling
// complaint can never satisfy a width case — and the phrases it expects are the FAILURE
// KIND only (`does not set` = deleted, `is`/`want` = broken value), never the knob's own
// name: a phrase that named the knob would also match the OTHER knob's message, which
// quotes it. A case wanting two failures spells both, separated by `+`.
const cases: Array<[string, string, "clean" | string]> = [
  ["no env block", `${STEP_FIXTURE}        run: bash x\n`, "does not set"],
  // The pin present only as a comment: the value never reaches the step's env, so the
  // answer is the missing-pin one. A reader that skipped comments only after matching
  // a key would call this a broken value instead.
  [
    "the width only as a comment",
    `${STEP_FIXTURE}        env:\n          # ${JOBS_VAR}: "${EXPECTED_JOBS}"\n          ${CEILING_VAR}: "${EXPECTED_CEILING}"\n        run: bash x\n`,
    "does not set",
  ],
  ["an empty value", envBlock(`""`), "is"],
  ["a templated value", envBlock("${{ vars.POOL }}"), "is"],
  ["a non-numeric width", envBlock("four"), "is"],
  // A wrong number is still a literal width, so the answer must be the WIDTH complaint
  // and never the missing-pin one — otherwise a broken pin and a deleted pin read alike.
  ["the wrong literal", envBlock(`"2"`), "is 2, want"],
  ["a pinned step", envBlock(`"${EXPECTED_JOBS}"`), "clean"],
  // The reason the lookup is per-step: a sibling step's env carries both pinned lines,
  // so the step under test carries neither and both pins read as missing.
  [
    "a sibling step's env is not this step's",
    `      - name: Something else\n        env:\n${PINNED}${STEP_FIXTURE}        run: bash x\n`,
    "does not set",
  ],
];
// The ceiling observed red on the shipped text: deleted outright, and blanked in place
// (a key still present whose value is empty is the shape a whole-file "is the line
// there?" reader calls pinned, and the shape that leaves CI with the ceiling off).
for (const [label, mutation] of [
  ["deleted", ""],
  ["blanked", `          ${CEILING_VAR}: ""\n`],
] as const) {
  const ceilMutant = shipped.replace(`${CEILING_LINE}\n`, mutation);
  assert(
    ceilMutant !== shipped,
    `canary: the ceiling line ${JSON.stringify(CEILING_LINE.trim())} is the shipped shape and was ${label}`,
  );
  const fails = ciStepPoolWidthFailures(ceilMutant);
  assert(
    fails.length === 1 &&
      fails[0]?.includes(CEILING_VAR) === true &&
      fails[0]?.includes(label === "deleted" ? "does not set" : "want") === true &&
      fails.every((f) => !f.includes(JOBS_VAR)),
    `canary: the workflow with the ceiling line ${label} is reported red, and only for the ceiling (${fails.length}: ${fails[0]?.slice(-60) ?? "none"})`,
  );
}

// The ceiling's own fixtures, judged by the shared `caseCanary` loop over the ceiling
// knob: the shipped step with the ceiling moved, mangled, commented out or set to `0` —
// the shipped OFF state, legal to the parser and worthless in CI, so it must be red here.
const ceilingCases: Array<[string, string, "clean" | string]> = [
  [
    "ceiling commented out",
    `${STEP_FIXTURE}        env:\n          ${JOBS_VAR}: "${EXPECTED_JOBS}"\n          # ${CEILING_VAR}: "${EXPECTED_CEILING}"\n        run: bash x\n`,
    "does not set",
  ],
  // The sibling-step shape: only the ceiling has moved, the width stays put.
  [
    "a sibling step's ceiling is not this step's",
    `      - name: Something else\n        env:\n          ${CEILING_VAR}: "${EXPECTED_CEILING}"\n${STEP_FIXTURE}          ${JOBS_VAR}: "${EXPECTED_JOBS}"\n        run: bash x\n`,
    "does not set",
  ],
  ["ceiling zero — the off state", envBlock2(CEILING_VAR, `"0"`), "is"],
  ["ceiling templated", envBlock2(CEILING_VAR, "${{ vars.CEIL }}"), "is"],
  ["ceiling the wrong literal", envBlock2(CEILING_VAR, `"120"`), "is 120, want"],
  ["ceiling pinned beside the width", envBlock2(CEILING_VAR, `"${EXPECTED_CEILING}"`), "clean"],
];

/**
 * One canary loop for both pins. `only` selects WHICH failures the case is judged on —
 * the failures naming the knob under test — so the other pin's state can neither rescue
 * nor break it, and a ceiling complaint can never satisfy a width case. The expected
 * `want` phrases are the FAILURE KIND only (`does not set` = deleted, `is … want` =
 * broken value) and never name a knob: each failure message quotes its sibling's name
 * in its remedy, so a knob-naming phrase would match the wrong failure.
 */
function caseCanary(label: string, text: string, want: "clean" | string, only: string): void {
  const fails = ciStepPoolWidthFailures(text).filter((f) => only === "" || f.includes(only));
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
for (const [label, text, want] of ceilingCases) caseCanary(label, text, want, CEILING_VAR);
for (const [label, text, want] of cases) caseCanary(label, text, want, JOBS_VAR);

// The per-step lookup, judged on the shipped file: move the width line out of the
// step's env to the job's column, byte-identical apart from its indentation, and the
// step must still read as unpinned. A whole-file "does the line exist?" reader would
// call this pinned, which is the whole reason the lookup is scoped by indentation.
const relocated = shipped.replace(`${ENV_LINE}\n`, `      ${JOBS_VAR}: "${EXPECTED_JOBS}"\n`);
const relocatedFails = ciStepPoolWidthFailures(relocated);
assert(
  relocated !== shipped &&
    relocatedFails.length === 1 &&
    relocatedFails[0]?.includes("does not set") === true,
  `canary: the shipped width line at env's OWN column is not read as pinned (${relocatedFails.length} failure(s))`,
);

// The same scoping for the ceiling, so it cannot be pinned from the job's env and read
// as armed: relocated it is one failure, and it names the ceiling and not the width.
const relocatedCeiling = shipped.replace(
  `${CEILING_LINE}\n`,
  `      ${CEILING_VAR}: "${EXPECTED_CEILING}"\n`,
);
const relocatedCeilingFails = ciStepPoolWidthFailures(relocatedCeiling);
assert(
  relocatedCeiling !== shipped &&
    relocatedCeilingFails.length === 1 &&
    relocatedCeilingFails[0]?.includes(CEILING_VAR) === true &&
    relocatedCeilingFails.every((f) => !f.includes(JOBS_VAR)),
  `canary: the shipped ceiling line at env's OWN column is not read as armed (${relocatedCeilingFails.length} failure(s))`,
);

// The step-name guard still fires for both pins: with the step absent there is no env
// to read, and silence must never read as two pinned knobs — one failure naming the
// step count, not the per-knobs wording the pins produce.
assert(
  ciStepPoolWidthFailures(
    `      - name: Some other step\n        env:\n          ${JOBS_VAR}: "${EXPECTED_JOBS}"\n          ${CEILING_VAR}: "${EXPECTED_CEILING}"\n        run: bash x\n`,
  ).length === 1,
  "canary: a workflow without the named step reports one step-count failure, not two pins",
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

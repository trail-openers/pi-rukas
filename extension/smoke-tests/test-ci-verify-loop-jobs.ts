#!/usr/bin/env bun
/**
 * Issue #2426 (epic #2424 item 1a) — CI's offline smoke step runs the pool at
 * width 4, pinned in the workflow text.
 *
 * `.github/workflows/ci.yml`'s last step invokes `verify-loop.sh` with no width
 * flag, so the pool would take the shipped default of 2 on a 4-vCPU runner. The
 * width is therefore carried as a step-level `env:` — `PI_ENSEMBLE_VERIFY_TEST_JOBS:
 * "4"` — and this file is what keeps it there. The env form (rather than
 * `--jobs-from-host`) is the only shape that works: `host_job_count` answers 2 below
 * 8 CPUs, so the flag CI already has elsewhere would have left the gate at 2 and
 * looked green doing it.
 *
 * The assertion is TEXTUAL, deliberately: the behavioural width seam already
 * exists (`test-verify-loop-jobs-from-host.ts` measures peak overlap against a
 * stubbed `getconf`), and re-running the pool here would inherit its timing window
 * to prove a number that is written in one YAML line.
 *
 * The parser is scoped by INDENTATION, not by a whole-file regex: `env:` is a legal
 * key at step, job and workflow level, so a pattern that ignores nesting either
 * reads a sibling step's env or the job's as this step's. A block whose entries sit
 * at the wrong depth — one space off — is a block belonging to someone else, and
 * the assertion says so rather than silently accepting it.
 *
 * Like every gate here, it is observed red: `ciStepPoolWidthFailures` is run against
 * the SHIPPED file with its env line actually deleted — the canary commits that
 * mutation to disk, checks the gate refuses it, and restores the original bytes on
 * every exit path (including a throw), asserting the file is byte-identical
 * afterwards. It is the same shipped-text canary shape as
 * `lib/ci-doctrine-shipped-canaries.ts`, where a canary whose mutant did not apply
 * is a red, not a pass.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Absolute, derived from this file — verify-loop.sh runs tests with cwd =
 * extension/, and develop's selected command passes "$PWD/…" paths, so a
 * cwd-relative read would work locally and break in the gate. */
const WORKFLOW = path.resolve(import.meta.dirname, "..", "..", ".github", "workflows", "ci.yml");

/** This file's own entry in `tsconfig.smoke-tests.json`'s `include`, and the entry
 * of the behavioural pool test whose wording this ticket rewords. Both import types
 * and must compile under that project; the entries are read back out of the config
 * (and asserted present) rather than assumed, so the pin cannot drift from the
 * registration that does the work. `test-review-findings-tsconfig-registration.ts`
 * judges that config's shape; what is checked here is narrower — the two files this
 * ticket touches are actually in it. */
const SELF_ENTRY = "smoke-tests/test-ci-verify-loop-jobs.ts";
const REWORDN_ENTRY = "smoke-tests/test-verify-loop-jobs-from-host.ts";
const TSCONFIG = path.resolve(import.meta.dirname, "..", "tsconfig.smoke-tests.json");

/** The step whose pool width is pinned, named exactly as the workflow names it. */
const STEP_NAME = "Offline smoke tests";
/** The knob, and the width the ticket chose for a 4-vCPU `ubuntu-latest` runner. */
const JOBS_VAR = "PI_ENSEMBLE_VERIFY_TEST_JOBS";
const EXPECTED_JOBS = "4";

/** The env line as the workflow writes it. The canary deletes THIS line from the
 * shipped file, so a reformat that moves the quoting or the spacing makes the
 * mutation a no-op — which the canary itself then reports, instead of the file
 * quietly losing its pin. */
const ENV_LINE = `          ${JOBS_VAR}: "${EXPECTED_JOBS}"`;

let exit = 0;
function report(msg: string): void {
  console.error(`✗ ${msg}`);
  exit = 1;
}
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else report(msg);
}

/** Leading-space count of a line; a blank or comment line answers -1 so it
 * separates both step list items (`      - name:`) and env entries (`          K:`). */
function indent(line: string): number {
  if (line.trim() === "" || line.trimStart().startsWith("#")) return -1;
  return line.length - line.trimStart().length;
}

/** `- name: <value>`, unquoting a YAML-quoted name so a step written
 * `- name: "Offline smoke tests"` is still the step this file means. */
function stepNameOf(line: string): string | null {
  const m = /^\s*-\s+name:\s*(.*)$/.exec(line);
  if (!m) return null;
  return (m[1] ?? "").trim().replace(/^["'](.*)["']$/, "$1");
}

/** One `- name:` step and the lines nested under it, up to the next item at the
 * same indentation. */
interface Step {
  name: string;
  lines: string[];
}

/** Every step of every job, in file order, each carrying its own nested lines. */
function parseSteps(lines: string[]): Step[] {
  const steps: Step[] = [];
  let current: Step | null = null;
  let itemIndent = 0;
  for (const line of lines) {
    const ind = indent(line);
    if (ind < 0) continue;
    const name = stepNameOf(line);
    if (name !== null) {
      current = { name, lines: [] };
      steps.push(current);
      itemIndent = ind;
      continue;
    }
    // Anything indented past the `- ` item belongs to it; anything back at or
    // outside that column is a sibling, a job key, or the next job.
    if (current !== null && ind > itemIndent) current.lines.push(line);
  }
  return steps;
}

/** The `key: value` entries of this step's own `env:` block, in order. Empty when
 * the step has no env block at all. Entries are the lines indented past `env:` —
 * entries at the wrong depth belong to another mapping and are reported, not read. */
function stepEnv(step: Step): { entries: Record<string, string>; malformed: string[] } {
  const entries: Record<string, string> = {};
  const malformed: string[] = [];
  const envIndent = step.lines.findIndex((l) => /^\s*env:\s*$/.test(l) && !/^\s*-/.test(l));
  if (envIndent < 0) return { entries, malformed };
  const envCol = indent(step.lines[envIndent] as string);
  for (const line of step.lines.slice(envIndent + 1)) {
    const ind = indent(line);
    if (ind <= envCol) break; // the block ended (a run:/with:/if: at env's level)
    const kv = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) {
      malformed.push(`unparsable env entry: ${JSON.stringify(line.trim())}`);
      continue;
    }
    // A tab, or a key not indented past `env:`, is not a child of the block —
    // reading it as one is how a misindented pin silently belongs to nothing.
    if (kv[1]?.includes("\t") || (kv[1]?.length ?? 0) <= envCol) {
      malformed.push(`env entry not nested under env: ${JSON.stringify(line.trim())}`);
      continue;
    }
    entries[(kv[2] ?? "").trim()] = (kv[3] ?? "").trim();
  }
  return { entries, malformed };
}

/** The digits a YAML scalar carries once its quotes are removed; `""` for anything
 * that is not a bare or quoted scalar (`${{ vars.POOL }}`, an empty value). */
function scalarDigits(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** Whether an env VALUE is a literal width: digits only (YAML quoting is free,
 * `${{ … }}` is not), in the range `verify-pool.sh`'s parse accepts. */
function isLiteralWidth(value: string): boolean {
  return /^[1-9][0-9]?$/.test(scalarDigits(value));
}

/**
 * The failures for one workflow text: what this step's env must say, and the shapes
 * that would make the file look pinned without pinning it — the step absent, no env
 * block, a value that is not a literal number, an entry that is not nested under
 * `env:`.
 *
 * An ABSENT env block is a failure with its own message: "the step has no env" and
 * "the step's env has the wrong value" must not collapse into one answer, because
 * the first is a deleted pin and the second is a broken one.
 */
export function ciStepPoolWidthFailures(text: string, expected = EXPECTED_JOBS): string[] {
  const steps = parseSteps(text.split("\n"));
  const matches = steps.filter((s) => s.name === STEP_NAME);
  if (matches.length !== 1) {
    return [
      `step "${STEP_NAME}" appears ${matches.length} time(s) in ${WORKFLOW} — the pin needs exactly one`,
    ];
  }
  const step = matches[0] as Step;
  const { entries, malformed } = stepEnv(step);
  const fails = malformed.map((m) => `${WORKFLOW}: ${STEP_NAME} — ${m}`);

  if (!(JOBS_VAR in entries)) {
    fails.push(
      `${WORKFLOW}: step "${STEP_NAME}" does not set ${JOBS_VAR} in its step-level env — CI would run the offline suite at the shipped default pool width`,
    );
    return fails;
  }
  const raw = entries[JOBS_VAR] as string;
  if (!isLiteralWidth(raw)) {
    fails.push(
      `${WORKFLOW}: step "${STEP_NAME}" sets ${JOBS_VAR} to ${JSON.stringify(raw)} — want the literal ${expected}, not an empty or templated value (verify-pool.sh warns and falls back to 2 on anything outside 1-99)`,
    );
    return fails;
  }
  if (scalarDigits(raw) !== expected) {
    fails.push(
      `${WORKFLOW}: step "${STEP_NAME}" sets ${JOBS_VAR} to ${scalarDigits(raw)}, want ${expected}`,
    );
  }
  return fails;
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

// ---- the shipped file
for (const f of ciStepPoolWidthFailures(shipped)) report(f);
if (exit === 0)
  console.log(`✓ ${WORKFLOW}: "${STEP_NAME}" runs the offline pool at ${JOBS_VAR}=${EXPECTED_JOBS}`);

/** The step the parser actually found, reported so a reader sees what was judged
 * rather than only that something passed. */
const found = parseSteps(shipped.split("\n")).filter((s) => s.name === STEP_NAME);
assert(found.length === 1, `the workflow holds exactly one "${STEP_NAME}" step (found ${found.length})`);

// ---- canaries: the gate observed red, on the shipped file and on fixtures.
// `try/finally` because the first canary deletes a line from the REAL workflow and
// the `finally` must get to put it back even if an assertion path throws.
try {
  // 1. THE mutant: the env line actually DELETED FROM THE FILE ON DISK. The shipped
  // check above is worth only what this half proves — that the same reader returns
  // one failure for the real workflow without its pin. The mutation is committed, so
  // the judge and the judged share one artefact; the bytes come back in the `finally`.
  let mutant: string;
  try {
    writeFileSync(WORKFLOW, shipped.replace(`${ENV_LINE}\n`, ""), "utf8");
    mutant = readFileSync(WORKFLOW, "utf8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    report(`canary: the env line could not be deleted from ${WORKFLOW} (${code})`);
    mutant = shipped;
  }
  assert(
    mutant.length === shipped.length - (ENV_LINE.length + 1),
    `canary: the env line ${JSON.stringify(ENV_LINE.trim())} was really deleted from the file`,
  );
  const mutantFails = ciStepPoolWidthFailures(mutant);
  assert(
    mutantFails.length === 1,
    `canary: the shipped workflow WITHOUT the env line fails the gate (${mutantFails.length} failure(s): ${mutantFails[0]?.slice(-60) ?? "none"})`,
  );

  // 2. The other ways a step can look pinned without being pinned. Exact counts:
  // an over-firing rule hides one that fires where it should not.
  const stepText = found[0]?.lines.join("\n") ?? "";
  const cases: Array<[string, string, number]> = [
    ["no env block at all", `      - name: ${STEP_NAME}\n        run: |\n          bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts\n`, 1],
    ["an empty value", `      - name: ${STEP_NAME}\n        env:\n          ${JOBS_VAR}: ""\n        run: bash x\n`, 1],
    ["a templated value", `      - name: ${STEP_NAME}\n        env:\n          ${JOBS_VAR}: \${{ vars.POOL }}\n        run: bash x\n`, 1],
    ["the width only in a comment", `      - name: ${STEP_NAME}\n        # ${JOBS_VAR}: ${EXPECTED_JOBS}\n        run: bash x\n`, 1],
    ["a non-numeric width", `      - name: ${STEP_NAME}\n        env:\n          ${JOBS_VAR}: four\n        run: bash x\n`, 1],
    ["the wrong literal", `      - name: ${STEP_NAME}\n        env:\n          ${JOBS_VAR}: "2"\n        run: bash x\n`, 1],
    ["an env entry at env's own indentation", `      - name: ${STEP_NAME}\n        env:\n        ${JOBS_VAR}: "4"\n        run: bash x\n`, 1],
    ["a pinned step", `      - name: ${STEP_NAME}\n        env:\n          ${JOBS_VAR}: "${EXPECTED_JOBS}"\n        run: bash x\n`, 0],
    ["a sibling step's env is not this step's", `      - name: Something else\n        env:\n          ${JOBS_VAR}: "${EXPECTED_JOBS}"\n      - name: ${STEP_NAME}\n        run: bash x\n`, 1],
  ];
  for (const [label, text, expected] of cases) {
    const n = ciStepPoolWidthFailures(text).length;
    if (n === expected) console.log(`✓ canary ${label}: ${n} failure(s)`);
    else report(`GATE-BROKEN: canary ${label} expected ${expected} failure(s), got ${n}`);
  }

  // 3. The step's own text must be what shipped — otherwise the fixtures above
  // judge a shape the real file does not have.
  assert(
    stepText.includes(`${JOBS_VAR}:`) && /\benv:/.test(stepText),
    `the "${STEP_NAME}" step parsed with both an env: key and the ${JOBS_VAR} entry`,
  );

  // 4. Reading is per-step for a reason: if the width line ever moved OUT of this
  // step's env — to the job or workflow scope, or into a sibling step's env — a
  // pattern that only asked "does the file contain the line?" would still read it as
  // pinned. `stepEnv` never sees it there, so the gate must fail. The mutant keeps
  // the line byte-identical and relocates only its indentation, so what differs from
  // the shipped file is nesting and nothing else.
  const relocatedText = shipped.replace(`${ENV_LINE}\n`, `        ${JOBS_VAR}: "${EXPECTED_JOBS}"\n`);
  const relocated = ciStepPoolWidthFailures(relocatedText);
  assert(
    relocatedText !== shipped && relocated.length === 1,
    `canary: the same width line at env's OWN indentation is not read as pinned (${relocated.length} failure(s))`,
  );
} finally {
  // The restore is the other half of mutating a real file: the canary must leave the
  // workflow byte-identical, or a crash between the two writes strands a red CI on
  // disk. A failed restore is a red — never a silent pass on a mutated tree.
  try {
    writeFileSync(WORKFLOW, shipped, "utf8");
    assert(
      readFileSync(WORKFLOW, "utf8") === shipped,
      `canary: ${WORKFLOW} restored byte-for-byte after the mutation`,
    );
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    report(`canary: ${WORKFLOW} could NOT be restored (${code}) — restore it from git`);
  }
}

// ---- the type-check registration the brief's gate depends on
{
  // `tsc -p tsconfig.smoke-tests.json` only judges a file `include` names, and it
  // prints nothing and exits 0 over an entry that resolves to nothing — so a new
  // test that was never registered, or whose registration lost a character, reads
  // as a clean type-check. Both directions: the entries are listed, and the files
  // they name exist.
  let cfg: string;
  try {
    cfg = readFileSync(TSCONFIG, "utf8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    report(`${TSCONFIG} is NOT readable (${code}) — neither file's type-check is registered`);
    cfg = "";
  }
  for (const entry of [SELF_ENTRY, REWORDN_ENTRY]) {
    assert(
      cfg.includes(`"${entry}"`),
      `tsconfig.smoke-tests.json lists ${entry} so tsc actually judges it`,
    );
    assert(
      existsSync(path.resolve(import.meta.dirname, "..", entry)),
      `the registered file ${entry} exists`,
    );
  }
}

console.log(exit === 0 ? "\nAll CI verify-loop pool-width checks passed." : "\nFAILED");
process.exit(exit);

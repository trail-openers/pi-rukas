#!/usr/bin/env bun
/**
 * #2428 AC7 — the roster is documented, and the documentation is pinned.
 *
 * Three files carry it and none of them is read at runtime: `docs/configuration.md`'s env table is
 * where an operator learns the lever exists and what `0` restores, its `work.json` row is where they
 * learn `verify.roster`'s shape, and `docs/troubleshooting.md` is where a hand-back becomes a cause
 * and a fix rather than a mystery. Nothing checks prose, so an assertion here is the only thing that
 * keeps the text from drifting away from the gate it describes (R8).
 *
 * The needles are the ones a reader actually needs: that the suite runs at BOTH commits, that the
 * report is the only source of the names, that a missing roster hands back rather than grading green,
 * that the land gate reads the RECORD, and that the off arm restores the pre-roster behaviour. An
 * incidental-word assertion would survive the sentence being rewritten to say something false.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leanProjectRosterEnabled } from "../src/lean/project-roster-switch.ts";
import { ROSTER_LAND_REFUSAL } from "../src/lean/verify-roster.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-AC7-project-roster-docs.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repo, rel), "utf8");

const configuration = read("docs/configuration.md");
const lean = read("docs/lean.md");
const troubleshooting = read("docs/troubleshooting.md");

/** The env table's row for one variable, so an assertion is about ITS row and not the file's. */
function envRow(name: string): string {
  const line = configuration.split("\n").find((l) => l.startsWith(`| \`${name}\` |`));
  if (line === undefined) throw new Error(`docs/configuration.md has no row for ${name}`);
  return line;
}

/** The work.json row, which documents every config field including `verify.roster`. */
function workJsonRow(): string {
  const line = configuration.split("\n").find((l) => l.includes("`.pi/work.json`"));
  if (line === undefined) throw new Error("docs/configuration.md has no .pi/work.json row");
  return line;
}

/** The verify step's row of the lean step table. */
function verifyRow(): string {
  const line = lean.split("\n").find((l) => l.startsWith("| `verify` |"));
  if (line === undefined) throw new Error("docs/lean.md has no verify step row");
  return line;
}

const rosterRow = envRow("PI_ENSEMBLE_LEAN_PROJECT_ROSTER");

/** The lever's row states the rule the switch implements, in both directions. */
function checkSwitchRow(): void {
  assert(
    /\| `1` \|/.test(rosterRow),
    "(configuration) the switch's row documents its default as ON",
  );
  assert(
    /Only the literal `"0"`/.test(rosterRow),
    "(configuration) the row says only the literal 0 takes the arm off",
  );
  assert(
    /Read at CALL time/i.test(rosterRow),
    "(configuration) the row says the lever is read at call time, not at load",
  );
  assert(
    /no projectRoster|no `projectRoster`/.test(rosterRow) && /verdict KIND/i.test(rosterRow),
    "(configuration) the row says the off arm writes no roster and asks only the kinds it asked before",
  );
  for (const test of ["verify-roster.ts", "project-roster-switch.ts", "engine-facts.ts"]) {
    assert(rosterRow.includes(test), `(configuration) the row names ${test} as its source`);
  }
  for (const suite of [
    "test-AC1-project-roster-handback.ts",
    "test-AC5-project-roster-switch.ts",
  ]) {
    assert(rosterRow.includes(suite), `(configuration) the row cites ${suite} as what pins it`);
  }
}

{
  // The config row: the field exists, its placeholders are named, and its argv discipline is stated
  // where an operator writing the field will read it.
  const row = workJsonRow();
  assert(/`verify\.roster`/.test(row), "(configuration) work.json's row documents verify.roster");
  assert(
    row.includes("{report}") && row.includes("{dir}"),
    "(configuration) both placeholders are named",
  );
  assert(
    /argv form/i.test(row),
    "(configuration) the row says the command is argv form, never a shell",
  );
  assert(
    /HANDS BACK|hands back/.test(row) && /`verify\.test`/.test(row),
    "(configuration) the row says a project with no way to run its suite hands back",
  );
  assert(
    /PI_ENSEMBLE_LEAN_PROJECT_ROSTER/.test(row),
    "(configuration) the config row points at the lever that takes the arm out",
  );
}

{
  // The step table's verify row, which is where an operator reads what the gate actually does.
  const row = verifyRow();
  assert(
    /pre-existing/.test(row),
    "(lean.md) the verify row says the project's PRE-EXISTING tests are judged",
  );
  assert(
    /base commit/.test(row) && /throwaway checkout of the base|once in the worktree/.test(row),
    "(lean.md) the row says the suite runs at the base commit as well as at head",
  );
  assert(
    /JUnit|JUnit report|report is the ONLY source/.test(row),
    "(lean.md) the row says the runner's report is where the per-test names come from",
  );
  assert(
    /git ls-tree/.test(row),
    "(lean.md) the row says pre-existing is decided by what the BASE commit lists",
  );
  assert(
    /base version of every pre-existing test file the run edited/.test(row),
    "(lean.md) the row says an edited test's base version is re-run against the head code",
  );
  assert(
    /RECORD, not the verdict|reads the RECORD/.test(row),
    "(lean.md) the row says the land gate reads the record, not the verdict kind",
  );
  assert(
    /outranks the whole-line baseline excuse/.test(row),
    "(lean.md) the row says the roster outranks the line-based excuse",
  );
}

/** Troubleshooting: the hand-back's symptom, its causes, and the fix an operator can act on. */
function checkTroubleshooting(): void {
  assert(
    /no project test roster/.test(troubleshooting),
    "(troubleshooting) the hand-back's own words are the symptom, so a search finds it",
  );
  assert(
    /testDir \+ verify\.testGlob|verify\.testDir/.test(troubleshooting),
    "(troubleshooting) the missing-config cause names the pair the project never set",
  );
  assert(
    /wrote nothing|no report/.test(troubleshooting),
    "(troubleshooting) the empty-report cause is distinguished from the config one",
  );
  assert(
    /"verify"\s*:/.test(troubleshooting) && troubleshooting.includes("--junitxml={report} {dir}"),
    "(troubleshooting) the fix is a work.json snippet an operator can paste",
  );
  assert(
    /PI_ENSEMBLE_LEAN_PROJECT_ROSTER=0/.test(troubleshooting),
    "(troubleshooting) the escape hatch is named with the value that takes it",
  );
  assert(
    /gitignore/i.test(troubleshooting),
    "(troubleshooting) the row warns about the report's bytes reaching the index",
  );
  assert(
    troubleshooting.includes(ROSTER_LAND_REFUSAL.slice(0, 32)),
    "(troubleshooting) the land refusal's own words appear, so an operator matching the log finds the entry",
  );
  assert(
    /verify not green/.test(troubleshooting),
    "(troubleshooting) the entry says the refusal names the roster rather than pointing at a green gate",
  );
}

/**
 * The docs and the code agree on the default. A row that says ON while the switch reads off is the
 * drift this test exists to catch, so the assertion is against the real reader rather than the prose.
 */
async function checkDefaults(): Promise<void> {
  assert(leanProjectRosterEnabled() === true, "(default) the shipped default really is ON");
  await withEnv({ PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0" }, async () => {
    assert(leanProjectRosterEnabled() === false, "(default) and the literal 0 really is off");
  });
}

checkSwitchRow();
checkTroubleshooting();
await checkDefaults();

console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);

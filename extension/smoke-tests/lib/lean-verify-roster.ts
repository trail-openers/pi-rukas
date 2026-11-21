/**
 * lib/lean-verify-roster — the PROJECT-TEST ROSTER vocabulary the verify fixture shares.
 *
 * The roster runs the project's suite in two trees the fixture built — the run's worktree and the
 * probe's throwaway checkout — and reads the runner's machine-readable report back out of each. A
 * case cannot make a real pytest write a report it did not configure, and it must not have to
 * rewrite a commit to say what the base's run reported, so the case DECLARES the two runs' per-test
 * verdicts and the exec stub answers the gate's report read from that declaration. These are the
 * three pieces that make the declaration legible to both sides: the option shape's serialiser
 * (`rosterReportXml`), the predicate that recognises the report read among the step's children
 * (`isRosterReportRead`), and the roster command the fixture renders from the config
 * (`rosterCommandFor`).
 *
 * The XML this writes is the shape a JUnit report has, so the gate's own parser is what reads it:
 * the fixture never hands the gate a verdict, only a report, and an unreadable report is the gate's
 * problem to refuse rather than the harness's to paper over.
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkConfig } from "../../src/lean/config.ts";
import { ROSTER_REPORT_FILE } from "../../src/lean/verify-roster-command.ts";
import type { VerifyOpts } from "./lean-verify-types.ts";

/**
 * The name a case declares as a side's ONLY name to make that roster run write NO report: a run
 * that exited 0 having written nothing, which is what a suite that collected nothing looks like.
 */
export const NO_REPORT_SENTINEL = "__NO_REPORT__";

/** One roster run's declared verdicts, as a case states them. */
export interface RosterSide {
  passed: readonly string[];
  failed: readonly string[];
}

/**
 * The JUnit report a declared roster run "wrote".
 *
 * `undefined` is the shape the case asks for when it wants the report missing: a run that exited 0
 * having written nothing is a run whose suite may have collected nothing at all, and the gate must
 * hand back rather than grade it green. A side with no names in either list is that same case.
 *
 * Names arrive as `classname::name` when the case writes them that way, which is what a pytest
 * report's `name` attribute holds and what the gate records.
 */
export function rosterReportXml(side: RosterSide): string | undefined {
  if (side.passed.length + side.failed.length === 0) return undefined;
  const cases = [
    ...(side.passed.map((name) => `  <testcase ${attrs(name)}/>`) as string[]),
    ...side.failed.map(
      (name) =>
        `  <testcase ${attrs(name)}><failure message="assertion failed">trace</failure></testcase>`,
    ),
  ];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<testsuite tests="${String(side.passed.length + side.failed.length)}" failures="${String(side.failed.length)}">`,
    ...cases,
    "</testsuite>",
    "",
  ].join("\n");
}

/**
 * A `<testcase>`'s identity attributes.
 *
 * A declared name of the `path::test` shape is split the way a real JUnit report splits it — the
 * file in `classname`, the case in `name` — because the gate rebuilds the label by joining the two
 * with `::`, and a serialiser that put the whole string in both would hand it `a::one::a::one`.
 * A name with no `::` is a bare case name and gets no classname at all.
 */
function attrs(name: string): string {
  const cut = name.lastIndexOf("::");
  if (cut <= 0) return `name="${attr(name)}"`;
  return `classname="${attr(name.slice(0, cut))}" name="${attr(name.slice(cut + 2))}"`;
}

/** An XML attribute value, escaped enough that a name with `<` or `&` still round-trips. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Is this exec call the gate reading a roster report back?
 *
 * The gate reads the report through a bounded `cat` whose argv is exactly the absolute report path,
 * so the shape is one argv word ending in the report's filename. Recognising it — rather than
 * running the suite again for it — is what lets a case declare the verdicts of a run in a tree it
 * built. `runTestFile`'s frozen runs are argv form too, but theirs begin with the runner binary and
 * carry the test path, never this filename alone.
 */
export function isRosterReportRead(o2: { argv?: string[] } | undefined): boolean {
  return (
    Array.isArray(o2?.argv) &&
    o2.argv.length === 1 &&
    o2.argv[0]?.endsWith(`/${ROSTER_REPORT_FILE}`) === true
  );
}

/** The roster command the fixture renders from the config, or `undefined` when none applies. */
export function rosterCommandFor(config: {
  roster?: string;
  test?: string;
}): { bin: string } | undefined {
  const template =
    config.roster ??
    (config.test === undefined ? undefined : deriveRosterTemplate(config.test));
  if (template === undefined) return undefined;
  const bin = template.split(/\s+/).filter((w) => w !== "")[0];
  return bin === undefined ? undefined : { bin };
}

/**
 * The fixture's copy of the gate's derivation (`deriveSuiteTemplate` in `verify-roster-command.ts`):
 * `verify.test` with one whole-word `{file}` removed, plus the report pair. A fixture that appended
 * without removing would recognise its own roster runs by an argv the gate no longer submits, and
 * every roster case would silently stop counting the runs it asserts on.
 */
export function deriveRosterTemplate(test: string): string {
  const words = test.split(/\s+/).filter((w) => w !== "");
  const at = words.indexOf("{file}");
  const kept = at < 0 ? words : [...words.slice(0, at), ...words.slice(at + 1)];
  return `${kept.join(" ")} --junitxml={report} {dir}`;
}

/**
 * Which tree a roster run belongs to.
 *
 * The base run's cwd is the throwaway checkout the step made for the base commit, whose path the
 * fixture does not know — it is a sibling of the repo named after the issue, not the fixture's
 * baseline dir. So "not the worktree" is the base, and the one case that could be mistaken for the
 * other (a run whose cwd is neither) is reported as the base, which is the side whose report the gate
 * is least willing to trust.
 */
export function rosterSideOf(cwd: string, worktree: string, _probeDir: string): "head" | "base" {
  return cwd === worktree ? "head" : "base";
}
/**
 * The project's pre-existing test files this case's base commit carries, as path -> the names its
 * run reports.
 *
 * The DEFAULT is one passing test the project already had, and it exists so the roster's on arm is
 * what every case written before Part A sees: those cases ask about the frozen contract, the tiers
 * and the tree, and a step that handed every one of them back for a suite the case never mentioned
 * would test nothing. A case that wants the rosterless shape passes `roster: {}` with no files; a
 * case that wants a red roster declares the names.
 *
 * A file is named for the pair the config will name it under, so the enumeration the gate performs
 * at the base commit finds it.
 */
export function rosterTestFiles(opts: VerifyOpts): Record<string, string[]> {
  if (opts.roster === undefined) return { [DEFAULT_PROJECT_TEST]: [] };
  // The case's declared files are the base commit's suite, in full: the default is for the case that
  // declared nothing, and keeping it beside a case's own list would hand the gate a file whose
  // verdicts the case never declared.
  return Object.fromEntries((opts.roster.files ?? []).map((rel): [string, string[]] => [rel, []]));
}

/**
 * The names each roster run's report holds.
 *
 * The DEFAULT declares one test that passes in both trees, which is what makes the roster's on arm
 * usable by every case written before Part A: those cases ask about the frozen contract, the tiers
 * and the tree, and a step that handed all of them back for a suite the case never mentioned would
 * test nothing. A case declares the names itself for every other shape — a test red at head that was
 * green at the base, a suite that collected nothing, a run that died.
 */
export function rosterSideNames(
  opts: VerifyOpts,
  side: "head" | "base",
): {
  passed: string[];
  failed: string[];
} {
  if (opts.roster === undefined)
    return side === "head"
      ? { passed: [...DEFAULT_ROSTER_NAMES], failed: [] }
      : { passed: [...DEFAULT_ROSTER_NAMES], failed: [] };
  return {
    passed: [
      ...(side === "head" ? (opts.roster.headPassed ?? []) : (opts.roster.basePassed ?? [])),
    ],
    failed: [
      ...(side === "head" ? (opts.roster.headFailed ?? []) : (opts.roster.baseFailed ?? [])),
    ],
  };
}

/** Where the fixture's default project test lives, matching the default config pair. */
export const DEFAULT_PROJECT_TEST = "tests/test-project.sh";
/** The one test the default project file reports passing, at head and at base alike. */
export const DEFAULT_ROSTER_NAMES = ["project_test_passes"] as const;

/**
 * The roster command this case's config carries.
 *
 * The default is the fixture's own runner: `sh <project test> --junitxml={report} {dir}`, which is
 * the derived form rendered against the project's per-file template. A case that configures its own
 * `verify.roster` gets exactly that, so the gate's own render is what the case exercises rather than
 * one the harness chose for it.
 */
export function rosterTemplate(
  opts: VerifyOpts,
  configured: Partial<WorkConfig["verify"]>,
): string {
  if (configured.roster !== undefined) return configured.roster;
  if (opts.rosterTemplate !== undefined) return opts.rosterTemplate;
  // The fixture's own runner: a committed script that writes the JUnit report the gate reads back.
  // It is written in the shape the gate DERIVES from `verify.test` — the file placeholder gone, the
  // tree and the report named — because a fixture whose template disagrees with the derivation is a
  // fixture that recognises its own roster runs by an argv the gate never submits.
  return "sh .lean-roster-runner.sh --junitxml={report} {dir}";
}

/**
 * Take the dependency tree a case says never arrived out of a roster checkout.
 *
 * Timed by the caller to the base SUITE's run rather than to the checkout: the production order is
 * checkout, link, then run, and the gate is asked to notice an undelivered dependency between the link
 * that reported success and the run that would silently fail every test. Removing them here is the
 * state a link that never landed leaves — the tree is present, the modules are not, and nothing
 * upstream reported it.
 */
export function bareDepsOf(tree: string, deps: readonly string[]): void {
  for (const dep of deps) {
    try {
      rmSync(path.join(tree, dep), { recursive: true, force: true });
    } catch {
      /* a tree already bare is the state the case asked for */
    }
  }
}

/**
 * Write the report a declared roster run "wrote", in the tree the run belongs to.
 *
 * A real file, in the shape a JUnit report has, so the gate's parser, its emptiness rule and its
 * contradiction rule all run on bytes rather than on a verdict the harness asserted. Synchronous, and
 * it has to be: the gate reads the report back with its own `readFileSync` the moment the run resolves,
 * so an await between the run and its answer is a report that arrives after the verdict — the same as
 * no report at all.
 */
export function writeDeclaredReport(
  tree: string,
  side: { passed: readonly string[]; failed: string[] },
  which: "head" | "base",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const report = path.join(tree, ROSTER_REPORT_FILE);
  const absent = [...side.passed, ...side.failed].includes(NO_REPORT_SENTINEL);
  const xml = absent ? undefined : rosterReportXml(side);
  try {
    if (xml === undefined) rmSync(report, { force: true });
    else writeFileSync(report, xml);
  } catch {
    /* a tree that is already gone is the gate's problem to refuse, not the stub's to hide */
  }
  return Promise.resolve({ code: 0, stdout: `roster-said-${which}\n`, stderr: "" });
}

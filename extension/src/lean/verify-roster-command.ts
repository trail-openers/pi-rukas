/**
 * lean/verify-roster-command — invoke the PROJECT's suite and read back its report.
 *
 * The roster's hands, not its judgement: render the project's report command for a tree, re-render
 * it for another, run it once, and turn the runner's machine-readable report into per-test verdicts.
 * What those verdicts MEAN is `verify-roster.ts`.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { failureLines } from "../work-driver-verify-failures.ts";
import { leanProjectRosterEnabled } from "./project-roster-switch.ts";
import type { VerifyExec, VerifyRosterConfig } from "./verify-types.ts";

const JUNIT_REPORT_FILE = ".lean-roster-report.xml";

/** One roster run's output ceiling; past it the roster is unreadable, not empty. */
const ROSTER_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Render the project roster command for one tree.
 *
 * A configured `verify.roster` template is the runner's machine-readable report form. With none
 * configured the default is DERIVED from `verify.test`: one whole-word `{file}` deleted and
 * `--junitxml={report} {dir}` appended, so `pytest -q {file}` becomes `pytest -q --junitxml={report}
 * {dir}`. Deleting the word is required — the loader REQUIRES `verify.test` to
 * carry one, so appending alone hands the runner a path literally named `{file}` and no report.
 * A template with no such word derives by appending alone.
 *
 * `{dir}` is the tree the roster runs in and `{report}` the file the roster reads back, each
 * substituted as a whole argv word.
 */
export function renderRosterCommand(
  config: VerifyRosterConfig,
  tree: string,
): { bin: string; args: string[]; report: string } | { reason: string } {
  const report = `${tree}/${JUNIT_REPORT_FILE}`;
  const template =
    config.roster ??
    (config.test === undefined
      ? undefined
      : // The derived default: the project's own runner, told to write a report this gate can read,
        // pointed at the whole tree instead of at one file.
        deriveSuiteTemplate(config.test));
  if (template === undefined)
    return {
      reason:
        "the project configured neither verify.roster nor verify.test, so no per-test report can be derived",
    };
  const words = template
    .split(/\s+/)
    .map((word) => word.split("{dir}").join(tree).split("{report}").join(report))
    .filter((word) => word !== "");
  const bin = words[0];
  if (bin === undefined || words.length < 2)
    return { reason: `the roster command ${template} has nothing to run` };
  return { bin, args: words.slice(1), report };
}

/**
 * `verify.test` as a SUITE command: one whole-word `{file}` removed, the report pair appended. Only a
 * word EQUAL to `{file}` counts — the loader admits exactly one, and `test-{file}.ts` is a name.
 *
 * Exported because the verify fixture renders the same command to recognise its own roster runs: a
 * second copy of this rule is a second thing that can disagree with the one the gate runs.
 */
export function deriveSuiteTemplate(test: string): string {
  const words = test.split(/\s+/).filter((word) => word !== "");
  const at = words.indexOf("{file}");
  const kept = at < 0 ? words : [...words.slice(0, at), ...words.slice(at + 1)];
  return `${kept.join(" ")} --junitxml={report} {dir}`;
}

/**
 * Why a run cannot start with this roster config, or undefined when it can.
 *
 * The derived command hands `verify.test` pytest's `--junitxml={report}`, and the roster learns
 * names ONLY from that report, so a runner that is not pytest writes none and every verify hands
 * back after build has spent its budget. "Is pytest" is one mechanical rule, never a reading of
 * the command: some argv word whose basename is `pytest` or `py.test`. A wrapper that forwards to
 * pytest without naming it is refused too, and spells the same command as its `verify.roster`.
 */
export function rosterStartProblem(config: VerifyRosterConfig): string | undefined {
  if (!leanProjectRosterEnabled()) return undefined;
  if (config.roster !== undefined) return escapingReportProblem(config.roster);
  if (config.test === undefined) return undefined;
  if (config.test.split(/\s+/).some((word) => /^py\.?test$/.test(path.basename(word))))
    return undefined;
  return "verify.roster is unset and verify.test is not pytest, so the derived --junitxml={report} writes no JUnit report: set verify.roster to write one to {report}, or PI_ENSEMBLE_LEAN_PROJECT_ROSTER=0 for a project with no suite to roster";
}

/**
 * Why a configured `verify.roster` names its report outside the tree it runs in, or undefined.
 *
 * Each leg reads its report from inside its own tree, so a `--junitxml` path that is absolute or climbs
 * out with `..` names a file both legs share and neither may read: refused before build spends its
 * budget, rather than handed back after.
 */
function escapingReportProblem(template: string): string | undefined {
  const words = template.split(/\s+/);
  for (const [i, word] of words.entries()) {
    const flag = /^--junit-?xml(?:=(.*))?$/.exec(word);
    if (flag === null) continue;
    const value = flag[1] ?? words[i + 1] ?? "";
    if (value.startsWith("/") || value.split("/").includes(".."))
      return `verify.roster writes its report to ${value}, outside the tree each roster run reads it from: name the report {report}`;
  }
  return undefined;
}

/**
 * The same command re-rendered for another tree.
 *
 * A configured `verify.roster` template may name its tree and report explicitly, so each word
 * that carried the head tree's path is replaced with the other tree's; words that named neither
 * travel unchanged. This is what keeps the head and base runs from reading each other's report.
 */
export function retargetRosterCommand(
  rendered: { bin: string; args: string[]; report: string },
  fromTree: string,
  toTree: string,
): { bin: string; args: string[]; report: string } {
  const fromReport = `${fromTree}/${JUNIT_REPORT_FILE}`;
  const toReport = `${toTree}/${JUNIT_REPORT_FILE}`;
  // One pass, report path first: the base tree is the head tree's name with a suffix, so a second pass
  // over the swapped text would rewrite the base report path again into a tree nobody reads.
  const from = new RegExp(`${escapeRegExp(fromReport)}|${escapeRegExp(fromTree)}`, "g");
  const swap = (word: string): string =>
    word.replace(from, (hit) => (hit === fromReport ? toReport : toTree));
  // A template with no `{report}` reports to a path this gate cannot predict, so the base run is
  // not run at all — the caller hands back rather than reading one tree's report as the other's.
  if (fromReport === toReport) return { bin: "", args: [], report: toReport };
  return { bin: swap(rendered.bin), args: rendered.args.map(swap), report: toReport };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The report file a roster run writes, so a fixture can name it too.
 *
 * One literal, exported: the fixtures that write a report by hand and the gate that reads it must name
 * the same file, and a second copy of the string is a second thing that can disagree with the first.
 */
export const ROSTER_REPORT_FILE = JUNIT_REPORT_FILE;

/**
 * `<testcase>` verdicts out of a JUnit XML report: each name (its `classname` prefixed when
 * present) and whether the element held a `<failure>`/`<error>` child.
 *
 * A scan, not an XML parser — one dependency to read one report is not worth it, and the only
 * answers returned are "these names ran", "these names failed", and (when neither set can be
 * built) nothing, which the caller reads as a hand-back. A malformed report yields nothing.
 *
 * A name is judged over EVERY occurrence: a runner that retries writes one `<testcase>` per attempt
 * (or nests the earlier attempts as `<rerunFailure>`/`<flakyFailure>`), and an attempt that failed is
 * a failure whichever attempt the report lists first. Any child other than the neutral ones counts as
 * a failure — report families name their retry markers differently, and an unknown marker read as a
 * pass is a green nobody observed. A name whose every occurrence was skipped ran nowhere: neither set.
 */
export function parseJUnitCases(xml: string): { passed: string[]; failed: string[] } {
  const verdict = new Map<string, "passed" | "failed" | "skipped">();
  const open = /<testcase\b[^>]*>/g;
  for (let match = open.exec(xml); match !== null; match = open.exec(xml)) {
    const tag = match[0];
    const selfClosed = tag.endsWith("/>");
    const end = selfClosed ? match.index : xml.indexOf("</testcase>", match.index);
    // An unterminated `<testcase>` means the report was cut short: nothing in it is trustworthy.
    if (end < 0) return { passed: [], failed: [] };
    const body = selfClosed ? tag : xml.slice(match.index, end);
    const name = /<testcase\b[^>]*\bname="([^"]*)"/.exec(body)?.[1] ?? "";
    if (name === "") return { passed: [], failed: [] };
    const classname = /<testcase\b[^>]*\bclassname="([^"]*)"/.exec(body)?.[1] ?? "";
    const label = classname === "" ? name : `${classname}::${name}`;
    // Captured output and comments are text, not markers: a log line that prints `<div>` is not a child.
    const children = [
      ...body
        .slice(tag.length)
        // A captured-output element is cut only after the CDATA it may wrap is gone, so
        // a `/>` or `</system-out>` printed inside the CDATA cannot end it early.
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "")
        .replace(/<(system-out|system-err)\b(?:[^>]*\/>|[\s\S]*?<\/\1>)/g, "")
        .matchAll(/<([A-Za-z_][\w.:-]*)/g),
    ].map((m) => m[1]);
    const now = children.some((c) => !NEUTRAL_CHILDREN.has(c ?? ""))
      ? "failed"
      : children.includes("skipped")
        ? "skipped"
        : "passed";
    const before = verdict.get(label);
    if (before === "failed" || (before === "passed" && now === "skipped")) continue;
    verdict.set(label, now);
  }
  const named = (v: string) => [...verdict].filter(([, at]) => at === v).map(([label]) => label);
  return { passed: named("passed"), failed: named("failed") };
}

/** The `<testcase>` children that say nothing about whether the test passed. */
const NEUTRAL_CHILDREN = new Set(["skipped", "properties", "property", "system-out", "system-err"]);

/** One roster run's verdicts: which tests ran and which failed. */
export type SuiteRun =
  | { ran: true; passed: string[]; failed: string[] }
  | { ran: false; reason: string };

/**
 * One roster run of one tree: run the configured command and read WHICH tests it ran.
 *
 * The command reaches the executor in argv form, so no shell re-parses the tree's path, and
 * `killGroup` makes the wall clock real for a runner that spawns a grandchild. The per-test
 * names come from the REPORT, never from the tail: a bounded tail elides every per-failure
 * marker, so a roster built from one silently reports zero tests.
 */
export async function runProjectSuite(
  exec: VerifyExec,
  opts: {
    cwd: string;
    bin: string;
    args: string[];
    report: string;
    timeoutMs: number;
    /** Where the report is read FROM — a tree the caller controls, never the exec seam's cwd. */
    reportCwd: string;
  },
): Promise<SuiteRun> {
  // Removed before the run, so an earlier run's report is never read as this one's, and after it,
  // so lean's own file is not dirt to the porcelain scans that follow.
  const report = path.resolve(opts.reportCwd, opts.report);
  rmSync(report, { force: true });
  try {
    return await runAndRead(exec, opts);
  } finally {
    rmSync(report, { force: true });
  }
}

async function runAndRead(
  exec: VerifyExec,
  opts: Parameters<typeof runProjectSuite>[1],
): Promise<SuiteRun> {
  const ran = await exec(opts.bin, {
    argv: opts.args,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: ROSTER_MAX_BUFFER,
    killGroup: true,
    env: verifyChildEnv(),
  }).catch((err: unknown) => ({ __err: err }) as never);
  // The executor's contract decides the reading: `execp` RESOLVES only when the child exited 0
  // (with no `code` on the result) and REJECTS otherwise, carrying `code`/`signal`/`killed` and the
  // streams on the error. So a rejection is observed through its error, and a resolution is exit 0.
  const rejected = (ran as { __err?: unknown }).__err;
  const e = (rejected !== undefined ? rejected : ran) as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    killed?: unknown;
    timedOutKill?: unknown;
    signal?: unknown;
    overflow?: unknown;
  };
  // Observation FIRST, the way every other verify classifier asks it: a kill, an overflow or an
  // un-startable command carries no numeric exit, and an exit-code test asked ahead of it reads
  // the absence as "exited 0" and hands a green to a run nobody watched.
  if (e.killed === true || e.timedOutKill === true)
    return { ran: false, reason: "the roster run was killed or timed out" };
  if (e.signal !== undefined && e.signal !== null)
    return { ran: false, reason: "the roster run was signalled" };
  if (e.overflow !== undefined)
    return {
      ran: false,
      reason: `the roster run exceeded its output bound on ${String(e.overflow)}`,
    };
  if (typeof e.code === "string")
    return { ran: false, reason: "the roster command could not be started" };
  // A resolution with no `code` is the child's exit 0. A REJECTION that carries no numeric exit — a
  // child whose status was never read — is the residue the observation arms above do not answer, and
  // the residue is "did not run", never "passed".
  const code = rejected === undefined && e.code === undefined ? 0 : e.code;
  if (typeof code !== "number" || !Number.isInteger(code))
    return {
      ran: false,
      reason: `the roster run produced no exit status (${code === undefined ? "none" : `code ${String(code)}`})`,
    };
  const exitCode = code;
  const report = readReport(opts.reportCwd, opts.report);
  if (report === undefined)
    return {
      ran: false,
      reason: `the roster report ${path.basename(opts.report)} was not readable after the run (exit ${String(exitCode)}${outputExcerpt(e.stderr, e.stdout)})`,
    };
  const cases = parseJUnitCases(report);
  if (cases.passed.length + cases.failed.length === 0)
    return { ran: false, reason: "the roster report named no test — nothing was observed running" };
  const stream = [e.stdout, e.stderr].filter((s): s is string => typeof s === "string").join("\n");
  // A runner that exited non-zero while its report claims every test passed, and whose stream
  // prints no failure line either, said two contradictory things: not the roster's verdict.
  if (exitCode !== 0 && cases.failed.length === 0 && failureLines(stream).length === 0)
    return {
      ran: false,
      reason: `the roster run exited ${String(exitCode)} while its report names only passing tests`,
    };
  return { ran: true, passed: cases.passed, failed: cases.failed };
}

/** The run's last words for a hand-back: stderr's tail (stdout's when stderr is empty), bounded. */
function outputExcerpt(stderr: unknown, stdout: unknown): string {
  const pick = [stderr, stdout].find((s): s is string => typeof s === "string" && s.trim() !== "");
  if (pick === undefined) return ", no output";
  const flat = pick.trim().replace(/\s+/g, " ");
  return `: ${flat.length > 400 ? `…${flat.slice(-400)}` : flat}`;
}

/**
 * The report's bytes, or `undefined` when the tree would not give them.
 *
 * `lstat` first: a report that is a symlink points at bytes another process controls, and a
 * roster read from there is a roster somebody else wrote. Any read failure — missing, unreadable,
 * a directory — is the same answer as no report, which the caller reads as a hand-back.
 */
function readReport(cwd: string, file: string): string | undefined {
  const abs = path.resolve(cwd, file);
  // A report outside the tree it is read from is bytes another tree's run wrote.
  const rel = path.relative(cwd, abs);
  if (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) return undefined;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

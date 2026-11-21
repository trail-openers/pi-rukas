/**
 * lean/verify-roster-command — invoke the PROJECT's suite and read back its report.
 *
 * The roster's hands, not its judgement: render the project's report command for a tree, re-render
 * it for another, run it once, and turn the runner's machine-readable report into per-test verdicts.
 * What those verdicts MEAN is `verify-roster.ts`; this module answers only "what did the runner
 * report". The rules it enforces are stated where they are judged — `verify-roster.ts`'s header.
 */

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { failureLines } from "../work-driver-verify-failures.ts";
import type { VerifyExec, VerifyRosterConfig } from "./verify-types.ts";

const JUNIT_REPORT_FILE = ".lean-roster-report.xml";

/** One roster run's output ceiling; past it the roster is unreadable, not empty. */
const ROSTER_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Render the project roster command for one tree.
 *
 * A configured `verify.roster` template is the runner's machine-readable report form; with none
 * configured, the derived default is the `verify.test` command with pytest's `--junitxml`
 * appended. `{dir}` is the tree the roster runs in and `{report}` the file the roster reads
 * back, each substituted as a whole argv word — no shell is involved on either form.
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
      : // The derived pytest default: the project's own runner, pointed at the whole tree,
        // told to write a report this gate can read.
        `${config.test} --junitxml={report} {dir}`);
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
  const swap = (word: string): string =>
    word.split(fromReport).join(toReport).split(fromTree).join(toTree);
  // A template with no `{report}` reports to a path this gate cannot predict, so the base run is
  // not run at all — the caller hands back rather than reading one tree's report as the other's.
  if (fromReport === toReport) return { bin: "", args: [], report: toReport };
  return { bin: swap(rendered.bin), args: rendered.args.map(swap), report: toReport };
}

/** The report file a roster run writes, so a fixture can name it too. */
export const ROSTER_REPORT_FILE = ".lean-roster-report.xml";

/**
 * `<testcase>` verdicts out of a JUnit XML report: each name (its `classname` prefixed when
 * present) and whether the element held a `<failure>`/`<error>` child.
 *
 * A scan, not an XML parser — one dependency to read one report is not worth it, and the only
 * answers returned are "these names ran", "these names failed", and (when neither set can be
 * built) nothing, which the caller reads as a hand-back. A malformed report yields nothing.
 */
export function parseJUnitCases(xml: string): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
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
    if (seen.has(label)) continue;
    seen.add(label);
    if (/<(failure|error)\b/i.test(body)) failed.push(label);
    else passed.push(label);
  }
  return { passed, failed };
}

/** One roster run's verdicts: which tests ran and which failed. */
export type SuiteRun =
  | { ran: true; passed: string[]; failed: string[] }
  | { ran: false; reason: string };

/**
 * One roster run of one tree: run the configured command and read WHICH tests it ran.
 *
 * The command reaches the executor in argv form, so no shell re-parses the tree's path, and
 * `killGroup` makes the wall clock real for a runner that spawns a grandchild. The per-test
 * names come from the REPORT, never from the tail: a bounded tail shows the summary and elides
 * every per-failure marker, so a roster built from one silently reports zero tests — the exact
 * pass this module exists to refuse.
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
  const ran = await exec(opts.bin, {
    argv: opts.args,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: ROSTER_MAX_BUFFER,
    killGroup: true,
    env: verifyChildEnv(),
  }).catch((err: unknown) => ({ __err: err }) as never);
  const e = ran as {
    __err?: unknown;
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
  const exitCode = typeof e.code === "number" ? e.code : e.__err === undefined ? 0 : undefined;
  if (exitCode === undefined)
    return { ran: false, reason: "the roster run produced no exit status" };
  const report = readReport(opts.reportCwd, opts.report);
  if (report === undefined)
    return {
      ran: false,
      reason: `the roster report ${path.basename(opts.report)} was not readable after the run`,
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

/**
 * The report's bytes, or `undefined` when the tree would not give them.
 *
 * `lstat` first: a report that is a symlink points at bytes another process controls, and a
 * roster read from there is a roster somebody else wrote. Any read failure — missing, unreadable,
 * a directory — is the same answer as no report, which the caller reads as a hand-back.
 */
function readReport(cwd: string, file: string): string | undefined {
  const abs = path.resolve(cwd, file);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

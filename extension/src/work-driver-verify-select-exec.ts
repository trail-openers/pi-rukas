/**
 * work-driver-verify-select-exec — #1647: the attribution wrapper around the
 * selected verify command.
 *
 * The develop gate and the ci tier each hand ONE command to an executor. This
 * wraps that executor for the selected command only; every other call passes
 * through untouched. A failing run is judged by the names in its out-of-band
 * report (#1404 — written by verify-loop.sh, never read from the stream), not
 * by its exit code alone:
 *
 *   - no parseable failing names (tsc or biome failed, the loop crashed, the
 *     report is missing) → blocks; a timed-out run → blocks, and is not rerun,
 *     because the bound is the verdict;
 *   - the run is repeated ONCE (the #782 single-rerun mechanism, here per
 *     selected run): passing on the rerun → flaky, not blocking;
 *   - failing again → a test this cycle changed or added blocks (a base run
 *     would test an older file); otherwise a per-test base probe runs exactly
 *     those tests through verify-loop. Red on base only → baseline-red, not
 *     blocking; any change-caused name, or an unresolved probe → blocks.
 *
 * Only tsc and biome failures always block without a test to attribute; every
 * other outcome is the rule above, which is what the resolved decisions on
 * #1647 settle.
 */

import { trace } from "./trace.ts";
import type { VerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import { attributeAgainstBase } from "./work-driver-verify-attribution.ts";
import { isTimedOutKill } from "./work-driver-verify-develop-helpers.ts";
import { readVerifyReport } from "./work-driver-verify-report-file.ts";
import { createVerifyReportFile, verifyReportEnv } from "./work-driver-verify-report-path.ts";
import type { ExecFn } from "./worktree.ts";

/** What a selected run let through without blocking, for the cycle's record. */
export interface SelectedVerifyRecord {
  /** Tests that failed once and passed on the rerun. */
  flaky: string[];
  /** Tests that failed twice and are red on the base commit too. */
  baselineRed: string[];
  /** Set when the run was recovered by its rerun: the first run's output, for the ci tier's #782 signal. */
  recovered?: { firstRunOutput: string };
}

export interface SelectedVerifyOptions {
  /** The exact selected command; only calls carrying it are wrapped. */
  cmd: string;
  channel: VerifyChannel;
  repoRoot: string;
  baseSha: string | undefined;
  /** Every tree the run may execute in (the worktrees and the integration checkout). */
  changeRoots: readonly string[];
  /** Test files this cycle changed or added, relative to `extension/`. Never probed. */
  changedTests: readonly string[];
  /** The base probe's worktree label; each seam passes its own (#1647). */
  probeLabel: string;
  timeoutMs: number;
  record: SelectedVerifyRecord;
  /**
   * The ci tier's single rerun for a failure that names no test (a transient
   * tsc or loop crash). The develop round leaves it off: an unnamed failure
   * blocks there, as it always has.
   */
  rerunUnnamed?: boolean;
}

type ExecError = Error & {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  timedOutKill?: boolean;
  overflow?: string;
};

type RunResult =
  | { ok: true; out: { stdout: string; stderr?: string } }
  | {
      ok: false;
      err: ExecError;
      timedOut: boolean;
      names?: string[];
      reportFile?: string;
      reason: string;
    };

const EXT_MARK = "/extension/";
const SMOKE_TEST_REL_RE = /^smoke-tests\/[A-Za-z0-9_.-]+\.ts$/;

/**
 * A failing-test name the loop printed, as a path relative to `extension/`.
 * Undefined for anything else: the rule the names must satisfy is the one the
 * probe command needs, because the name is written into a shell argument.
 */
export function extensionRelative(name: string): string | undefined {
  const at = name.lastIndexOf(EXT_MARK);
  if (at < 0) return undefined;
  const rel = name.slice(at + EXT_MARK.length);
  return SMOKE_TEST_REL_RE.test(rel) ? rel : undefined;
}

/** The base probe: the same verify-loop, given only the failing tests. */
function probeCommand(rels: readonly string[]): string {
  return `cd extension && bash smoke-tests/lib/verify-loop.sh --jobs-from-host ${rels.map((r) => `"$PWD/${r}"`).join(" ")}`;
}

async function runOnce(
  o: SelectedVerifyOptions,
  execFn: ExecFn,
  opts: Parameters<ExecFn>[1],
  label: string,
): Promise<RunResult> {
  let reportFile: string | undefined;
  let env = opts?.env ?? process.env;
  try {
    reportFile = createVerifyReportFile(o.channel.reportDir, label);
    env = verifyReportEnv(env, reportFile);
  } catch (err) {
    trace(
      `work-driver: verify-select — could not create a report for the ${label} run: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
  try {
    const out = await execFn(o.cmd, { ...opts, env });
    return { ok: true, out };
  } catch (err) {
    const e = err as ExecError;
    const timedOut = isTimedOutKill(e);
    if (reportFile === undefined) {
      return {
        ok: false,
        err: e,
        timedOut,
        reason: "no report file could be created for this run",
      };
    }
    const report = readVerifyReport(reportFile);
    if (timedOut) {
      return {
        ok: false,
        err: e,
        timedOut,
        reportFile,
        reason: "the run was killed at its time bound",
      };
    }
    if (report.names === undefined) {
      return {
        ok: false,
        err: e,
        timedOut,
        reportFile,
        reason: `the failing tests cannot be named (${report.reason ?? "no report"}), so this is not a test failure this gate can attribute — a tsc or biome failure, or a loop that did not finish`,
      };
    }
    if (report.names.length === 0) {
      return {
        ok: false,
        err: e,
        timedOut,
        reportFile,
        names: [],
        reason: "the run failed while naming no failing test",
      };
    }
    return { ok: false, err: e, timedOut, reportFile, names: report.names, reason: "" };
  }
}

/** Serialises base probes in this process. */
let probeChain: Promise<unknown> = Promise.resolve();

/**
 * One base probe of exactly `rels`. Passes only when every name is red on base
 * and the change run has no name that is green there.
 */
async function probeOnce(
  o: SelectedVerifyOptions,
  rawExec: ExecFn,
  rels: readonly string[],
  changeReportFile: string,
  label: string,
): Promise<{ ok: true } | { blocks: string }> {
  let probeReportFile: string;
  try {
    probeReportFile = createVerifyReportFile(o.channel.reportDir, label);
  } catch {
    return { blocks: "the base probe's report could not be created, so it cannot run" };
  }
  const probeEnv = verifyReportEnv(process.env, probeReportFile);
  const run = probeChain.then(() =>
    attributeAgainstBase(rawExec, {
      repoRoot: o.repoRoot,
      verifyCmd: probeCommand(rels),
      baseSha: o.baseSha as string,
      timeoutMs: o.timeoutMs,
      changeRoots: [...o.changeRoots],
      changeReportFile,
      reportDir: o.channel.reportDir,
      probeEnv,
      probeReportFile,
      probeLabel: o.probeLabel,
    }),
  );
  probeChain = run.catch(() => undefined);
  const probe = await run;
  if (probe === undefined) {
    return {
      blocks:
        "the base probe did not establish a red base for these tests (green on base, or the probe was unresolved), so the failure is not attributed",
    };
  }
  if (probe.changeCausedFailures.length > 0) {
    return {
      blocks: `red on this change and green on base: ${probe.changeCausedFailures.join(", ")}`,
    };
  }
  const redOnBase = new Set(
    probe.preExistingFailures.map(extensionRelative).filter((r): r is string => r !== undefined),
  );
  if (!rels.every((r) => redOnBase.has(r))) {
    return { blocks: "a failing test was not shown to be red on the base commit" };
  }
  return { ok: true };
}

/**
 * Judge a twice-failing run's names. Returns the names that are baseline-red,
 * or the reason the failure blocks. Two base runs must agree: one red run on a
 * loaded host would otherwise excuse a test the change breaks deterministically.
 */
async function judge(
  o: SelectedVerifyOptions,
  rawExec: ExecFn,
  names: readonly string[],
  changeReportFile: string,
): Promise<{ baselineRed: string[] } | { blocks: string }> {
  const rels: string[] = [];
  for (const name of names) {
    const rel = extensionRelative(name);
    if (rel === undefined)
      return { blocks: `the failing test "${name}" is not a smoke test this gate can place` };
    rels.push(rel);
  }
  const changed = rels.filter((r) => o.changedTests.includes(r));
  if (changed.length > 0) {
    return {
      blocks: `${changed.join(", ")} changed or added by this cycle, so it is not probed against base (its base version is not the test that just failed)`,
    };
  }
  if (o.baseSha === undefined) return { blocks: "there is no base commit to probe" };
  for (const label of ["probe", "probe2"]) {
    const verdict = await probeOnce(o, rawExec, rels, changeReportFile, label);
    if ("blocks" in verdict) return verdict;
  }
  return { baselineRed: rels };
}

/** Record the names that failed once and did not fail on the rerun. */
function recordFlaky(o: SelectedVerifyOptions, names: readonly string[]): void {
  const flaky = names.map(extensionRelative).filter((r): r is string => r !== undefined);
  if (flaky.length === 0) return;
  o.record.flaky.push(...flaky);
  trace(
    `work-driver: verify-select \u2014 ${flaky.join(", ")} failed once and passed on the rerun (flaky, not blocking)`,
  );
}

function block(err: ExecError, reason: string): ExecError {
  err.stderr = `${err.stderr ?? ""}\n[verify-select] blocking: ${reason}`;
  return err;
}

/**
 * Wrap `execFn` so the selected command is attributed. `rawExec` runs the base
 * probe without the fast tier, which the probed tests do not need.
 */
export function withSelectedAttribution(
  execFn: ExecFn,
  rawExec: ExecFn,
  o: SelectedVerifyOptions,
): ExecFn {
  return async (cmd, opts) => {
    if (cmd !== o.cmd) return execFn(cmd, opts);
    const first = await runOnce(o, execFn, opts, "first");
    if (first.ok) return first.out;
    if (first.timedOut) throw block(first.err, first.reason);
    const firstNames = first.names ?? [];
    if (firstNames.length === 0 && o.rerunUnnamed !== true) {
      throw block(first.err, first.reason);
    }
    const second = await runOnce(o, execFn, opts, "rerun");
    if (second.ok) {
      recordFlaky(o, firstNames);
      o.record.recovered = {
        firstRunOutput: `${first.err.stdout ?? ""}\n${first.err.stderr ?? ""}`.trim(),
      };
      return second.out;
    }
    if (second.timedOut || second.names === undefined || second.names.length === 0) {
      throw block(second.err, second.reason);
    }
    if (second.reportFile === undefined) throw block(second.err, second.reason);
    // Failed on the first run and passed the rerun is flaky. A name that failed
    // on the first run but not the second is one of those, so it is recorded
    // before the second run is judged: a blocked cycle still discloses it.
    const secondSet = new Set(second.names);
    recordFlaky(
      o,
      firstNames.filter((n) => !secondSet.has(n)),
    );
    const verdict = await judge(o, rawExec, second.names, second.reportFile);
    if ("blocks" in verdict) throw block(second.err, verdict.blocks);
    o.record.baselineRed.push(...verdict.baselineRed);
    trace(
      `work-driver: verify-select — ${verdict.baselineRed.join(", ")} red on base too (baseline-red, not blocking)`,
    );
    return { stdout: second.err.stdout ?? "", stderr: second.err.stderr ?? "" };
  };
}

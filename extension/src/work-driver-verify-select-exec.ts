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
 *     because the bound is the verdict — at develop. The ci tier (rerunUnnamed)
 *     reruns both once, as its pre-#1647 `runVerifyFull(…, {retry: true})` did:
 *     a full suite on a loaded host is exactly the run that can hit its bound
 *     once and pass the next time;
 *   - the failing IDs are rerun ONCE, through the probe's verify-loop shape; an
 *     unnamed failure (ci only) reruns the whole command. Passing on the rerun
 *     → flaky, not blocking;
 *   - failing again → a test this cycle changed or added blocks (a base run
 *     would test an older file); otherwise a per-test base probe runs exactly
 *     those tests through verify-loop, twice. Red on base only, FOR THE SAME
 *     FAILURE LINE, → baseline-red, not blocking; any change-caused name, a
 *     different failure on base, or an unresolved probe → blocks.
 *
 * The decisions themselves are pure and live in work-driver-verify-select-verdict;
 * this module gathers the facts (runs, probes) and asks them.
 *
 * One wall clock covers the whole call: the first run, its rerun and both probes
 * draw on the same budget, and exhausting it blocks with that reason named.
 *
 * "Non-attributable" is exactly two outcomes, flaky and baseline-red (#1647 resolved
 * decisions). Every other failure blocks.
 */

import { trace } from "./trace.ts";
import type { VerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import { attributeAgainstBase } from "./work-driver-verify-attribution.ts";
import { isTimedOutKill } from "./work-driver-verify-develop-helpers.ts";
import { readVerifyReport } from "./work-driver-verify-report-file.ts";
import { createVerifyReportFile, verifyReportEnv } from "./work-driver-verify-report-path.ts";
import {
  type ProbeFacts,
  firstRunPlan,
  judgeProbe,
  placeable,
} from "./work-driver-verify-select-verdict.ts";
import { type VerifyAttributionRecord, extensionRelative } from "./work-driver-verify-shared.ts";
import { failureSignatures } from "./work-driver-verify-signature.ts";
import type { ExecFn } from "./worktree.ts";

/** What a selected run let through without blocking, for the cycle's record. */
export interface SelectedVerifyRecord extends VerifyAttributionRecord {
  /** Set when the run was recovered by its rerun: the first run's output, for the ci tier's #782 signal. */
  recovered?: { firstRunOutput: string };
}

export interface SelectedVerifyOptions {
  /** The exact selected command; only calls carrying it are wrapped. */
  cmd: string;
  channel: VerifyChannel;
  repoRoot: string;
  /** The cycle's base commit, already validated as a 40-hex SHA by the caller, or undefined when there is none. */
  baseSha: string | undefined;
  /** Every tree the run may execute in (the worktrees and the integration checkout). */
  changeRoots: readonly string[];
  /** Test files this cycle changed or added, relative to `extension/`. Never probed. */
  changedTests: readonly string[];
  /** The base probe's worktree label; each seam passes its own (#1647). */
  probeLabel: string;
  /** The wall clock for the whole call, shared by the run, its rerun and both probes. */
  timeoutMs: number;
  record: SelectedVerifyRecord;
  /**
   * The ci tier's single rerun for a failure that names no test (a transient
   * tsc or loop crash) or that hit its time bound. The develop round leaves it
   * off: an unnamed or timed-out failure blocks there, as it always has.
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

/** Thrown when the shared wall clock runs out; the wrapper turns it into a named block. */
class BudgetExhausted extends Error {
  constructor(readonly step: string) {
    super(step);
  }
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
  cmd: string,
  timeoutMs: number,
): Promise<RunResult> {
  let reportFile: string | undefined;
  let env = opts?.env ?? process.env;
  try {
    reportFile = createVerifyReportFile(o.channel.reportDir, label);
    // The path reaches the verify command, and the loop passes it to no test:
    // verify-kill.sh runs every test under `env -u VERIFY_REPORT_FILE`. The
    // channel makes a FAILING test unable to name a passing run; it is not a
    // defence against the cycle's own code, which can edit any test. That limit
    // is stated in docs/troubleshooting.md → "Selected verify: what attribution does not defend".
    env = verifyReportEnv(env, reportFile);
  } catch (err) {
    trace(
      `work-driver: verify-select — could not create a report for the ${label} run: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
  try {
    const out = await execFn(cmd, { ...opts, env, timeout: timeoutMs });
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

/**
 * Base probes queue per repository, not per process: each one creates a
 * worktree under its repoRoot's `.git`, and two repoRoots share no such state.
 */
const probeChains = new Map<string, Promise<unknown>>();

/**
 * One base probe of exactly `rels`. Returns the facts the probe established, or
 * the reason it could not establish any. A probe that throws is a named block,
 * never an escape: the caller's evidence must say why the gate blocked.
 */
async function probeOnce(
  o: SelectedVerifyOptions,
  rawExec: ExecFn,
  baseSha: string,
  rels: readonly string[],
  changeReportFile: string,
  label: string,
  timeoutMs: number,
): Promise<{ facts: ProbeFacts } | { blocks: string }> {
  let probeReportFile: string;
  try {
    probeReportFile = createVerifyReportFile(o.channel.reportDir, label);
  } catch {
    return { blocks: "the base probe's report could not be created, so it cannot run" };
  }
  const probeEnv = verifyReportEnv(process.env, probeReportFile);
  const prior = probeChains.get(o.repoRoot) ?? Promise.resolve();
  const settled = prior.then(() =>
    attributeAgainstBase(rawExec, {
      repoRoot: o.repoRoot,
      verifyCmd: probeCommand(rels),
      baseSha,
      timeoutMs,
      changeRoots: [...o.changeRoots],
      changeReportFile,
      reportDir: o.channel.reportDir,
      probeEnv,
      probeReportFile,
      probeLabel: o.probeLabel,
    }),
  );
  probeChains.set(
    o.repoRoot,
    settled.catch(() => undefined),
  );
  let probe: Awaited<typeof settled>;
  try {
    probe = await settled;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { blocks: `the base probe failed: ${message.slice(0, 200)}` };
  }
  if (probe === undefined) {
    return {
      blocks:
        "the base probe did not establish a red base for these tests (green on base, or the probe was unresolved), so the failure is not attributed",
    };
  }
  return { facts: probe };
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
  changeOutput: string,
  baseSha: string | undefined,
  budget: (step: string) => number,
): Promise<{ baselineRed: string[] } | { blocks: string }> {
  const rels = placeable(names);
  if (rels === undefined) {
    const bad = names.find((n) => extensionRelative(n) === undefined);
    return { blocks: `the failing test "${bad}" is not a smoke test this gate can place` };
  }
  const changed = rels.filter((r) => o.changedTests.includes(r));
  if (changed.length > 0) {
    return {
      blocks: `${changed.join(", ")} changed or added by this cycle, so it is not probed against base (its base version is not the test that just failed)`,
    };
  }
  if (baseSha === undefined) return { blocks: "there is no base commit to probe" };
  const changeSignatures = failureSignatures(changeOutput);
  for (const label of ["probe", "probe2"]) {
    const probed = await probeOnce(
      o,
      rawExec,
      baseSha,
      rels,
      changeReportFile,
      label,
      budget(`the ${label} run`),
    );
    if ("blocks" in probed) return probed;
    const verdict = judgeProbe(rels, probed.facts, changeSignatures);
    if ("blocks" in verdict) return verdict;
    if (verdict.unsigned.length > 0) {
      trace(
        `work-driver: verify-select — no failure signature for ${verdict.unsigned.join(", ")}; judged by name only`,
      );
    }
  }
  return { baselineRed: rels };
}

/**
 * Record the names that failed once and did not fail on the rerun. A name that
 * is not a smoke test path is kept as written: the record is what a reviewer
 * reads, and dropping the name would drop the evidence with it.
 */
function recordFlaky(o: SelectedVerifyOptions, names: readonly string[]): void {
  if (names.length === 0) return;
  const flaky = names.map((n) => {
    const rel = extensionRelative(n);
    if (rel === undefined) {
      trace(
        `work-driver: verify-select — flaky name is not a smoke test path, recorded as written: ${n}`,
      );
    }
    return rel ?? n;
  });
  o.record.flaky.push(...flaky);
  trace(
    `work-driver: verify-select — ${flaky.join(", ")} failed once and passed on the rerun (flaky, not blocking)`,
  );
}

/**
 * Attach a blocking reason to the error the run produced, so the caller's
 * evidence says why the gate blocked. With no run to attach to (the wall clock
 * ran out before the first run), a named Error carries the reason instead.
 */
function block(err: ExecError | undefined, reason: string): ExecError {
  const e: ExecError =
    err ?? new Error("verify-select: no run produced output to attach the block to");
  const line = `[verify-select] blocking: ${reason}`;
  e.stderr = `${e.stderr ?? ""}\n${line}`;
  // runVerifyFull reads err.message before stderr, so the ci evidence would
  // otherwise carry only "Command failed" and hide why the gate blocked.
  e.message = `${e.message}\n${line}`;
  return e;
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
    const deadline = Date.now() + o.timeoutMs;
    const budget = (step: string): number => {
      const left = deadline - Date.now();
      if (left <= 0) throw new BudgetExhausted(step);
      return left;
    };
    const last: { err?: ExecError } = {};
    try {
      return await attribute(execFn, rawExec, o, opts, budget, last);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        throw block(
          last.err,
          `the selected verify's ${o.timeoutMs} ms wall clock ran out before ${err.step}`,
        );
      }
      throw err;
    }
  };
}

async function attribute(
  execFn: ExecFn,
  rawExec: ExecFn,
  o: SelectedVerifyOptions,
  opts: Parameters<ExecFn>[1],
  budget: (step: string) => number,
  last: { err?: ExecError },
): ReturnType<ExecFn> {
  const first = await runOnce(o, execFn, opts, "first", o.cmd, budget("the first run"));
  if (first.ok) return first.out;
  last.err = first.err;
  const firstNames = first.names ?? [];
  const plan = firstRunPlan(firstNames, first.timedOut, o.rerunUnnamed === true);
  if (plan.kind === "block") throw block(first.err, first.reason);
  // A named failure reruns its IDs through the probe's shape. A timed-out run
  // never reached the rest of the suite, and an unnamed failure names nothing,
  // so both rerun the whole command.
  let rerunCmd = o.cmd;
  if (plan.kind === "rerun-named") {
    const rels = placeable(firstNames);
    if (rels === undefined) {
      const bad = firstNames.find((n) => extensionRelative(n) === undefined);
      throw block(
        first.err,
        `the failing test "${bad}" is not a smoke test this gate can place, so it cannot be rerun by its ID`,
      );
    }
    rerunCmd = probeCommand(rels);
  }
  const second = await runOnce(o, execFn, opts, "rerun", rerunCmd, budget("the rerun"));
  if (second.ok) {
    recordFlaky(o, firstNames);
    o.record.recovered = {
      firstRunOutput: `${first.err.stdout ?? ""}\n${first.err.stderr ?? ""}`.trim(),
    };
    return second.out;
  }
  last.err = second.err;
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
  const changeOutput = `${second.err.stdout ?? ""}\n${second.err.stderr ?? ""}`;
  const verdict = await judge(
    o,
    rawExec,
    second.names,
    second.reportFile,
    changeOutput,
    o.baseSha,
    budget,
  );
  if ("blocks" in verdict) throw block(second.err, verdict.blocks);
  o.record.baselineRed.push(...verdict.baselineRed);
  trace(
    `work-driver: verify-select — ${verdict.baselineRed.join(", ")} red on base too (baseline-red, not blocking)`,
  );
  return { stdout: second.err.stdout ?? "", stderr: second.err.stderr ?? "" };
}

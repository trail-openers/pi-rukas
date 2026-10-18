#!/usr/bin/env bun
/**
 * #1647 — the attribution of the selected verify run (work-driver-verify-select-exec.ts).
 *
 * A real git repository supplies the base commit the per-test probe checks out.
 * The executor is a stub that behaves like verify-loop.sh: it names the failing
 * tests it was given, in its out-of-band report (VERIFY_REPORT_FILE) and in its
 * stream, and it fails for the tests the scenario says are red in that tree.
 * Git commands run for real.
 *
 * Covers the outcome table: flaky (fail, then pass) → not blocking; red twice
 * and red on base → baseline-red, not blocking; red twice and green on base →
 * blocks; a change-caused name among pre-existing ones → blocks; a changed test
 * → blocks without a probe; an unresolved probe → blocks; no report (tsc or
 * biome) → blocks after one run; a timed-out run → blocks without a rerun.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createVerifyChannel } from "../src/work-driver-integrate-verify-flake.ts";
import { foldVerifyAttribution } from "../src/work-driver-verify-events.ts";
import { verifyAttributionSectionOf } from "../src/work-driver-verify-select-render.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "../src/work-driver-verify-select-exec.ts";
import { selectedVerifyCommand } from "../src/work-driver-verify-select.ts";
import { initialState } from "../src/workflow-state.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { runCiVerifyFull } from "../src/work-driver-ci-verify.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const root = mkdtempSync(path.join(tmpdir(), "pi-verify-select-exec-"));
const repo = path.join(root, "repo");
mkdirSync(path.join(repo, "extension", "smoke-tests"), { recursive: true });
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
git(["init", "-q"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
writeFileSync(path.join(repo, "extension", "smoke-tests", "placeholder.txt"), "x\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "base"]);
const baseSha = git(["rev-parse", "HEAD"]).trim();

const PATHS_RE = /"\$PWD\/(smoke-tests\/[^"]+)"/g;

interface Scenario {
  /** Failing test paths in the change tree, per call: a number = fail that many times, then pass. */
  change: Record<string, number>;
  /** Failing test paths in the base tree (the probe). */
  base: string[];
  /** When set, the change run is killed at its bound. */
  killed?: boolean;
  /** When set, the change run fails without writing a report (a tsc-style failure). */
  noReport?: boolean;
  /** When set, only the first change run fails without a report; the rerun is green. */
  noReportFirst?: boolean;
  /** When set, the base probe is killed at its bound: unresolved, so it cannot excuse. */
  probeKilled?: boolean;
}

/** A verify-loop stand-in: real git for everything else, names reported out-of-band. */
function stubExec(s: Scenario, calls: { change: number; probe: number }) {
  const remaining = { ...s.change };
  return async (cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv; argv?: string[] }) => {
    if (opts?.argv !== undefined) {
      // The argv form is how the driver runs git: the executable and its arguments, no shell.
      const { stdout, stderr } = await execFileP(cmd, opts.argv, {
        cwd: opts.cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr };
    }
    if (!cmd.includes("verify-loop.sh")) {
      const { stdout, stderr } = await execFileP("/bin/sh", ["-c", cmd], {
        cwd: opts?.cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr };
    }
    const requested = [...cmd.matchAll(PATHS_RE)].map((m) => m[1] ?? "");
    const isProbe = opts?.cwd !== repo;
    const tree = opts?.cwd ?? repo;
    const extension = path.join(tree, "extension");
    if (isProbe) calls.probe++;
    else calls.change++;
    if (isProbe && s.probeKilled) {
      throw Object.assign(new Error("killed"), {
        killed: true,
        timedOutKill: true,
        stdout: "",
        stderr: "",
      });
    }
    if (!isProbe && s.killed) {
      throw Object.assign(new Error("killed"), {
        killed: true,
        timedOutKill: true,
        stdout: "",
        stderr: "",
      });
    }
    const failing = isProbe
      ? requested.filter((r) => s.base.includes(r))
      : requested.filter((r) => {
          const left = remaining[r] ?? 0;
          if (left > 0) {
            remaining[r] = left - 1;
            return true;
          }
          return false;
        });
    const reportFile = opts?.env?.VERIFY_REPORT_FILE;
    if (!isProbe && (s.noReport || (s.noReportFirst === true && calls.change === 1))) {
      throw Object.assign(new Error("tsc: error TS2304"), {
        stdout: "",
        stderr: "src/a.ts(1,1): error",
      });
    }
    if (failing.length === 0) return { stdout: "all green\n", stderr: "" };
    const names = failing.map((r) => path.join(extension, r));
    if (reportFile) {
      writeFileSync(reportFile, `${names.join("\n")}\nFAILED-TESTS: ${names.length}\n`, "utf8");
    }
    const stream = [
      ...names.map((n) => `FAILED: ${n}`),
      `FAILED: ${names.length} test(s) — ${names.join(", ")}`,
    ].join("\n");
    throw Object.assign(new Error("Command failed"), { code: 1, stdout: stream, stderr: "" });
  };
}

async function attempt(
  name: string,
  s: Scenario,
  changedTests: string[],
  rerunUnnamed = false,
): Promise<{
  ok: boolean;
  record: SelectedVerifyRecord;
  calls: { change: number; probe: number };
  stderr: string;
}> {
  const channel = createVerifyChannel();
  if (channel === undefined) throw new Error(`${name}: no report channel`);
  const record: SelectedVerifyRecord = { flaky: [], baselineRed: [] };
  const calls = { change: 0, probe: 0 };
  const cmd = selectedVerifyCommand([...Object.keys(s.change), ...s.base]);
  const exec = stubExec(s, calls);
  const wrapped = withSelectedAttribution(exec, exec, {
    cmd,
    channel,
    repoRoot: repo,
    baseSha,
    changeRoots: [repo],
    changedTests,
    timeoutMs: 60_000,
    record,
    rerunUnnamed,
  });
  let ok = true;
  let stderr = "";
  try {
    await wrapped(cmd, { cwd: repo });
  } catch (err) {
    ok = false;
    stderr = (err as { stderr?: string }).stderr ?? "";
  } finally {
    rmSync(channel.reportDir, { recursive: true, force: true });
  }
  return { ok, record, calls, stderr };
}

const T = "smoke-tests/test-x.ts";
const R = "smoke-tests/test-red.ts";

// Flaky: fails once, passes on the rerun. Not blocking; recorded as flaky.
{
  const r = await attempt("flaky", { change: { [T]: 1 }, base: [] }, []);
  assert(
    r.ok && r.record.flaky.join() === T,
    "fail once, pass on the rerun → not blocking, recorded flaky",
  );
  assert(r.calls.change === 2 && r.calls.probe === 0, "flaky: one rerun, no base probe");
}
// Red twice, red on base: baseline-red, not blocking.
{
  const r = await attempt("baseline-red", { change: { [R]: 2 }, base: [R] }, []);
  assert(
    r.ok && r.record.baselineRed.join() === R,
    "red twice and red on base → baseline-red, not blocking",
  );
  assert(r.calls.probe === 1, "baseline-red: the base is probed once, for that test only");
}
// Red twice, green on base: blocks.
{
  const r = await attempt("green-base", { change: { [T]: 2 }, base: [] }, []);
  assert(!r.ok && r.record.baselineRed.length === 0, "red twice and green on base → blocks");
  assert(
    r.stderr.includes("[verify-select] blocking"),
    "blocking: the evidence names the verify-select decision",
  );
}
// A change-caused name beside a pre-existing one: blocks.
{
  const r = await attempt("mixed", { change: { [T]: 2, [R]: 2 }, base: [R] }, []);
  assert(
    !r.ok && r.record.baselineRed.length === 0,
    "a change-caused name among pre-existing ones → blocks",
  );
}
// A test this cycle changed is never probed against base: blocks.
{
  const r = await attempt("changed", { change: { [T]: 2 }, base: [T] }, [T]);
  assert(
    !r.ok && r.calls.probe === 0,
    "a changed or added test that fails twice → blocks, with no base probe",
  );
}
// The base probe is killed: unresolved, so blocks.
{
  const r = await attempt("probe-killed", { change: { [T]: 2 }, base: [T], probeKilled: true }, []);
  assert(!r.ok && r.record.baselineRed.length === 0, "an unresolved base probe → blocks");
}
// No report (tsc or biome): blocks after one run, no rerun.
{
  const r = await attempt("no-report", { change: {}, base: [], noReport: true }, []);
  assert(!r.ok && r.calls.change === 1, "no failing names (tsc or biome) → blocks after one run");
}
// Mixed rerun: A fails once and passes the rerun (flaky); B fails twice and is
// green on base. A is recorded as flaky even though the cycle is blocked by B.
{
  const r = await attempt("mixed-rerun", { change: { [T]: 1, [R]: 2 }, base: [] }, []);
  assert(
    !r.ok && r.record.flaky.join() === T,
    "a name that fails once and not on the rerun is recorded flaky, even when the cycle blocks",
  );
}
// ci tier: a run that names no test is rerun once, and a recovered rerun passes.
{
  const r = await attempt("ci-unnamed", { change: {}, base: [], noReportFirst: true }, [], true);
  assert(r.ok && r.calls.change === 2, "ci: a run with no failing names is rerun once and passes");
}
// ci tier: an unnamed failure that fails again still blocks.
{
  const r = await attempt("ci-unnamed-twice", { change: {}, base: [], noReport: true }, [], true);
  assert(!r.ok && r.calls.change === 2, "ci: an unnamed failure that fails the rerun blocks");
}
// Timed out: blocks, no rerun.
{
  const r = await attempt("timeout", { change: {}, base: [], killed: true }, []);
  assert(!r.ok && r.calls.change === 1, "a run killed at its bound → blocks, not rerun");
}

// The ci tier runs the same attribution over the full suite.
{
  const ciState = (() => {
    const base = initialState(9);
    return { ...base, pipelineState: { ...base.pipelineState, baseSha } };
  })();
  const ctx = { repoRoot: repo, issue: 9 } as unknown as CycleContext;
  const suite = (s: Scenario) =>
    runCiVerifyFull(
      ctx,
      ciState,
      repo,
      selectedVerifyCommand([T, R]),
      60_000,
      stubExec(s, { change: 0, probe: 0 }),
    );
  const flaky = await suite({ change: { [T]: 1 }, base: [] });
  assert(
    flaky.outcome === "success" && flaky.record?.flaky.join() === T,
    "ci: a flaky suite test passes the tier and is recorded",
  );
  const redOnBase = await suite({ change: { [R]: 2 }, base: [R] });
  assert(
    redOnBase.outcome === "success" && redOnBase.record?.baselineRed.join() === R,
    "ci: a test red on base too does not fail the tier, and is recorded",
  );
  const greenOnBase = await suite({ change: { [T]: 2 }, base: [] });
  assert(greenOnBase.outcome === "failure", "ci: a test red here and green on base fails the tier");
}

// The PR body names what the gate carried, and the state keeps each name once.
{
  const body = verifyAttributionSectionOf({
    flaky: [T],
    baselineRed: [R],
  });
  assert(
    body.includes("## Flaky tests") && body.includes(`\`${T}\``),
    "the PR body lists the flaky tests",
  );
  assert(
    body.includes("## Tests red on the base commit") && body.includes(`\`${R}\``),
    "the PR body lists the baseline-red tests",
  );
  assert(verifyAttributionSectionOf(undefined) === "", "no section when nothing was carried");
  const folded = foldVerifyAttribution(
    foldVerifyAttribution(initialState(9), { flaky: [T], baselineRed: [] }),
    { flaky: [T], baselineRed: [R] },
  );
  assert(
    folded.pipelineState.verifyAttribution?.flaky.join() === T &&
      folded.pipelineState.verifyAttribution?.baselineRed.join() === R,
    "rounds fold into one record with each name once",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);

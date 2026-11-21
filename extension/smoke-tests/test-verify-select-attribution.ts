#!/usr/bin/env bun
/**
 * #1647 review round 3 (half 2 of the hardening suite) — the selected verify's
 * attribution and its PR-body disclosure:
 *
 *   - the attribution compares failure signatures before it excuses a baseline-red
 *     test, shares one wall clock across its runs and probes, reruns named failures
 *     by ID, and blocks on a name it cannot place;
 *   - the PR body's attribution block is replaced, not appended to: a repeated
 *     write converges, a null body is written, and a body the writer cannot read
 *     as text (or cannot read at all) is never edited.
 *
 * The sibling `test-verify-select-hardening.ts` owns the selector's rules and the
 * tokenizer's; this half owns the two consumers of a selection's RESULT. The split
 * is by subject, not by length: neither half reads as half a file.
 *
 * The attribution stub is the one the exec suite uses: verify-loop's out-of-band
 * report and its `FAILED:` stream, with real git for the base probe.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { discloseInPrBody } from "../src/work-driver-ci-verify.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { createVerifyChannel } from "../src/work-driver-integrate-verify-flake.ts";
import { foldVerifyAttribution } from "../src/work-driver-verify-events.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "../src/work-driver-verify-select-exec.ts";
import { ATTRIBUTION_BEGIN } from "../src/work-driver-verify-select-render.ts";
import { selectedVerifyCommand } from "../src/work-driver-verify-select.ts";
import type { ExecFn } from "../src/worktree.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const attrRoot = mkdtempSync(path.join(tmpdir(), "pi-verify-select-attr-"));
const repo = path.join(attrRoot, "repo");
const ghRoot = mkdtempSync(path.join(tmpdir(), "pi-verify-select-gh-"));
mkdirSync(path.join(repo, "extension", "smoke-tests"), { recursive: true });
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
git(["init", "-q"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
mkdirSync(path.join(repo, ".pi"), { recursive: true });
writeFileSync(path.join(repo, ".pi", "verify-select"), "");
writeFileSync(path.join(repo, "extension", "smoke-tests", "placeholder.txt"), "x\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "base"]);
const baseSha = git(["rev-parse", "HEAD"]).trim();

const T = "smoke-tests/test-x.ts";

interface Stub {
  /** Tests that fail on this change, and how many times each fails before it passes. */
  change: Record<string, number>;
  /** Tests that fail on base. */
  base: string[];
  /** The failure line each tree prints for a failing test. */
  reason: { change: string; base: string };
  /** Milliseconds the first change run takes before it fails. */
  delayMs?: number;
  /** Names the first change run reports, instead of the real ones. */
  rawNames?: string[];
}

/** Every command the stub saw, for the rerun-shape assertions. */
function stub(s: Stub, seen: string[]) {
  const remaining = { ...s.change };
  let changeRuns = 0;
  return async (cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv; argv?: string[] }) => {
    if (opts?.argv !== undefined) {
      const { stdout, stderr } = await execFileP(cmd, opts.argv, { cwd: opts.cwd });
      return { stdout, stderr };
    }
    if (!cmd.includes("verify-loop.sh")) {
      const { stdout, stderr } = await execFileP("/bin/sh", ["-c", cmd], { cwd: opts?.cwd });
      return { stdout, stderr };
    }
    seen.push(cmd);
    const isProbe = opts?.cwd !== repo;
    const tree = opts?.cwd ?? repo;
    const requested = [...cmd.matchAll(/"\$PWD\/([^"]+)"/g)].map((m) => m[1] ?? "");
    if (!isProbe) changeRuns++;
    if (!isProbe && changeRuns === 1 && s.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, s.delayMs));
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
    if (failing.length === 0) return { stdout: "all green\n", stderr: "" };
    const names =
      !isProbe && changeRuns === 1 && s.rawNames !== undefined
        ? s.rawNames
        : failing.map((r) => path.join(tree, "extension", r));
    const reportFile = opts?.env?.VERIFY_REPORT_FILE;
    if (reportFile)
      writeFileSync(reportFile, `${names.join("\n")}\nFAILED-TESTS: ${names.length}\n`, "utf8");
    const reason = isProbe ? s.reason.base : s.reason.change;
    const stream = [
      ...names.map((n) => `FAILED: ${n}\n✗ case one\n  ${reason}`),
      `FAILED: ${names.length} test(s) — ${names.join(", ")}`,
    ].join("\n");
    throw Object.assign(new Error("Command failed"), { code: 1, stdout: stream, stderr: "" });
  };
}

async function attempt(
  name: string,
  s: Stub,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; record: SelectedVerifyRecord; seen: string[]; stderr: string }> {
  const channel = createVerifyChannel();
  if (channel === undefined) throw new Error(`${name}: no report channel`);
  const record: SelectedVerifyRecord = { flaky: [], baselineRed: [] };
  const seen: string[] = [];
  const cmd = selectedVerifyCommand([T]);
  const exec = stub(s, seen);
  const wrapped = withSelectedAttribution(exec, exec, {
    cmd,
    channel,
    repoRoot: repo,
    baseSha,
    changeRoots: [repo],
    changedTests: [],
    probeLabel: `hardening-${name}`,
    timeoutMs,
    record,
  });
  let ok = true;
  let stderr = "";
  try {
    await wrapped(cmd, { cwd: repo });
  } catch (err) {
    ok = false;
    stderr = `${(err as Error).message}\n${(err as { stderr?: string }).stderr ?? ""}`;
  } finally {
    rmSync(channel.reportDir, { recursive: true, force: true });
  }
  return { ok, record, seen, stderr };
}

// The same failure line on base and on the change: the test is baseline-red.
{
  const r = await attempt("same-reason", {
    change: { [T]: 2 },
    base: [T],
    reason: { change: "expected 3 got 4", base: "expected 3 got 4" },
  });
  assert(r.ok && r.record.baselineRed.join() === T, "the same failure line on base → baseline-red");
}
// A different failure line on base: red on base for another reason, so it blocks.
{
  const r = await attempt("other-reason", {
    change: { [T]: 2 },
    base: [T],
    reason: { change: "expected 3 got 4", base: "timed out waiting for the socket" },
  });
  assert(
    !r.ok && r.record.baselineRed.length === 0 && r.stderr.includes("different reason"),
    "a test red on base for a different failure line blocks",
  );
}
// Digits are folded out, so a timing figure alone does not make two failures differ.
{
  const r = await attempt("timing-only", {
    change: { [T]: 2 },
    base: [T],
    reason: { change: "took 812 ms, budget 500", base: "took 640 ms, budget 500" },
  });
  assert(
    r.ok && r.record.baselineRed.join() === T,
    "a failure that differs only in digits is the same failure",
  );
}
// The rerun of a named failure runs its IDs through the probe's shape, not the whole suite.
{
  const r = await attempt("rerun-ids", {
    change: { [T]: 1 },
    base: [],
    reason: { change: "x", base: "x" },
  });
  const rerun = r.seen[1] ?? "";
  assert(
    r.ok &&
      r.record.flaky.join() === T &&
      !rerun.includes("tsc --noEmit") &&
      rerun.includes(`"$PWD/${T}"`),
    "a named failure is rerun by its IDs, not the whole command",
  );
}
// A failing name that is not a smoke-test path cannot be rerun by ID: blocks.
{
  const r = await attempt("unplaceable", {
    change: { [T]: 1 },
    base: [],
    reason: { change: "x", base: "x" },
    rawNames: ["/tmp/elsewhere/notes.ts"],
  });
  assert(
    !r.ok && r.stderr.includes("cannot be rerun by its ID"),
    "a failing name that cannot be placed blocks, with the reason named",
  );
}
// One wall clock: a first run that uses it all leaves the rerun no budget, and the block names the step.
{
  const r = await attempt(
    "deadline",
    { change: { [T]: 1 }, base: [], reason: { change: "x", base: "x" }, delayMs: 120 },
    60,
  );
  assert(
    !r.ok && r.stderr.includes("wall clock ran out before the rerun") && r.seen.length === 1,
    "the first run and the rerun share one wall clock; exhausting it blocks, naming the step",
  );
}

// --- disclosure: one replaceable block, written only from a readable PR body ----
{
  const T2 = "smoke-tests/test-flaky-a.ts";
  const T3 = "smoke-tests/test-flaky-b.ts";
  const state = foldVerifyAttribution(
    { ...initialState(9), pipelineState: { ...initialState(9).pipelineState, prNumber: 77 } },
    { flaky: [T2], baselineRed: [] },
  );
  // discloseInPrBody reads only the repo root and the issue number.
  const ctx = { repoRoot: ghRoot, issue: 9 } as unknown as CycleContext;
  const ghWith = (view: () => string, edits: string[]): ExecFn =>
    (async (cmd: string, opts?: { argv?: string[] }) => {
      const argv = opts?.argv ?? [];
      if (cmd !== "gh") throw new Error(`unexpected command ${cmd}`);
      if (argv[1] === "view") return { stdout: view(), stderr: "" };
      if (argv[1] === "edit") {
        edits.push(readFileSync(argv[argv.indexOf("--body-file") + 1] ?? "", "utf8"));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh ${argv.join(" ")}`);
    }) as unknown as ExecFn;
  const bodyOf = (body: string | null) => JSON.stringify({ body });

  // First write: the intro is kept and the block is appended once.
  const edits1: string[] = [];
  const first = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf("Intro text"), edits1),
  );
  assert(first.ok && edits1.length === 1, "a readable body with no block is written once");
  const written1 = edits1[0] ?? "";
  assert(
    written1.startsWith("Intro text") &&
      written1.split(ATTRIBUTION_BEGIN).length === 2 &&
      written1.includes(T2),
    "the written body keeps the intro and carries exactly one attribution block naming the flaky test",
  );
  // A repeated write of the same record is a no-op: the block converges.
  const edits2: string[] = [];
  const again = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(written1), edits2),
  );
  assert(again.ok && edits2.length === 0, "writing the same record again changes nothing");
  // A grown record replaces the block rather than appending a second one.
  const grown = foldVerifyAttribution(state, { flaky: [T3], baselineRed: [] });
  const edits3: string[] = [];
  await discloseInPrBody(
    ctx,
    grown,
    ghWith(() => bodyOf(written1), edits3),
  );
  const written3 = edits3[0] ?? "";
  assert(
    written3.split(ATTRIBUTION_BEGIN).length === 2 &&
      written3.includes(T3) &&
      written3.includes(T2),
    "a later write replaces the block with the whole record, not a second block",
  );
  // A null body is an empty PR body, so it is written rather than refused.
  const edits4: string[] = [];
  const nullBody = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(null), edits4),
  );
  assert(nullBody.ok && edits4.length === 1, "a null PR body is treated as empty and written");
  // A body that is not text is refused, and nothing is edited.
  const edits5: string[] = [];
  const notText = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(7 as never), edits5),
  );
  assert(
    !notText.ok && edits5.length === 0 && notText.reason.includes("could not be read as text"),
    "a PR body that is not a string is refused with the reason named, and never edited",
  );
  // A failed read is named and nothing is edited.
  const edits6: string[] = [];
  const unread = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => {
      throw new Error("gh: network down");
    }, edits6),
  );
  assert(
    !unread.ok && edits6.length === 0 && unread.reason.includes("network down"),
    "a PR body read that throws is named and the body is left alone",
  );
  // Half-marked markers are a body the writer does not understand: refused, not patched.
  const edits7: string[] = [];
  const halfMarked = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(`x\n${ATTRIBUTION_BEGIN}\nno end`), edits7),
  );
  assert(!halfMarked.ok && edits7.length === 0, "unpaired attribution markers are refused");
}
rmSync(attrRoot, { recursive: true, force: true });
rmSync(ghRoot, { recursive: true, force: true });

process.exit(exit);

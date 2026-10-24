#!/usr/bin/env bun
/**
 * #1762 / #1770 round 4 — the anchor is an OFFSET inside the stored excerpt.
 *
 * The store's `anchored` was a boolean, and it was wrong for one whole shape of
 * stream: the producer clamps the window start to `min(anchor, len - 4000)`, so a
 * failure that sits in the LAST excerpt-width of the stream is stored INSIDE the
 * positional tail, not at its head. The flag still said "anchored" there, and
 * `keepEvidenceHead` then kept the first 500 characters of the excerpt — the lines
 * ABOVE the failure — and dropped the failure line itself. #1762's symptom, back
 * through a flag that over-claimed.
 *
 * Split out of `test-verify-failure-shapes-c-1762.ts` along the round seam so no
 * file crosses the 500-line cap (AGENTS.md §12). Every fixture is synthetic output
 * the driver was fed in production.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCiVerifyFull } from "../src/work-driver-ci-verify.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  VERIFY_FULL_EVIDENCE_MAX,
  VERIFY_FULL_OUTPUT_MAX,
  boundByCodePoints,
  keepEvidenceHead,
  runVerifyFull,
} from "../src/work-driver-verify-full.ts";
import { selectedVerifyCommand } from "../src/work-driver-verify-select.ts";
import { initialState } from "../src/workflow-state.ts";
import { makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const execFileP = promisify(execFile);
const { assert, failed } = makeAssert();
const T = "smoke-tests/test-x.ts";

// ── 5c. #1762 round 4 — the anchor OFFSET, not a boolean ─────────────────────
// Both cases below must put the failure at the TOP of the 500-character evidence:
// one where the failure sits inside the positional tail (1000 characters from the
// end, so the clamp starts the window BEFORE it) and one outside it (6000, so the
// window opens at the failure and the clamp never fires). The near case is the one
// the boolean got wrong; the far case is the one it got right, and both are pinned
// because an implementation that always head-cut from zero satisfies the far one.
{
  const FAIL_LINE = "✗ the migration left the schema half-applied";
  const TAIL_NOISE = "passing summary line 7 ok\n"; // 25 chars
  const build = (tailChars: number): string => {
    const before = "noise: irrelevant preamble\n".repeat(40);
    const after = TAIL_NOISE.repeat(Math.ceil(tailChars / TAIL_NOISE.length)).slice(0, tailChars);
    return `${before}${FAIL_LINE}\n${after}`;
  };
  const cases: Array<[string, number]> = [
    ["inside the positional tail", 1000],
    ["outside the positional tail", 6000],
  ];
  for (const [label, tailChars] of cases) {
    const stream = build(tailChars);
    const distance = stream.length - (stream.indexOf(FAIL_LINE) + FAIL_LINE.length) - 1;
    assert(
      distance === tailChars,
      `c5: the failure line ends ${tailChars} characters before the end (${label}, got ${distance})`,
    );
    const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
      stdout: stream,
      stderr: "",
    });
    const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
      throw failing;
    });
    assert(
      run.anchorOffset !== undefined,
      `c5: the failure is recognised, so an offset is reported (${label})`,
    );
    assert(
      run.output.slice(run.anchorOffset ?? -1, (run.anchorOffset ?? -1) + FAIL_LINE.length) ===
        FAIL_LINE,
      `c5: the offset points AT the failure line inside the excerpt (${label}, got ${JSON.stringify(run.output.slice(run.anchorOffset ?? 0, (run.anchorOffset ?? 0) + 60))})`,
    );
    const evidence = keepEvidenceHead(run.output, run.anchorOffset);
    assert(
      evidence.length <= VERIFY_FULL_EVIDENCE_MAX,
      `c5: the evidence is bounded to the handoff budget (${label}, ${evidence.length})`,
    );
    assert(
      evidence.startsWith(FAIL_LINE),
      `c5: the 500-char evidence STARTS with the failure line (${label}, got ${JSON.stringify(evidence.slice(0, 70))})`,
    );
    if (tailChars > VERIFY_FULL_OUTPUT_MAX) {
      // The discriminating half for the far case: a blind tail cut of the excerpt
      // keeps the passing noise and drops the failure, which is what the offset is
      // there to prevent. (The near case has no such alternative — its excerpt IS
      // the positional tail — so it is pinned by `startsWith` alone.)
      const blindTail = Array.from(run.output).slice(-VERIFY_FULL_EVIDENCE_MAX).join("");
      assert(
        !blindTail.includes(FAIL_LINE),
        `c5: the blind tail cut really does omit the failure (${label})`,
      );
    }
  }
  // And with no failure line anywhere, the evidence is the excerpt's tail.
  const quiet = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: "passing summary line 7 ok\n".repeat(400),
    stderr: "",
  });
  const quietRun = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw quiet;
  });
  assert(
    quietRun.anchorOffset === undefined,
    `c5: a stream with no failure line reports no offset (got ${JSON.stringify(quietRun.anchorOffset)})`,
  );
  assert(
    keepEvidenceHead(quietRun.output, quietRun.anchorOffset) ===
      Array.from(quietRun.output).slice(-VERIFY_FULL_EVIDENCE_MAX).join(""),
    "c5: with no offset the evidence is the tail",
  );
}

// ── 5d. #1762 round 4 — the recovered run carries the FIRST run's own offset ───
// The stepback renders `firstRunOutput` as the evidence for a recovered run, so the
// offset it hands the cut must describe THAT excerpt. The re-run passed, so its
// anchor (or absence of one) says nothing about where the first run's failure sits —
// `runVerifyFull` reports the first run's offset for a recovered tier precisely so
// the cut cannot be made at a position that describes a different string.
{
  const FAIL_LINE = "✗ the flaky gate tripped on the fixture";
  const firstStream = `${"noise: before the failure\n".repeat(40)}${FAIL_LINE}\n${"passing summary line 7 ok\n".repeat(200)}`;
  const secondStream = "all checks passed, nothing to report".repeat(30);
  let call = 0;
  const result = await runVerifyFull(
    "bash scripts/verify.sh --full",
    "/w",
    5000,
    async () => {
      call++;
      if (call === 1) {
        throw Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
          stdout: firstStream,
          stderr: "",
        });
      }
      return { stdout: secondStream, stderr: "" };
    },
    { retry: true },
  );
  assert(
    result.recovered === true && result.outcome === "success",
    `c5: the re-run recovered the tier (${JSON.stringify(result.outcome)}, recovered ${JSON.stringify(result.recovered)})`,
  );
  assert(
    result.firstRunOutput?.includes(FAIL_LINE) === true,
    "c5: the recovered run still preserves the first run's failing excerpt",
  );
  const firstEvidence = keepEvidenceHead(result.firstRunOutput ?? result.output, result.anchorOffset);
  assert(
    firstEvidence.startsWith(FAIL_LINE),
    `c5: the recovered evidence cut uses the first run's own offset (got ${JSON.stringify(firstEvidence.slice(0, 70))})`,
  );
  assert(
    keepEvidenceHead(result.output, result.anchorOffset).length <= VERIFY_FULL_EVIDENCE_MAX,
    "c5: the reported excerpt still cuts to the handoff budget",
  );
}

// ── 5e. #1762 round 5 — the recovered path stores, it does not forward ────────
// `runCiVerifyFull` reads the first run's stream out of the attribution record, and
// used to put that RAW text straight into `firstRunOutput` while taking only the
// offset from `storeTierOutput` — an unbounded, unredacted stream paired with a
// position measured inside a different (stored) string. That field is persisted to
// the state file and rendered into the handoff. End to end on the opted-in path:
// the first run is red with a synthetic GitHub token well up the stream and the
// failure line ~8000 characters from the end; the rerun is green.
{
  const ciRoot = mkdtempSync(path.join(tmpdir(), "pi-verify-f1762-ci-"));
  const ciRepo = path.join(ciRoot, "repo");
  mkdirSync(path.join(ciRepo, "extension", "smoke-tests"), { recursive: true });
  mkdirSync(path.join(ciRepo, ".pi"), { recursive: true });
  writeFileSync(path.join(ciRepo, ".pi", "verify-select"), "");
  writeFileSync(path.join(ciRepo, "extension", "smoke-tests", "placeholder.txt"), "x\n");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: ciRepo, stdio: "pipe" }).toString();
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  const ciBaseSha = git(["rev-parse", "HEAD"]).trim();

  const FAIL_LINE = "✗ the token echo leaked a secret";
  const SECRET = `ghp_${"aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v".repeat(2)}`; // ghp_ + 36 alphanumerics
  const TOKEN_LINE = `assertion echoed: ${SECRET}`;
  const ciCmd = selectedVerifyCommand([T]);
  const PATHS = /"\$PWD\/(smoke-tests\/[^"]+)"/g;
  const ciState = {
    ...initialState(11),
    pipelineState: { ...initialState(11).pipelineState, baseSha: ciBaseSha },
  };
  const ciCtx = { repoRoot: ciRepo, issue: 11 } as unknown as CycleContext;
  let changeCalls = 0;
  const ciExec = async (cmd: string, opts?: { cwd?: string; argv?: string[]; env?: NodeJS.ProcessEnv }) => {
    if (opts?.argv !== undefined) {
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
    changeCalls++;
    const requested = [...cmd.matchAll(PATHS)].map((m) => m[1] ?? "");
    const names = requested.map((r) => path.join(path.join(ciRepo, "extension"), r));
    if (changeCalls > 1) return { stdout: "all green\n", stderr: "" };
    // Out-of-band names, as verify-loop.sh reports them: the attribution reruns
    // the whole command for an unnamed failure, which is not the case here.
    if (opts?.env?.VERIFY_REPORT_FILE) {
      writeFileSync(opts.env.VERIFY_REPORT_FILE, `${names.join("\n")}\nFAILED-TESTS: ${names.length}\n`, "utf8");
    }
    const raw = [
      TOKEN_LINE,
      "noise: unrelated passing output\n".repeat(400),
      FAIL_LINE,
      "passing summary line 7 ok\n".repeat(600),
    ].join("\n");
    throw Object.assign(new Error("Command failed"), { code: 1, stdout: raw, stderr: "" });
  };

  const ci = await runCiVerifyFull(ciCtx, ciState, ciRepo, ciCmd, 60_000, ciExec);
  assert(
    ci.outcome === "success" && ci.recovered === true && changeCalls === 2,
    `c6: the attribution rerun recovered the ci tier (outcome ${JSON.stringify(ci.outcome)}, recovered ${JSON.stringify(ci.recovered)}, calls ${changeCalls})`,
  );
  const stored = ci.firstRunOutput ?? "";
  assert(stored.includes(FAIL_LINE), "c6: the stored first-run excerpt keeps the failure line");
  assert(
    Array.from(stored).length <= VERIFY_FULL_OUTPUT_MAX,
    `c6: the recovered excerpt is bounded like every other stored tier (${Array.from(stored).length})`,
  );
  assert(!stored.includes("ghp_"), "c6: the recovered excerpt carries no token");
  const evidence = keepEvidenceHead(stored, ci.firstRunAnchorOffset);
  assert(
    evidence.startsWith(FAIL_LINE),
    `c6: the recovered evidence cuts at the stored excerpt's own offset (got ${JSON.stringify(evidence.slice(0, 70))})`,
  );
  assert(
    evidence.length <= VERIFY_FULL_EVIDENCE_MAX,
    `c6: the recovered evidence is inside the handoff budget (${evidence.length})`,
  );
  // The pair comes from ONE call. `storeTierOutput` on the RAW stream alone is not a
  // way to tell the two apart (the anchor is absolute, and the window clamps to the
  // same place either way), so the discriminating observation is the one this field
  // exists for: the token printed ~8000 characters ABOVE the failure is gone from
  // the stored excerpt, which a raw forward cannot be, and the reported offset is
  // measured inside the excerpt it accompanies.
  const raw = [
    TOKEN_LINE,
    "noise: unrelated passing output\n".repeat(400),
    FAIL_LINE,
    "passing summary line 7 ok\n".repeat(600),
  ].join("\n");
  assert(
    raw.includes("ghp_") && raw.includes(FAIL_LINE),
    "c6: the raw first-run stream really did carry both the token and the failure",
  );
  assert(
    raw.length > VERIFY_FULL_OUTPUT_MAX && raw.lastIndexOf(FAIL_LINE) > VERIFY_FULL_OUTPUT_MAX,
    `c6: the failure lives past any window a raw forward could store (${raw.lastIndexOf(FAIL_LINE)} of ${raw.length})`,
  );
  assert(
    ci.firstRunAnchorOffset !== undefined && stored.slice(ci.firstRunAnchorOffset).startsWith(FAIL_LINE),
    `c6: the reported offset is the stored excerpt's own (${JSON.stringify(ci.firstRunAnchorOffset)})`,
  );

  // A persisted or hand-written offset outside the excerpt describes no position in
  // it, so the reader falls back to the tail cut rather than `slice(99)` → "".
  assert(keepEvidenceHead("short", 99) === "short", "c6: an offset past the end → the tail");
  assert(keepEvidenceHead("short", -1) === "short", "c6: a negative offset → the tail");
  assert(
    keepEvidenceHead("short", 1.5) === "short",
    "c6: a non-integer offset → the tail, never a fractional slice",
  );
  const long = `${FAIL_LINE}\n${"x".repeat(VERIFY_FULL_OUTPUT_MAX)}`;
  const longStored = { output: long, anchorOffset: 0 };
  assert(
    keepEvidenceHead(longStored.output, longStored.anchorOffset).startsWith(FAIL_LINE),
    "c6: a legitimate offset still takes the head cut",
  );
  assert(
    boundByCodePoints(long, VERIFY_FULL_OUTPUT_MAX).clipped === true,
    "c6: the bound helper clips what exceeds its budget",
  );

  rmSync(ciRoot, { recursive: true, force: true });
}

console.log(failed() ? "\nFAILED" : "\nAll #1762 round-4 anchor-offset checks passed.");
process.exit(failed() ? 1 : 0);
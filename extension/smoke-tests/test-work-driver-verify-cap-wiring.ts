#!/usr/bin/env bun
/**
 * #1153 / PR18 — R4: end-to-end CAP WIRING for the develop / commit-pr
 * verification gates.
 *
 * Split out of test-work-driver-verify-hardening.ts for the 500-line cap; that
 * file keeps R1 (note-suppression), R6 (verify-cmd precedence) and the #285
 * scope/fanout gate. Drives the FULL runWorkDriver with a scripted dispatchFn +
 * verifyExecFn and asserts the gate's cap-hit, evidence persistence and handoff
 * routing through the real state machine (pre-PR18 the wiring was asserted only
 * via explainCap text).
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/dispatch.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { isNulStatusRead, nulStatus } from "./lib/nul-porcelain.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}
// PR11 — default issue-body fetcher for tests. runExplore's empty-body
// halt guard (PR11 §C) would otherwise fire when execp("gh issue view N")
// rejects or returns empty stdout — true for almost every test (the test
// repos don't have GitHub remotes). Tests that deliberately exercise
// the empty-body path pass their own injection; everything else gets
// this stub so the cycle proceeds to plan/branch/develop normally.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});
// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}
// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  try {
    // --- R4: end-to-end cap wiring. Drive the FULL runWorkDriver with
    // scripted dispatchFn + verifyExecFn and assert the gate's cap-hit,
    // evidence persistence, and handoff routing through the real state
    // machine (pre-PR18 the wiring was asserted only via explainCap text).

    // R4a — hollow develop claim → cap-hit verify-failed:develop →
    // handoff terminal.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4a-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const hollowExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, stubOpts) => {
          cmd = commandOf(cmd, stubOpts);
          if (cmd === "git rev-parse HEAD")
            return { stdout: "1111111111111111111111111111111111111111\n" };
          if (isNulStatusRead(cmd)) return { stdout: "" };
          if (cmd.includes("rev-parse --verify --end-of-options origin/"))
            return { stdout: "a".repeat(40) + "\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          host: makeFakePi().pi,
          repoRoot: dir,
          issue: 991,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: hollowExec,
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-991" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented the fix" });
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 991);
        const capEvent = after?.eventLog.find(
          (e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop",
        );
        assert(
          capEvent !== undefined,
          "R4a: hollow develop claim fires cap-hit verify-failed:develop through the real wiring",
        );
        assert(
          after?.pipelineState.verifyEvidence?.step === "develop" &&
            (after?.pipelineState.verifyEvidence?.failures.length ?? 0) > 0,
          "R4a: verifyEvidence persisted to the state file with the failure detail",
        );
        assert(
          after?.pipelineState.status === "handoff",
          "R4a: cycle terminal status is handoff (gate failure routed through nextStep)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // R4b — good develop evidence passes the gate; cycle reaches
    // adversarial and (with an approving loop) commit-pr, whose gate then
    // catches a zero-commit claim.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4b-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, stubOpts) => {
          cmd = commandOf(cmd, stubOpts);
          if (cmd === "git rev-parse HEAD")
            return { stdout: "1111111111111111111111111111111111111111\n" };
          if (isNulStatusRead(cmd)) return { stdout: nulStatus(" M src/lib.rs") };
          if (cmd.includes("rev-parse --verify --end-of-options origin/"))
            return { stdout: "a".repeat(40) + "\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: "feature/issue-991" }) };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          host: makeFakePi().pi,
          repoRoot: dir,
          issue: 992,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-992" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented" });
            if (label === "ops:commit-pr")
              return mkResult({ role: "ops", text: "Committed and pushed.\npr: 556" });
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 992);
        assert(
          !after?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop"),
          "R4b: real develop evidence passes the gate (no verify-failed:develop)",
        );
        assert(
          after?.eventLog.some((e) => e.kind === "adversarial-approved"),
          "R4b: cycle proceeded through adversarial after the develop gate",
        );
        const commitCap = after?.eventLog.find(
          (e) => e.kind === "cap-hit" && e.cap === "verify-failed:commit-pr",
        );
        assert(
          commitCap !== undefined,
          "R4b: zero-commits-ahead claim fires cap-hit verify-failed:commit-pr through the real wiring",
        );
        assert(
          after?.pipelineState.verifyEvidence?.step === "commit-pr" &&
            after?.pipelineState.verifyEvidence?.failures.some((f) => /zero commits/.test(f)),
          "R4b: commit-pr verifyEvidence persisted with the zero-commits failure",
        );
        assert(
          after?.pipelineState.status === "handoff",
          "R4b: commit-pr gate failure routes the cycle to handoff",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // R4c — pr:-marker omission repaired via gh pr list adoption; no
    // cap fires and pipelineState.prNumber is written back.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4c-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, stubOpts) => {
          cmd = commandOf(cmd, stubOpts);
          if (cmd === "git rev-parse HEAD")
            return { stdout: "1111111111111111111111111111111111111111\n" };
          if (isNulStatusRead(cmd)) return { stdout: nulStatus(" M src/lib.rs") };
          if (cmd.includes("rev-parse --verify --end-of-options origin/"))
            return { stdout: "a".repeat(40) + "\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "789\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: "feature/issue-993" }) };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          host: makeFakePi().pi,
          repoRoot: dir,
          issue: 993,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-993" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented" });
            if (label === "ops:commit-pr")
              return mkResult({ role: "ops", text: "Committed and pushed. (forgot the marker)" });
            if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 993);
        assert(
          !after?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:commit-pr"),
          "R4c: missing pr: marker repaired via gh pr list — no verify-failed:commit-pr cap",
        );
        assert(
          after?.pipelineState.prNumber === 789,
          "R4c: adopted PR number written back to pipelineState.prNumber (bonus repair wired)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
  }
}

process.exit(exit);

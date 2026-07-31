#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR19 — mechanized commit-pr: the driver executes consolidation +
 * commit + push + PR creation directly (LLM ops dispatch becomes the
 * fallback). Full-driver integration tests with scripted verifyExecFn.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState } from "../src/workflow-state.ts";

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

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// PR19 — mechanized commit-pr: the driver executes consolidation +
// commit + push + PR creation directly (LLM ops dispatch becomes the
// fallback). Full-driver integration tests with scripted verifyExecFn;
// dispatchFn THROWS on ops:commit-pr in the happy-path test to prove
// the LLM dispatch never fires.
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  const prevSpec = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
  const prevMech = process.env.PI_ENSEMBLE_MECHANIZE_OPS;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = "1";
  process.env.PI_ENSEMBLE_MECHANIZE_OPS = "1";

  // Shared fixture bits for the 3-workstream shape.
  const PLAN_REPLY = `## Workstreams

### task-a — fix module a
- paths: src/a.rs
- out-of-scope: docs

### task-b — fix module b
- paths: src/b.rs
- out-of-scope: docs

### task-c — fix module c
- paths: src/c.rs
- out-of-scope: docs
`;
  const branchReplyFor = (dir: string, issue: number) =>
    [
      `branch: feature/issue-${issue}`,
      "",
      "## Worktrees",
      "",
      `- task-a: ${dir}/wta`,
      `- task-b: ${dir}/wtb`,
      `- task-c: ${dir}/wtc`,
    ].join("\n");
  const mkDispatchFn =
    (dir: string, issue: number, opts?: { allowOpsCommitPr?: boolean }) =>
    async (
      _pi: unknown,
      spec: { role: string; prompt: string },
      dOpts?: { label?: string },
    ): Promise<DispatchResult> => {
      const label = dOpts?.label ?? spec.role;
      if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
      if (label === "plan") return mkResult({ text: PLAN_REPLY });
      if (label === "ops") return mkResult({ role: "ops", text: branchReplyFor(dir, issue) });
      if (label.startsWith("developer"))
        return mkResult({ role: "developer", text: "done — implemented" });
      if (label === "ops:commit-pr") {
        if (opts?.allowOpsCommitPr)
          return mkResult({ role: "ops", text: "Committed and pushed.\npr: 556" });
        throw new Error("ops:commit-pr dispatched — mechanized path should have handled this");
      }
      if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
      if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      throw new Error(`unexpected dispatch: ${label}`);
    };
  try {
    // M1 — happy path: 3 worktrees consolidated by the driver, PR opened,
    // number parsed; the LLM ops:commit-pr dispatch never fires.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-happy-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const calls: string[] = [];
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          calls.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-994\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wta")) return { stdout: " M src/a.rs\n" };
            if (cwd.endsWith("/wtb")) return { stdout: " M src/b.rs\n" };
            if (cwd.endsWith("/wtc")) return { stdout: "?? src/c.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd === "git diff --cached")
            return { stdout: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" };
          if (cmd.startsWith("git apply --index")) return { stdout: "" };
          if (cmd.startsWith("git commit")) return { stdout: "" };
          if (cmd.startsWith("git push")) return { stdout: "" };
          if (cmd.startsWith("gh pr create"))
            return { stdout: "https://github.com/owner/repo/pull/612\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 994,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 994),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 994);
        const mechEvent = after?.eventLog.find(
          (e) =>
            e.kind === "dispatch-completed" &&
            e.role === "driver" &&
            e.label === "driver:commit-pr",
        );
        assert(
          mechEvent !== undefined,
          "M1: mechanized commit-pr emitted dispatch-completed (role=driver) — LLM ops never dispatched",
        );
        assert(
          after?.pipelineState.prNumber === 612,
          "M1: PR number parsed from gh pr create URL and written to pipelineState",
        );
        assert(
          calls.filter((c) => c.startsWith("git apply --index")).length === 3,
          "M1: all 3 sibling worktrees' staged diffs applied at repoRoot (3× git apply --index)",
        );
        assert(
          calls.some((c) => c.startsWith("git push")) &&
            calls.some((c) => c.startsWith("gh pr create")),
          "M1: push + gh pr create executed by the driver",
        );
        assert(
          !after?.eventLog.some(
            (e) => e.kind === "cap-hit" && e.cap === "commit-pr-incomplete-consolidation",
          ),
          "M1: consolidation oracle (verifyConsolidation) passes on the mechanized result",
        );
        assert(
          !after?.eventLog.some((e) => e.kind === "plumb-report"),
          "M1: no fallback plumb-report — mechanized path completed cleanly",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // M2 — mechanical failure (git apply conflict) → plumb-report +
    // graceful fallback to the LLM ops dispatch.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-fallback-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-995\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtb") || cwd.endsWith("/wtc"))
              return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd === "git diff --cached") return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply --index")) {
            const err = new Error("patch does not apply") as Error & { stderr?: string };
            err.stderr = "error: patch failed: src/x.rs:1";
            throw err;
          }
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 995,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 995, { allowOpsCommitPr: true }),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 995);
        assert(
          after?.eventLog.some(
            (e) => e.kind === "plumb-report" && /fell back to the ops dispatch/.test(e.body),
          ),
          "M2: apply conflict → plumb-report explains the fallback",
        );
        assert(
          after?.eventLog.some(
            (e) =>
              e.kind === "dispatch-completed" && e.role === "ops" && e.label === "ops:commit-pr",
          ),
          "M2: LLM ops:commit-pr dispatched as fallback after mechanized failure",
        );
        assert(
          after?.pipelineState.prNumber === 556,
          "M2: fallback path's pr: marker still parsed into pipelineState",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // M3 — empty-worktree guard: one clean worktree → fallback with the
    // no-uncommitted-work reason (the LLM/ops + downstream gates decide
    // what to do; the mechanized path never ships a partial slice).
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-empty-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-996\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wtb")) return { stdout: "" }; // task-b clean
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtc")) return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd === "git diff --cached") return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply --index")) return { stdout: "" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 996,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 996, { allowOpsCommitPr: true }),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 996);
        assert(
          after?.eventLog.some(
            (e) => e.kind === "plumb-report" && /no uncommitted work/.test(e.body),
          ),
          "M3: clean worktree → mechanized path bails with the no-uncommitted-work reason",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // M4 — escape hatch: PI_ENSEMBLE_MECHANIZE_OPS=0 → straight to the
    // LLM ops dispatch, no mechanized attempt, no plumb-report.
    {
      process.env.PI_ENSEMBLE_MECHANIZE_OPS = "0";
      const dir = mkdtempSync(path.join(tmpdir(), "mech-off-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const mechCalls: string[] = [];
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse --abbrev-ref HEAD") mechCalls.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtb") || cwd.endsWith("/wtc"))
              return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 997,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 997, { allowOpsCommitPr: true }),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 997);
        assert(
          mechCalls.length === 0,
          "M4: PI_ENSEMBLE_MECHANIZE_OPS=0 → mechanized path never probes the repo",
        );
        assert(
          after?.eventLog.some(
            (e) =>
              e.kind === "dispatch-completed" && e.role === "ops" && e.label === "ops:commit-pr",
          ) && !after?.eventLog.some((e) => e.kind === "plumb-report"),
          "M4: LLM ops path used directly, no fallback plumb-report",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
        process.env.PI_ENSEMBLE_MECHANIZE_OPS = "1";
      }
    }
  } finally {
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    process.env.PI_ENSEMBLE_VERIFY = "0";
    if (prevSpec === undefined) delete process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
    else process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = prevSpec;
    if (prevMech === undefined) delete process.env.PI_ENSEMBLE_MECHANIZE_OPS;
    else process.env.PI_ENSEMBLE_MECHANIZE_OPS = prevMech;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

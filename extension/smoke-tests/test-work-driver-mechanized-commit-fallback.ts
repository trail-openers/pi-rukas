#!/usr/bin/env bun
/**
 * #507 — mechanized commit-pr fallback tests (M2, M3).
 *
 * Split out of test-work-driver-mechanized-commit.ts so that file stays
 * under the 500-line hard cap after adding the M4 clip-title e2e case.
 * CI globs `smoke-tests/test-*.ts` excluding `*-live.ts`, so this file
 * runs automatically in the offline suite.
 *
 * M2 — mechanical failure (git apply conflict) → plumb-report +
 *       graceful fallback to the LLM ops dispatch.
 * M3 — empty-worktree guard: one clean worktree → fallback with the
 *       no-uncommitted-work reason.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
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

function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});

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

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

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

{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  try {
    // M2 — mechanical failure (git apply conflict) → plumb-report +
    // graceful fallback to the LLM ops dispatch.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-fallback-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const calls2: string[] = [];
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          calls2.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-995\n" };
          if (cmd.startsWith("git rev-parse ")) return { stdout: "base123\n" };
          if (cmd.startsWith("git fetch origin")) return { stdout: "" };
          if (cmd.startsWith("git worktree add")) return { stdout: "" };
          if (cmd.startsWith("git worktree remove")) return { stdout: "" };
          if (cmd.startsWith("git status --porcelain")) {
            const worktreeAdds = calls2.filter((c) => c.startsWith("git worktree add")).length;
            const cwd = o?.cwd ?? "";
            if (worktreeAdds < 3) return { stdout: "" };
            if (/-task-[abc]$/.test(cwd)) return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply")) {
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
    // no-uncommitted-work reason.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-empty-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-996\n" };
          if (cmd.startsWith("git status --porcelain")) {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wtb")) return { stdout: "" };
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtc")) return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply")) return { stdout: "" };
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
  } finally {
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    process.env.PI_ENSEMBLE_VERIFY = "0";
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

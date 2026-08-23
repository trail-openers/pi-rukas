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
  process.env.PI_ENSEMBLE_VERIFY = "1";

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
        // #475 — the pre-create `inspectWorktreeForLoss` guard must find
        // clean worktrees during branch setup, but the worktrees read dirty
        // during develop (the developer "wrote" code). The discriminator:
        // `git worktree add` runs LAST in the branch step (after all
        // `git status` probes), so any `git status` call before the first
        // `git worktree add` is a pre-create probe → return clean.
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          calls.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-994\n" };
          // #393 — mechanized branch setup is now unconditional (the knob that
          // skipped it is gone), so the stub must answer its commands too or
          // the branch step falls back and emits a plumb-report that this
          // fixture's "mechanized path completed cleanly" assertion then trips on.
          if (cmd.startsWith("git rev-parse ")) return { stdout: "base123\n" };
          if (cmd.startsWith("git fetch origin")) return { stdout: "" };
          // #475 — the pre-remove guard (`inspectWorktreeForLoss`) checks for
          // unrecoverable work before force-removing a same-path worktree.
          // The driver's worktrees don't exist on disk in this fixture, so
          // the guard finds nothing and the pre-remove proceeds; this stub
          // models that by accepting the remove.
          if (cmd.startsWith("git worktree remove")) return { stdout: "" };
          if (cmd.startsWith("git worktree add")) return { stdout: "" };
          if (cmd.startsWith("git status --porcelain")) {
            // #393 — worktree paths now come from mechanized branch setup
            // (`.worktrees/issue-994/<workstream>`), not from the ops reply,
            // so key on the workstream id rather than the old /wta,/wtb,/wtc
            // paths the LLM branch flow used to invent.
            // #475 — during the branch step, the `inspectWorktreeForLoss`
            // guard probes each worktree's `git status` BEFORE its
            // `git worktree add`. The worktrees don't exist on disk in this
            // fixture, so the guard finds nothing and the pre-remove
            // proceeds. During develop/commit-pr, the developer "wrote"
            // code, so the worktrees read dirty.
            //
            // Discriminator: count `git worktree add` calls already issued
            // vs. total workstreams (3). If all 3 worktrees are created,
            // we're past the branch step → return dirty. Otherwise → clean.
            const worktreeAdds = calls.filter((c) =>
              c.startsWith("git worktree add"),
            ).length;
            const cwd = o?.cwd ?? "";
            if (worktreeAdds < 3) return { stdout: "" };
            if (cwd.endsWith("-task-a")) return { stdout: " M src/a.rs\n" };
            if (cwd.endsWith("-task-b")) return { stdout: " M src/b.rs\n" };
            if (cwd.endsWith("-task-c")) return { stdout: "?? src/c.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd.startsWith("git diff --cached"))
            return { stdout: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" };
          if (cmd.startsWith("git apply")) return { stdout: "" };
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
          calls.filter((c) => c.startsWith("git apply")).length === 3,
          "M1: all 3 sibling worktrees' staged diffs applied at repoRoot (3× git apply)",
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

    // M2 and M3 moved to test-work-driver-mechanized-commit-fallback.ts
    // (#507 file-size split: this file gained the M4 clip-title e2e case
    // and would have exceeded the 500-line hard cap with M2+M3 in place).

    // M4 — #507: over-budget title is clipped at a word boundary with an
    // ellipsis. The captured `--title` and `git commit -m` first `-m` arg
    // must be the same clipped value, asserted against hard-coded literals.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-clip-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const calls: string[] = [];
        const LONG_TITLE =
          "fix: long issue title that exceeds the sixty-four code unit budget-TAIL";
        assert(LONG_TITLE.length > 64, "M4: fixture title really is over budget");
        const { clipTitle } = await import("../src/work-driver-commit.ts");
        const expectedClipped = clipTitle(LONG_TITLE, 64);
        assert(expectedClipped.length <= 64, "M4: clipped title is within budget");
        assert(expectedClipped.endsWith("\u2026"), "M4: clipped title ends with ellipsis");
        assert(!expectedClipped.includes("-TAIL"), "M4: sentinel tail is clipped away");

        const longTitleBody = async (issue: number, _cwd: string) => ({
          stdout: `title:\t${LONG_TITLE}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
        });

        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          calls.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "feature/issue-997\n" };
          if (cmd.startsWith("git rev-parse ")) return { stdout: "base123\n" };
          if (cmd.startsWith("git fetch origin")) return { stdout: "" };
          if (cmd.startsWith("git worktree add")) return { stdout: "" };
          if (cmd.startsWith("git worktree remove")) return { stdout: "" };
          if (cmd.startsWith("git status --porcelain")) {
            const worktreeAdds = calls.filter((c) => c.startsWith("git worktree add")).length;
            const cwd = o?.cwd ?? "";
            if (worktreeAdds < 3) return { stdout: "" };
            if (cwd.endsWith("-task-a")) return { stdout: " M src/a.rs\n" };
            if (cwd.endsWith("-task-b")) return { stdout: " M src/b.rs\n" };
            if (cwd.endsWith("-task-c")) return { stdout: "?? src/c.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd.startsWith("git diff --cached"))
            return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply")) return { stdout: "" };
          if (cmd.startsWith("git commit")) return { stdout: "" };
          if (cmd.startsWith("git push")) return { stdout: "" };
          if (cmd.startsWith("gh pr create"))
            return { stdout: "https://github.com/owner/repo/pull/614\n" };
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
          issueBodyFetcherFn: longTitleBody,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 997),
        };
        await runWorkDriver(ctx).catch(() => {});

        const prCreateCmd = calls.find((c) => c.startsWith("gh pr create"));
        const commitCmd = calls.find((c) => c.startsWith("git commit"));
        assert(prCreateCmd !== undefined, "M4: gh pr create was executed");
        assert(commitCmd !== undefined, "M4: git commit was executed");

        const titleMatch = prCreateCmd?.match(/--title (".*?")/);
        assert(titleMatch !== undefined, "M4: --title flag present in gh pr create");
        const prTitle = titleMatch ? JSON.parse(titleMatch[1]) : "";
        assert(
          prTitle === expectedClipped,
          `M4: --title is the clipped value (${JSON.stringify(prTitle)} vs expected ${JSON.stringify(expectedClipped)})`,
        );
        assert(!prTitle.includes("-TAIL"), "M4: sentinel -TAIL is absent from --title");

        const mMatches = commitCmd?.match(/-m (".*?")/g) ?? [];
        assert(mMatches.length >= 1, "M4: git commit has at least one -m arg");
        const commitTitle = mMatches.length > 0 ? JSON.parse(mMatches[0].replace("-m ", "")) : "";
        assert(
          commitTitle === expectedClipped,
          `M4: git commit -m first arg is the clipped value (${JSON.stringify(commitTitle)} vs expected ${JSON.stringify(expectedClipped)})`,
        );
        assert(!commitTitle.includes("-TAIL"), "M4: sentinel -TAIL is absent from commit title");

        assert(
          prTitle === commitTitle,
          "M4: --title and git commit -m use the same clipped value (one source, no divergence)",
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

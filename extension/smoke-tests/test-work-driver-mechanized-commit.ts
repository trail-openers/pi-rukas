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
        // #453 — SHA values for cherry-pick simulation.
        const WORKTREE_SHA = {
          "-task-a": "aaa111aaa111aaa111aaa111aaa111aaa111aa",
          "-task-b": "bbb222bbb222bbb222bbb222bbb222bbb222bbbb",
          "-task-c": "ccc333ccc333ccc333ccc333ccc333ccc333cccc",
        };
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
            return { stdout: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" };
          // #453 — cherry-pick: return worktree-specific SHAs for SHA extraction.
          if (cmd === "git rev-parse HEAD" && o?.cwd) {
            if (o.cwd.endsWith("-task-a")) return { stdout: WORKTREE_SHA["-task-a"] + "\n" };
            if (o.cwd.endsWith("-task-b")) return { stdout: WORKTREE_SHA["-task-b"] + "\n" };
            if (o.cwd.endsWith("-task-c")) return { stdout: WORKTREE_SHA["-task-c"] + "\n" };
          }
          if (cmd.startsWith("git cherry-pick")) return { stdout: "" };
          // Tree hash check (isCommitOnBranch): return DIFFERENT hashes to
          // ensure cherry-pick doesn't skip (different tree = not on branch).
          if (cmd.startsWith("git cat-file -p")) {
            // HEAD on the integration branch has a different tree than dev commits.
            if (cmd.endsWith(" git cat-file -p HEAD"))
              return { stdout: "tree head1head1head1head1head1head1head1head1\nauthor T\n" };
            // Developer commits have unique trees.
            const devSha = cmd.match(/git cat-file -p ([0-9a-f]+)/)?.[1];
            const hash = (devSha ?? "abc").slice(0, 8);
            return { stdout: `tree ${hash}${hash.toUpperCase().padEnd(16, "x")}deadbeefdeadbeef\nauthor T\n` };
          }
          if (cmd.startsWith("git cherry-pick")) return { stdout: "" };
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
          calls.filter((c) => c.startsWith("git cherry-pick")).length === 3,
          "M1: all 3 sibling worktrees' commits cherry-picked at repoRoot (3× git cherry-pick)",
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
          if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/x b/x\n+new\n" };
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

// M5 — #453 cherry-pick integration: verify commitShas are recorded.
// Uses real git against a throwaway repo (similar to test-work-driver-integrate-realgit.ts).
{
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");

  const execFileP = promisify(execFile);
  const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
  const realRoot = mkdtempSync(path.default.join(tmpdir(), "mech-cherry-"));
  const originDir = path.default.join(realRoot, "origin.git");
  const repoDir = path.default.join(realRoot, "repo");
  const scratchDir = path.default.join(realRoot, "scratch");
  try {
    await (await import("node:fs")).mkdirSync(path.default.join(repoDir, ".git", "info"), {
      recursive: true,
    });
    // Create a bare origin.
    await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
    // Create a repo with one commit on main.
    await execFileP("git", ["init", "--initial-branch=main", repoDir]);
    await git(repoDir, ["config", "user.email", "t@example.com"]);
    await git(repoDir, ["config", "user.name", "T"]);
    writeFileSync(path.default.join(repoDir, "base.txt"), "base\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-q", "-m", "base"]);
    await git(repoDir, ["remote", "add", "origin", originDir]);
    await git(repoDir, ["push", "-q", "-u", "origin", "main"]);

    // Mechanized branch setup.
    const { mechanizedBranchSetup } = await import("../src/work-driver-branch-mechanized.ts");
    const { integrate } = await import("../src/work-driver-integrate.ts");
    type ExecFn = (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{
      stdout: string;
    }>;
    const realExec: ExecFn = async (cmd, o) => {
      const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
        cwd: o?.cwd,
        maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
      });
      return { stdout };
    };

    const setup = await mechanizedBranchSetup(
      realExec,
      repoDir,
      453,
      [453],
      ["task-a"],
      "SHA recording test",
    );
    const wt = setup.worktrees["task-a"] ?? "";

    // Developer commits in the worktree.
    writeFileSync(path.default.join(wt, "feature.txt"), "feature\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "add feature.txt"]);
    const { stdout: shaOut } = await git(wt, ["rev-parse", "HEAD"]);
    const devSha = shaOut.trim();
    assert(devSha.length === 40, "M5: developer commit SHA is 40 chars");

    // Integrate — cherry-pick path (no pre-existing commitShas for first attempt).
    const res = await integrate(realExec, {
      repoRoot: repoDir,
      branchName: setup.branchName,
      baseSha: setup.baseSha,
      worktrees: setup.worktrees,
      scratchDir: scratchDir,
      commitTitle: "feat(#453): task-a",
      commitBody: "Fixes #453",
      mode: "create",
      requireAllNonEmpty: true,
    });
    assert(res.ok && !res.empty, `M5: cherry-pick integration succeeded (${JSON.stringify(res)})`);
    // Verify commitShas is recorded in the result.
    assert(
      res.commitShas !== undefined,
      "M5: commitShas is recorded in integrate result",
    );
    assert(
      res.commitShas?.["task-a"] === devSha,
      "M5: commitShas maps task-a to the developer's SHA",
    );
    // Verify the commit landed on the branch.
    const { stdout: headAhead } = await git(repoDir, [
      "rev-list",
      "--count",
      `${setup.baseSha}..HEAD`,
    ]);
    assert(
      headAhead.trim() === "1",
      "M5: exactly one commit ahead of baseSha (cherry-picked)",
    );
    console.log("✓ M5: cherry-pick SHA recording verified");
  } finally {
    rmSync(realRoot, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

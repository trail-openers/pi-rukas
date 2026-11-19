#!/usr/bin/env bun
/**
 * The branch step stops on a remote branch of the issue that this cycle did not
 * push, before any develop dispatch (`stale-remote-branch`).
 *
 * Real git against a bare "origin" on disk; `gh` and `git fetch` are stubbed.
 *
 *   1. An earlier cycle's branch of the same name: the cap, its evidence names the
 *      branch and tip, no worktree was made, and the branch is untouched.
 *   2. A `feature/issue-<n>-*` branch of another title stops the same way.
 *   3. This cycle's own recorded push (`pushed.json`): proceeds (the restart path).
 *   4. No remote branch, or only `feature/issue-<n>0-*`: proceeds.
 *   5. An unreadable remote: proceeds (fails open).
 *   6. An open PR on that branch: still `existing-pr-detected`, unchanged.
 *   7. The cause is `environment`, and the action and explanation say to look at
 *      the branch, delete it if abandoned, or open its PR by hand.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import { branchSlug } from "../src/work-driver-branch-mechanized.ts";
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { recordPushedSha } from "../src/work-driver-push-lease.ts";
import { scratchDir } from "../src/work-driver-workspace.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";

const execFileP = promisify(execFile);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const ISSUE = 1800;
const TITLE = "stale remote branch";
const BRANCH = branchSlug([ISSUE], TITLE);
const rootBase = mkdtempSync(path.join(tmpdir(), "pi-ens-1800-"));
const TITLE_ARTIFACT = path.join(rootBase, "issue-title.txt");
writeFileSync(TITLE_ARTIFACT, `title: ${TITLE}\n`);

async function fixture(name: string) {
  const root = path.join(rootBase, name);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "Earlier Cycle"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  return repo;
}

/** Push a commit on top of main to `origin/<branch>`, as an earlier cycle would; returns its sha. */
async function pushBranch(repo: string, branch: string): Promise<string> {
  await git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(path.join(repo, "c.txt"), `${branch}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "earlier attempt"]);
  const sha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repo, ["push", "-q", "origin", branch]);
  await git(repo, ["checkout", "-q", "main"]);
  await git(repo, ["branch", "-q", "-D", branch]);
  return sha;
}

interface Opts {
  prList?: string;
  lsRemoteFails?: boolean;
  baseSha?: string;
}

async function run(repo: string, o: Opts = {}): Promise<WorkState | undefined> {
  const dispatched: string[] = [];
  const execFn: ExecFn = async (cmd, opts) => {
    const line = commandOf(cmd, opts);
    if (line.includes("remote.origin.url")) return { stdout: "https://github.com/o/r\n" };
    if (line.startsWith("gh ")) return { stdout: o.prList ?? "[]" };
    if (line.startsWith("git fetch")) return { stdout: "" };
    if (o.lsRemoteFails && line.startsWith("git ls-remote")) {
      throw new Error("fatal: could not read from remote repository");
    }
    return realExec(cmd, opts);
  };
  const ctx = {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture
    host: {} as any,
    issue: ISSUE,
    issues: [ISSUE],
    restart: true,
    repoRoot: repo,
    verifyExecFn: execFn,
    dispatchFn: async () => {
      dispatched.push("dispatch");
      throw new Error("no dispatch expected");
    },
  } as unknown as DriverContext;
  const state = initialState(ISSUE);
  state.pipelineState.issueBodyArtifact = TITLE_ARTIFACT;
  if (o.baseSha) state.pipelineState.baseSha = o.baseSha;
  const out = await runBranch(ctx, state, 1000).catch((e) => {
    console.error(`runBranch threw: ${(e as Error).message}`);
    return undefined;
  });
  assert(dispatched.length === 0, "no child was dispatched");
  return out;
}

const capOf = (s: WorkState | undefined) =>
  s?.eventLog.find((e) => e.kind === "cap-hit") as
    | Extract<WorkState["eventLog"][number], { kind: "cap-hit" }>
    | undefined;
const worktreeOf = (repo: string) => path.join(repo, ".worktrees", `issue-${ISSUE}-default`);

try {
  // 1. An earlier cycle's branch of the same name.
  {
    const repo = await fixture("same-name");
    const sha = await pushBranch(repo, BRANCH);
    const out = await run(repo);
    const cap = capOf(out);
    assert(
      cap?.cap === "stale-remote-branch",
      `same name: cap stale-remote-branch (got ${cap?.cap})`,
    );
    assert(cap?.nextStep === "handoff", "same name: routes to the handoff");
    assert(cap?.evidence?.includes(`origin/${BRANCH}`) === true, "evidence names the branch");
    assert(cap?.evidence?.includes(sha.slice(0, 12)) === true, "evidence names the tip");
    assert(
      cap?.evidence?.includes("Earlier Cycle") === true,
      "evidence names the author when the commit is local",
    );
    assert(!existsSync(worktreeOf(repo)), "no worktree was created: develop never starts");
    const remote = (await git(repo, ["ls-remote", "origin", `refs/heads/${BRANCH}`])).stdout;
    assert(remote.startsWith(sha), "the remote branch is untouched");
    if (out !== undefined) {
      const verdict = causeVerdictOf(out, "stale-remote-branch", undefined);
      assert(
        verdict?.causeClass === "environment",
        `cause class environment (got ${verdict?.causeClass})`,
      );
      assert(
        verdict?.userAction?.includes("git push origin --delete <branch>") === true &&
          verdict.userAction.includes("open or update its PR by hand") &&
          verdict.userAction.includes(`/work ${ISSUE}`),
        "the action says delete it if abandoned, re-run, or open its PR by hand",
      );
      assert(
        verdict?.causeEvidence.some((l) => l.includes(`origin/${BRANCH}`)) === true,
        "the cause evidence names the branch",
      );
      const why = explainCap("stale-remote-branch", out);
      assert(
        why.includes(`origin/${BRANCH}`) && why.includes("git push origin --delete"),
        "the explanation names the branch and the steps",
      );
    }
  }
  // 2. Another title of the same issue.
  {
    const repo = await fixture("other-title");
    await pushBranch(repo, `feature/issue-${ISSUE}-an-older-title`);
    const cap = capOf(await run(repo));
    assert(cap?.cap === "stale-remote-branch", "feature/issue-<n>-<other title>: stops too");
    assert(
      cap?.evidence?.includes(`feature/issue-${ISSUE}-an-older-title`) === true,
      "evidence names that branch",
    );
  }
  // 3. This cycle's own recorded push.
  {
    const repo = await fixture("own-push");
    const sha = await pushBranch(repo, BRANCH);
    await recordPushedSha(scratchDir(repo, ISSUE), BRANCH, sha);
    const out = await run(repo);
    assert(capOf(out) === undefined, "own recorded push: proceeds (no cap)");
    assert(existsSync(worktreeOf(repo)), "own recorded push: the worktree is created");
  }
  // 3b. A recorded push the remote moved past is not this cycle's.
  {
    const repo = await fixture("own-push-moved");
    await pushBranch(repo, BRANCH);
    await recordPushedSha(scratchDir(repo, ISSUE), BRANCH, "f".repeat(40));
    assert(capOf(await run(repo))?.cap === "stale-remote-branch", "a record of another sha: stops");
  }
  // 4. No remote branch, or only another issue's.
  {
    const repo = await fixture("none");
    assert(capOf(await run(repo)) === undefined, "no remote branch: proceeds");
    await pushBranch(repo, `feature/issue-${ISSUE}0-other-issue`);
    const out = await run(repo);
    assert(capOf(out) === undefined, "feature/issue-<n>0-*: another issue, proceeds");
  }
  // 4b. A merged branch left on the remote: its tip is in the base, so the
  // first push on top of it is a fast-forward and the cycle proceeds.
  {
    const repo = await fixture("merged");
    const before = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const sha = await pushBranch(repo, BRANCH);
    assert(
      capOf(await run(repo, { baseSha: before }))?.cap === "stale-remote-branch",
      "a branch not in the base: stops",
    );
    await git(repo, ["merge", "-q", "--ff-only", sha]);
    await git(repo, ["push", "-q", "origin", "main"]);
    // No recorded base, as on a fresh cycle: the check reads origin/main.
    assert(capOf(await run(repo)) === undefined, "a branch whose tip is in the base: proceeds");
  }
  // 5. An unreadable remote.
  {
    const repo = await fixture("unreadable");
    await pushBranch(repo, BRANCH);
    assert(
      capOf(await run(repo, { lsRemoteFails: true })) === undefined,
      "ls-remote fails: proceeds (fails open)",
    );
  }
  // 6. An open PR on that branch.
  {
    const repo = await fixture("open-pr");
    await pushBranch(repo, BRANCH);
    const prList = JSON.stringify([{ number: 7, headRefName: BRANCH, body: `Fixes #${ISSUE}` }]);
    const cap = capOf(await run(repo, { prList }));
    assert(
      cap?.cap === "existing-pr-detected",
      `open PR: existing-pr-detected, unchanged (got ${cap?.cap})`,
    );
  }
} finally {
  rmSync(rootBase, { recursive: true, force: true });
}
console.log(`\nexit ${exit}`);
process.exit(exit);

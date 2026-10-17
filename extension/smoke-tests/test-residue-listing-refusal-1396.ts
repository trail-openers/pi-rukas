#!/usr/bin/env bun
/**
 * #1396 (six-lens round 3, items c + 4) — a `git worktree list` that HANGS is
 * not evidence that nothing is there, at the two reads this round had left
 * unbounded or fail-open.
 *
 * (1) The branch step's same-issue residue pass. `scanWorktrees` keeps its
 *     long-standing `catch → []` contract (its other callers act on the empty
 *     list safely), and `work-driver-branch-residue.ts` used to swallow every
 *     throw as "non-fatal, continue". Together those two read a HANG — which
 *     became a rejection the moment the listing grew `WORKTREE_LIST_TIMEOUT_MS`
 *     — as "no leftovers": the pass removed nothing and reported a clean pass
 *     while a same-issue tree holding uncommitted work sat in place for the
 *     next cycle's `worktree add` to refuse on. That is the same fail-open class
 *     as the #654 sweep's `.catch(() => "")`. The pass now records a
 *     `worktree-listing-unreadable` cap-hit.
 *
 * (2) `branchHolders` (the post-dispatch audit) ran its listing with NO
 *     timeout at all — the last `git worktree list` in the harness without one.
 *     Pinned by the option the executor actually receives, because a fake that
 *     ignores `timeout` cannot tell a bound from an absent one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { branchHolders } from "../src/work-driver-branch-holder.ts";
import { runBranchResiduePass } from "../src/work-driver-branch-residue.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { type ExecFn, WORKTREE_LIST_TIMEOUT_MS } from "../src/worktree.ts";
import { git, realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1396-r3-"));

try {
  // ---------------------------------------------------------------- (1)
  // The refusal the round closed: `handleSameIssueLeftovers` used to let a
  // listing failure fall through to `worktree-leftover.ts`'s `scanWorktrees`
  // `catch → []`, so a HANG (a rejection ever since the listing grew
  // WORKTREE_LIST_TIMEOUT_MS) read as "no leftovers" — the pass removed nothing
  // and reported success, and the dirty same-issue tree sat in place for the
  // next cycle's `worktree add` to refuse on. The caller
  // (`work-driver-branch-residue.ts`) is what turns that into a visible park.
  const mkRepo = async (name: string) => {
    const repo = path.join(root, name);
    const originDir = path.join(root, `${name}-origin.git`);
    await git(root, ["init", "--bare", "--initial-branch=main", originDir]);
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "a.txt"), "base\n");
    await git(repo, ["init", "-q", "--initial-branch=main"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "T"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["remote", "add", "origin", originDir]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    return repo;
  };
  // The driver's own wrapper, with the two reads it makes before the residue
  // scan stubbed (both are network/origin reads a temp repo satisfies anyway —
  // stubbing them keeps the test pinned to the ONE read under test).
  const runPass = async (repo: string, listing: ExecFn) => {
    const exec: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git symbolic-ref --short refs/remotes/origin/HEAD")) {
        return { stdout: "origin/main\n" };
      }
      if (cmd.startsWith("git rev-parse --verify --quiet")) return { stdout: "abc123\n" };
      if (cmd.startsWith("git status --porcelain")) return { stdout: "" };
      if (cmd.startsWith("gh ") || cmd.startsWith("git fetch")) return { stdout: "" };
      return listing(cmd, o);
    };
    return runBranchResiduePass(
      { repoRoot: repo, issue: 1396, issues: [1396] } as unknown as CycleContextShim,
      initialState(1396),
      exec,
      path.join(root, `scratch-${path.basename(repo)}`),
    );
  };

  {
    const repo = await mkRepo("repo");
    const killedListing: ExecFn = async () => {
      // The shape `promisify(exec)` reports when `timeout` fires: killed, a
      // signal, and NO `code` — nothing here can read it as "git is missing".
      throw Object.assign(new Error("Command failed: git worktree list --porcelain"), {
        killed: true,
        signal: "SIGTERM",
        stderr: "",
        stdout: "",
      });
    };
    const out = await runPass(repo, killedListing);
    const cap = out.eventLog.find((e) => e.kind === "cap-hit");
    assert(
      cap !== undefined && (cap as { cap?: string }).cap === "worktree-listing-unreadable",
      "#1396 (c) a killed listing parks the residue pass instead of reporting a clean pass",
    );
    assert(
      cap !== undefined && (cap as { nextStep?: string }).nextStep === "handoff",
      "(c) the refusal routes to handoff, not a silent continue",
    );
    assert(
      cap !== undefined &&
        /worktree list/.test(String((cap as { evidence?: string }).evidence ?? "")),
      "(c) the cap evidence names the command that could not answer",
    );
  }

  // A git that genuinely is not there keeps the pre-existing non-fatal
  // degradation — the pass must not park a cycle over an absent binary.
  {
    const repo = await mkRepo("repo-nogit");
    const enoent: ExecFn = async () => {
      throw Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" });
    };
    const out = await runPass(repo, enoent);
    assert(
      !out.eventLog.some((e) => e.kind === "cap-hit"),
      "(c) ENOENT still degrades non-fatally — 'no git' is not 'could not look'",
    );
  }

  // ---------------------------------------------------------------- (2)
  {
    const seen: Array<{ cmd: string; timeout?: number }> = [];
    const spy: ExecFn = async (cmd, o) => {
      seen.push({ cmd, timeout: o?.timeout });
      return {
        stdout: [`worktree /w/one`, "HEAD abc", `branch refs/heads/feature/issue-9-x`, ""].join(
          "\n",
        ),
      };
    };
    const res = await branchHolders(spy, "/repo", "feature/issue-9-x");
    const listCall = seen.find((c) => c.cmd === "git worktree list --porcelain");
    assert(
      res.ok === true && res.holders.length === 1,
      "#1396 (4) branchHolders still parses the holder it is chartered to find",
    );
    assert(
      listCall !== undefined && listCall.timeout === WORKTREE_LIST_TIMEOUT_MS,
      `#1396 (4) canary: branchHolders passes WORKTREE_LIST_TIMEOUT_MS (got ${String(listCall?.timeout)})`,
    );

    // And an unreadable listing is still `{ ok: false }`, not "no holders".
    const fail: ExecFn = async () => {
      throw new Error("fatal: failed to read worktree list");
    };
    const bad = await branchHolders(fail, "/repo", "feature/issue-9-x");
    assert(
      bad.ok === false && /failed to read/.test(bad.error),
      "(4) an unreadable listing returns the error, so the audit cannot read 'no holders'",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The residue pass takes the driver's CycleContext; the two fields it reads are
// the ones this test supplies. A local shim keeps the test honest about that
// surface instead of an unchecked `as unknown as` over the whole type.
type CycleContextShim = {
  repoRoot: string;
  issue: number;
  issues: number[];
  dirtyRootExempt?: readonly string[];
};

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #451 — canary: per-worktree diff reads must stay per-worktree.
 *
 * The worktree-isolation epic moves the repo root OFF the feature branch.
 * Once that lands, any verification or diff-fetch path that runs
 * `git diff HEAD` / `..HEAD` at `ctx.repoRoot` compares the mainline
 * against itself and passes unconditionally — the worst possible gate
 * failure mode, invisible in CI until the epic lands.
 *
 * `fetchDiff` (work-driver-diff.ts) is exempt by design: its `git diff
 * HEAD` is DELIBERATE pre-commit semantics — adversarial review runs
 * pre-commit, `cwd` is always a per-cycle worktree (or the documented
 * last-resort repoRoot fallback), and "working tree vs its own HEAD"
 * is exactly the uncommitted work to review. The defect this canary
 * guards is the SCOPE, not the command: a repo-root verification path
 * must name the branch it means (see readIntegratedDiff, which uses
 * `origin/<base>..origin/<branch>` and is the reference shape).
 *
 * Two assertions, both offline:
 *
 *   1. SOURCE SCAN — the verification and diff-fetch sources name every
 *      repo-root ref explicitly; the only bare `git diff HEAD` in
 *      work-driver-diff.ts is the documented per-worktree `fetchDiff`
 *      call, and the per-worktree `git diff HEAD -U0` fallback in
 *      work-driver-verify-develop.ts is bounded by a baseSha precondition.
 *
 *   2. LIVE SCOPE — in a real repo whose ROOT IS ON MAINLINE, an
 *      uncommitted change in a DETACHED worktree is exactly what
 *      `fetchDiff(worktree)` returns and exactly what `fetchDiff(root)`
 *      does NOT return. If a future refactor ever pointed a
 *      repo-root-scoped diff read at the wrong tree, this fixture
 *      catches it: the gate would see mainline-vs-mainline = empty and
 *      approve.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fetchDiff } from "../src/work-driver-diff.ts";
import { runBranchViaOpsDispatch } from "../src/work-driver-branch-ops.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.join(import.meta.dir, "..", "src");

// ---------------------------------------------------------------------------
// 1. Source scan — repo-root verification paths name their refs explicitly.
// ---------------------------------------------------------------------------

const readSrc = (name: string) => readFileSync(path.join(SRC, name), "utf8");

// work-driver-verify.ts — the commit-pr gates run at ctx.repoRoot.
{
  const src = readSrc("work-driver-verify.ts");
  assert(
    !/(^|\s)\.\.HEAD\b/.test(src),
    "work-driver-verify.ts: no bare `..HEAD` range in any verification command",
  );
  assert(
    !/git diff HEAD/.test(src),
    "work-driver-verify.ts: no unbased `git diff HEAD` (repo-root gates must name a branch)",
  );
}

// work-driver-diff.ts — the per-worktree fetchers.
{
  const src = readSrc("work-driver-diff.ts");
  // The ONLY bare `git diff HEAD` in CODE is fetchDiff's per-worktree call.
  // Doc comments also mention it, so strip comment lines before counting.
  const codeLines = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");
  const matches = codeLines.match(/git diff HEAD/g) ?? [];
  assert(
    matches.length === 1,
    `work-driver-diff.ts: exactly one bare \`git diff HEAD\` remains in code (the per-worktree fetchDiff call), found ${matches.length}`,
  );
  assert(
    src.includes("DELIBERATE pre-commit semantics"),
    "work-driver-diff.ts: fetchDiff documents its `git diff HEAD` as deliberate pre-commit semantics",
  );
  // The repo-root integrated read names both refs — the reference shape.
  assert(
    /git diff origin\/\$\{base\}\.\.origin\/\$\{branchName\}/.test(src),
    "work-driver-diff.ts: readIntegratedDiff names explicit refs (origin/<base>..origin/<branch>)",
  );
}

// work-driver-verify-develop.ts — the develop gate.
{
  const src = readSrc("work-driver-verify-develop.ts");
  // The skip-ratchet's bounded `git diff HEAD -U0` fallback (worktree cwd,
  // only when baseSha is absent) is legitimate — it is not a repo-root
  // gate. The assertion that matters: nothing in this file runs a
  // verification command at ctx.repoRoot against bare HEAD.
  assert(
    !/cwd:\s*ctx\.repoRoot[\s\S]{0,120}git diff HEAD|git diff HEAD[\s\S]{0,120}cwd:\s*ctx\.repoRoot/.test(
      src,
    ),
    "work-driver-verify-develop.ts: no bare `git diff HEAD` paired with a ctx.repoRoot cwd",
  );
}

// ---------------------------------------------------------------------------
// 2. Live scope — fetchDiff at repoRoot vs worktree, root ON MAINLINE.
// ---------------------------------------------------------------------------

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-diff-head-canary-"));
  try {
    // Fixture: repo root checked out on mainline; one detached worktree
    // with uncommitted work — the exact post-epic shape.
    const repo = path.join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
    await git(repo, ["config", "user.email", "canary@example.com"]);
    await git(repo, ["config", "user.name", "Canary"]);
    writeFileSync(path.join(repo, "src.txt"), "base\n");
    await git(repo, ["add", "src.txt"]);
    await git(repo, ["commit", "-q", "-m", "base"]);

    const wt = path.join(root, "wt");
    await git(repo, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);
    writeFileSync(path.join(wt, "src.txt"), "developer edit\n");

    // The worktree read sees the change...
    const wtDiff = await fetchDiff(wt);
    assert(
      wtDiff.includes("developer edit"),
      "live scope: fetchDiff(worktree) returns the uncommitted work",
    );
    // ...and the repo-root read does NOT — the mainline tree is clean.
    // A verification path that runs this at repoRoot post-epic would
    // review mainline-vs-mainline = "" and approve.
    const rootDiff = await fetchDiff(repo);
    assert(
      rootDiff === "",
      "live scope: fetchDiff(repoRoot-on-mainline) is empty — scoping the diff read to the worktree is what keeps the gate meaningful",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. N=1 ops fallback — a `## Worktrees` block in the reply must win over
//    the `{ default: repoRoot }` last resort, even for a single workstream.
// ---------------------------------------------------------------------------

async function branchOpsFixture(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-diff-head-ops-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "canary@example.com"]);
  await git(repo, ["config", "user.name", "Canary"]);
  writeFileSync(path.join(repo, "a.txt"), "x\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return dir;
}

async function main2() {
  const base = await branchOpsFixture();
  const dispatchResult = {
    role: "ops",
    ok: true,
    text: "branch: feature/issue-451-canary\n\n## Worktrees\n\n- default: " + base + "/wt\n",
    toolUses: [],
    ms: 1,
    exitCode: 0,
    transcriptPath: "/tmp/x.json",
  };
  const ctx = {
    pi: {} as ExtensionAPI,
    issue: 451,
    issues: [451],
    repoRoot: base,
    dispatchFn: async () => dispatchResult,
    verifyExecFn: async (cmd: string) =>
      cmd === "git rev-parse --abbrev-ref HEAD"
        ? { stdout: "feature/issue-451-canary\n" }
        : cmd === "git rev-parse HEAD"
          ? { stdout: "deadbeef00000000000000000000000000000000\n" }
          : { stdout: "" },
  } as unknown as DriverContext;

  // N=1 with a `## Worktrees` block: the recorded worktree is the reply's
  // path, NOT repoRoot (#451 — the fallback used to bypass parsing for N=1).
  const state = initialState(451, Date.now());
  const out = await runBranchViaOpsDispatch(ctx, state, ["default"], Date.now());
  assert(
    out.pipelineState.worktrees["default"] === base + "/wt",
    `ops fallback N=1: a ## Worktrees block in the reply is honoured (recorded ${out.pipelineState.worktrees["default"] ?? "nothing"}, expected the worktree, not repoRoot)`,
  );

  // N=1 without a block: the documented last resort still applies.
  const noBlock = { ...dispatchResult, text: "branch: feature/issue-451-canary\n\ndone.\n" };
  const ctx2 = { ...ctx, dispatchFn: async () => noBlock };
  const out2 = await runBranchViaOpsDispatch(ctx2, state, ["default"], Date.now());
  assert(
    out2.pipelineState.worktrees["default"] === base,
    "ops fallback N=1 without a ## Worktrees block: the documented last resort is { default: repoRoot }",
  );

  rmSync(base, { recursive: true, force: true });
}

await main();
await main2();

console.log(`\nexit ${exit}`);
process.exit(exit);

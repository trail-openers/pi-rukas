#!/usr/bin/env bun
/**
 * #1170 — an unreadable `git worktree list` during the branch step's sibling
 * scan REFUSES the cycle (step-failed:branch → handoff). It must never fall
 * through to the LLM ops fallback, which would create the worktree unscanned.
 * The refusal is a WorktreeScanError (not a DirtyWorktreeError: there is no
 * worktree path to name), and the sibling scan's fail-open contract for its
 * other callers is unchanged. Also pins the ref charset `assertSafeRef`
 * accepts (`_`, `+`) and rejects shell metacharacters.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { assertSafeRef } from "../src/worktree-loss.ts";
import {
  DirtyWorktreeError,
  type ExecFn,
  WorktreeScanError,
  findDirtySameIssueLeftover,
  scanWorktrees,
} from "../src/worktree.ts";
import { git, realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-sibling-"));
const TITLE = "sibling scan refusal";
const TITLE_ARTIFACT = path.join(root, "issue-title.txt");
writeFileSync(TITLE_ARTIFACT, `title: ${TITLE}\n`);

/** Every `git worktree list` fails with a git-style error; everything else is real. */
const unreadableListing: ExecFn = async (cmd, o) => {
  if (cmd.includes("worktree list")) throw new Error("git: unable to read worktree list");
  return realExec(cmd, o);
};

try {
  // ---- branch step with an unreadable worktree listing
  const originDir = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await git(root, ["init", "--bare", "--initial-branch=main", originDir]);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  let dispatches = 0;
  const execFn: ExecFn = async (cmd, o) => {
    if (cmd.startsWith("gh ")) return { stdout: "[]" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    return unreadableListing(cmd, o);
  };
  const ctx = {
    host: {} as DriverContext["host"],
    issue: 1170,
    issues: [1170],
    restart: true,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: async () => {
      dispatches++;
      return { role: "ops", ok: true, text: "noop", toolUses: [], ms: 0, exitCode: 0 };
    },
  } as unknown as DriverContext;
  const st = initialState(1170);
  st.pipelineState.issueBodyArtifact = TITLE_ARTIFACT;

  const out = await runBranch(ctx, st, 1000).catch((e) => {
    console.error(`runBranch threw: ${(e as Error).message}`);
    return undefined;
  });
  const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.cap === "step-failed:branch",
    "an unreadable sibling listing yields a step-failed:branch cap",
  );
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.nextStep === "handoff",
    "the refusal routes to handoff",
  );
  assert(dispatches === 0, "no LLM ops dispatch runs after the refusal (no unscanned creation)");
  assert(
    out?.pipelineState.plumbReports?.some((r) =>
      r.body.includes("unable to read worktree list"),
    ) === true,
    "the plumb report carries the git error",
  );

  // ---- the scan's own contracts (#1170)
  let scanErr: unknown;
  try {
    await findDirtySameIssueLeftover(unreadableListing, repo, "HEAD", "issue-1170", "issue-1170-x");
  } catch (e) {
    scanErr = e;
  }
  assert(
    scanErr instanceof WorktreeScanError && !(scanErr instanceof DirtyWorktreeError),
    "findDirtySameIssueLeftover: an unreadable listing throws WorktreeScanError, not DirtyWorktreeError",
  );
  assert(
    scanErr instanceof Error && scanErr.message.includes("unable to read worktree list"),
    "WorktreeScanError carries the git error",
  );
  const failOpen = await scanWorktrees(unreadableListing, repo, "HEAD", [".worktrees/issue-1170"]);
  assert(failOpen.length === 0, "scanWorktrees keeps its fail-open contract (no siblings)");

  // ---- ref charset
  for (const ok of ["fix/issue_12", "feature/a+b", "release/1.2.3", "feature/x-y@{1}"]) {
    let threw = false;
    try {
      assertSafeRef(ok);
    } catch {
      threw = true;
    }
    assert(!threw, `assertSafeRef accepts ${ok}`);
  }
  for (const bad of ["feature/x;rm -rf /", "a$(id)", "a`id`", "a b", "-x"]) {
    let threw = false;
    try {
      assertSafeRef(bad);
    } catch {
      threw = true;
    }
    assert(threw, `assertSafeRef rejects ${JSON.stringify(bad)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

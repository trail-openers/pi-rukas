#!/usr/bin/env bun
/**
 * AC2 (#2030) — the SECOND commit-pr of a cycle, on the field shape.
 *
 * Round 1 consolidated the develop worktree's commits onto the branch under
 * NEW SHAs; a lens-fix then landed on the tip rewriting a line those commits
 * also touch. The worktree still holds the original commits, so the second
 * round re-picks them: the pick's context no longer matches, the batch aborts,
 * `integrate()` reports `failure: "apply"`, and the mechanized step falls back
 * to the ops dispatch — which is how the field cycle spent its second
 * commit-pr. A commit whose patch is already on the branch must be skipped
 * instead, so this round consolidates and pushes.
 *
 * Offline: real git in temp dirs, a scripted `gh` (the harness of
 * test-commit-pr-second-round.ts), no network, no model.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp as realExec } from "../src/exec.ts";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { addLocalRemote, fixture, git } from "./helpers-integrate-pin-realgit.ts";
import { commandOf } from "./lib/argv-shell.ts";

const FILE = "test-AC2-second-commit-pr-repick.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL ${FILE}: ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "github";
process.env.PI_ENSEMBLE_VERIFY = "0";

const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-ac2-"));
const ISSUE = 2030;
const BRANCH = "feature/issue-2030-x";
const PR = 11;

const { repo, baseSha } = await fixture(root, "cycle");
await addLocalRemote(root, repo);
await git(repo, ["push", "-q", "-u", "origin", "main"]);
const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-default`);
await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);

const gh: string[] = [];
const exec: NonNullable<DriverContext["verifyExecFn"]> = async (raw, o) => {
  const cmd = commandOf(raw, o);
  if (!cmd.startsWith("gh ")) return realExec(raw, o);
  gh.push(cmd);
  if (cmd.startsWith("gh pr list")) return { stdout: JSON.stringify([{ number: PR }]) };
  if (cmd.startsWith("gh pr view"))
    return { stdout: JSON.stringify({ number: PR, state: "OPEN", headRefName: BRANCH }) };
  if (cmd.startsWith("gh repo view")) return { stdout: "main\n" };
  return { stdout: "" };
};
const ctx = { host: {}, repoRoot: repo, issue: ISSUE, verifyExecFn: exec } as unknown as DriverContext;
const commitIn = async (dir: string, file: string, body: string, msg: string) => {
  writeFileSync(path.join(dir, file), body);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", msg]);
};

// The driver serialises repoRoot writes through a lockfile that lives at
// `<repoRoot>/.git/pi-rukas-integration.lock`; the lock code creates the dir
// and a lock left by a crashed sibling cycle blocks the whole step, so the
// directory is part of the fixture, not an accident of it.
mkdirSync(path.join(repo, ".git"), { recursive: true });

// Round 1: the developer's two commits, consolidated and pushed by the driver.
await commitIn(wt, "note.txt", "alpha\nround-1\n", "developer: round 1");
await commitIn(wt, "note.txt", "alpha\nround-1\nround-2\n", "developer: round 2");
const dev = { ...initialState(ISSUE, 1000) };
const first = await mechanizedCommitPr(
  ctx,
  {
    ...dev,
    pipelineState: {
      ...dev.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      branchName: BRANCH,
      baseSha,
      worktrees: { default: wt },
    },
  },
  2000,
);
assert(first.ok === true, `round 1 consolidated and pushed (${first.ok ? "ok" : first.reason})`);

// The branch then gained a lens-fix on the tip that rewrote the same line.
// Round 1 left the branch as repoRoot's detached HEAD, not a local branch,
// so materialise it the way the lens-fix integrate path leaves it.
await git(repo, ["checkout", "-q", "-B", BRANCH]);
await commitIn(repo, "note.txt", "alpha\nlens rewrite\n", "fix(lens): round 1 review findings");
await git(repo, ["push", "-q", "origin", BRANCH]);

// Round 2 (the CI-fix shape): nothing new in the worktree but its original
// commits, which the branch already carries patch-for-patch.
const afterFirst: WorkState = {
  ...(first.ok ? first.state : dev),
  pipelineState: { ...(first.ok ? first.state.pipelineState : dev.pipelineState), prNumber: PR, ciRetryCount: 1 },
};
gh.length = 0;
const second = await mechanizedCommitPr(ctx, afterFirst, 5000);
assert(
  second.ok === true,
  `the second commit-pr does not fall back to the ops dispatch (${second.ok ? "ok" : `${second.fallbackCause}: ${second.reason.slice(0, 120)}`})`,
);
assert(
  second.ok === false && second.fallbackCause === undefined,
  `the failure reached the step as an apply conflict the cause classifier could not name today (fallbackCause ${JSON.stringify(second.ok ? undefined : second.fallbackCause)})`,
);
assert(
  !gh.some((g) => g.startsWith("gh pr create")),
  "…and no replacement PR is opened for the branch that already has one",
);
await git(repo, ["fetch", "-q", "origin"]);
const remoteNote = await git(repo, ["show", `refs/remotes/origin/${BRANCH}:note.txt`]).then(
  (r) => r.stdout,
  () => "",
);
assert(
  remoteNote.includes("lens rewrite"),
  `…and the lens-fix content is still what origin/<branch> holds (${JSON.stringify(remoteNote)})`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);

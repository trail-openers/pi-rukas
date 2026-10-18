#!/usr/bin/env bun
/**
 * #1468 — the `--continue-pr` guard helpers against REAL git: a bare origin,
 * the driver's clone and a second clone that plays the other pusher.
 *
 * continuedHeadMoved: false when the remote head equals P and after our own
 * unpushed commit; true after a foreign push, a deleted branch and a rewind
 * below P. continuePrDevelopProblems: flags MERGE_HEAD, unmerged paths, a
 * leftover marker, a rebased H and a missing M, and does NOT flag a real
 * `=======` line that main brought into a conflicted path.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  continuePrDevelopProblems,
  continuePrNote,
  continuedHeadMoved,
  headMovedCap,
  mergeInProgress,
} from "../src/work-driver-continue-pr-guard.ts";
import type { ContinuedPr } from "../src/work-driver-continue-pr-state.ts";
import { initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

gitTestEnv();
const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** argv-only exec: every helper under test must use the argv form. */
const realExec: ExecFn = async (cmd, o) => {
  if (!o?.argv) throw new Error(`shell-form call refused by the fixture: ${cmd}`);
  const { stdout } = await execFileP(cmd, o.argv, {
    cwd: o.cwd,
    env: o.env ?? process.env,
    maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", args, { cwd })).stdout.trim();

async function initRepo(dir: string) {
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
}

function cpOf(headSha: string, mainlineSha: string, conflictPaths: string[]): ContinuedPr {
  return {
    number: 42,
    headRefName: "feat",
    headSha,
    mainlineSha,
    conflictPaths,
    matchedBy: "branch",
  };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1468-guard-"));
try {
  // ---- continuedHeadMoved ------------------------------------------------
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await initRepo(repo);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "origin", "main"]);
  await git(repo, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(path.join(repo, "a.txt"), "base\nfeat\n");
  await git(repo, ["commit", "-q", "-am", "feat"]);
  const p = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["push", "-q", "origin", "feat"]);
  await git(repo, ["checkout", "-q", "main"]);
  await execFileP("git", ["clone", "-q", origin, other]);
  await initRepo(other);

  const ps = { continuedPr: cpOf(p, base, []) };
  assert(
    (await continuedHeadMoved(realExec, repo, ps)) === undefined,
    "head-moved: false when the remote head equals P",
  );

  await git(repo, ["checkout", "-q", "feat"]);
  writeFileSync(path.join(repo, "b.txt"), "ours\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "ours"]);
  await git(repo, ["checkout", "-q", "main"]);
  assert(
    (await continuedHeadMoved(realExec, repo, ps)) === undefined,
    "head-moved: false after our own unpushed local commit",
  );

  await git(other, ["checkout", "-q", "feat"]);
  writeFileSync(path.join(other, "c.txt"), "foreign\n");
  await git(other, ["add", "."]);
  await git(other, ["commit", "-q", "-m", "foreign"]);
  await git(other, ["push", "-q", "origin", "feat"]);
  const foreign = await continuedHeadMoved(realExec, repo, ps);
  assert(foreign !== undefined, "head-moved: true after a push from the second clone");

  await git(other, ["push", "-q", "origin", "--delete", "feat"]);
  const deleted = await continuedHeadMoved(realExec, repo, ps);
  assert(deleted !== undefined, "head-moved: true when the branch is deleted");

  await git(other, ["push", "-q", "origin", `${base}:refs/heads/feat`]);
  const rewound = await continuedHeadMoved(realExec, repo, ps);
  assert(
    rewound !== undefined,
    "head-moved: true after a rewind below P, though the remote is an ancestor of local",
  );

  await git(repo, ["remote", "set-url", "origin", path.join(root, "missing.git")]);
  assert(
    (await continuedHeadMoved(realExec, repo, ps)) === undefined,
    "head-moved: an unreadable ls-remote does not cap",
  );
  assert(
    (await continuedHeadMoved(realExec, repo, {})) === undefined,
    "head-moved: no continuedPr, no check",
  );

  const capped = headMovedCap(initialState(42, 1), "remote moved", "lens-review");
  const last = capped.eventLog.at(-1);
  const report = capped.eventLog.at(-2);
  assert(
    last?.kind === "cap-hit" &&
      last.cap === "continue-pr-head-moved" &&
      last.nextStep === "handoff" &&
      last.evidence === "remote moved",
    "headMovedCap: cap-hit continue-pr-head-moved routes to handoff",
  );
  assert(
    report?.kind === "plumb-report" && report.step === "lens-review",
    "headMovedCap: a plumb-report precedes the cap",
  );

  // ---- continuePrDevelopProblems -----------------------------------------
  const dev = path.join(root, "dev");
  await execFileP("git", ["init", "-q", "--initial-branch=main", dev]);
  await initRepo(dev);
  const lines = ["1", "2", "3", "4", "5", "6", "7", "8"];
  writeFileSync(path.join(dev, "a.txt"), `${lines.join("\n")}\n`);
  await git(dev, ["add", "."]);
  await git(dev, ["commit", "-q", "-m", "base"]);
  await git(dev, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(path.join(dev, "a.txt"), `1\nfeat2\n${lines.slice(2).join("\n")}\n`);
  await git(dev, ["commit", "-q", "-am", "feat"]);
  const P = await git(dev, ["rev-parse", "HEAD"]);
  await git(dev, ["checkout", "-q", "main"]);
  // main's own `=======` line lands in the conflicted path.
  writeFileSync(path.join(dev, "a.txt"), `1\nmain2\n${lines.slice(2).join("\n")}\n=======\n`);
  await git(dev, ["commit", "-q", "-am", "main"]);
  const M = await git(dev, ["rev-parse", "HEAD"]);
  const wt = path.join(root, "wt");
  await git(dev, ["worktree", "add", "-q", "--detach", wt, P]);
  const cp = cpOf(P, M, ["a.txt"]);

  assert(!(await mergeInProgress(realExec, wt)), "mergeInProgress: false before the merge");
  await execFileP("git", ["merge", "--no-ff", "--no-edit", M], { cwd: wt }).catch(() => {});
  assert(await mergeInProgress(realExec, wt), "mergeInProgress: true while MERGE_HEAD exists");
  const mid = await continuePrDevelopProblems(realExec, wt, cp);
  assert(
    mid.some((s) => /MERGE_HEAD/.test(s)),
    "develop problems: MERGE_HEAD flagged",
  );
  assert(
    mid.some((s) => /unmerged/.test(s) && s.includes("a.txt")),
    "develop problems: unmerged paths flagged",
  );

  // Commit with the markers still in the file.
  await git(wt, ["add", "a.txt"]);
  await git(wt, ["commit", "-q", "--no-edit"]);
  assert(!(await mergeInProgress(realExec, wt)), "mergeInProgress: false after the commit");
  const leftover = await continuePrDevelopProblems(realExec, wt, cp);
  assert(
    leftover.some((s) => /conflict marker/.test(s) && s.includes("a.txt:2")),
    "develop problems: a leftover marker is flagged",
  );
  assert(
    !leftover.some((s) => s.includes("a.txt:13")),
    "develop problems: main's ======= line is not among the leftover markers",
  );

  // A proper resolution keeps main's ======= line and flags nothing.
  await git(wt, ["reset", "-q", "--hard", P]);
  await execFileP("git", ["merge", "--no-ff", "--no-edit", M], { cwd: wt }).catch(() => {});
  writeFileSync(path.join(wt, "a.txt"), `1\nfeat2\nmain2\n${lines.slice(2).join("\n")}\n=======\n`);
  await git(wt, ["add", "a.txt"]);
  await git(wt, ["commit", "-q", "--no-edit"]);
  const clean = await continuePrDevelopProblems(realExec, wt, cp);
  assert(
    clean.length === 0,
    `develop problems: a real ======= from main in a conflicted path is not flagged (${clean.join("; ")})`,
  );

  // Rebased H: the PR's change replayed on M, so P is not on the first-parent chain.
  await git(wt, ["checkout", "-q", "--detach", M]);
  writeFileSync(path.join(wt, "a.txt"), `1\nfeat2\n${lines.slice(2).join("\n")}\n=======\n`);
  await git(wt, ["commit", "-q", "-am", "rebased"]);
  const rebased = await continuePrDevelopProblems(realExec, wt, cp);
  assert(
    rebased.some((s) => /first-parent/.test(s)),
    "develop problems: a rebased H (P not first-parent) is flagged",
  );

  // Missing M: H is P plus a commit, no merge.
  await git(wt, ["checkout", "-q", "--detach", P]);
  writeFileSync(path.join(wt, "d.txt"), "more\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "more"]);
  const noMerge = await continuePrDevelopProblems(realExec, wt, cp);
  assert(
    noMerge.some((s) => /not an ancestor/.test(s)),
    "develop problems: M not an ancestor of H is flagged",
  );

  // ---- continuePrNote ----------------------------------------------------
  const note = continuePrNote(cp);
  assert(
    note.includes("#42") && note.includes("feat") && note.includes("a.txt"),
    "note: names the PR, the branch and the conflicted paths",
  );
  assert(
    /push/.test(note) && /merge --abort/.test(note) && /rebase/.test(note),
    "note: says not to push, abort the merge or rebase",
  );
  assert(continuePrNote(cpOf(P, M, [])).includes("#42"), "note: renders with no conflicts");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);

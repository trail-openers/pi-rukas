#!/usr/bin/env bun
/**
 * A git read that FAILED is not a read that returned zero.
 *
 * The cycle this pins: a host ran out of processes at handoff time, so every
 * `git` the handoff issued died with `/bin/sh: 1: Cannot fork`. Each reader
 * swallowed the error into its empty default, and the handoff told the
 * operator — over five reviewed commits sitting on the retained worktree's
 * detached HEAD — "no committed work ahead of the base — nothing to
 * consolidate", "(no branch was created)" and "0 file(s) modified".
 *
 * Asserted here: the consolidation reason, the snapshot and all three
 * renderers distinguish "could not read" from "read, and empty", and the
 * unread case names each worktree with the commands that list its commits
 * and attach them to a branch.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consolidateWorktreesToBranch,
  countAheadOfBase,
} from "../src/work-driver-handoff-consolidate.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { captureCommittedWork } from "../src/work-driver-handoff-post.ts";
import { captureWorktreeSnapshot } from "../src/work-driver-handoff-snapshot.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";
const WT = `${REPO}/.worktrees/issue-63-default`;
const BRANCH = "feature/issue-63-mobile";
const BASE = "2fec7a31aaaabbbbccccddddeeeeffff00001111";
/** The failure the real cycle hit, verbatim. */
const cannotFork = async (): Promise<{ stdout: string }> => {
  throw Object.assign(new Error("Command failed: git status --porcelain"), {
    stderr: "/bin/sh: 1: Cannot fork\n",
    code: 2,
  });
};

function parkedState(snapshot: Record<string, unknown>): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 63,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "adversarial",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: BRANCH,
      baseSha: BASE,
      worktrees: { default: WT },
      handoffSnapshot: {
        modifiedFiles: [],
        unstagedCount: 0,
        stagedCount: 0,
        branchExists: false,
        branchPushed: false,
        headSha: "",
        capturedAt: 1000,
        ...snapshot,
      },
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "integration-verify-failed",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  } as unknown as WorkState;
}

// 1. countAheadOfBase reports the failed read instead of folding it into 0.
{
  const r = await countAheadOfBase(cannotFork, REPO, BASE, { default: WT });
  assert(r.total === 0, "countAheadOfBase: a failed read still moves nothing");
  assert(
    r.unreadable.length === 1 && r.unreadable[0].includes("Cannot fork"),
    `countAheadOfBase: the failed read is reported with its error (got ${JSON.stringify(r.unreadable)})`,
  );
  const ok = await countAheadOfBase(async () => ({ stdout: "0\n" }), REPO, BASE, { default: WT });
  assert(ok.unreadable.length === 0, "countAheadOfBase: a real zero is not reported as unreadable");
}

// 2. The consolidation reason does not claim there is no committed work.
{
  const state = parkedState({});
  const out = await consolidateWorktreesToBranch(
    { repoRoot: REPO, issue: 63, scratchDir: `${REPO}/tmp/issue-63` },
    state,
    cannotFork,
  );
  assert(out.ok === false, "consolidate: a failed read does not consolidate");
  assert(
    !/no committed work ahead of the base/.test(out.reason ?? ""),
    `consolidate: a failed read is not reported as "no committed work" (got: ${out.reason})`,
  );
  assert(
    /could not read/.test(out.reason ?? "") && /Cannot fork/.test(out.reason ?? ""),
    "consolidate: the reason names the read failure and its error",
  );
  const empty = await consolidateWorktreesToBranch(
    { repoRoot: REPO, issue: 63, scratchDir: `${REPO}/tmp/issue-63` },
    state,
    async () => ({ stdout: "0\n" }),
  );
  assert(
    /no committed work ahead of the base/.test(empty.reason ?? ""),
    "consolidate: a real zero keeps the existing reason",
  );
}

// 3. captureCommittedWork records the failed read on the snapshot.
{
  const snap = parkedState({}).pipelineState.handoffSnapshot;
  if (!snap) throw new Error("fixture");
  await captureCommittedWork(snap, REPO, { baseSha: BASE, worktrees: { default: WT } }, cannotFork);
  assert(snap.committedWork === undefined, "captureCommittedWork: no committed work is invented");
  assert(
    snap.unreadable?.length === 1 && snap.unreadable[0].includes(WT),
    "captureCommittedWork: the unread worktree is recorded in snapshot.unreadable",
  );
}

// 4. captureWorktreeSnapshot against real git: a directory git cannot run in
//    is unreadable; a healthy repo whose branch was simply never created is not.
{
  const tmp = mkdtempSync(join(tmpdir(), "pi-unreadable-"));
  try {
    const gone = join(tmp, "gone");
    const bad = await captureWorktreeSnapshot(gone, BRANCH, { default: join(tmp, "gone-wt") });
    assert(
      (bad.unreadable?.length ?? 0) >= 3,
      `snapshot: failed status / HEAD / branch reads are all recorded (got ${JSON.stringify(bad.unreadable)})`,
    );
    const repo = join(tmp, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"],
      { cwd: repo },
    );
    const good = await captureWorktreeSnapshot(repo, BRANCH, undefined);
    assert(
      good.branchExists === false,
      "snapshot: a branch that was never created reads as absent",
    );
    assert(
      good.unreadable === undefined,
      `snapshot: an absent branch in a healthy repo is NOT unreadable (got ${JSON.stringify(good.unreadable)})`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 5. Every surface says "not read" and names the worktree's recovery commands.
{
  const unread = parkedState({ unreadable: [`git status in ${WT}: /bin/sh: 1: Cannot fork`] });
  const surfaces: Record<string, string> = {
    chat: renderHandoffUserMessage(unread, REPO, `${REPO}/tmp/issue-63`),
    markdown: renderHandoffMarkdown(unread),
    status: renderTerminalStatus(unread, REPO),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert(/NOT READ/.test(text), `${name}: says the worktree state was not read`);
    assert(/Cannot fork/.test(text), `${name}: carries the read error`);
    assert(
      text.includes(`git -C ${WT} log --oneline ${BASE.slice(0, 12)}..HEAD`),
      `${name}: prints the command listing the worktree's commits ahead of the base`,
    );
    assert(
      text.includes(`git -C ${WT} branch ${BRANCH} HEAD`),
      `${name}: prints the command attaching the detached HEAD to the branch`,
    );
  }
  assert(
    !/0 file\(s\) modified/.test(surfaces.chat),
    'chat: no "0 file(s) modified" over unread state',
  );
  assert(
    !/no branch was created/.test(surfaces.chat),
    'chat: no "(no branch was created)" over an unread branch probe',
  );

  // The read-and-empty case is unchanged.
  const read = parkedState({});
  const chat = renderHandoffUserMessage(read, REPO, `${REPO}/tmp/issue-63`);
  assert(
    /0 file\(s\) modified/.test(chat),
    "chat: a snapshot that WAS read still prints its count",
  );
  assert(/no branch was created/.test(chat), "chat: a read, absent branch still says so");
  assert(!/NOT READ/.test(chat), "chat: nothing is flagged unread when every read succeeded");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

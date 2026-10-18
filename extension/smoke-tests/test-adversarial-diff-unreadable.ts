#!/usr/bin/env bun
/**
 * #1634 — the adversarial gate never approves a worktree diff it could not
 * read. `fetchDiff` returned "" for a failed read, the #286 empty-diff skip
 * treated "" as a pass, and a cycle whose worktree git could not read ("not a
 * git repository") was approved unseen. The read is now `readWorktreeDiff`, a
 * discriminated result (the #384 `readIntegratedDiff` shape), and an
 * unreadable diff halts with `adversarial-diff-unreadable`.
 *
 * Also: with a baseSha, an empty `baseSha..HEAD` (nothing committed) is
 * confirmed against the working tree, so tracked changes left uncommitted are
 * reviewed instead of skipped as empty.
 *
 * Offline: real git in temp dirs, the adversarial loop is mocked.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { readWorktreeDiff } from "../src/work-driver-diff.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileP("git", args, { cwd });

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkApproved(): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "APPROVED",
    toolUses: [],
    ms: 1,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    roundsExecuted: 1,
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  };
}

/** A repo with one committed file; returns its path and the commit SHA. */
async function mkRepo(): Promise<{ dir: string; sha: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "adv-diff-unreadable-repo-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-q", "-m", "init");
  const { stdout } = await git(dir, "rev-parse", "HEAD");
  return { dir, sha: stdout.trim() };
}

function seed(worktrees: Record<string, string>, baseSha?: string): WorkState {
  const s = initialState(1634, 1000);
  s.pipelineState = {
    ...s.pipelineState,
    currentStep: "adversarial",
    lastCompletedStep: "develop",
    worktrees,
    ...(baseSha ? { baseSha } : {}),
    workstreams: Object.fromEntries(
      Object.keys(worktrees).map((id) => [id, { id, scope: id, paths: [], outOfScope: [] }]),
    ),
  };
  return s;
}

const tmp: string[] = [];
try {
  const repo = await mkRepo();
  tmp.push(repo.dir);
  const notGit = mkdtempSync(path.join(tmpdir(), "adv-diff-unreadable-nogit-"));
  tmp.push(notGit);

  // 1. The read itself.
  const unread = await readWorktreeDiff(notGit);
  assert(!unread.ok, "readWorktreeDiff: a directory git cannot read is NOT ok (not empty)");
  assert(
    !unread.ok && /not a git repository/i.test(unread.reason),
    "readWorktreeDiff: the reason carries git's own error",
  );
  const clean = await readWorktreeDiff(repo.dir, repo.sha);
  assert(clean.ok && clean.diff === "", "readWorktreeDiff: a clean readable tree is ok and empty");
  writeFileSync(path.join(repo.dir, "a.txt"), "one\ntwo uncommitted\n");
  const uncommitted = await readWorktreeDiff(repo.dir, repo.sha);
  assert(
    uncommitted.ok && uncommitted.diff.includes("two uncommitted"),
    "readWorktreeDiff: HEAD at baseSha with a tracked uncommitted change returns that change",
  );

  // 2. N=1: an unreadable worktree halts — no review, no skip, no approval.
  {
    let calls = 0;
    const ctx = {
      repoRoot: repo.dir,
      issue: 1634,
      adversarialLoopFn: async () => {
        calls++;
        return mkApproved();
      },
    } as unknown as DriverContext;
    const out = await runAdversarial(ctx, seed({ default: notGit }), Date.now());
    const kinds = out.eventLog.map((e) => e.kind);
    assert(calls === 0, "N=1 unreadable: no reviewer dispatched");
    assert(!kinds.includes("adversarial-approved"), "N=1 unreadable: NOT approved");
    assert(
      !kinds.includes("adversarial-skipped-empty-diff"),
      "N=1 unreadable: not recorded as an empty-diff skip",
    );
    const cap = out.eventLog.at(-1);
    assert(
      cap?.kind === "cap-hit" && cap.cap === "adversarial-diff-unreadable",
      "N=1 unreadable: the step ends on cap-hit adversarial-diff-unreadable",
    );
    assert(
      cap?.kind === "cap-hit" && (cap.evidence ?? "").includes(notGit),
      "N=1 unreadable: the cap evidence names the worktree and git's error",
    );
    assert(
      /not a git repository/i.test(explainCap("adversarial-diff-unreadable", out)),
      "N=1 unreadable: the handoff explanation carries git's error",
    );
  }

  // 3. N=2: one readable workstream with real work, one unreadable — still halts.
  {
    const ctx = {
      repoRoot: repo.dir,
      issue: 1634,
      adversarialLoopFn: async () => mkApproved(),
    } as unknown as DriverContext;
    const out = await runAdversarial(
      ctx,
      seed({ good: repo.dir, bad: notGit }, repo.sha),
      Date.now(),
    );
    const kinds = out.eventLog.map((e) => e.kind);
    assert(!kinds.includes("adversarial-approved"), "N=2 one unreadable: NOT approved");
    const cap = out.eventLog.at(-1);
    assert(
      cap?.kind === "cap-hit" &&
        cap.cap === "adversarial-diff-unreadable" &&
        (cap.evidence ?? "").includes("[bad]"),
      "N=2 one unreadable: halts with the unreadable workstream named",
    );
  }

  // 4. Uncommitted tracked work at HEAD==baseSha is reviewed, not skipped.
  {
    let seen = "";
    const ctx = {
      repoRoot: repo.dir,
      issue: 1634,
      adversarialLoopFn: async (p: { diff: string }) => {
        seen = p.diff;
        return mkApproved();
      },
    } as unknown as DriverContext;
    const out = await runAdversarial(ctx, seed({ default: repo.dir }, repo.sha), Date.now());
    assert(seen.includes("two uncommitted"), "uncommitted work: the reviewer sees the change");
    assert(
      !out.eventLog.some((e) => e.kind === "adversarial-skipped-empty-diff"),
      "uncommitted work: not skipped as an empty diff",
    );
  }
} finally {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
}

process.exit(exit);

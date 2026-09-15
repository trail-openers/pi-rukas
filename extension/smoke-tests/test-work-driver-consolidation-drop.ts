#!/usr/bin/env bun
/**
 * #728 task-d — strict-subset regression test for the #723 consolidation
 * drop, driven against REAL git.
 *
 * Pre-#728, integrate cherry-picked only the worktree's HEAD SHA, so a
 * multi-commit workstream staged the last commit's files and silently
 * dropped the earlier ones. Post-#728, `cherryPickWorkstreams` walks the
 * full `baseSha..HEAD` range — the ONLY remaining drop reachable in that
 * code is the range-read FALLBACK: `rev-list` throws → the pick degrades
 * to HEAD-only for that workstream, and the completeness measurement
 * (`measureConsolidationCompleteness`) names what did not land.
 *
 * Four cases:
 *   1. CAP-WIRING  — a `consolidationCompleteness` record with non-empty
 *                    `droppedPaths` turned into a cap-hit by
 *                    `raiseConsolidationIncompleteCap`:
 *                    `cap === "consolidation-incomplete"` and
 *                    `nextStep === "handoff"`.
 *   2. POSITIVE    — the fallback, driven directly through
 *                    `cherryPickWorkstreams` with an execFn that throws ONLY
 *                    for the `rev-list` range read: the entry carries
 *                    `rangeReadError`, and the completeness measurement
 *                    names exactly the missing file.
 *   3. NEGATIVE    — same fixture, a file that nets to zero across the
 *                    workstream's commits (added then deleted) must NOT
 *                    appear in droppedPaths: proof the intended set is the
 *                    CUMULATIVE diff, not a per-commit union.
 *   4. CARDINALITY — the multi-commit workstream appears EXACTLY ONCE in
 *                    `orchestrateCherryPick`'s `cherryApplied` (the pre-#728
 *                    double-listing regression).
 *
 * Deliberately NOT named `*-live.ts` — no Pi children, no tokens; it forks
 * git only and must run in the offline pre-push gate.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cherryPickWorkstreams, orchestrateCherryPick } from "../src/work-driver-cherry-pick.ts";
import { raiseConsolidationIncompleteCap } from "../src/work-driver-commit-completeness.ts";
import { measureConsolidationCompleteness } from "../src/work-driver-completeness.ts";
import { initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Hard assertion: this file must pass test-file-size-limit.ts (500-line
// hard cap, 300 ideal).
{
  const self = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "test-work-driver-consolidation-drop.ts",
  );
  const lines = readFileSync(self, "utf8").split("\n").length;
  assert(lines <= 500, `file size gate: this file is ${lines} lines (hard cap 500, ideal 300)`);
}

/** Real shell exec, matching the driver's ExecFn contract. */
// `sh -c`, matching promisify(exec)'s default. NOT a login shell: `-l`
// sources profile files that may cd, which would silently run git elsewhere.
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

/**
 * Like realExec, but throws ONLY for the cherry-pick range read
 * (`git rev-list --reverse --first-parent …`). Every other command —
 * including the plain `git rev-parse HEAD` the fallback itself issues —
 * behaves normally, so the fallback fires and completes.
 */
const brokenRangeExec: ExecFn = async (cmd, o) => {
  if (cmd.includes("git rev-list --reverse")) {
    throw new Error("simulated rev-list failure (range read)");
  }
  return realExec(cmd, o);
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

interface Fixture {
  root: string;
  repo: string;
  scratch: string;
  branchName: string;
  baseSha: string;
  wt: string;
  headSha: string;
}

/**
 * One shared fixture (POSITIVE / NEGATIVE / CARDINALITY are the same
 * workstream shape): a bare origin + clone, and a worktree detached at the
 * base with a TWO-commit workstream:
 *   commit1: adds early.ts  (this is the file the #723 incident dropped)
 *   commit2: adds late.ts
 * The integration branch is created lazily BY THE PICKS (a `--no-commit`
 * cherry-pick auto-creates it at the pick commit's parent, i.e. the base —
 * the worktree does NOT check out the branch first, so nothing pre-lands).
 */
async function makeFixture(tag: string): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), `pi-ens-drop-${tag}-`));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const scratch = path.join(root, "scratch");
  mkdirSync(scratch, { recursive: true });

  await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  const { stdout: baseSha } = await git(repo, ["rev-parse", "HEAD"]);

  // Worktree detached at the base — exactly the always-worktree shape.
  const wt = path.join(root, "wt");
  await git(repo, ["worktree", "add", "--detach", wt, baseSha.trim()]);

  // The multi-commit workstream (the #723 shape): two commits, two files.
  writeFileSync(path.join(wt, "early.ts"), "early content\n");
  await git(wt, ["add", "early.ts"]);
  await git(wt, ["commit", "-q", "-m", "add early.ts"]);
  writeFileSync(path.join(wt, "late.ts"), "late content\n");
  await git(wt, ["add", "late.ts"]);
  await git(wt, ["commit", "-q", "-m", "add late.ts"]);
  const { stdout: headShaOut } = await git(wt, ["rev-parse", "HEAD"]);

  return {
    root,
    repo,
    scratch,
    branchName: `issue-736-${tag}`,
    baseSha: baseSha.trim(),
    wt,
    headSha: headShaOut.trim(),
  };
}

const f = await makeFixture("shared");
try {
  // ---- 1. CAP-WIRING -----------------------------------------------------
  // A WorkState carrying the POSITIVE case's completeness record must
  // produce the consolidation-incomplete cap-hit routed to handoff.
  {
    const s = initialState(736, Date.now());
    s.pipelineState.consolidationCompleteness = {
      intended: ["early.ts", "late.ts"],
      landed: ["late.ts"],
      droppedPaths: ["early.ts"],
    };
    const out = raiseConsolidationIncompleteCap(s);
    const last = out.eventLog[out.eventLog.length - 1];
    assert(last.kind === "cap-hit", "cap-wiring: the appended event is a cap-hit");
    if (last.kind === "cap-hit") {
      assert(
        last.cap === "consolidation-incomplete",
        "cap-wiring: cap is 'consolidation-incomplete'",
      );
      assert(last.nextStep === "handoff", "cap-wiring: nextStep is 'handoff'");
    }
  }

  // ---- 2. POSITIVE (the only reachable drop: range-read fallback) --------
  // The execFn throws only for `rev-list --reverse`, so the pick degrades
  // to HEAD-only (staging late.ts only) while the workstream's cumulative
  // diff (intended) is {early.ts, late.ts}.
  {
    const entries = await cherryPickWorkstreams(brokenRangeExec, {
      repoRoot: f.repo,
      branchName: f.branchName,
      worktrees: { ws: f.wt },
      commitShas: {},
      scratchDir: f.scratch,
      baseSha: f.baseSha,
    });
    const wsEntries = entries.filter((e) => e.sha === f.headSha);
    assert(
      wsEntries.length === 1 && wsEntries[0].status === "cherry-picked",
      `positive: the fallback picked the worktree HEAD as a single entry (entries: ${JSON.stringify(entries)})`,
    );
    assert(
      wsEntries[0]?.rangeReadError?.workstreamId === "ws",
      "positive: the entry records the range-read failure (the fallback fired)",
    );

    // The completeness measurement — the same one orchestrateCherryPick
    // runs after the pick — must name exactly the missing file.
    const completeness = await measureConsolidationCompleteness(realExec, {
      repoRoot: f.repo,
      worktrees: { ws: f.wt },
      baseSha: f.baseSha,
      committedIds: ["ws"],
    });
    assert(completeness.checkError === undefined, "positive: the completeness measurement ran");
    assert(
      completeness.droppedPaths.length > 0,
      `positive: droppedPaths is non-empty (intended=${JSON.stringify(completeness.intended)} landed=${JSON.stringify(completeness.landed)})`,
    );
    assert(
      JSON.stringify(completeness.droppedPaths) === JSON.stringify(["early.ts"]),
      "positive: droppedPaths names EXACTLY the missing file (early.ts)",
    );

    // ---- 3. NEGATIVE (cumulative-diff control) ----------------------------
    // A file that nets to zero across the workstream's commits must not be
    // dropped: the intended set is the CUMULATIVE diff, not per-commit.
    writeFileSync(path.join(f.wt, "temp.txt"), "temp\n");
    await git(f.wt, ["add", "temp.txt"]);
    await git(f.wt, ["commit", "-q", "-m", "add temp.txt"]);
    await git(f.wt, ["rm", "temp.txt"]);
    await git(f.wt, ["commit", "-q", "-m", "delete temp.txt"]);

    await cherryPickWorkstreams(brokenRangeExec, {
      repoRoot: f.repo,
      branchName: f.branchName,
      worktrees: { ws: f.wt },
      commitShas: {},
      scratchDir: f.scratch,
      baseSha: f.baseSha,
    });
    const negative = await measureConsolidationCompleteness(realExec, {
      repoRoot: f.repo,
      worktrees: { ws: f.wt },
      baseSha: f.baseSha,
      committedIds: ["ws"],
    });
    assert(
      !negative.droppedPaths.includes("temp.txt"),
      "negative: a net-zero file (added then deleted) is NOT dropped — cumulative semantics",
    );
    assert(
      negative.droppedPaths.includes("early.ts"),
      "negative: the genuinely dropped file is STILL named alongside it",
    );
  }

  // ---- 4. CARDINALITY ------------------------------------------------------
  // A multi-commit workstream must appear EXACTLY ONCE in
  // orchestrateCherryPick's cherryApplied (the pre-#728 double-listing).
  // Full range read works here (realExec): both commits land.
  {
    const orch = await orchestrateCherryPick(realExec, {
      repoRoot: f.repo,
      branchName: f.branchName,
      worktrees: { ids: ["ws"], worktrees: { ws: f.wt }, commitShas: {} },
      baseSha: f.baseSha,
      scratchDir: f.scratch,
    });
    assert(
      JSON.stringify(orch.cherryApplied) === JSON.stringify(["ws"]),
      `cardinality: the multi-commit workstream appears exactly ONCE in cherryApplied (${JSON.stringify(orch.cherryApplied)})`,
    );
    // The picks are `--no-commit` (staged, not committed) — the landed
    // evidence lives on the integration branch plus the index, exactly what
    // measureConsolidationCompleteness compares.
    const { stdout: branchDiff } = await git(f.repo, ["diff", "--name-only", `${f.baseSha}..HEAD`]);
    const { stdout: indexDiff } = await git(f.repo, ["diff", "--cached", "--name-only"]);
    const landedText = branchDiff + indexDiff;
    assert(
      landedText.includes("early.ts") && landedText.includes("late.ts"),
      "cardinality: both files of the range landed (no strict-subset drop)",
    );
    const completeness = await measureConsolidationCompleteness(realExec, {
      repoRoot: f.repo,
      worktrees: { ws: f.wt },
      baseSha: f.baseSha,
      committedIds: ["ws"],
    });
    assert(
      completeness.droppedPaths.length === 0,
      `cardinality: the full-range pick is complete (dropped: ${JSON.stringify(completeness.droppedPaths)})`,
    );
  }
} finally {
  rmSync(f.root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

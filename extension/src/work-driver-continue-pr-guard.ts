/**
 * work-driver-continue-pr-guard — #1468: the checks that keep `--continue-pr`
 * from overwriting someone else's push or pushing an unfinished merge, and
 * the developer note for the continued worktree. Every git call is argv: the
 * head name comes from the PR.
 *
 * P is the PR head at the start, M the mainline commit merged in, H the
 * worktree HEAD after develop.
 */

import { trace } from "./trace.ts";
import type { ContinuedPr } from "./work-driver-continue-pr-state.ts";
import { runNetGit } from "./work-driver-net-git.ts";
import { type WorkState, type WorkStep, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const LS_REMOTE_TIMEOUT_MS = 30_000;

async function gitOk(execFn: ExecFn, cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFn("git", { argv: args, cwd });
    return true;
  } catch {
    return false;
  }
}

async function gitOut(execFn: ExecFn, cwd: string, args: string[]): Promise<string> {
  return (await execFn("git", { argv: args, cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/**
 * Evidence that the PR head moved under us, or undefined. R is the remote
 * head. It moved when R is gone, when R is not an ancestor of our local
 * branch (an object we do not have is a foreign commit), or when P is not an
 * ancestor of R (a rewind). Comparing with the local branch, not a stored
 * SHA, means our own pushes need no state update. An unreadable ls-remote
 * is traced and does not cap.
 */
export async function continuedHeadMoved(
  execFn: ExecFn,
  repoRoot: string,
  ps: { continuedPr?: ContinuedPr },
): Promise<string | undefined> {
  const cp = ps.continuedPr;
  if (!cp) return undefined;
  const ref = `refs/heads/${cp.headRefName}`;
  let listing: string;
  try {
    listing = (
      await runNetGit(execFn, "git", {
        argv: ["ls-remote", "origin", ref],
        cwd: repoRoot,
        timeoutMs: LS_REMOTE_TIMEOUT_MS,
      })
    ).stdout;
  } catch (err) {
    trace(
      `work-driver: continue-pr head check could not read origin ${ref} (not capping): ${(err as Error).message?.slice(0, 200)}`,
    );
    return undefined;
  }
  const remote = listing
    .split("\n")
    .map((l) => l.split("\t"))
    .find(([, name]) => name?.trim() === ref)?.[0]
    ?.trim();
  if (!remote) return `origin ${ref} is gone (PR #${cp.number} head was ${cp.headSha})`;
  if (!(await gitOk(execFn, repoRoot, ["merge-base", "--is-ancestor", remote, ref]))) {
    return `origin ${ref} is at ${remote}, which is not on the local branch: someone else pushed`;
  }
  if (!(await gitOk(execFn, repoRoot, ["merge-base", "--is-ancestor", cp.headSha, remote]))) {
    return `origin ${ref} is at ${remote}, behind the PR head ${cp.headSha}: the branch was rewound`;
  }
  return undefined;
}

/** Stop the cycle because the PR head moved: a report, then the cap. */
export function headMovedCap(state: WorkState, evidence: string, step: WorkStep): WorkState {
  const next = appendEvent(state, {
    kind: "plumb-report",
    at: Date.now(),
    step,
    role: "driver",
    body: `Continue-PR stopped before ${step}: the PR head moved. ${evidence}. Nothing was pushed over it.`,
  });
  return appendEvent(next, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "continue-pr-head-moved",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
  });
}

/**
 * Whether a merge is in progress in `cwd`. `rev-parse -q --verify` exits 1
 * when MERGE_HEAD is absent; any other failure counts as in progress, so a
 * caller that would commit skips instead.
 */
export async function mergeInProgress(execFn: ExecFn, cwd: string): Promise<boolean> {
  try {
    await execFn("git", { argv: ["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd });
    return true;
  } catch (err) {
    const e = err as { code?: unknown; signal?: unknown; killed?: unknown };
    if ((e.code === 1 || e.code === "1") && !e.signal && !e.killed) return false;
    trace(`work-driver: could not read MERGE_HEAD in ${cwd}, treating it as present`);
    return true;
  }
}

/** `path:lineno` of each leftover conflict marker `git diff --check` reports. */
async function markerLines(
  execFn: ExecFn,
  cwd: string,
  from: string,
  to: string,
  paths: string[],
): Promise<Set<string>> {
  let out: string;
  try {
    out = await gitOut(execFn, cwd, ["diff", "--check", from, to, "--", ...paths]);
  } catch (err) {
    // `diff --check` exits non-zero when it finds anything; its report is on stdout.
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string" || stdout === "") throw err;
    out = stdout;
  }
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^(.+:\d+): leftover conflict marker$/.exec(line);
    if (m?.[1]) found.add(m[1]);
  }
  return found;
}

/**
 * What stops the continued worktree from being pushed, empty when nothing
 * does. A marker counts only when it is new against both parents, so a real
 * `=======` line from either side is not refused.
 */
export async function continuePrDevelopProblems(
  execFn: ExecFn,
  worktree: string,
  cp: ContinuedPr,
): Promise<string[]> {
  const problems: string[] = [];
  const P = cp.headSha;
  const M = cp.mainlineSha;
  try {
    if (await mergeInProgress(execFn, worktree)) {
      problems.push("the merge is not finished (MERGE_HEAD is present): commit it");
    }
    const unmerged = (
      await gitOut(execFn, worktree, ["diff", "--name-only", "--diff-filter=U"])
    ).trim();
    if (unmerged) problems.push(`unmerged paths remain: ${unmerged.split("\n").join(", ")}`);
    const H = (await gitOut(execFn, worktree, ["rev-parse", "HEAD"])).trim();
    if (cp.conflictPaths.length > 0) {
      const vsP = await markerLines(execFn, worktree, P, H, cp.conflictPaths);
      const vsM = await markerLines(execFn, worktree, M, H, cp.conflictPaths);
      const both = [...vsP].filter((l) => vsM.has(l));
      if (both.length > 0) problems.push(`leftover conflict markers at ${both.join(", ")}`);
    }
    if (!(await gitOk(execFn, worktree, ["merge-base", "--is-ancestor", M, H]))) {
      problems.push(`the mainline commit ${M} is not an ancestor of HEAD ${H}: merge it in`);
    }
    const firstParents = (await gitOut(execFn, worktree, ["rev-list", "--first-parent", H])).split(
      "\n",
    );
    if (!firstParents.includes(P)) {
      problems.push(
        `the PR head ${P} is not on HEAD's first-parent chain: the branch was rebased or reset`,
      );
    }
  } catch (err) {
    problems.push(`could not check the merge: ${(err as Error).message?.slice(0, 200)}`);
  }
  return problems;
}

/** The develop note for a continued PR's worktree. */
export function continuePrNote(cp: ContinuedPr): string {
  const conflicts =
    cp.conflictPaths.length > 0
      ? `Task 1: resolve the conflict markers in ${cp.conflictPaths.join(", ")}, \`git add\` them, then run \`git commit --no-edit\` to finish the merge.`
      : "The merge was clean; there are no conflicts to resolve.";
  return [
    `This worktree is the head of PR #${cp.number} (branch ${cp.headRefName}) with the mainline commit ${cp.mainlineSha} merged in.`,
    'Ignore the description of the worktree as "detached at base".',
    conflicts,
    "Never run `git merge --abort`, rebase, reset or push.",
    "Make the gate green. Do no other work: the PR already implements the issue.",
  ].join("\n");
}

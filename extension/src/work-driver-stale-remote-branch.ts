/**
 * work-driver-stale-remote-branch — the branch step stops when the remote already
 * holds a branch of this issue that this cycle did not push.
 *
 * The cycle's branch name is deterministic (`branchSlug`), so a cycle of an issue
 * that was worked before meets the earlier cycle's `origin/feature/issue-<n>-…`.
 * Its first push is plain and is refused as non-fast-forward, after a whole
 * develop phase. pi-rukas cannot tell an abandoned branch of its own from someone
 * else's work, so it does not build on it, replace it or delete it: it stops
 * before develop with `stale-remote-branch` and names the branch, its tip and,
 * when the commit is already local, its author and date.
 *
 * Checked: the cycle's own branch name, `feature/issue-<n>` and every
 * `feature/issue-<n>-*`, in one `git ls-remote --heads origin`. A branch whose tip
 * is the sha this cycle recorded in `tmp/issue-<n>/pushed.json` is this cycle's
 * own earlier push, which `--restart` may replace by lease, so it does not stop.
 * Nor does a branch whose tip is already in the cycle's base (a merged branch
 * left on the remote): the first push on top of it is a fast-forward. A tip the
 * clone does not hold is not in the base, so it stops.
 * A branch with an open PR never reaches here: the PR preflight before it stops
 * on `existing-pr-detected`, and `--continue-pr` takes its own branch path.
 *
 * Fails open, like the PR preflight beside it: an unreadable remote proceeds
 * with a trace. The check guards no destructive act; the push itself stays the
 * backstop, and its refusal is classed as a moved branch.
 */

import { trace } from "./trace.ts";
import { runNetGit } from "./work-driver-net-git.ts";
import { pushedShaOf } from "./work-driver-push-lease.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const PROBE_TIMEOUT_MS = 30_000;

/** One remote branch of the issue that this cycle did not push. */
export interface StaleRemoteBranch {
  branch: string;
  sha: string;
  /** `<author>, <date>` when the commit is in the local object store. */
  who?: string;
}

/** Whether `branch` is the cycle's own name or one of `feature/issue-<issue>[-*]`. */
function issueBranch(branch: string, issue: number, own: string): boolean {
  const stem = `feature/issue-${issue}`;
  return branch === own || branch === stem || branch.startsWith(`${stem}-`);
}

async function authorOf(execFn: ExecFn, repoRoot: string, sha: string) {
  const out = await execFn("git", {
    cwd: repoRoot,
    argv: ["log", "-1", "--format=%an, %cI", sha],
    maxBuffer: 64 * 1024,
  }).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  return out.length > 0 ? out : undefined;
}

/** Whether `sha` is in `base`'s history; a commit not held locally is not. */
async function inBase(execFn: ExecFn, repoRoot: string, sha: string, base: string | undefined) {
  if (!base) return false;
  return execFn("git", {
    cwd: repoRoot,
    argv: ["merge-base", "--is-ancestor", sha, base],
    maxBuffer: 64 * 1024,
  }).then(
    () => true,
    () => false,
  );
}

/**
 * The remote branches of `issue` that this cycle did not push. Empty when there
 * are none, and when the remote could not be read (see the header).
 */
export async function staleRemoteBranches(
  execFn: ExecFn,
  repoRoot: string,
  scratchDir: string,
  issue: number,
  branchName: string,
  baseSha?: string,
): Promise<StaleRemoteBranch[]> {
  let stdout: string;
  try {
    ({ stdout } = await runNetGit(execFn, "git", {
      cwd: repoRoot,
      argv: [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/feature/issue-${issue}*`,
        `refs/heads/${branchName}`,
      ],
      timeoutMs: PROBE_TIMEOUT_MS,
    }));
  } catch (err) {
    trace(
      `work-driver: remote branch check for #${issue} could not read origin — proceeding: ${String(err).slice(0, 160)}`,
    );
    return [];
  }
  const found = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha === undefined || ref === undefined || !/^[0-9a-f]{40}$/.test(sha)) continue;
    if (!ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (issueBranch(branch, issue, branchName)) found.set(branch, sha);
  }
  const stale: StaleRemoteBranch[] = [];
  for (const [branch, sha] of found) {
    if ((await pushedShaOf(scratchDir, branch)) === sha) continue;
    if (await inBase(execFn, repoRoot, sha, baseSha)) continue;
    const who = await authorOf(execFn, repoRoot, sha);
    stale.push({ branch, sha, ...(who ? { who } : {}) });
  }
  return stale;
}

/** The cap's evidence: each branch, its tip, and who made it when known. */
export function staleBranchEvidence(stale: readonly StaleRemoteBranch[]): string {
  const rows = stale.map(
    (s) => `origin/${s.branch} at ${s.sha.slice(0, 12)}${s.who ? ` (${s.who})` : ""}`,
  );
  return `the remote already has ${rows.join("; ")}, which this cycle did not push`;
}

/** The branch step's stop: a step-started and the cap-hit, routed to the handoff. */
export function staleRemoteBranchCap(
  state: WorkState,
  stale: readonly StaleRemoteBranch[],
  now: number,
): WorkState {
  const started = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
    { kind: "step-started", step: "branch", at: now },
  );
  return appendEvent(started, {
    kind: "cap-hit",
    at: now,
    cap: "stale-remote-branch",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: staleBranchEvidence(stale),
  });
}

/** The handoff's sentence for the cap, naming the branch and the steps. */
export function explainStaleRemoteBranch(evidence: string | undefined, issue: number): string {
  const what =
    evidence ?? "the remote already has a branch of this issue that this cycle did not push";
  return `the branch step stopped before any development: ${what}. Its first push would be refused as non-fast-forward, so nothing was built, pushed or deleted. Look at the branch (\`git fetch origin\`, then \`git log origin/<branch>\`). If it is an abandoned earlier attempt, delete it on the remote (\`git push origin --delete <branch>\`) and re-run \`/work ${issue}\`. If it holds work you want, open or update its PR by hand`;
}

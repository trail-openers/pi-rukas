/**
 * work-driver-branch-holder — who has `refs/heads/<branchName>` checked out.
 *
 * Split from `work-driver-integrate-worktree.ts` (file-size gate): the
 * integrate-worktree module owns creating and re-creating the driver's tree;
 * these two functions answer a different question — which trees HOLD the
 * branch — and are consumed by the post-dispatch audit as well as the
 * creation path. Splitting them is the natural seam, not an arbitrary cut.
 *
 * `repoRootHoldsBranch` deliberately bypasses the caller's ExecFn: repoRoot
 * is the one holder `git worktree list` refuses to report, so a test fake's
 * short-circuit must not be able to exculpate it. Read the two fail-open /
 * fail-closed branches before changing the probe.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { type ExecFn, WORKTREE_LIST_TIMEOUT_MS } from "./worktree.ts";

/**
 * Whether the MAIN working tree (repoRoot) currently holds the branch.
 * `git worktree list --porcelain` never lists the main tree, so the
 * branch-holder audit and the repoRoot-detach path can both see it only
 * via this direct probe of its own checkout.
 *
 * Error classes are distinguished, because "cannot answer" and "holds the
 * branch" have OPPOSITE consequences:
 *  - "not a git repository" (stderr) or ENOENT (the directory is gone) →
 *    FALSE. A directory that is not a repository cannot hold a branch, so
 *    reading it as holding would halt clean cycles with a spurious
 *    `integration-worktree-violation` (the #861 shape: the fallback audit
 *    probed a temp repoRoot that is not a repo and the fail-closed default
 *    read it as the offending holder).
 *  - ANY OTHER git error (a lock, permission, timeout) → TRUE (fail closed
 *    with a trace): there is a repo there we simply could not read, and a
 *    possibly-holding tree must not be exculpated (the #861 defect: a
 *    failing probe read as "does not hold").
 */
export async function repoRootHoldsBranch(repoRoot: string, branchName: string): Promise<boolean> {
  if (!branchName) return false;
  // The probe ALWAYS runs through the production exec seam (not execFn):
  // the repoRoot holder is the one `git worktree list` refuses to report,
  // and a test fake's `git symbolic-ref` short-circuit must not be able to
  // make the probe fail and exculpate that holder. The primary probe is
  // `symbolic-ref`; a DETACHED HEAD returns non-empty output but the wrong
  // ref, so a detached root reads as not-holding. A truly unreadable
  // symbolic-ref (not a clean empty) cannot be distinguished from a
  // detached HEAD via that command, so the `git status` fallback
  // disambiguates: its "## branch..." line carries the checkout name.
  const probe = async (cmd: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execp(cmd, {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      });
      return stdout;
    } catch (err) {
      const e = err as Error & { code?: string; stderr?: string };
      const detail = e.stderr ?? e.message ?? "";
      if (/not a git repository/i.test(detail) || e.code === "ENOENT") {
        // A directory that is not a repository (or is gone) cannot hold a
        // branch — the fail-closed default would halt clean cycles over
        // what is actually nothing (the #861 spurious-violation shape).
        trace(
          `work-driver: repoRoot holder probe for ${branchName} — ${repoRoot} is not a git repository (or is gone) — it cannot hold the branch`,
        );
        return "not-a-repo";
      }
      trace(
        `work-driver: repoRoot holder probe failed for ${branchName} — treating as possibly holding (fail closed): ${String(detail).slice(0, 200)}`,
      );
      return undefined;
    }
  };
  const refProbe = await probe("git symbolic-ref --quiet --short HEAD");
  if (refProbe === "not-a-repo") return false;
  if (refProbe !== undefined) return refProbe.trim() === branchName;
  const statusOut = await probe("git status --porcelain=v1 -b --untracked-files=normal");
  if (statusOut === "not-a-repo") return false;
  if (statusOut === undefined) return true;
  const line = statusOut.split("\n")[0] ?? "";
  const m = /^## ([^\s.]+)/.exec(line);
  return m !== null && m[1] === branchName;
}

/**
 * The branch-holder audit (decision (4)). Parses `git worktree list
 * --porcelain` and REALPATH-resolves every listed path (the macOS
 * /private/var shape — #753) and returns the worktrees whose `branch`
 * attribute is `refs/heads/<branchName>`. The driver's post-dispatch audit
 * requires that list to contain only the integrate worktree (or be empty);
 * any other holder halts the cycle. Sibling worktree HEADs are NOT
 * compared — concurrent cycles legitimately commit in their own worktrees.
 *
 * Unreadable list → `{ ok: false, error }` (the audit halts rather than reading
 * "no holders"; the PR-verification gates still run the executed-evidence
 * checks).
 *
 * #1396 (round 3) — the listing carries `WORKTREE_LIST_TIMEOUT_MS`, the bound
 * every other `git worktree list` in the harness runs with (see the timeout
 * policy in `worktree.ts`'s header). Without it, a listing that hung here held
 * the caller — the post-dispatch audit, in the integration path — for as long
 * as git took, and the `{ ok: false }` branch was only reachable via an error
 * git chose to report.
 */
export type BranchHoldersResult = { ok: true; holders: string[] } | { ok: false; error: string };

export async function branchHolders(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<BranchHoldersResult> {
  let list: string;
  try {
    ({ stdout: list } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      timeout: WORKTREE_LIST_TIMEOUT_MS,
    }));
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
  const lines = list.split("\n");
  const holders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]?.trim() ?? "";
    if (!l.startsWith("worktree ")) continue;
    // The worktree line is followed by its attribute lines (HEAD, branch,
    // detached) up to the next `worktree` marker — the branch we care about
    // is in the `branch` line, so walk forward (the #654 sweep pattern).
    let j = i + 1;
    let found = false;
    while (j < lines.length) {
      const attr = lines[j]?.trim() ?? "";
      if (attr.startsWith("worktree ")) break;
      if (attr === `branch refs/heads/${branchName}`) {
        holders.push(lines[i]?.slice("worktree ".length).trim() ?? "");
        found = true;
        break;
      }
      j++;
    }
    if (found) i = j;
  }
  return { ok: true, holders };
}

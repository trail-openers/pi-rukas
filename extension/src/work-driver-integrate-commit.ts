/**
 * work-driver-integrate-commit — "is this commit already on the integration
 * branch?", the one read `integrate()` performs before cherry-picking. Split from
 * `work-driver-integrate.ts` for the AGENTS.md §12 500-line cap; it is a pure git
 * read with no dependency on the consolidation itself.
 */

/** The executor shape this read needs — a subset of `ExecFn`. */
type ReadExec = (
  cmd: string,
  o?: { cwd?: string; maxBuffer?: number },
) => Promise<{ stdout: string }>;

/**
 * Check if a commit is already on the integration branch: either it is in
 * the branch's history, or its tree is the branch head's tree (the commit
 * is effectively already applied even if the SHA differs, e.g. from a
 * resume). The tree test alone only ever recognises the commit AT the tip:
 * a second lens-fix round starts on the integrated tip, so its
 * `baseSha..HEAD` range holds every commit already on the branch, and
 * re-picking the ones behind the tip conflicts with the fixes made since.
 * Returns `false` on any read error (optimistic: cherry-pick if we can't
 * verify).
 */
export async function isCommitOnBranch(
  execFn: ReadExec,
  repoRoot: string,
  branchName: string,
  sha: string,
): Promise<boolean> {
  try {
    // `0` commits of `sha`'s history missing from HEAD = `sha` is in it. A
    // count, not `merge-base --is-ancestor`'s exit status, so an executor
    // that answers nothing is never read as "already there".
    const { stdout: missing } = await execFn(`git rev-list --count HEAD..${sha}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (missing.trim() === "0") return true;
  } catch {
    // Unreadable — fall through to the tree test.
  }
  try {
    const commitTreeHash = await treeOf(execFn, repoRoot, sha);
    if (commitTreeHash === null) return false;
    const headTreeHash = await treeOf(execFn, repoRoot, "HEAD");
    return headTreeHash !== null && commitTreeHash === headTreeHash;
  } catch {
    return false;
  }
}

/** The tree hash `rev` names, or `null` when git says nothing readable. */
async function treeOf(execFn: ReadExec, repoRoot: string, rev: string): Promise<string | null> {
  const { stdout } = await execFn(`git cat-file -p ${rev}`, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
  });
  return stdout.match(/^tree ([0-9a-f]{40})$/m)?.[1] ?? null;
}

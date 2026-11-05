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
    if (headTreeHash !== null && commitTreeHash === headTreeHash) return true;
  } catch {
    return false;
  }
  // Neither of the above sees a commit that landed on the branch under a
  // DIFFERENT SHA — the consolidation writes its own commit, so the next
  // round's range holds the worktree's originals again. Patch-equivalence is
  // the only read that does, and it reads the whole branch, not just the tip.
  return patchOnBranch(execFn, repoRoot, branchName, sha);
}

/**
 * Patch-id equivalence against the branch, decided the way `git cherry`
 * decides it: the branch's commits are reduced to their `git patch-id
 * --stable` ids and compared with this commit's own. `git cherry` itself is
 * not usable here — it drops every commit whose parent is reachable from
 * HEAD, which is exactly the worktree range this batch walks (a detached
 * worktree shares its base with the branch), so it reports a landed patch as
 * `+`. A commit with no patch is not "already on the branch": it has no
 * content for the branch to hold, so it falls through to the pick. So does
 * any commit whose patch-id cannot be read — the pick is the optimistic
 * answer, and a conflict it causes is what the caller reports.
 */
async function patchOnBranch(
  execFn: ReadExec,
  repoRoot: string,
  branchName: string,
  sha: string,
): Promise<boolean> {
  const own = await patchIdOf(execFn, repoRoot, sha);
  if (own === undefined) return false;
  let branchShas: string[];
  try {
    const { stdout } = await execFn(
      `git rev-list --reverse --no-merges ${JSON.stringify(branchName)} ^${JSON.stringify(sha)}^`,
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    branchShas = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{7,}$/.test(l));
  } catch {
    return false;
  }
  for (const candidate of branchShas) {
    if ((await patchIdOf(execFn, repoRoot, candidate)) === own) return true;
  }
  return false;
}

/**
 * `git patch-id --stable` over the commit's own diff — the same construction
 * `review-patch-identity.ts` records for the review ledger, applied to one
 * commit. `undefined` for an empty patch and for a read git refused or
 * answered oddly; the two are not distinguishable here and both mean "no
 * equivalence proven".
 */
async function patchIdOf(
  execFn: ReadExec,
  repoRoot: string,
  sha: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFn(
      `git diff ${JSON.stringify(sha)}^ ${JSON.stringify(sha)} | git patch-id --stable`,
      { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
    );
    // git prints `<id> <path>` per file, or one `<id> <sha>` line when the
    // stream carried no diff at all; a bare newline is an empty patch.
    return stdout.trim().split(/\s+/)[0]?.trim() || undefined;
  } catch {
    return undefined;
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

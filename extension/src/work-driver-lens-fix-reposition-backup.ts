/**
 * work-driver-lens-fix-reposition-backup — #981 (task-b) — the two small
 * git helpers the round-2+ lens-fix reposition guard needs to PARK safely:
 * backing the worktree up to a backup ref, and enumerating the commits it
 * holds beyond the branch tip.
 *
 * Split from work-driver-lens-fix-commit.ts for the AGENTS.md §12 500-line
 * gate. The backup ref namespacing and the enumeration are the two pieces
 * of the guard that touch git in a way the gate (fetch / status /
 * merge-base / ff-merge) does not.
 */
import { trace } from "./trace.ts";
import { hardenedGitArgv } from "./work-driver-fix-pass-strays.ts";
import type { RepositionResult } from "./work-driver-lens-fix-reposition-gate.ts";
import { GIT_TIMEOUT_MS, isAncestor } from "./work-driver-lens-fix-reposition-queries.ts";
import type { ExecFn } from "./worktree.ts";

/** Where the backups live, one subtree per issue. */
const LENS_FIX_BACKUP_NAMESPACE = "refs/pi-rukas/lens-fix-backup";

/**
 * #981 — move the worktree's current HEAD to a backup ref so unlanded /
 * divergent commits are preserved but never dispatched on. The ref is
 * `<namespace>/issue-<N>/<n>`: keyed on the issue so the merged step can find
 * it whatever the title became, and numbered one past the highest existing
 * backup so no round reuses a name. The write is create-only (an empty old
 * value), so a name that exists anyway fails instead of overwriting the
 * earlier backup. Returns the ref name, or `undefined` when the backup
 * could not be created (the caller still parks — the backup is a safety
 * net, not the gate), plus the git error's first line when creation failed
 * (surfaced in the park detail — a silent backup failure left the operator
 * no way to tell which git call died).
 */
export async function backupLensFixTree(
  execFn: ExecFn,
  tree: string,
  issues: number[],
): Promise<{ ref?: string; error?: string }> {
  const prefix = `${LENS_FIX_BACKUP_NAMESPACE}/issue-${issues[0]}/`;
  try {
    const { stdout } = await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      // #1882 lens round 2 — every git call in this module runs through
      // `hardenedGitArgv`: the worktree is child-writable, so a
      // `core.fsmonitor` script or a hook dropped into `.git/hooks` by the
      // fixer would otherwise run as part of the driver's own `update-ref`
      // / `checkout` / `merge`, in the parent, against a tree the fixer
      // controls.
      argv: hardenedGitArgv(["rev-parse", "HEAD"]),
    });
    const sha = stdout.trim();
    const listed = await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      argv: hardenedGitArgv(["for-each-ref", "--format=%(refname)", prefix]),
    });
    let n = 1;
    for (const name of listed.stdout.split("\n")) {
      const k = Number(name.trim().slice(prefix.length));
      if (name.startsWith(prefix) && Number.isInteger(k) && k >= n) n = k + 1;
    }
    const ref = `${prefix}${n}`;
    await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      argv: hardenedGitArgv(["update-ref", ref, sha, ""]),
    });
    trace(`lens-fix-reposition: backed up worktree to ${ref} (${sha.slice(0, 12)})`);
    return { ref };
  } catch (e) {
    // Surface the git error's first line (≤200 chars) so the caller's park
    // detail can name WHY the backup failed — the ref itself was never
    // created, so only the error is carried (never a bogus ref).
    const first = (
      (e as Error & { stderr?: string }).stderr ??
      (e as Error).message ??
      "unknown error"
    )
      .toString()
      .split("\n")[0];
    const raw = (first ?? "unknown error").slice(0, 200);
    trace(`lens-fix-reposition: backup ref creation failed: ${raw}`);
    return { ref: undefined, error: raw };
  }
}

/**
 * #981 — enumerate the worktree's commits not on the branch tip (for the
 * unlanded / diverged detail). Empty array when the enumeration itself
 * fails (the caller renders "(unreadable)" for an empty list).
 */
export async function enumerateUnlanded(
  execFn: ExecFn,
  tree: string,
  tipSha: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: hardenedGitArgv(["rev-list", `${tipSha}..HEAD`]),
    });
    return stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * #981 — the cherry-failed fallback: `git cherry` itself failed against
 * the tip, so the tree is untrustworthy — back it up and park as
 * `unlanded` (the tip is an ancestor of the tree) or `diverged` (it is
 * not). Lives here with the other backup helpers (the gate's 500-line
 * limit); it is the terminal branch of
 * {@link repositionLensFixWorktree}'s fallback path.
 */
export async function parkCherryFailedTree(
  execFn: ExecFn,
  tree: string,
  issues: number[],
  tipSha: string,
): Promise<RepositionResult> {
  const backup = await backupLensFixTree(execFn, tree, issues);
  const aheadShas = await enumerateUnlanded(execFn, tree, tipSha);
  // #981: the ancestry probe must distinguish "git says not an ancestor"
  // (exit 1 → diverged) from "git could not answer" (any other failure →
  // git-failed, fail closed). A git error used to be read as `diverged`,
  // which parked the tree with the wrong reason and no git error in the
  // detail; it now parks as `git-failed` with the error.
  const ancestry = await isAncestor(execFn, tree, tipSha, "HEAD");
  if ("error" in ancestry) {
    const detail = `git cherry could not be run against tip ${tipSha.slice(0, 12)} AND the ancestry probe failed — treating the tree as unverified: ${aheadShas.join(", ") || "(unreadable)"}${backup.ref === undefined && backup.error ? ` (backup ref could not be created: ${backup.error})` : ""}`;
    trace(`lens-fix-reposition: git-failed: ${detail}`);
    return {
      kind: "git-failed",
      detail,
      ...(backup.ref ? { backupRef: backup.ref } : {}),
    };
  }
  const kind: "unlanded" | "diverged" = ancestry.isAncestor ? "unlanded" : "diverged";
  const detail = `git cherry could not be run against tip ${tipSha.slice(0, 12)} — treating ${aheadShas.length} ahead commit(s) as unverified: ${aheadShas.join(", ") || "(unreadable)"}${backup.ref === undefined && backup.error ? ` (backup ref could not be created: ${backup.error})` : ""}`;
  trace(`lens-fix-reposition: ${kind}: ${detail}`);
  return {
    kind,
    detail,
    ...(backup.ref ? { backupRef: backup.ref } : {}),
    aheadShas,
  };
}

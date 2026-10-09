import { trace } from "./trace.ts";
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
import { branchSlug } from "./work-driver-branch-mechanized.ts";
import type { RepositionResult } from "./work-driver-lens-fix-reposition-gate.ts";
import { GIT_TIMEOUT_MS, isAncestor } from "./work-driver-lens-fix-reposition-queries.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * #981 — move the worktree's current HEAD to a backup ref so unlanded /
 * divergent commits are preserved but never dispatched on. The ref is
 * namespaced per branch slug + timestamp so a later round does not clobber
 * an earlier backup. Returns the ref name, or `undefined` when the backup
 * could not be created (the caller still parks — the backup is a safety
 * net, not the gate), plus the git error's first line when creation failed
 * (surfaced in the park detail — a silent backup failure left the operator
 * no way to tell which git call died).
 */
export async function backupLensFixTree(
  execFn: ExecFn,
  tree: string,
  branchName: string,
  issues: number[],
  issueTitle: string | undefined,
): Promise<{ ref?: string; error?: string }> {
  const slug = branchSlug(issues, issueTitle).replace(/^feature\//, "");
  const ts = new Date().toISOString().replace(/[.:-]/g, "-").slice(0, 19);
  const ref = `refs/pi-rukas/lens-fix-backup/${slug}/${ts}`;
  try {
    // #981 lens MEDIUM: argv form — the branch slug (and issue title) is
    // data, not a shell command; the argv form prevents a shell re-parse.
    const { stdout } = await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: ["rev-parse", "HEAD"],
    });
    const sha = stdout.trim();
    await execFn("git", { cwd: tree, timeout: GIT_TIMEOUT_MS, argv: ["update-ref", ref, sha] });
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
      argv: ["rev-list", `${tipSha}..HEAD`],
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
  branchName: string,
  issues: number[],
  issueTitle: string | undefined,
  tipSha: string,
): Promise<RepositionResult> {
  const backup = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
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

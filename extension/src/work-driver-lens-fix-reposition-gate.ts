/**
 * work-driver-lens-fix-reposition-gate — #981 (task-b) — the round-2+
 * lens-fix reposition gate.
 *
 * The round-2+ fix must build on the branch tip, which may have advanced by
 * a cherry-pick of a previous round's work. This gate moves the worktree
 * onto the freshly-fetched branch so the fixer never dispatches onto a
 * stale base. It is a GATE, not best-effort: the fixer is dispatched only
 * when the worktree is verified at the branch tip (`already-at-tip` /
 * `repositioned`). Anything else — a dirty tree, a clean tree holding
 * unlanded round-1 work, or a truly diverged tree — returns a failure kind
 * so the caller parks the fix loop (a `lens-fix-reposition` cap-hit)
 * rather than dispatching a fix onto a base it cannot trust. An unlanded /
 * diverged tree is moved to a backup ref first so nothing is destroyed.
 *
 * Split from work-driver-lens-fix-commit.ts for the AGENTS.md §12 500-line
 * gate. The small backup + enumeration helpers live in
 * work-driver-lens-fix-reposition-backup.ts.
 */
import { trace } from "./trace.ts";
import { backupLensFixTree, enumerateUnlanded } from "./work-driver-lens-fix-reposition-backup.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The outcome of the round-2+ reposition gate.
 *
 * - `already-at-tip` — the worktree is clean and at the branch tip; nothing
 *   moved. The round-1 shape (round 1 never advanced the branch, or the
 *   tree is already current).
 * - `repositioned` — the tree was clean and BEHIND the tip; it was
 *   fast-forwarded to the tip. This is the #978 shape (branch advanced by a
 *   round-1 cherry-pick, tree still at the old base) and is the safe
 *   fast-forward path only.
 * - `dirty` — uncommitted changes present; the fixer is NOT dispatched
 *   (it would build on a half-edited tree). Nothing was moved or stashed.
 * - `unlanded` — the worktree is clean and BEHIND the tip but holds commits
 *   the tip does not (e.g. a previous round's commit that was never
 *   integrated). A fast-forward would DESTROY that work, so the tree is
 *   moved to a backup ref and the cycle parks. `backupRef` names it.
 * - `diverged` — the worktree holds commits the tip does not and is NOT
 *   behind it either (the tip is not an ancestor of the tree): the tree and
 *   the branch have genuinely split. The tree is moved to a backup ref and
 *   the cycle parks. `backupRef` names it.
 * - `git-failed` — a git probe or the backup ref itself failed; detail
 *   carries the git output. `backupRef` is present when the backup was
 *   created before the failure.
 */
export type RepositionResult =
  | { kind: "already-at-tip"; tipSha: string }
  | { kind: "repositioned"; fromSha: string; tipSha: string }
  | { kind: "dirty"; detail: string }
  | { kind: "unlanded"; detail: string; backupRef?: string; aheadShas?: string[] }
  | { kind: "diverged"; detail: string; backupRef?: string; aheadShas?: string[] }
  | { kind: "git-failed"; detail: string; backupRef?: string };

const TRACE_PREFIX = "lens-fix-reposition";

/**
 * #981 — move the lens-fix worktree onto the freshly-fetched branch tip
 * BEFORE the round-2+ fixer dispatch. See {@link RepositionResult} for the
 * outcome kinds; only the two success kinds are safe to dispatch on.
 *
 * The guard is deliberately conservative: it fast-forwards ONLY a CLEAN
 * worktree that is strictly BEHIND the tip. Anything else — a dirty tree,
 * or a clean tree whose history does not sit below the tip (round-1 work
 * unlanded, or true divergence) — moves the tree to a backup ref (when it
 * can) and returns a failure kind so the caller parks rather than
 * dispatching a fix onto a base it cannot trust.
 */
export async function repositionLensFixWorktree(
  execFn: ExecFn,
  tree: string,
  branchName: string,
  issues: number[],
  issueTitle: string | undefined,
): Promise<RepositionResult> {
  // 1. Fetch the branch tip. A fetch failure means the tip cannot be
  //    trusted; park rather than guess. `git fetch` writes to stderr on
  //    success, so the absence of a throw is the success signal.
  let tipSha: string;
  try {
    await execFn(`git fetch origin ${JSON.stringify(branchName)} --quiet`, {
      cwd: tree,
      maxBuffer: 64 * 1024,
    });
    const tip = await execFn(
      `git rev-parse --verify ${JSON.stringify(`origin/${branchName}`)}`, // #919: branch name is data
      { cwd: tree, maxBuffer: 64 * 1024 },
    );
    tipSha = tip.stdout.trim();
  } catch (e) {
    const detail = `could not fetch/resolve origin/${branchName} (tip unknown): ${e}`;
    trace(`${TRACE_PREFIX}: ${detail}`);
    return { kind: "git-failed", detail };
  }

  // 2. Dirty check — a worktree with uncommitted changes is never moved
  //    (moving HEAD under an in-flight fix would lose or corrupt it), and
  //    the fixer is not dispatched onto one either. Nothing is stashed; the
  //    operator inspects and clears it.
  let porcelain: string;
  try {
    const st = await execFn("git status --porcelain", { cwd: tree, maxBuffer: 64 * 1024 });
    porcelain = st.stdout.trim();
  } catch (e) {
    trace(`${TRACE_PREFIX}: git-failed (status): ${e}`);
    return { kind: "git-failed", detail: `git status --porcelain failed: ${e}` };
  }
  if (porcelain !== "") {
    const paths = porcelain
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const detail = `worktree has uncommitted changes: ${paths.join(", ")}`;
    trace(`${TRACE_PREFIX}: ${detail}`);
    return { kind: "dirty", detail };
  }

  // 3. Where is the worktree relative to the tip? A clean tree at the tip
  //    is the no-op; a clean tree strictly BEHIND it is the repositionable
  //    shape. Anything else (the tree holds commits the tip does not) is a
  //    guard failure — back up the tree and park.
  let treeSha: string;
  try {
    const hp = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
    treeSha = hp.stdout.trim();
  } catch (e) {
    trace(`${TRACE_PREFIX}: git-failed (rev-parse HEAD): ${e}`);
    return { kind: "git-failed", detail: `git rev-parse HEAD failed: ${e}` };
  }

  if (treeSha === tipSha) {
    trace(`${TRACE_PREFIX}: already-at-tip ${tipSha.slice(0, 12)}`);
    return { kind: "already-at-tip", tipSha };
  }

  // Strict-ancestor test in the fast-forward direction: if the tree IS an
  // ancestor of the tip, the tree is strictly behind it and a
  // `git merge --ff-only` is safe. If it is NOT, the tree holds commits the
  // tip does not (unlanded or diverged) — a fast-forward would destroy
  // that work, so back it up and park.
  let treeIsAncestorOfTip: boolean;
  try {
    await execFn(
      `git merge-base --is-ancestor ${JSON.stringify(treeSha)} ${JSON.stringify(tipSha)}`,
      { cwd: tree },
    );
    treeIsAncestorOfTip = true;
  } catch {
    treeIsAncestorOfTip = false;
  }

  if (treeIsAncestorOfTip) {
    // Clean fast-forward: the tree is strictly behind the tip.
    try {
      await execFn(`git merge --ff-only --quiet ${JSON.stringify(tipSha)}`, {
        cwd: tree,
        maxBuffer: 64 * 1024,
      });
      const hp2 = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
      const newSha = hp2.stdout.trim();
      if (newSha !== tipSha) {
        const detail = `fast-forward did not land on the tip (expected ${tipSha.slice(0, 12)}, got ${newSha.slice(0, 12)})`;
        trace(`${TRACE_PREFIX}: ${detail}`);
        return { kind: "git-failed", detail };
      }
      trace(`${TRACE_PREFIX}: repositioned ${treeSha.slice(0, 12)} -> ${newSha.slice(0, 12)}`);
      return { kind: "repositioned", fromSha: treeSha, tipSha };
    } catch (e) {
      trace(`${TRACE_PREFIX}: reposition failed: ${e}`);
      return {
        kind: "git-failed",
        detail: `git merge --ff-only ${tipSha.slice(0, 12)} failed: ${e}`,
      };
    }
  }

  // The tree is NOT an ancestor of the tip: it holds commits the branch
  // does not. Distinguish unlanded (tip is an ancestor of the tree — the
  // tree is ahead) from true divergence (neither is an ancestor of the
  // other). Both are guard failures; back up the tree and park.
  let tipIsAncestorOfTree: boolean;
  try {
    await execFn(
      `git merge-base --is-ancestor ${JSON.stringify(tipSha)} ${JSON.stringify(treeSha)}`,
      { cwd: tree },
    );
    tipIsAncestorOfTree = true;
  } catch {
    tipIsAncestorOfTree = false;
  }

  const backupRef = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
  const aheadShas = await enumerateUnlanded(execFn, tree, tipSha);
  const kind: "unlanded" | "diverged" = tipIsAncestorOfTree ? "unlanded" : "diverged";
  const detail =
    kind === "unlanded"
      ? `worktree holds ${aheadShas.length} commit(s) the branch tip ${tipSha.slice(0, 12)} does not (previous-round work unlanded): ${aheadShas.join(", ") || "(unreadable)"}`
      : `worktree has diverged from the branch tip ${tipSha.slice(0, 12)} — the tree holds commits the branch does not: ${aheadShas.join(", ") || "(unreadable)"}`;
  trace(`${TRACE_PREFIX}: ${kind}: ${detail}`);
  return {
    kind,
    detail,
    ...(backupRef ? { backupRef } : {}),
    aheadShas,
  };
}

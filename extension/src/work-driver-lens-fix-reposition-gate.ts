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
 * Tip selection (documented): the driver's own worktrees are detached and
 * the branch ref in the worktree is often absent, so the tip is resolved
 * from BOTH `refs/heads/<branch>` and `refs/remotes/origin/<branch>` after
 * the fetch. If only one exists, that one is the tip. If both exist, the
 * NEWER one is taken — when one is an ancestor of the other, the
 * descendant is the newer (a local commit that has not been pushed yet, or
 * a remote commit not yet pulled, are both "ahead" of the other ref in the
 * ancestor direction); if the two refs have genuinely diverged (neither is
 * an ancestor of the other), the gate cannot know which ref the integration
 * step will apply against, so it returns `diverged` and parks.
 *
 * The `git cherry` landed-check (#981 normal case): in round 2+ the lens
 * worktree typically holds the previous round's fix commit, which reached
 * the branch as a DIFFERENT commit (cherry-picked, same patch). Those
 * commits are already landed, so the worktree must be MOVED to the tip,
 * not parked. `git cherry <tip> <tree>` prints one line per worktree
 * commit: `-` when a patch-equivalent exists on the tip (landed), `+`
 * when it does not (genuinely un-landed). If every line is `-` (or the
 * output is empty — the worktree has no commits beyond the tip) the work
 * is already on the branch and the worktree is checked out at the tip.
 *
 * All git commands run through the `ExecFn` argv form (no shell re-parse of
 * branch names / SHAs — the LLM MEDIUM of the #981 review).
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
 * - `repositioned` with `landedViaCherry: true` — the tree is NOT a strict
 *   ancestor of the tip (it holds commits the tip does not contain by
 *   identity) BUT `git cherry` shows every one of those worktree commits
 *   has a patch-equivalent on the tip (the NORMAL #981 case: the previous
 *   round's fix was cherry-picked onto the branch as a different commit).
 *   The worktree's work is already on the branch, so the clean tree is
 *   checked out at the tip and the round-2+ fix is safe to dispatch. No
 *   backup ref is created (the commits are already reachable from the
 *   branch). `fromSha` records where the tree moved from.
 * - `dirty` — uncommitted changes present; the fixer is NOT dispatched
 *   (it would build on a half-edited tree). Nothing was moved or stashed.
 * - `unlanded` — the worktree is clean and BEHIND the tip but holds commits
 *   the tip does not (e.g. a previous round's commit that was never
 *   integrated). A fast-forward would DESTROY that work, so the tree is
 *   moved to a backup ref and the cycle parks. `backupRef` names it.
 * - `diverged` — the worktree holds commits the tip does not and is NOT
 *   behind it either (the tip is not an ancestor of the tree): the tree and
 *   the branch have genuinely split — or the local and remote branch refs
 *   diverged from each other during tip selection. The tree is moved to a
 *   backup ref and the cycle parks. `backupRef` names it.
 * - `git-failed` — a git probe or the backup ref itself failed; detail
 *   carries the git output. `backupRef` is present when the backup was
 *   created before the failure.
 */
export type RepositionResult =
  | { kind: "already-at-tip"; tipSha: string }
  | { kind: "repositioned"; fromSha: string; tipSha: string; landedViaCherry?: boolean }
  | { kind: "dirty"; detail: string }
  | { kind: "unlanded"; detail: string; backupRef?: string; aheadShas?: string[] }
  | { kind: "diverged"; detail: string; backupRef?: string; aheadShas?: string[] }
  | { kind: "git-failed"; detail: string; backupRef?: string };

const TRACE_PREFIX = "lens-fix-reposition";

/** Resolve one rev to a SHA (trimmed), or undefined when the read failed. */
async function revToSha(execFn: ExecFn, tree: string, rev: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git", {
      cwd: tree,
      maxBuffer: 64 * 1024,
      argv: ["rev-parse", "--verify", rev],
    });
    const sha = stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/** True when `a` is an ancestor of `b` (inclusive of a === b). */
async function isAncestor(execFn: ExecFn, tree: string, a: string, b: string): Promise<boolean> {
  try {
    await execFn("git", {
      cwd: tree,
      argv: ["merge-base", "--is-ancestor", a, b],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * #981 — the tip of `branchName` in `tree`, resolved from the local and
 * remote refs. Returns `{ ok: true, tipSha }`, `{ ok: false, kind:
 * "git-failed" }` when neither ref is readable, or `{ ok: false, kind:
 * "diverged" }` when the two refs exist and have split (neither is an
 * ancestor of the other). See the module header for the documented rule.
 */
async function resolveBranchTip(
  execFn: ExecFn,
  tree: string,
  branchName: string,
): Promise<
  { ok: true; tipSha: string } | { ok: false; kind: "git-failed" | "diverged"; detail: string }
> {
  const local = await revToSha(execFn, tree, `refs/heads/${branchName}`);
  const remote = await revToSha(execFn, tree, `refs/remotes/origin/${branchName}`);
  if (local === undefined && remote === undefined) {
    return {
      ok: false,
      kind: "git-failed",
      detail: `could not resolve refs/heads/${branchName} or refs/remotes/origin/${branchName} (tip unknown)`,
    };
  }
  if (local === undefined || remote === undefined) {
    const onlyRef = local ?? remote;
    if (onlyRef === undefined) {
      return {
        ok: false,
        kind: "git-failed",
        detail: `could not resolve refs/heads/${branchName} or refs/remotes/origin/${branchName} (tip unknown)`,
      };
    }
    return { ok: true, tipSha: onlyRef };
  }
  if (local === remote) return { ok: true, tipSha: local };
  const localIsAncestorOfRemote = await isAncestor(execFn, tree, local, remote);
  const remoteIsAncestorOfLocal = await isAncestor(execFn, tree, remote, local);
  if (localIsAncestorOfRemote) return { ok: true, tipSha: remote };
  if (remoteIsAncestorOfLocal) return { ok: true, tipSha: local };
  return {
    ok: false,
    kind: "diverged",
    detail: `branch tip ambiguous — local ref ${local.slice(0, 12)} and origin/${branchName} ${remote.slice(0, 12)} have diverged (neither is an ancestor of the other)`,
  };
}

/**
 * #981 — the `git cherry <tipSha> <treeSha>` output, or undefined when the
 * command failed. Each line marks one worktree commit beyond the tip:
 * `-` = a patch-equivalent exists on the tip (landed), `+` = genuinely
 * un-landed.
 */
async function cherryLines(
  execFn: ExecFn,
  tree: string,
  tipSha: string,
  treeSha: string,
): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFn("git", {
      cwd: tree,
      maxBuffer: 64 * 1024,
      argv: ["cherry", tipSha, treeSha],
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * #981 — `true` when EVERY commit in the `tipSha..treeSha` range is a
 * non-empty patch (its tree differs from its parent's tree). `git cherry`
 * marks commits by PATCH-EQUIVALENCE via patch-id, and its contract only
 * covers non-empty patches — every empty commit produces the SAME (empty)
 * patch-id, so an all-`-` cherry result can be a false positive when the
 * range contains an empty worktree commit that collides with an unrelated
 * empty commit on the tip. An empty worktree commit (or a real fix riding
 * on one) has no non-empty patch to land, so such a range is treated as
 * UNVERIFIED — the caller backs the tree up and parks rather than moving
 * it to the tip. `undefined` when the emptiness read itself fails (the
 * caller also treats that as unverified — fail closed).
 */
async function rangeAllNonEmpty(
  execFn: ExecFn,
  tree: string,
  tipSha: string,
  treeSha: string,
): Promise<boolean | undefined> {
  let shas: string[];
  try {
    const { stdout } = await execFn("git", {
      cwd: tree,
      maxBuffer: 64 * 1024,
      argv: ["rev-list", `${tipSha}..${treeSha}`],
    });
    shas = stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
  for (const sha of shas) {
    let empty: boolean;
    try {
      await execFn("git", {
        cwd: tree,
        argv: ["diff", "--quiet", "--exit-code", `${sha}^`, sha],
      });
      empty = true;
    } catch (e) {
      // `git diff --quiet --exit-code` exits 1 on a non-empty diff (the
      // ExecFn rejects on any non-zero exit), so the reject IS the
      // non-empty signal. A missing parent (the root commit) rejects with
      // a different error, but a root commit can never fall inside a
      // `tipSha..treeSha` range — the tip is always at or above it.
      const err = e as Error & { code?: number | string };
      const code = typeof err.code === "number" ? err.code : Number(err.code);
      if (code !== 1) {
        return undefined;
      }
      empty = false;
    }
    if (empty) return false;
  }
  return true;
}

/**
 * #981 — move the lens-fix worktree onto the freshly-fetched branch tip
 * BEFORE the round-2+ fixer dispatch. See {@link RepositionResult} for the
 * outcome kinds; only the two success kinds are safe to dispatch on.
 *
 * The guard is deliberately conservative: it fast-forwards ONLY a CLEAN
 * worktree that is strictly BEHIND the tip, and it moves a CLEAN worktree
 * that is NOT behind the tip ONLY when `git cherry` proves every commit it
 * holds is already on the branch by patch-equivalence (the normal #981
 * round-2+ shape). Anything else — a dirty tree, a clean tree holding
 * commits with no patch-equivalent on the branch, or a branch-tip pair
 * that has split — moves the tree to a backup ref (when it can) and
 * returns a failure kind so the caller parks rather than dispatching a fix
 * onto a base it cannot trust.
 */
export async function repositionLensFixWorktree(
  execFn: ExecFn,
  tree: string,
  branchName: string,
  issues: number[],
  issueTitle: string | undefined,
): Promise<RepositionResult> {
  // 1. Fetch the branch, then resolve the tip from the local + remote
  //    refs (documented tip selection, module header). A fetch failure or
  //    an unresolvable tip means the base cannot be trusted; park rather
  //    than guess.
  try {
    await execFn("git", {
      cwd: tree,
      maxBuffer: 64 * 1024,
      argv: ["fetch", "origin", branchName, "--quiet"],
    });
  } catch (e) {
    const detail = `could not fetch origin/${branchName}: ${e}`;
    trace(`${TRACE_PREFIX}: ${detail}`);
    return { kind: "git-failed", detail };
  }
  const tip = await resolveBranchTip(execFn, tree, branchName);
  if (!tip.ok) {
    trace(`${TRACE_PREFIX}: ${tip.kind}: ${tip.detail}`);
    return tip.kind === "diverged"
      ? { kind: "diverged", detail: tip.detail }
      : { kind: "git-failed", detail: tip.detail };
  }
  const tipSha = tip.tipSha;

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
  //    shape. Anything else (the tree holds commits the tip does not) is
  //    either the normal #981 shape (every such commit has a patch-
  //    equivalent on the tip — `git cherry` all `-`) or a guard failure —
  //    back up the tree and park.
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
  // tip does not — the normal #981 case is a cherry-picked previous-round
  // fix (patch-equivalent on the branch), which the `git cherry` check
  // below detects and repositions; anything with a `+` line is un-landed
  // or diverged and must park.
  const treeIsAncestorOfTip = await isAncestor(execFn, tree, treeSha, tipSha);
  if (treeIsAncestorOfTip) {
    // Clean fast-forward: the tree is strictly behind the tip.
    try {
      await execFn("git", {
        cwd: tree,
        maxBuffer: 64 * 1024,
        argv: ["merge", "--ff-only", "--quiet", tipSha],
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
  // does not contain by identity. The NORMAL #981 round-2+ case: the
  // previous round's fix commit reached the branch as a DIFFERENT
  // (cherry-picked) commit with the same patch. `git cherry <tip> <tree>`
  // marks each such worktree commit `-` when a patch-equivalent exists on
  // the tip and `+` otherwise. All `-` (or empty — no commits beyond the
  // tip) means the work is already on the branch: move the clean tree to
  // the tip. Any `+` means genuinely un-landed work: back up and park.
  //
  // `rangeAllNonEmpty` guards the all-`-` path against `git cherry`'s
  // empty-patch-id collision: its contract covers only NON-EMPTY patches,
  // and every empty commit produces the same (empty) patch-id, so an all-`-`
  // result can be a false positive when the worktree's range holds an empty
  // commit (or a real fix riding on one). Such work is NOT on the branch,
  // so an empty range commit falls through to the backup-and-park path.
  const lines = await cherryLines(execFn, tree, tipSha, treeSha);
  if (lines !== undefined) {
    const plusShas = lines
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    const minusShas = lines
      .filter((l) => l.startsWith("-"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    if (plusShas.length === 0) {
      const allNonEmpty = await rangeAllNonEmpty(execFn, tree, tipSha, treeSha);
      if (allNonEmpty === true) {
        // Landed via cherry: every worktree commit beyond the tip is a
        // NON-EMPTY commit with a patch-equivalent on the tip. No backup
        // ref — those commits are already reachable from the branch. Trace
        // the moved-from SHA.
        try {
          await execFn("git", {
            cwd: tree,
            maxBuffer: 64 * 1024,
            argv: ["checkout", "--detach", "--quiet", tipSha],
          });
          const hp2 = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
          const newSha = hp2.stdout.trim();
          if (newSha !== tipSha) {
            const detail = `checkout to the tip did not land on the tip (expected ${tipSha.slice(0, 12)}, got ${newSha.slice(0, 12)})`;
            trace(`${TRACE_PREFIX}: ${detail}`);
            return { kind: "git-failed", detail };
          }
          trace(
            `${TRACE_PREFIX}: repositioned (landedViaCherry) ${treeSha.slice(0, 12)} -> ${newSha.slice(0, 12)} — ${minusShas.length} worktree commit(s) already on the branch by patch-equivalence: ${minusShas.join(", ") || "(none beyond the tip)"}`,
          );
          return { kind: "repositioned", fromSha: treeSha, tipSha, landedViaCherry: true };
        } catch (e) {
          trace(`${TRACE_PREFIX}: checkout to tip failed: ${e}`);
          return {
            kind: "git-failed",
            detail: `git checkout --detach ${tipSha.slice(0, 12)} failed: ${e}`,
          };
        }
      }
      // all-`-` but the range contains an empty commit (or the emptiness
      // read failed): the cherry result is UNVERIFIED. Fall through to the
      // backup-and-park path below — do NOT move the tree to the tip, and
      // do NOT skip the backup (the all-`-` no-backup rationale does not
      // apply to unverifiable ranges).
      trace(
        `${TRACE_PREFIX}: cherry result all-\`-\` but the range ${tipSha.slice(0, 12)}..${treeSha.slice(0, 12)} contains an empty commit (or the emptiness read failed) — treating as unverified, backing up and parking`,
      );
    }

    // Genuinely un-landed work (`+` lines), or an unverifiable all-`-`
    // range (empty commit). Distinguish unlanded (tip is an ancestor of
    // the tree — the tree is ahead) from true divergence (neither is an
    // ancestor of the other). Both are guard failures; back up the tree
    // and park.
    const tipIsAncestorOfTree = await isAncestor(execFn, tree, tipSha, treeSha);
    const backupRef = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
    const aheadShas =
      plusShas.length > 0 ? plusShas : await enumerateUnlanded(execFn, tree, tipSha);
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

  // `git cherry` itself failed — treat the tree as untrustworthy: back it
  // up and park (conservative — we cannot prove the work is landed).
  const backupRef = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
  const aheadShas = await enumerateUnlanded(execFn, tree, tipSha);
  const tipIsAncestorOfTree = await isAncestor(execFn, tree, tipSha, treeSha);
  const kind: "unlanded" | "diverged" = tipIsAncestorOfTree ? "unlanded" : "diverged";
  const detail = `git cherry could not be run against tip ${tipSha.slice(0, 12)} — treating ${aheadShas.length} ahead commit(s) as unverified: ${aheadShas.join(", ") || "(unreadable)"}`;
  trace(`${TRACE_PREFIX}: ${kind}: ${detail}`);
  return {
    kind,
    detail,
    ...(backupRef ? { backupRef } : {}),
    aheadShas,
  };
}

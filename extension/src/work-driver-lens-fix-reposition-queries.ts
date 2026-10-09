/**
 * work-driver-lens-fix-reposition-queries — #981 (task-b) — the private
 * git-query helpers for the round-2+ lens-fix reposition gate
 * (work-driver-lens-fix-reposition-gate.ts). Extracted verbatim from that
 * file to satisfy the 500-line gate (AGENTS.md §12); the gate imports them
 * back. No behaviour changed in the move.
 *
 * All git commands run through the `ExecFn` argv form (no shell re-parse).
 */
import type { ExecFn } from "./worktree.ts";

/** Resolve one rev to a SHA (trimmed), or undefined when the read failed. */
export async function revToSha(
  execFn: ExecFn,
  tree: string,
  rev: string,
): Promise<string | undefined> {
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
export async function isAncestor(
  execFn: ExecFn,
  tree: string,
  a: string,
  b: string,
): Promise<boolean> {
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
export async function resolveBranchTip(
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
  // The unreachable `onlyRef === undefined` guard is kept as a type guard:
  // at runtime exactly one of local/remote is defined when we reach this
  // line, but TypeScript cannot narrow `local ?? remote` without it.
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
export async function cherryLines(
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
export async function rangeAllNonEmpty(
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

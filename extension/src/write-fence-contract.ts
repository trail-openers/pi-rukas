/**
 * write-fence-contract — the dispatch-side contract of the /work write fence (#1655).
 *
 * The driver names a dispatch's fence (`WriteFence`) and builds the env the child
 * reads it from (`writeFenceChildEnv`); the child's companion reads that env
 * (write-fence-path.ts). Dependency-free apart from the forge strip, so the
 * dispatch seam and the driver can import the contract without pulling in the
 * judge or the log channel.
 *
 * `childEnvFor` is THIS module's child-env construction: what it owns is the
 * write-fence removal and the role stamp, and it also applies the forge strip so
 * that a caller which builds its env here cannot get an env with a login in it.
 * It is NOT the only child-env construction: the spawn path assembles its env in
 * `spawn-child-env.ts` (`childBaseEnv`) and the resume-reattach path calls
 * `forgeReadChildEnv` directly (`work-driver-resume-reattach.ts`), because both
 * own a forge-config dir with a teardown, which this function deliberately does
 * not have (`configDir` is a parameter for exactly that reason — an absent one
 * means "no config root is available", and `stripForgeCredentials` then deletes
 * BOTH roots rather than leaving an inherited one: a token-less child must not
 * keep a populated config root). The invariant "no non-ops child env carries a
 * forge token or an operator config root" therefore has three construction sites,
 * and its single point of truth is `stripForgeCredentials` in
 * `child-forge-env.ts`, which each of them calls — not this function.
 */

import { stripForgeCredentials } from "./child-forge-env.ts";

/** What a dispatch is fenced to: its worktree, the main checkout, and the cycle scratch dir. All absolute. */
export interface WriteFence {
  root: string;
  repo: string;
  scratch: string;
}

/**
 * The env the fence and the deletion rule (#2200) read. A child inherits none of
 * these unless the driver sets them for its dispatch. `PI_ENSEMBLE_CHILD_TMP` is
 * listed here although the spawn layer sets it in `spawn.ts`, not in
 * `writeFenceChildEnv`: it names a deletable root, so a nested dispatch made
 * inside a child must not carry its parent's per-child temp root — on a host
 * whose `TMPDIR` is a shared root, an inherited value would hand the child that
 * shared root as a root it may remove.
 */
export const WRITE_FENCE_ENV = [
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_REPO",
  "PI_ENSEMBLE_WRITE_SCRATCH",
  "PI_ENSEMBLE_CHILD_TMP",
] as const;

/**
 * The env a child starts from: the parent's, with any inherited fence setting
 * removed (a child the driver did not fence must not inherit the ambient root of
 * the process that spawned it) and the child's role set.
 *
 * `configDir` is optional and its absence is meaningful. When the caller has a
 * per-child forge-config dir already — the spawn path's broker made one inside
 * its own 0700 tree and will remove it — the strip redirects both config roots
 * into it. When the caller passes none, this function strips the five token
 * variables AND deletes both config roots: it will not allocate a directory it
 * has no way to clean up, and it will not leave a populated inherited root
 * either, because `gh`/`glab` read an `hosts.yml` out of a config root and the
 * whole point of deleting the tokens is that a helper has no login (#2160). An
 * inherited root is not the honest fallback for a token-less child — an absent
 * root is.
 */
export function childEnvFor(
  env: NodeJS.ProcessEnv,
  role: string,
  configDir?: string,
): Record<string, string> {
  const inherited = Object.entries({ ...env, PI_ENSEMBLE_ROLE: role }).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !(WRITE_FENCE_ENV as readonly string[]).includes(entry[0]),
  );
  const out = Object.fromEntries(inherited);
  stripForgeCredentials(out, role, configDir ?? "");
  return out;
}

/** The env a fenced dispatch's child gets. An unfenced child gets none, so the fence stays off for it. */
export function writeFenceChildEnv(fence: WriteFence | undefined): Record<string, string> {
  return fence
    ? {
        PI_ENSEMBLE_WRITE_ROOT: fence.root,
        PI_ENSEMBLE_WRITE_REPO: fence.repo,
        PI_ENSEMBLE_WRITE_SCRATCH: fence.scratch,
      }
    : {};
}

/**
 * The child's own temp root, in every spelling a tool honours (#2241). Set it
 * LAST, after every other write to the child env — an inherited value must never
 * win, the placement the `GIT_*` canary in `test-subagent-git-guard.ts` pins for
 * its own assignments. A child inherited its parent's `TMPDIR`, so its `mktemp`
 * output and its runner's scratch landed in the SHARED root — which the deletion
 * rule (#2200) refuses it as a delete target — and what it leaked went where every
 * other run shares. `TMPDIR` is the one `os.tmpdir()` follows, so a nested
 * dispatch mkdtemp's under the CHILD's dir; trees that must stay host-wide (the
 * slot dir, the broker and permission sockets, the reviewer isolation tree) are
 * resolved in the parent and reach the child as absolute values.
 */
export function childTempEnv(childTmp: string): Record<string, string> {
  return { TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp };
}

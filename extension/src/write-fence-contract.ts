/**
 * write-fence-contract — the dispatch-side contract of the /work write fence (#1655).
 *
 * The driver names a dispatch's fence (`WriteFence`) and builds the env the child
 * reads it from (`writeFenceChildEnv`); the child's companion reads that env
 * (write-fence-path.ts). Dependency-free, so the dispatch seam and the driver can
 * import the contract without pulling in the judge or the log channel.
 */

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
 * the process that spawned it), and the child's role set.
 */
export function childEnvFor(env: NodeJS.ProcessEnv, role: string): Record<string, string> {
  const inherited = Object.entries({ ...env, PI_ENSEMBLE_ROLE: role }).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !(WRITE_FENCE_ENV as readonly string[]).includes(entry[0]),
  );
  return Object.fromEntries(inherited);
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

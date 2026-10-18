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

/** The env the fence reads. A child inherits none of these unless the driver sets them for its dispatch. */
export const WRITE_FENCE_ENV = [
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_REPO",
  "PI_ENSEMBLE_WRITE_SCRATCH",
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

/**
 * work-driver-verify-tree — #1240: the tree identity behind "this tree was
 * already verified".
 *
 * The develop gate runs the project's verify command TWICE on the same
 * content in an N=1 cycle: once in the develop worktree
 * (`work-driver-verify-verify-cmd.ts`) and once at repoRoot for the
 * consolidated probe (`work-driver-consolidated-verify.ts`), which cherry-
 * picks that one workstream's own commits onto `baseSha` — the same commit
 * range the worktree holds, so the resulting tree is byte-identical. The
 * consolidated half is pure duplicate work: measured on the orchard factory,
 * ~21 minutes per pass, a third of a three-round cycle.
 *
 * Identity is established POSITIVELY, from git's own tree object ids:
 *
 *   - the tree that PASSED in the worktree — the HEAD commit's tree when
 *     every developer change is committed, the INDEX tree of the same
 *     worktree when it holds uncommitted changes that the consolidation
 *     transplants as a patch;
 *   - the tree the consolidated verify is about to run — the INDEX tree at
 *     repoRoot after the cherry-picks landed (uncommitted by construction:
 *     `cherryPickWorkstreams` picks with `--no-commit`).
 *
 * Both sides therefore include staged content and exclude untracked files:
 * the driver's own index-free scaffolding (`.worktrees/`, `.pi/`, `tmp/`)
 * never enters the hash, while a dirty worktree's staged work does. A
 * mismatch, an unreadable hash on either side, or a cycle shape that is not
 * the single-workstream one means NO skip — every failure routes to "run
 * the consolidated verify exactly as before". A gate that cannot prove
 * equivalence runs the check.
 */
import { isDriverManagedDirtLine } from "./work-driver-branch-residue.ts";
import type { ExecFn } from "./worktree.ts";

/** git's own object id shape — anything else is not a hash we can trust. */
const TREE_HASH_RE = /^[0-9a-f]{40}$/;

/**
 * The tree the project's verify command actually sees in one working tree, or
 * `undefined` when git could not establish it (a read failed, the output is
 * not an object id, or the working tree holds content no tree object
 * describes) — an executor that answers nothing is never read as a hash.
 *
 * Two reads, deliberately:
 *
 *   1. `git write-tree` — the INDEX, promoted to a tree object. Content
 *      staged but not committed counts.
 *   2. `git rev-parse HEAD^{tree}` — the HEAD commit's tree.
 *
 * HEAD is the identity whenever the index and HEAD agree, and `write-tree`
 * when they do not — the index is what a pending consolidation transplants,
 * so a worktree holding staged-but-uncommitted work is identified by its
 * index, matching the probe's own index at repoRoot (picks are `--no-commit`).
 *
 * Neither hash is returned when the working tree holds content NO tree object
 * describes (unstaged modifications, deletions, untracked-not-ignored files):
 * the verify command reads FILES, so a hash of HEAD there would be a claim
 * about content that is not what was tested. Driver-managed scaffolding
 * (`.worktrees/`, `.pi/`, `tmp/`) does not count, so the driver's own scratch
 * never defeats the identity.
 */
export async function verifyTreeId(execFn: ExecFn, cwd: string): Promise<string | undefined> {
  const run = async (cmd: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 });
      const out = stdout.trim();
      return TREE_HASH_RE.test(out) ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const status = await porcelain(execFn, cwd);
  if (status === undefined) return undefined;
  if (hasWorkingTreeDirt(status)) return undefined;
  const staged = await run("git write-tree");
  const committed = await run("git rev-parse HEAD^{tree}");
  if (staged === undefined || committed === undefined) return undefined;
  return staged === committed ? committed : staged;
}

/**
 * `git status --porcelain -uall`, or `undefined` when the read failed. The
 * status is read FIRST because it decides whether either hash is meaningful.
 */
async function porcelain(execFn: ExecFn, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git status --porcelain -uall", {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Does this porcelain output describe content that NO tree object holds —
 * unstaged modifications or deletions (worktree column set), or
 * untracked-but-not-ignored files?
 *
 * Staged-only entries (index column set, worktree column blank: `A `, `M `)
 * are NOT dirt: `git write-tree` describes them exactly, and they are the
 * shape a develop worktree with uncommitted work presents to the
 * consolidation, which transplants them as a patch.
 *
 * Untracked files ARE dirt here even though `write-tree` ignores them: an
 * untracked file can change what the verify command does (the smoke loop
 * greps sources, a TypeScript build reads every file under `src/`), so a tree
 * holding one is not a tree whose identity was verified. Both sides of the
 * comparison apply the same rule, so an untracked file the driver owns — the
 * scaffolding `isDriverManagedDirtLine` excludes — is invisible to it.
 */
function hasWorkingTreeDirt(status: string): boolean {
  return status.split("\n").some((line) => {
    if (line.trim().length === 0) return false;
    if (isDriverManagedDirtLine(line)) return false;
    // An untracked entry: `?? path`.
    if (line.startsWith("??")) return true;
    // XY path — the worktree column (index 2) set means the FILES differ
    // from every tree object; a blank there means the index describes them.
    return line.length > 2 && line[2] !== " ";
  });
}

/**
 * Escape hatch: `PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0` restores the
 * pre-#1240 behaviour (the consolidated verify always runs). Anything else,
 * including a malformed value, keeps the skip available — the safe side is
 * the one that runs the check.
 */
export function consolidatedVerifySkipEnabled(): boolean {
  return process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP !== "0";
}

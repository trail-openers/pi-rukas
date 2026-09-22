/**
 * worktree-provision-verify — #765 post-hook / post-symlink filesystem
 * verification helpers for `provisionWorktree`.
 *
 * Extracted from `worktree-provision.ts` (file-size cap). The functions here
 * answer ONE question: after provisioning, does the expected dependency
 * location actually exist, resolve, and contain content?
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SHAREABLE_DEPS } from "./worktree-provision.ts";

async function isNonEmptyDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.readdir(abs)).length > 0;
  } catch {
    return false;
  }
}

function candidatesForDir(dirRel: string): string[] {
  return dirRel === "" ? [...SHAREABLE_DEPS] : SHAREABLE_DEPS.filter((d) => d === "node_modules");
}
/**
 * The shareable-dep source locations the hook path must VERIFY afterwards:
 * a non-empty candidate under `repoRoot` or one of the discovered package
 * dirs (the same resolution as `findDepDirs`, minus the gitignore check —
 * on the hook path the source is gitignored by definition). `dirRel === ""`
 * is the `repoRoot` itself; only `node_modules` is conventionally nested in
 * a package dir.
 */
export async function expectedDepLocations(
  repoRoot: string,
  packageDirs: string[],
): Promise<Array<{ dirRel: string; source: string }>> {
  const locations: Array<{ dirRel: string; source: string }> = [
    { dirRel: "", source: repoRoot },
    ...packageDirs.map((d) => ({ dirRel: d, source: path.join(repoRoot, d) })),
  ];
  const found: Array<{ dirRel: string; source: string }> = [];
  for (const dep of SHAREABLE_DEPS) {
    let hit: { dirRel: string; source: string } | undefined;
    for (const { dirRel, source } of locations) {
      if (!candidatesForDir(dirRel).includes(dep)) continue;
      if (await isNonEmptyDirectory(path.join(source, dep))) {
        hit = { dirRel, source: path.join(source, dep) };
        break;
      }
    }
    if (hit) found.push(hit);
  }
  return found;
}

/**
 * True when at least one shareable-dep source location (repoRoot or a
 * discovered package dir) is a non-empty directory — the precondition for
 * the hook path: if none is, the hook has nothing to link (the #761 fork-A
 * shape: fresh clone / mid-install) and the branch step records a `problem`
 * at provisioning time instead of discovering the bare worktree 61 minutes
 * later at the commit-pr verify.
 */
export async function anyNonEmptySharedSource(
  repoRoot: string,
  packageDirs: string[],
): Promise<boolean> {
  const locations = await expectedDepLocations(repoRoot, packageDirs);
  return locations.length > 0;
}

/**
 * True when the path exists, RESOLVES (a symlink to a since-deleted target
 * does not — `fs.realpath` throws and the check fails), and is a non-empty
 * directory. `dist/` build output is deliberately out of this check's scope:
 * it is on `NEVER_SHARED` and the hook builds it locally.
 */
export async function resolvedNonEmptyDirectory(abs: string): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await fs.realpath(abs);
  } catch {
    return false;
  }
  return isNonEmptyDirectory(resolved);
}

/**
 * worktree-provision-hook — the `.pi/worktree-setup` hook path for
 * `provisionWorktree`, with its #765 post-hook verification.
 *
 * Extracted from `worktree-provision.ts` (the 500-line file-size cap,
 * AGENTS.md §12 — the file sat AT the cap, leaving zero headroom for the
 * next edit; this is the same seam as `worktree-provision-verify.ts`).
 *
 * One responsibility: when the project provides `.pi/worktree-setup`, RUN
 * it in the worktree and then VERIFY on the filesystem what it actually
 * did. The hook contract — no arguments, no environment, cwd = the new
 * worktree, the hook locates `repoRoot` itself — is documented in
 * `worktree-provision.ts`'s module docstring, unchanged here.
 *
 * #765's post-hook verification is the load-bearing part of this seam:
 *
 *   - exit 0 records INVOCATION, the filesystem records provisioning.
 *     Each expected dependency source (resolved via
 *     `worktree-provision-verify.ts`) must RESOLVE to a non-empty directory
 *     — a no-op hook used to report an unqualified `via: "hook"`, so a
 *     verify gate ran against an unusable tree and parked with a false
 *     "does not build" diagnosis.
 *   - The precondition check (project expects deps but no source tree is
 *     non-empty — the #761 fork-A fresh-clone shape) is recorded as a
 *     `problem` at branch time instead of being discovered 61 minutes
 *     later at the commit-pr verify.
 *
 * Behaviour contract: a hook that exits non-zero returns
 * `{ via: "hook", problem, hookFailed: true }` (it never throws); a hook
 * that exits 0 returns `via: "hook"`, with a `problem` only when the project
 * expects an in-tree dependency directory the worktree does not have. A
 * project with nothing linkable (Rust, Go — see `IN_TREE_DEP_MARKERS`) is a
 * clean success, not a finding. Problems are returned, not traced here: every
 * caller that acts on one traces it, and tracing in both places printed the
 * same sentence twice.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import {
  anyNonEmptySharedSource,
  expectedDepLocations,
  resolvedNonEmptyDirectory,
} from "./worktree-provision-verify.ts";
import { WORKTREE_SETUP_HOOK } from "./worktree-provision.ts";
import type { ExecFn, ProvisionResult } from "./worktree-provision.ts";

/**
 * Run the project's setup hook in the worktree, then verify on the
 * filesystem what it actually did. Never throws — a failed hook run returns
 * `{ via: "hook", problem }` instead.
 */
export async function runHookProvisioning(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
  hook: string,
): Promise<ProvisionResult> {
  // #765 — precondition: the project expects deps (manifest present) but
  // no source tree is non-empty (fork-A: fresh clone). The hook's
  // deliberate exit-0-when-source-absent branch is untouched.
  const hookPreconditions: string[] = [];
  const hookPackageDirs = await packageDirsAt(repoRoot);
  if (
    (await depsExpectedAt(repoRoot, hookPackageDirs)) &&
    !(await anyNonEmptySharedSource(repoRoot, hookPackageDirs))
  ) {
    hookPreconditions.push(
      "no non-empty dependency source (node_modules/.venv/vendor) at repoRoot or in the discovered " +
        "package dirs, yet the project expects dependencies here (a manifest/lockfile is present) — " +
        "the hook has nothing to link unless it installs from scratch; the worktree will be bare " +
        "until the source tree exists at repoRoot",
    );
  }
  try {
    await execFn(`sh ${JSON.stringify(hook)}`, {
      cwd: worktreeAbs,
      maxBuffer: 1024 * 1024,
    });
    // #765 — verify, do not assume: exit 0 records INVOCATION, the
    // filesystem records provisioning. Each expected location must RESOLVE
    // to a non-empty dir (catches stale symlinks). No stdout parsing.
    const locations = await expectedDepLocations(repoRoot, hookPackageDirs);
    const verified: string[] = [];
    for (const { dirRel, source } of locations) {
      const dep = path.basename(source);
      const target = path.join(worktreeAbs, dirRel, dep);
      if (await resolvedNonEmptyDirectory(target)) {
        verified.push(dirRel === "" ? dep : path.join(dirRel, dep));
        continue;
      }
      const rel = dirRel === "" ? dep : path.join(dirRel, dep);
      const problem =
        `${WORKTREE_SETUP_HOOK} exited 0 but ${rel} in the worktree is absent, stale, or empty ` +
        `(source: ${source}) — the hook linked nothing useful there`;
      return {
        via: "hook",
        linked: verified,
        problem:
          hookPreconditions.length > 0
            ? `${hookPreconditions.join("; ")} (and ${problem})`
            : problem,
      };
    }
    // #765 — if NO source tree existed at hook-run time, the hook could
    // not have linked anything (fresh-clone fork-A shape). Only a finding
    // when the project expects one: with no in-tree dependency directory to
    // have, an empty `locations` is the normal shape and the hook simply ran.
    if (hookPreconditions.length > 0) {
      return { via: "hook", linked: [], problem: hookPreconditions.join("; ") };
    }
    trace(`worktree: provisioned via ${WORKTREE_SETUP_HOOK}`);
    return { via: "hook", linked: verified };
  } catch (err) {
    const problem = `${WORKTREE_SETUP_HOOK} failed: ${(err as Error).message?.slice(0, 200)}`;
    return { via: "hook", linked: [], problem, hookFailed: true };
  }
}

/**
 * Depth-1 subdirectories of `repoRoot` that contain a dependency marker.
 *
 * Depth-1 only: deeper nesting is where per-worktree scratch (`.worktrees/`)
 * and vendor trees live, and scanning them would re-link the very worktrees
 * this module creates. Unreadable / non-directory `repoRoot` → no candidates.
 */
export async function packageDirsAt(repoRoot: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name);
  if (dirs.length === 0) return [];
  // Awaited one by one: `fileExists` returns a Promise, and a Promise is
  // always truthy — a bare `.some(fileExists)` made every directory a match.
  const hasMarker = async (dir: string) => {
    for (const m of DEPENDENCY_MARKERS) {
      if (await fileExists(path.join(repoRoot, dir, m))) return true;
    }
    return false;
  };
  const marked: string[] = [];
  for (const dir of dirs) {
    if (await hasMarker(dir)) marked.push(dir);
  }
  return marked;
}

/**
 * Does the project "plainly need" an in-tree dependency directory — one of
 * `IN_TREE_DEP_MARKERS` at the root, or in a discovered package directory?
 * Drives the `problem` field: a project that needs deps and has none findable
 * gets a trace, not a silent bare worktree.
 */
export async function depsExpectedAt(repoRoot: string, packageDirs: string[]): Promise<boolean> {
  const rootHit = await Promise.any(
    IN_TREE_DEP_MARKERS.map((m) =>
      fileExists(path.join(repoRoot, m)).then((ok) => (ok ? true : Promise.reject())),
    ),
  ).catch(() => false);
  if (rootHit) return true;
  for (const dir of packageDirs) {
    const dirHit = await Promise.any(
      IN_TREE_DEP_MARKERS.map((m) =>
        fileExists(path.join(repoRoot, dir, m)).then((ok) => (ok ? true : Promise.reject())),
      ),
    ).catch(() => false);
    if (dirHit) return true;
  }
  return false;
}

/**
 * Markers of an ecosystem whose dependencies are installed INSIDE the tree,
 * in a directory on `SHAREABLE_DEPS` (Node → `node_modules`, Python →
 * `.venv`). Only these can promise a tree a worktree lacks.
 *
 * Cargo, Go and Bundler are deliberately absent: by default they resolve
 * into a per-user cache outside the repository, and Rust's only in-tree
 * directory is `target/`, which is on `NEVER_SHARED`. A `Cargo.toml` with no
 * `node_modules` beside it is a complete project — reporting "expects
 * dependencies here" for one sent an operator after a fault that did not
 * exist while the worktree's gate ran green. A `vendor/` that does exist is
 * still linked; it is just not demanded.
 */
const IN_TREE_DEP_MARKERS = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
];

/**
 * Manifest/lockfile markers: "this directory is a package", i.e. a place to
 * look for a nested `node_modules`. #481's discovery signal — depth-1
 * directories with any of these are scanned, so a nested-package monorepo
 * provisions without a hook and without knowing its own layout.
 */
const DEPENDENCY_MARKERS = [...IN_TREE_DEP_MARKERS, "go.mod", "go.sum", "Cargo.toml", "Gemfile"];

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

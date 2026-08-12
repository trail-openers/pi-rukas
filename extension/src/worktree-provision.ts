/**
 * worktree-provision — make a fresh worktree usable, not just present.
 *
 * `git worktree add --detach` gives you tracked files and nothing else. Every
 * gitignored directory a project's toolchain depends on — `node_modules`, a
 * virtualenv, a vendor tree — is absent, and the develop step then runs the
 * project's verify command inside that tree.
 *
 * How badly this bites is language-dependent, which is why it went unnoticed:
 *
 *   - Rust: `cargo check` rebuilds from scratch. It works. It costs minutes,
 *     per worktree, per cycle.
 *   - Node/bun: the command fails outright. pi-ensemble's own verify command
 *     needs `extension/node_modules`, which is gitignored — so pi-ensemble
 *     dogfooding `/work` on itself could not pass its own develop gate.
 *
 * Two mechanisms, in order:
 *
 *   1. `.pi/worktree-setup` — the project says what it needs. No guessing, and
 *      anything the allowlist below cannot express goes here.
 *   2. Otherwise, symlink a small allowlist of dependency directories that
 *      exist at `repoRoot` and are gitignored.
 *
 * The allowlist is deliberately short and deliberately excludes build output.
 * `node_modules` is read-mostly and safe for N worktrees to share. `target/`,
 * `build/` and `dist/` are write-heavy: sharing one across a fan-out would
 * serialise the parallel workstreams that always-worktree (#287) exists to
 * enable, turning a correctness fix into a throughput regression.
 *
 * Provisioning never fails the branch step. A worktree without dependencies is
 * exactly what shipped before this module, so the failure mode of "could not
 * link" is the status quo, not a regression — it is traced and reported, and
 * the cycle continues.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";

/** The exec shape `worktree.ts` already uses. */
type ExecFn = (
  cmd: string,
  opts: { cwd?: string; maxBuffer?: number },
) => Promise<{ stdout: string }>;

/** Where a project describes provisioning we cannot infer. */
export const WORKTREE_SETUP_HOOK = ".pi/worktree-setup";

/**
 * Dependency directories safe to share between worktrees.
 *
 * Read-mostly caches only. Build output is excluded on purpose — see the module
 * docstring.
 */
export const SHAREABLE_DEPS = ["node_modules", ".venv", "vendor"] as const;

/** Never linked, however tempting: concurrent writers would serialise. */
export const NEVER_SHARED = ["target", "build", "dist", ".next", "out"] as const;

export interface ProvisionResult {
  /** How the worktree was provisioned, for the trace and the plumb report. */
  via: "hook" | "symlink" | "none";
  linked: string[];
  /** Set when provisioning was attempted and failed. Never throws. */
  problem?: string;
}

/** Is this path gitignored? Only ignored dirs are safe to link over. */
async function isIgnored(execFn: ExecFn, repoRoot: string, rel: string): Promise<boolean> {
  try {
    await execFn(`git check-ignore -q ${JSON.stringify(rel)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    // Exit 1 means "not ignored" — a tracked directory of the same name, which
    // we must never shadow with a link to somewhere else.
    return false;
  }
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Give a new worktree what it needs to run the project's own commands.
 *
 * Returns what it did rather than throwing: the caller records it and carries
 * on either way.
 */
export async function provisionWorktree(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
): Promise<ProvisionResult> {
  const hook = path.join(repoRoot, WORKTREE_SETUP_HOOK);
  if (await isDirectory(path.dirname(hook)).then(() => fileExists(hook))) {
    try {
      await execFn(`sh ${JSON.stringify(hook)}`, {
        cwd: worktreeAbs,
        maxBuffer: 1024 * 1024,
      });
      trace(`worktree: provisioned via ${WORKTREE_SETUP_HOOK}`);
      return { via: "hook", linked: [] };
    } catch (err) {
      const problem = `${WORKTREE_SETUP_HOOK} failed: ${(err as Error).message?.slice(0, 200)}`;
      trace(`worktree: ${problem}`);
      return { via: "hook", linked: [], problem };
    }
  }

  const linked: string[] = [];
  const problems: string[] = [];
  for (const dep of SHAREABLE_DEPS) {
    const source = path.join(repoRoot, dep);
    if (!(await isDirectory(source))) continue;
    if (!(await isIgnored(execFn, repoRoot, dep))) {
      // Tracked, so `git worktree add` already materialised it. Linking would
      // replace real content with a pointer elsewhere.
      continue;
    }
    try {
      await fs.symlink(source, path.join(worktreeAbs, dep), "dir");
      linked.push(dep);
    } catch (err) {
      problems.push(`${dep}: ${(err as Error).message?.slice(0, 120)}`);
    }
  }
  if (linked.length > 0) trace(`worktree: linked ${linked.join(", ")} from repoRoot`);
  return {
    via: linked.length > 0 ? "symlink" : "none",
    linked,
    problem: problems.length > 0 ? `could not link ${problems.join("; ")}` : undefined,
  };
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this verify output look like missing dependencies rather than a defect?
 *
 * A develop gate that fails because the worktree has no `node_modules` reports
 * the same shape as one that fails because the diff is wrong, and the operator
 * reads the second. Naming the difference is most of the fix.
 */
export function looksLikeMissingDeps(output: string): boolean {
  return [
    /Cannot find module/i,
    /Could not resolve/i,
    /ModuleNotFoundError/i,
    /command not found/i,
    /No such file or directory.*node_modules/i,
    /error: Cannot find package/i,
  ].some((re) => re.test(output));
}

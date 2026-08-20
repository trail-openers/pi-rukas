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
 *     dogfooding `/work` on itself could not pass its own develop gate until
 *     #481 made discovery look below `repoRoot`.
 *
 * Two mechanisms, in order:
 *
 *   1. `.pi/worktree-setup` — the project says what it needs. No guessing, and
 *      anything the allowlist below cannot express goes here. The hook
 *      receives no arguments and no environment and runs with cwd = the new
 *      worktree; locating `repoRoot` is the hook's own job (e.g. `git
 *      rev-parse --path-format=absolute --git-common-dir`). The hook path
 *      skips the symlink loop — including the `info/exclude` write — so a
 *      hook that creates a symlink must write its own exclude entry or
 *      `stagePorcelainPaths` will stage the link into the PR.
 *   2. Otherwise, symlink a small allowlist of dependency directories that
 *      are gitignored and non-empty, discovered by scanning one level of
 *      package directories for manifests/lockfiles (`extension/`, `pkg/`,
 *      …) as well as `repoRoot` itself. #481: the scan is what lets a
 *      nested-package monorepo — pi-ensemble itself — provision without a
 *      per-clone hook, and it is what stops an EMPTY `node_modules/` at
 *      `repoRoot` from being linked and reported as a useful link.
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

/**
 * Is this path gitignored? Only ignored dirs are safe to link over.
 *
 * Three states, because the probe is one of the load-bearing safety checks
 * in this module — the one that prevents a TRACKED directory of the same
 * name from being shadowed by a link to elsewhere — and `git check-ignore`
 * distinguishes all three:
 *
 *   - exit 0 → IGNORED: linkable.
 *   - exit 1 → NOT-IGNORED: tracked or otherwise visible; never link over it.
 *   - exit ≥ 2 → git itself failed (not a repo, permission error, malformed
 *     path, …). #481's original bug: pre-#481 the probe collapsed exit 1 and
 *     exit ≥2 into one state, so a real git error (e.g. `git check-ignore`
 *     run against a path outside any repo) read as "not ignored" and a
 *     tracked directory was silently treated as a linkable candidate.
 *
 * The seam is preserved: the probe goes through the injected `execFn`, so
 * tests can fake the three states by rejecting with different `code`
 * values. The production `execFn` is `promisify(exec)`, whose rejection
 * carries `.code: <exit status>` on a non-zero exit, so the discrimination
 * is free — the error object is already there, we just inspect it. A
 * rejection with no numeric `.code` (exec itself failed to spawn) is
 * treated as `git-error` (same as ≥2), so a candidate we cannot confirm as
 * ignored is never linked over.
 */
async function isIgnored(execFn: ExecFn, repoRoot: string, rel: string): Promise<boolean> {
  try {
    await execFn(`git check-ignore -q -- ${JSON.stringify(rel)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (typeof code === "number") {
      return gitCheckIgnore(code) === "ignored";
    }
    // No exit code — exec failed to spawn (ENOENT) or the executor itself
    // threw. Same treatment as exit ≥2: unconfirmed, never link over.
    return false;
  }
}

/**
 * `git check-ignore` exit codes, three states: 0 = ignored, 1 = not ignored,
 * ≥2 = git itself failed (treated as not-ignored at the caller — a candidate
 * we cannot confirm as ignored must not be linked over).
 */
function gitCheckIgnore(exitCode: number): "ignored" | "not-ignored" | "git-error" {
  if (exitCode === 0) return "ignored";
  if (exitCode === 1) return "not-ignored";
  return "git-error";
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when the directory has at least one entry.
 *
 * `git check-ignore` answers about the path, not its contents — an EMPTY
 * `node_modules/` at `repoRoot` is gitignored just like a full one, and
 * linking it then reporting `linked: ["node_modules"]` is indistinguishable
 * from success while the worktree is still bare (#481's observed live
 * failure). Empty candidates are skipped before the link, so they are never
 * reported as a useful link.
 */
async function isNonEmptyDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.readdir(abs)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Where a package directory's dependencies end up. `node_modules` is a
 * hard-won invariant of every Node package manager (bun, npm, pnpm);
 * `.venv`/`vendor` have no such convention, so only the root is checked.
 */
function candidatesForDir(dirRel: string): string[] {
  return dirRel === "" ? [...SHAREABLE_DEPS] : SHAREABLE_DEPS.filter((d) => d === "node_modules");
}

/**
 * Manifest/lockfile markers: "this directory is a package", i.e. a place to
 * look for a nested `node_modules`. #481's discovery signal — depth-1
 * directories with any of these are scanned, so a nested-package monorepo
 * provisions without a hook and without knowing its own layout.
 */
const DEPENDENCY_MARKERS = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Gemfile",
];

/**
 * Depth-1 subdirectories of `repoRoot` that contain a dependency marker.
 *
 * Depth-1 only: deeper nesting is where per-worktree scratch (`.worktrees/`)
 * and vendor trees live, and scanning them would re-link the very worktrees
 * this module creates. Unreadable / non-directory `repoRoot` → no candidates.
 */
async function packageDirsAt(repoRoot: string): Promise<string[]> {
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
  const hasMarker = async (dir: string) =>
    DEPENDENCY_MARKERS.some((m) => fileExists(path.join(repoRoot, dir, m)));
  const marked: string[] = [];
  for (const dir of dirs) {
    if (await hasMarker(dir)) marked.push(dir);
  }
  return marked;
}

/**
 * Directories under `repoRoot` that "plainly need dependencies" — a manifest
 * or lockfile at the root, or in a discovered package directory. Drives the
 * `problem` field: a project that needs deps and has none findable gets a
 * trace, not a silent bare worktree.
 */
async function depsExpectedAt(repoRoot: string, packageDirs: string[]): Promise<boolean> {
  const rootHit = await Promise.any(
    DEPENDENCY_MARKERS.map((m) =>
      fileExists(path.join(repoRoot, m)).then((ok) => (ok ? true : Promise.reject())),
    ),
  ).catch(() => false);
  if (rootHit) return true;
  for (const dir of packageDirs) {
    const dirHit = await Promise.any(
      DEPENDENCY_MARKERS.map((m) =>
        fileExists(path.join(repoRoot, dir, m)).then((ok) => (ok ? true : Promise.reject())),
      ),
    ).catch(() => false);
    if (dirHit) return true;
  }
  return false;
}

/**
 * Resolve where each shareable dependency lives: a non-empty, gitignored
 * candidate under `repoRoot` or one of the discovered package directories.
 *
 * The non-empty check is per-location — an empty `node_modules/` at the root
 * is ignored, a full `pkg/node_modules` is linked. A non-ignored candidate
 * is skipped (a tracked directory of the same name is already materialised;
 * linking would shadow real content). The first non-empty ignored candidate
 * wins per dep name; `dirRel === ""` is the `repoRoot` itself.
 */
async function findDepDirs(
  execFn: ExecFn,
  repoRoot: string,
  packageDirs: string[],
): Promise<Map<string, { dirRel: string; source: string }>> {
  const locations: Array<{ dirRel: string; source: string }> = [
    { dirRel: "", source: repoRoot },
    ...packageDirs.map((d) => ({ dirRel: d, source: path.join(repoRoot, d) })),
  ];
  const found = new Map<string, { dirRel: string; source: string }>();
  for (const dep of SHAREABLE_DEPS) {
    for (const { dirRel, source } of locations) {
      if (!candidatesForDir(dirRel).includes(dep)) continue;
      const abs = path.join(source, dep);
      if (!(await isNonEmptyDirectory(abs))) continue;
      if (!(await isIgnored(execFn, repoRoot, path.join(dirRel, dep)))) continue;
      found.set(dep, { dirRel, source: abs });
      break;
    }
  }
  return found;
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

  const packageDirs = await packageDirsAt(repoRoot);
  const found = await findDepDirs(execFn, repoRoot, packageDirs);
  const linked: string[] = [];
  const linkedRel: string[] = [];
  const problems: string[] = [];
  for (const [dep, { dirRel, source }] of found) {
    const target = path.join(worktreeAbs, dirRel, dep);
    try {
      // Nested candidates need their parent directory to exist; `git
      // worktree add` materialises the tracked `extension/` (or `pkg/`), but
      // the mkdir is a no-op when it already does and guards the case where
      // the package directory itself is untracked.
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(source, target, "dir");
      linked.push(dep);
      linkedRel.push(dirRel === "" ? dep : path.join(dirRel, dep));
    } catch (err) {
      problems.push(
        `${dirRel === "" ? dep : path.join(dirRel, dep)}: ${(err as Error).message?.slice(0, 120)}`,
      );
    }
  }
  if (linked.length > 0) {
    const sources = [...found.entries()]
      .map(([dep, f]) => `${path.join(f.dirRel, dep)} → ${f.source}`)
      .join(", ");
    trace(`worktree: linked ${linkedRel.join(", ")} (source: ${sources})`);
    await hideFromGit(execFn, worktreeAbs, linkedRel);
  }
  // #481 — a project that plainly needs dependencies (a manifest/lockfile at
  // the root or in a discovered package directory) but had no gitignored
  // non-empty tree anywhere findable gets a `problem`, not a silent bare
  // worktree. Still never throws: the branch step continues, and the
  // develop gate's missing-deps hint (#445) is the backstop that names the
  // failure to the operator.
  if (found.size === 0 && (await depsExpectedAt(repoRoot, packageDirs))) {
    problems.push(
      "no dependency tree found for a project with a manifest/lockfile — " +
        "worktree will be bare; if the verify command needs dependencies it " +
        "will fail with a module-not-found error",
    );
  }
  return {
    via: linked.length > 0 ? "symlink" : "none",
    linked,
    problem: problems.length > 0 ? `could not link ${problems.join("; ")}` : undefined,
  };
}

/**
 * Make git blind to the links we just created.
 *
 * A `.gitignore` entry of `node_modules/` — the overwhelmingly common form,
 * used by both this repo and every project measured — matches a DIRECTORY.
 * A symlink is not a directory, so the pattern does not match it and the link
 * surfaces as `?? node_modules` in `git status --porcelain`. That is our own
 * scaffolding appearing as if it were the developer's work: `integrate()`
 * stages every path porcelain lists, so the link was staged, captured into
 * the patch as an absolute-path `mode 120000` entry, and applying it at
 * repoRoot failed `Directory not empty` — aborting the whole mechanized
 * integration on every Node or Python project.
 *
 * The exclude goes to `$GIT_COMMON_DIR/info/exclude`, verified as the only
 * one a linked worktree reads: `$GIT_DIR/info/exclude` resolves to
 * `.git/worktrees/<name>/info/exclude`, which git ignores entirely.
 *
 * Best-effort, like the rest of provisioning. `stagePorcelainPaths` refuses
 * escaping symlinks independently, so this is the tidy fix rather than the
 * load-bearing one — worktrees provisioned before this landed are still safe.
 */
async function hideFromGit(execFn: ExecFn, worktreeAbs: string, deps: string[]): Promise<void> {
  try {
    const { stdout } = await execFn("git rev-parse --git-common-dir", {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    const commonDir = path.resolve(worktreeAbs, stdout.trim());
    const excludeFile = path.join(commonDir, "info", "exclude");
    await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    const current = await fs.readFile(excludeFile, "utf8").catch(() => "");
    const have = new Set(current.split("\n").map((l) => l.trim()));
    // No trailing slash: that is the whole point — it must match the symlink.
    const missing = deps.filter((d) => !have.has(d));
    if (missing.length === 0) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await fs.appendFile(excludeFile, `${prefix}${missing.join("\n")}\n`);
    trace(`worktree: excluded ${missing.join(", ")} via ${excludeFile}`);
  } catch (err) {
    trace(`worktree: could not exclude links from git: ${(err as Error).message?.slice(0, 160)}`);
  }
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

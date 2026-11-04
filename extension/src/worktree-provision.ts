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
 *   - Node/bun: the command fails outright. pi-rukas's own verify command
 *     needs `extension/node_modules`, which is gitignored — so pi-rukas
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
 *      nested-package monorepo — pi-rukas itself — provision without a
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
import { NO_HOOKS } from "./lean/specify-reset.ts";
import { NESTED_DEP, SHAREABLE_DEPS } from "./worktree-dep-contract.ts";
import { depsExpectedAt, packageDirsAt, runHookProvisioning } from "./worktree-provision-hook.ts";
import { linkFoundDeps } from "./worktree-provision-verify.ts";

/**
 * The exec shape `worktree.ts` already uses.
 *
 * #1394 — `argv` is part of the contract, not an extra: the `git check-ignore`
 * probe below passes the candidate path as ONE argument. The shell-string form
 * (`git check-ignore -q -- "<rel>"`) re-parses the path in `sh -c`, so a
 * directory whose name contains `$(…)` or backticks EXECUTES. Every production
 * executor honours `argv` via `execFile` (`src/exec.ts` `execp`); a shell-only
 * executor that drops it runs a bare `git` (#1279), which is a wrong answer,
 * not a security hole.
 */
export type ExecFn = (
  cmd: string,
  opts: { cwd?: string; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string }>;

/** Where a project describes provisioning we cannot infer. */
export const WORKTREE_SETUP_HOOK = ".pi/worktree-setup";

/** Never linked, however tempting: concurrent writers would serialise. */
export const NEVER_SHARED = ["target", "build", "dist", ".next", "out"] as const;

export interface ProvisionResult {
  /** How the worktree was provisioned, for the trace and the plumb report. */
  via: "hook" | "symlink" | "none";
  linked: string[];
  /** Set when provisioning was attempted and failed. Never throws. */
  problem?: string;
  /**
   * The hook exited non-zero. Distinct from `problem`, which a hook that
   * exited 0 also carries when the worktree still lacks an expected tree.
   */
  hookFailed?: boolean;
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
/** The three states of `git check-ignore` for `rel` under `repoRoot`. */
export type IgnoreVerdict = "ignored" | "not-ignored" | "git-error";

/**
 * The shared `git check-ignore` probe.
 *
 * Exported so the post-hook verification asks the SAME question the hook asks.
 * Before #1394 the two had separate notions of "is this a dependency we should
 * expect", and they disagreed: the hook skips a non-ignored tree, while the
 * verification still expected a copy of it, so a correctly-behaving hook was
 * reported as one that linked nothing. One probe, one answer, both sides.
 */
export async function ignoredStatus(
  execFn: ExecFn,
  repoRoot: string,
  rel: string,
  // Callers that must not trip a repo's hooks pass `NO_HOOKS`
  // (`lean/specify-reset.ts`); an empty prefix keeps every other caller's argv
  // byte-identical, so the shared probe stays one probe.
  prefix: readonly string[] = [],
): Promise<IgnoreVerdict> {
  try {
    // argv form (#1394): `rel` is a filesystem path this module did not name,
    // and it never passes through a shell.
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      argv: [...prefix, "check-ignore", "-q", "--", rel],
    });
    return "ignored";
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    // No exit code — exec failed to spawn (ENOENT) or the executor itself
    // threw. Same treatment as exit ≥2: unconfirmed, never link over.
    return gitCheckIgnore(typeof code === "number" ? code : 2);
  }
}

async function isIgnored(
  execFn: ExecFn,
  repoRoot: string,
  rel: string,
  prefix: readonly string[] = [],
): Promise<boolean> {
  return (await ignoredStatus(execFn, repoRoot, rel, prefix)) === "ignored";
}

/**
 * `git check-ignore` exit codes, three states: 0 = ignored, 1 = not ignored,
 * ≥2 = git itself failed (the caller treats that as not-linkable — a candidate
 * we cannot confirm as ignored must not be linked over).
 *
 * The three states are computed HERE rather than collapsed at each caller:
 * #481's original bug was a caller folding "not ignored" and "git failed" into
 * one answer, which let a git error read as "safe to skip".
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
 * True when the directory has at least one entry, faults included.
 *
 * `git check-ignore` answers about the path, not its contents — an EMPTY
 * `node_modules/` at `repoRoot` is gitignored just like a full one, and
 * linking it then reporting `linked: ["node_modules"]` is indistinguishable
 * from success while the worktree is still bare (#481's observed live
 * failure). Empty candidates are skipped before the link, so they are never
 * reported as a useful link.
 *
 * A non-`ENOENT` fault (EACCES on the tree, ELOOP, ENOTDIR under a path that
 * exists) is COLLECTED and reported as a `problem` by the symlink path rather
 * than swallowed — "could not look" is not the same answer as "nothing there",
 * and the second is the #481 finding while the first is the #1394 one. The
 * probe-free callers (the hook precondition, `missingDepLocations`' source
 * scan) reach this copy instead of `worktree-provision-verify.ts`'s
 * `resolvedNonEmptyDirectory`, which must stay permissive because it asks the
 * question AFTER a link was made: a link that cannot be resolved is already a
 * `problem` there, and re-throwing would turn a reportable state into a throw.
 */
async function isNonEmptyDirectory(abs: string): Promise<{
  nonEmpty: boolean;
  fault?: string;
}> {
  try {
    return { nonEmpty: (await fs.readdir(abs)).length > 0 };
  } catch (err) {
    // ENOENT is the expected answer for a tree that was never installed.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { nonEmpty: false };
    return { nonEmpty: false, fault: errnoDetail(err) };
  }
}

/** `EACCES: permission denied, scandir '…'` — the code first, then the message. */
function errnoDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  const code = typeof e?.code === "string" ? e.code : "unknown";
  const message = typeof e?.message === "string" ? e.message : String(err);
  // Node's own errno message already begins with the code, so prefixing it
  // printed `EACCES: EACCES: permission denied…`. The code is the token a
  // reader (and a test) greps for, so the code is kept and a duplicated prefix
  // on the message is dropped.
  const detail = message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
  return `${code}: ${detail.slice(0, 120)}`;
}

/**
 * Where a package directory's dependencies end up. `node_modules` is a
 * hard-won invariant of every Node package manager (bun, npm, pnpm);
 * `.venv`/`vendor` have no such convention, so only the root is checked.
 */
function candidatesForDir(dirRel: string): string[] {
  return dirRel === "" ? [...SHAREABLE_DEPS] : SHAREABLE_DEPS.filter((d) => d === NESTED_DEP);
}

/**
 * Resolve where each shareable dependency lives: a non-empty, gitignored
 * candidate under `repoRoot` or one of the discovered package directories.
 *
 * The non-empty check is per-location — an empty `node_modules/` at the root
 * is ignored, a full `pkg/node_modules` is linked. A non-ignored candidate
 * is skipped (a tracked directory of the same name is already materialised;
 * linking would shadow real content). Every non-empty ignored candidate is
 * returned — #1146: a root `node_modules` must not hide a package dir's own
 * tree; `dirRel === ""` is the `repoRoot` itself.
 */
async function findDepDirs(
  execFn: ExecFn,
  repoRoot: string,
  packageDirs: string[],
  prefix: readonly string[] = [],
): Promise<{ found: Array<{ dep: string; dirRel: string; source: string }>; faults: string[] }> {
  const locations: Array<{ dirRel: string; source: string }> = [
    { dirRel: "", source: repoRoot },
    ...packageDirs.map((d) => ({ dirRel: d, source: path.join(repoRoot, d) })),
  ];
  const found: Array<{ dep: string; dirRel: string; source: string }> = [];
  const faults: string[] = [];
  for (const dep of SHAREABLE_DEPS) {
    for (const { dirRel, source } of locations) {
      if (!candidatesForDir(dirRel).includes(dep)) continue;
      const abs = path.join(source, dep);
      const probe = await isNonEmptyDirectory(abs);
      // The path is named first so a fault about one tree is never ambiguous
      // with another; `slice` bounds the whole string, not the code.
      if (probe.fault !== undefined) faults.push(`${path.join(dirRel, dep)}: ${probe.fault}`);
      if (!probe.nonEmpty) continue;
      if (!(await isIgnored(execFn, repoRoot, path.join(dirRel, dep), prefix))) continue;
      found.push({ dep, dirRel, source: abs });
    }
  }
  return { found, faults };
}

/**
 * Give a new worktree what it needs to run the project's own commands.
 *
 * Returns what it did rather than throwing: the caller records it and carries
 * on either way.
 *
 * #1394 — "rather than throwing" is the contract, not an aspiration, and it is
 * total. The contract above says provisioning never fails the branch step, and a
 * rejected promise here did exactly that: `worktreeCreate` propagated it, the
 * mechanized branch setup failed, and the branch step fell to the LLM ops
 * dispatch — or halted. So EVERY filesystem probe and every git call this
 * function makes goes through something that turns a fault into a `problem`
 * string: `findDepDirs` collects probe faults, the link loop catches per link,
 * `depsExpectedAt` / `packageDirsAt` swallow theirs, and every probe exported
 * from `worktree-provision-verify.ts` (`resolvedNonEmptyDirectory`,
 * `anyLinkableSharedSource`, `expectedDepLocations`) absorbs its own errno into
 * a reported field — a fault there never reaches this function as a rejection.
 * A `repoRoot` this cannot read is reported (`via: "none"` with a fault), never
 * propagated.
 */
export async function provisionWorktree(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
): Promise<ProvisionResult> {
  // Built here, next to the read: `test-headless-inputs.ts` recognises a
  // `.pi/<file>` as read only when a join of its const sits within two lines of
  // the fs call, so hoisting this away makes the hook look unread.
  // ENOENT — the normal answer for a project with no hook — stays quiet; any
  // other fault reaching here would be one this module cannot explain, and
  // `stat` is the one call in this function not already wrapped.
  const hookExists = await fileExists(path.join(repoRoot, WORKTREE_SETUP_HOOK));
  // #545 — an unreadable repoRoot is not a provisioning failure; it means
  // the worktree was never actually created (e.g. the `ExecFn` is a test
  // fixture that never materialises the directory). Skip provisioning and
  // report via: "none" so the caller's `worktreeCreate` still returns.
  // #1394 — "could not read" (EACCES) is reported with its errno rather than
  // reported as "absent", because the operator's fix differs.
  if (!(await isDirectory(repoRoot))) {
    const unreadable = await unreadableRootDetail(repoRoot);
    return {
      via: "none",
      linked: [],
      problem:
        unreadable === undefined
          ? undefined
          : `could not read repoRoot ${repoRoot} — ${unreadable}; nothing was linked and the worktree will be bare`,
    };
  }
  if (hookExists) {
    return runHookProvisioning(
      execFn,
      repoRoot,
      worktreeAbs,
      path.join(repoRoot, WORKTREE_SETUP_HOOK),
    );
  }

  const packageDirs = await packageDirsAt(repoRoot);
  const { found, faults } = await findDepDirs(execFn, repoRoot, packageDirs);
  return linkFoundDeps(execFn, worktreeAbs, found, faults, {
    // #481 — a project that plainly needs dependencies (a manifest/lockfile at
    // the root or in a discovered package directory) but had no gitignored
    // non-empty tree anywhere findable gets a `problem`, not a silent bare
    // worktree. Still never throws: the branch step continues, and the
    // develop gate's missing-deps hint (#445) is the backstop that names the
    // failure to the operator.
    reportNeeds: (await depsExpectedAt(repoRoot, packageDirs))
      ? "no dependency tree found for a project with a manifest/lockfile — " +
        "worktree will be bare; if the verify command needs dependencies it " +
        "will fail with a module-not-found error"
      : undefined,
  });
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
/**
 * Make git blind to the links we just created.
 *
 * A `.gitignore` entry of `node_modules/` — the overwhelmingly common form,
 * used by both this repo and every project measured — matches a DIRECTORY.
 * A symlink is not a directory, so the pattern does not match it and the link
 * surfaces as `?? node_modules` in `git status --porcelain`. That is our own
 * scaffolding appearing as if it were the developer's work:
 * `stagePorcelainPaths` stages every path porcelain lists, so the link was
 * staged, captured into the patch as an absolute-path `mode 120000` entry, and
 * applying it at repoRoot failed `Directory not empty` — aborting the whole
 * mechanized integration on every Node or Python project.
 *
 * The exclude goes to `$GIT_COMMON_DIR/info/exclude`, verified as the only one
 * a linked worktree reads: `$GIT_DIR/info/exclude` resolves to
 * `.git/worktrees/<name>/info/exclude`, which git ignores entirely.
 *
 * Best-effort, like the rest of provisioning. `stagePorcelainPaths` refuses
 * escaping symlinks independently, so this is the tidy fix rather than the
 * load-bearing one — worktrees provisioned before this landed are still safe.
 */
async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Symlink the shareable dependency dirs into `worktreeAbs` — the symlink half
 * of {@link provisionWorktree}, on its own.
 *
 * The caller that needs the half and not the whole is the reviewer tree
 * (#1975): a reviewer child runs the project's targeted checks, so it needs
 * `node_modules`, but a throwaway directory another process's bash can reach
 * must not have the project's `.pi/worktree-setup` executed in it. The hook
 * branch of `provisionWorktree` is deliberately absent here — symlinks only,
 * never a hook.
 *
 * Same contract as the whole: never throws; reports what it linked and why it
 * could not.
 */
export async function linkShareableDeps(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
): Promise<ProvisionResult> {
  const packageDirs = await packageDirsAt(repoRoot);
  const { found, faults } = await findDepDirs(execFn, repoRoot, packageDirs, NO_HOOKS);
  return linkFoundDeps(execFn, worktreeAbs, found, faults);
}

/**
 * Why `repoRoot` could not be read, or `undefined` when it is simply absent.
 *
 * `isDirectory` cannot tell "no such directory" from "not permitted to look"
 * — both fail — and the two need different sentences: the first means the
 * worktree was never created (#545, a test fixture), the second means a real
 * tree is there and something has it locked. Best-effort: this probe failing
 * too just reports the absent case, which is the pre-#1394 behaviour.
 */
async function unreadableRootDetail(repoRoot: string): Promise<string | undefined> {
  try {
    await fs.stat(repoRoot);
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return errnoDetail(err);
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

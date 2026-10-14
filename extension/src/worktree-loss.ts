/**
 * worktree-loss — the #475 no-loss rule for existing worktrees (split from
 * worktree.ts for the AGENTS.md §12 500-line cap).
 *
 * `worktreeCreate` and its sibling scan must not force-remove a worktree that
 * holds work git cannot recover. The rule (#1170):
 *
 *  - A directory is inspected only when it is its OWN worktree root: a
 *    `<abs>/.git` exists and `git rev-parse --show-toplevel` resolves to
 *    `<abs>`. A plain directory inside a repo (git walks up to the parent) is
 *    not a worktree and is never treated as clean.
 *  - Uncommitted work is any entry of `git status --porcelain --ignored=traditional
 *    --untracked-files=normal`: tracked and untracked changes always are. Ignored
 *    entries are loss UNLESS they are (a) a symlink (a provisioned link), or
 *    (b) exactly `node_modules/`, `.venv/` or `vendor/` — the collapsed
 *    directory — at the worktree root, or directly inside a depth-1 directory
 *    that holds a package manifest/lockfile. Everything else ignored (`build/`,
 *    `dist/`, `target/`, any ignored file, any file under any directory) is loss:
 *    refusing is safe, because nothing is deleted on a refusal.
 *  - The `--ignored=traditional` collapse keeps the output bounded: an ignored
 *    `target/` tree is one `!! target/` line, not one line per file.
 *  - With no uncommitted work, the worktree is no-loss when HEAD is an ancestor
 *    of `<fromRef>` (nothing HEAD has that the base lacks), OR when HEAD is
 *    exactly one commit ahead of `<fromRef>` and its tree equals `<fromRef>^{tree}`
 *    (a single tree-identical develop commit). Any other history ahead counts as
 *    loss — a commit that adds a file and a later commit that removes it leaves
 *    the tree identical while the history is not.
 *  - ANY git error on those reads counts as loss and keeps the refusal. An
 *    unreadable worktree is not evidence that it is clean. Trade-off (#1170):
 *    an unreadable leftover now blocks the cycle instead of being removed —
 *    fail closed beats the old wedged-queue avoidance.
 *  - Git calls are shell strings. A ref is JSON-quoted into one, and
 *    worktree-create-guard rejects any ref outside a safe charset before a
 *    create runs (no ref reaches a shell unvalidated).
 *  - A path with no directory on disk is not a worktree — nothing to inspect.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExecFn } from "./worktree.ts";

/**
 * A leftover worktree holds work we would otherwise destroy.
 *
 * `worktreeCreate` pre-removes an existing worktree at the same path so a
 * resumed cycle is not wedged by its own leftover — but a `git worktree remove
 * --force` does not check what it is removing. The develop step instructs
 * developers not to commit, so a cycle that died mid-develop leaves its diff
 * uncommitted in the worktree: not in the object database, unrecoverable
 * (#475). The force-remove destroyed it with no warning, and deleting
 * unrecoverable work must never be the silent default.
 */
export class DirtyWorktreeError extends Error {
  /** The absolute worktree path and what it holds — the plumb report and the
   * #545 same-issue salvage use this instead of re-scanning the name. */
  readonly finding: DirtyWorktreeFinding;

  constructor(finding: DirtyWorktreeFinding) {
    super(DirtyWorktreeError.messageFor(finding));
    this.name = "DirtyWorktreeError";
    this.finding = finding;
  }

  static messageFor(finding: DirtyWorktreeFinding): string {
    // If the worktree is being retained, return a retention message.
    if (finding.retained === true) {
      return `refusing to pre-remove retained worktree ${finding.path} — it is in the retained names set`;
    }
    const fromRef =
      finding.unpushedCommitCount > 0 ? ` (unpushed commits: ${finding.unpushedCommitCount})` : "";
    const parts = [
      `refusing to force-remove existing worktree ${finding.path} — it holds unrecoverable work:`,
      finding.notOwnWorktree === true
        ? "(not a worktree of its own — git does not report this directory as its own toplevel)"
        : "",
      finding.uncommittedFiles.length > 0
        ? `${finding.uncommittedFiles.length} uncommitted file(s): ${finding.uncommittedFiles
            .slice(0, 8)
            .join(", ")}${finding.uncommittedFiles.length > 8 ? ", …" : ""}`
        : "",
      fromRef,
      finding.treeDiffers === true && finding.uncommittedFiles.length === 0
        ? "(its tree differs from the base)"
        : "",
      finding.inspectError !== undefined
        ? `(git could not read it — treated as loss: ${finding.inspectError})`
        : "",
    ].filter(Boolean);
    parts.push(
      "Inspect the worktree (`git status`, `git diff`), salvage the work (e.g. `git diff > patch` or commit it to a branch), then remove it (`git worktree remove --force -- <path>`) and re-run.",
    );
    return parts.join(" ");
  }
}

export interface DirtyWorktreeFinding {
  path: string;
  uncommittedFiles: string[];
  unpushedCommitCount: number;
  /** True when the worktree is being retained (not removed) due to being in the retained names set. */
  retained?: boolean;
  /** True when `HEAD^{tree}` differs from `<fromRef>^{tree}`. */
  treeDiffers?: boolean;
  /** Set when a git read failed — the worktree is refused, not assumed clean. */
  inspectError?: string;
  /** True when the directory is not its own worktree root (#1170). */
  notOwnWorktree?: boolean;
}

export interface InspectOpts {
  /**
   * Whether ignored entries count as loss. `true` (default) for every REMOVAL
   * decision. `false` only for trees the cycle itself owns and never removes
   * (the integrate step's in-cycle develop trees): an ignored `target/` there
   * is a build artefact, not a reason to refuse the integration.
   */
  ignoredIsLoss?: boolean;
}

/** Directories whose ignored form is a regenerable dependency tree. */
const REGENERABLE_DIR_NAMES = new Set(["node_modules", ".venv", "vendor"]);

/** A depth-1 directory holding one of these is a project whose tree may be exempted. */
const PROJECT_MANIFESTS = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const raw = String(e?.stderr ?? e?.message ?? err).trim();
  return raw.replace(/^\s*Command failed:\s*.*\n?/s, "").trim() || "unknown git error";
}

/**
 * Whether one ignored porcelain entry is a regenerable dependency tree (or a
 * provisioned link) rather than work. Entries arrive with the collapsed
 * directory's trailing slash already stripped.
 */
async function isRegenerableIgnored(worktreeAbs: string, entry: string): Promise<boolean> {
  const full = path.join(worktreeAbs, entry);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(full);
  } catch {
    return false; // unstattable: cannot prove it is a link or a regenerable tree
  }
  if (st.isSymbolicLink()) return true;
  if (!st.isDirectory()) return false; // an ignored FILE is never regenerable
  const segs = entry.split("/");
  if (!REGENERABLE_DIR_NAMES.has(segs[segs.length - 1] ?? "")) return false;
  if (segs.length === 1) return true; // root node_modules/, .venv/, vendor/
  if (segs.length === 2) {
    // A dependency tree directly inside a depth-1 project directory.
    for (const manifest of PROJECT_MANIFESTS) {
      if (await pathExists(path.join(worktreeAbs, segs[0] ?? "", manifest))) return true;
    }
  }
  return false;
}

/**
 * Which porcelain entries are uncommitted work. Tracked and untracked changes
 * always are. Ignored entries are work unless `isRegenerableIgnored` exempts
 * them — and not at all when `ignoredIsLoss` is false.
 */
async function uncommittedEntries(
  worktreeAbs: string,
  porcelain: string,
  ignoredIsLoss: boolean,
): Promise<string[]> {
  const out: string[] = [];
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    if (status !== "!!") {
      out.push(line.trim());
      continue;
    }
    if (!ignoredIsLoss) continue;
    const entry = line.slice(3).replace(/\/$/, "");
    if (await isRegenerableIgnored(worktreeAbs, entry)) continue;
    out.push(line.trim());
  }
  return out;
}

/**
 * Inspect an existing worktree for work a force-remove would destroy.
 *
 * Returns `undefined` only when the worktree is provably no-loss (see the
 * module header). Otherwise returns a finding — including the case where a git
 * read failed, which is reported through `inspectError` rather than thrown.
 */
export async function inspectWorktreeForLoss(
  execFn: ExecFn,
  _repoRoot: string,
  worktreeAbs: string,
  fromRef: string,
  opts: InspectOpts = {},
): Promise<DirtyWorktreeFinding | undefined> {
  const ignoredIsLoss = opts.ignoredIsLoss !== false;
  const unreadable = (err: unknown): DirtyWorktreeFinding => ({
    path: worktreeAbs,
    uncommittedFiles: [],
    unpushedCommitCount: 0,
    inspectError: errorText(err),
  });
  // A path with no directory is not a worktree — nothing on disk to inspect.
  if (!(await pathExists(worktreeAbs))) return undefined;
  const notOwn: DirtyWorktreeFinding = {
    path: worktreeAbs,
    uncommittedFiles: [],
    unpushedCommitCount: 0,
    notOwnWorktree: true,
  };
  // A directory on disk must be its OWN worktree root, checked before any other
  // read (#1170). A plain directory under a repo would otherwise resolve git's
  // parent repo and be read as that repo's clean worktree.
  if (!(await pathExists(path.join(worktreeAbs, ".git")))) return notOwn;
  let toplevel: string;
  try {
    ({ stdout: toplevel } = await execFn("git rev-parse --show-toplevel", {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    }));
  } catch (err) {
    return unreadable(err);
  }
  const top = await realpathOrUndefined(toplevel.trim());
  const own = await realpathOrUndefined(worktreeAbs);
  if (top === undefined || own === undefined || top !== own) return notOwn;
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify("HEAD")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
  } catch (err) {
    return unreadable(err);
  }

  let porcelain: string;
  let headTree: string;
  let baseTree: string;
  let ahead: number;
  try {
    ({ stdout: porcelain } = await execFn(
      "git status --porcelain --ignored=traditional --untracked-files=normal",
      {
        cwd: worktreeAbs,
        maxBuffer: 8 * 1024 * 1024,
      },
    ));
    ({ stdout: headTree } = await execFn(`git rev-parse ${JSON.stringify("HEAD^{tree}")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    }));
    // Worktrees share the repo's object database: the base tree resolves the
    // same from inside the worktree as from repoRoot.
    ({ stdout: baseTree } = await execFn(`git rev-parse ${JSON.stringify(`${fromRef}^{tree}`)}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    }));
    const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(`${fromRef}..HEAD`)}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    // Zero commits HEAD has and fromRef lacks ⟺ HEAD is an ancestor of fromRef.
    ahead = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) throw new Error(`unreadable commit count: ${stdout}`);
  } catch (err) {
    return unreadable(err);
  }
  const treeDiffers = headTree.trim() !== baseTree.trim();
  const files = await uncommittedEntries(worktreeAbs, porcelain, ignoredIsLoss);
  if (files.length > 0) {
    return { path: worktreeAbs, uncommittedFiles: files, unpushedCommitCount: ahead, treeDiffers };
  }
  if (ahead === 0) return undefined; // HEAD is an ancestor of the base: nothing unique to HEAD
  if (ahead === 1 && !treeDiffers) return undefined; // one tree-identical commit (the develop output)
  return { path: worktreeAbs, uncommittedFiles: [], unpushedCommitCount: ahead, treeDiffers };
}

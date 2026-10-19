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
 *    entries are loss UNLESS they are (a) a symlink (a provisioned link),
 *    (b) exactly `node_modules/`, `.venv/` or `vendor/` — the collapsed
 *    directory — at the worktree root, or directly inside a depth-1 directory
 *    that holds a package manifest/lockfile, or (c) an ignored DIRECTORY — a
 *    build/regenerable output tree (measured: `!! dist/`, `!! build/`,
 *    `!! coverage/`, `!! .pytest_cache/`). The exemption is for the collapsed
 *    directory as a whole: an ALL-ignored `vendor/` is exempt by design and git
 *    never enumerates its contents, so they are neither inspected nor counted as
 *    loss. A `vendor/` with any tracked file IS enumerated, and its ignored FILES
 *    are loss — a `!! vendor/.env` is a secret, not output (test 6 in
 *    test-worktree-loss-1170.ts). An ignored FILE at any other path is loss too,
 *    and so is anything inside a tracked or partly tracked directory that git
 *    enumerates as a file. Refusing stays safe, because nothing is deleted on a
 *    refusal; exempting the directory form is what stopped a worktree where a
 *    build had simply run blocking the next cycle for that issue (#1642 run 6:
 *    a same-issue leftover whose only dirt was `!! dist/` parked `step-failed:branch`).
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
 *  - Git calls are shell strings. A ref is JSON-quoted into one, and EVERY
 *    function in this module or worktree-create-guard that interpolates a ref
 *    validates it with `assertSafeRef` before the first shell call:
 *    `inspectWorktreeForLoss` (an unsafe ref is a finding with `inspectError`,
 *    so it fails closed) and `runCreateGuards`. No ref reaches a shell
 *    unvalidated.
 *  - A path with no directory on disk is not a worktree — nothing to inspect.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExecFn } from "./worktree.ts";

/**
 * The refusal wording a dirty-worktree guard records — exported so the cause
 * classifier (#1642) recognises the branch step's refusal from the SAME
 * constant the producer writes, instead of a hand-copied phrase that drifts.
 */
export const DIRTY_WORKTREE_REFUSAL_MARK = "refusing to force-remove existing worktree";

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
      `${DIRTY_WORKTREE_REFUSAL_MARK} ${finding.path} — it holds unrecoverable work:`,
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

/**
 * #1170 — `git worktree list` could not be read, so the same-issue sibling scan
 * cannot prove the absence of a dirty sibling. A refusal of its own: there is
 * no worktree path to name, so it is NOT a DirtyWorktreeError.
 */
export class WorktreeScanError extends Error {
  constructor(detail: string) {
    super(`git worktree list failed, so same-issue siblings could not be scanned: ${detail}`);
    this.name = "WorktreeScanError";
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
  /**
   * #1642 — whether a git-COLLAPSED ignored DIRECTORY (`!! dist/`, `!! build/`,
   * a wholly ignored `target/`) counts as loss. `false` (the default, and the
   * #1642 fix) for the branch step's same-issue residue pass and the
   * worktreeCreate pre-remove: there, a worktree whose only dirt was build
   * output blocked the next cycle for that issue forever, even though the
   * output is regenerable (`bun run build`) and this repo's own
   * `.pi/worktree-setup` generates `dist/prompts/` in every tree it provisions.
   *
   * `true` is passed by the STALE-INTEGRATE-TREE check only: that tree is not
   * one a verify run ever builds in (see `keepOrRefuseStaleIntegrateTree`), so
   * build output sitting in it is an operator's or the ops fallback's artefact
   * in a driver-owned tree, not residue the driver itself produced — and a
   * refusal costs the operator nothing.
   *
   * An ignored FILE git enumerated (`!! .env`, `!! vendor/.env`) is loss under
   * BOTH settings: this option only ever exempts the collapsed-directory form.
   */
  collapsedDirIsLoss?: boolean;
}

/** Dependency trees exempted wherever they sit — a symlink or a directory. */
const REGENERABLE_DIR_NAMES = new Set(["node_modules", ".venv", "vendor"]);

/**
 * #1642 (interactive #1557) — the collapsed-entry shapes that git itself
 * reports for an entire ignored subtree: `!! dist/` and `!! node_modules/`.
 * A porcelain entry is three characters — two status columns and the space —
 * then the path, so a TRAILING SLASH can only mean git collapsed a whole
 * directory: it never prints one for a file it enumerated. That is exactly the
 * shape a regenerable build tree takes (`!! dist/`, `!! build/`,
 * `!! coverage/`), and the shape `isRegenerableIgnored` judges.
 *
 * A tracked file anywhere inside prevents the collapse and makes git enumerate
 * the ignored files individually, so a collapsed entry is never a secret or a
 * source file hiding behind an exempted name — those arrive as file entries and
 * stay loss. Entries without the slash (an ignored file, or anything git
 * enumerated rather than collapsed) are judged the old way.
 */
const COLLAPSED_DIR_SUFFIX = /\/$/;

/** A ref name made only of characters that are inert inside double quotes. */
const SAFE_REF = /^[A-Za-z0-9._\/^{}~@+-]+$/;

/**
 * Throw unless `ref` is a plain ref name safe to interpolate into a shell
 * string. Every caller that puts a ref into a git command line calls this
 * first (#1170) — the charset is the only thing standing between a ref and
 * `$(…)` expansion.
 */
export function assertSafeRef(ref: string): void {
  if (!SAFE_REF.test(ref) || ref.startsWith("-")) {
    throw new Error(`base ref ${JSON.stringify(ref)} is not a valid ref name`);
  }
}

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
 * Whether one ignored porcelain entry is a regenerable tree (or a provisioned
 * link) rather than work.
 *
 * `collapsedDir` says git reported this entry as a WHOLE ignored directory —
 * `!! dist/` — rather than as one file it enumerated. It is derived from the
 * porcelain line itself (the raw trailing slash), never from the filesystem:
 * the driver may inspect a tree it has since removed, and git's own collapse
 * IS the proof that nothing tracked lives inside.
 *
 * Exempt: (a) any symlink — a provisioned link; (b) a dependency tree
 * (`node_modules`/`.venv`/`vendor`) at the root or inside a depth-1 project
 * directory, whatever shape git reported it in; (c) an ignored directory that
 * git COLLAPSED to one line, i.e. a build/regenerable output tree such as
 * `dist/` (#1642). Not exempt: any ignored FILE git enumerated — `!! .env`,
 * `!! vendor/.env` — which is content, not output.
 */
async function isRegenerableIgnored(
  worktreeAbs: string,
  entry: string,
  collapsedDir: boolean,
): Promise<boolean> {
  const full = path.join(worktreeAbs, entry);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(full);
  } catch {
    // #1642 — git just listed it, so it exists; the tree may have been removed
    // since. When git itself collapsed the entry to a whole directory, that
    // answer stands on its own and the stat is not needed to trust it.
    return collapsedDir === true;
  }
  if (st.isSymbolicLink()) return true;
  const segs = entry.split("/");
  if (REGENERABLE_DIR_NAMES.has(segs[segs.length - 1] ?? "")) {
    if (!st.isDirectory()) return false;
    if (segs.length === 1) return true; // root node_modules/, .venv/, vendor/
    if (segs.length === 2) {
      // A dependency tree directly inside a depth-1 project directory.
      for (const manifest of PROJECT_MANIFESTS) {
        if (await pathExists(path.join(worktreeAbs, segs[0] ?? "", manifest))) return true;
      }
    }
    return false;
  }
  // An ignored FILE is never regenerable; only a git-COLLAPSED directory is.
  if (!st.isDirectory() || !collapsedDir) return false;
  return true;
}

/**
 * Which porcelain entries are uncommitted work. Tracked and untracked changes
 * always are. Ignored entries are work unless `isRegenerableIgnored` exempts
 * them — and not at all when `ignoredIsLoss` is false. A collapsed DIRECTORY is
 * exempted unless `collapsedDirIsLoss` is explicitly true (#1642).
 */
async function uncommittedEntries(
  worktreeAbs: string,
  porcelain: string,
  ignoredIsLoss: boolean,
  collapsedDirIsLoss: boolean,
): Promise<string[]> {
  const out: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    if (status !== "!!") {
      out.push(line.trim());
      continue;
    }
    if (!ignoredIsLoss) continue;
    const raw = line.slice(3);
    const entry = raw.replace(/\/$/, "");
    const collapsed = COLLAPSED_DIR_SUFFIX.test(raw);
    // The dependency-tree / provisioned-link exemptions always apply; the
    // collapsed-DIRECTORY exemption (#1642) is the one the caller can veto.
    if (await isRegenerableIgnored(worktreeAbs, entry, collapsed && !collapsedDirIsLoss)) {
      continue;
    }
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
  const collapsedDirIsLoss = opts.collapsedDirIsLoss === true;
  const unreadable = (err: unknown): DirtyWorktreeFinding => ({
    path: worktreeAbs,
    uncommittedFiles: [],
    unpushedCommitCount: 0,
    inspectError: errorText(err),
  });
  // #1170 — `fromRef` is interpolated into shell strings below. An unsafe ref
  // is refused as an unreadable worktree (fail closed), before any command runs.
  try {
    assertSafeRef(fromRef);
  } catch (err) {
    return unreadable(err);
  }
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
  const files = await uncommittedEntries(worktreeAbs, porcelain, ignoredIsLoss, collapsedDirIsLoss);
  if (files.length > 0) {
    return {
      path: worktreeAbs,
      uncommittedFiles: files,
      unpushedCommitCount: ahead,
      treeDiffers,
    };
  }
  if (ahead === 0) return undefined; // HEAD is an ancestor of the base: nothing unique to HEAD
  if (ahead === 1 && !treeDiffers) return undefined; // one tree-identical commit (the develop output)
  return {
    path: worktreeAbs,
    uncommittedFiles: [],
    unpushedCommitCount: ahead,
    treeDiffers,
  };
}

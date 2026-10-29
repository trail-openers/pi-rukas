#!/usr/bin/env bun
/**
 * lean/specify-tree — the worktree the specify child works in, and the
 * CAPTURE / RESET / REWRITE primitives the step drives it with.
 *
 * Four jobs, all deterministic git/file facts with no model in the loop:
 *
 *   1. `ensureSpecifyWorktree` — a path nobody has to guess (`<repoRoot>/
 *      .worktrees/lean-<issue>`), created at the run's base sha, plus
 *      `assertSpecifyWorktreeOwned`, which refuses a path at that location
 *      that the step does not own. A directory someone else made is not the
 *      step's to `reset --hard`.
 *   2. `validateSubmitRows` — the boundary a `submit_tests` row has to pass
 *      before the step believes a file is a test the child wrote (see
 *      submit-tests-extract.ts for the reading half), including the
 *      filesystem check that a kept path is an ordinary file of the worktree.
 *   3. `captureTestBytes` (in specify-capture.ts) — the ONLY thing that
 *      survives from the child: the bytes of each kept file, read into memory
 *      through one descriptor per file, so a link swapped in after validation
 *      is refused rather than followed.
 *   4. `resetWorktreeToBase` — discard child commits, staged changes,
 *      untracked files and ignore tricks, then PROVE the tree is at base and
 *      clean, or throw. A reset nobody confirmed is a claim, not a fact.
 *
 * The worktree itself is created through `worktreeCreate` from ../worktree.ts
 * — so it gets the driver's pre-add guards and its dependency provisioning,
 * which is what lets the project's own runner execute inside a tree that is
 * otherwise only tracked files.
 *
 * Every git call here is argv form: the worktree path and the base sha come
 * from the run, and neither is allowed to become a word a shell re-parses.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { provisionWorktree } from "../worktree-provision.ts";
import { type ExecFn, worktreeCreate, worktreePath } from "../worktree.ts";
import type { PiSpec } from "./spec.ts";
import { resetWorktreeToBase } from "./specify-reset.ts";
import type { SubmitTestsRow } from "./submit-tests-extract.ts";

/** The worktree directory name for one issue's specify step. */
export function specifyWorktreeName(issue: number): string {
  return `lean-${issue}`;
}

/** The worktree path for one issue, derived rather than remembered. */
export function specifyWorktreePath(repoRoot: string, issue: number): string {
  return worktreePath(repoRoot, specifyWorktreeName(issue));
}

/** The branch the specify worktree sits on; a run with no branch gets this. */
export function specifyBranch(runBranch: string, issue: number): string {
  return runBranch.trim() === "" ? `lean/issue-${issue}` : runBranch.trim();
}

/** True when the worktree directory is there (a re-run after a crash). */
export function worktreeExists(wt: string): boolean {
  return existsSync(wt);
}

/** `git worktree list --porcelain` from `repoRoot`: every registered path. */
async function registeredWorktreePaths(
  exec: ExecFn,
  repoRoot: string,
): Promise<string[] | undefined> {
  let stdout: string | undefined;
  try {
    const r = await exec("git", {
      argv: ["worktree", "list", "--porcelain"],
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = r.stdout;
  } catch {
    // Unreadable listing is NOT "no worktrees here" — the caller refuses.
    return undefined;
  }
  const out: string[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    try {
      out.push(realpathSync(line.slice("worktree ".length).trim()));
    } catch {
      // A path that cannot be resolved simply is not the one we are looking for.
    }
  }
  return out;
}

/**
 * The precondition for a worktree that is ALREADY there: this step owns it, or
 * the step does not touch it.
 *
 * `.worktrees/lean-<issue>` is a name another tool — or a human — can also
 * use. `reset --hard` and `clean -fdx` in a tree the step does not own destroys
 * somebody else's work, so ownership is PROVEN rather than inferred from the
 * directory existing: the path appears in `git worktree list --porcelain` of
 * this repo, and its HEAD is either the run's branch or detached at the base
 * sha. Anything else, including an unreadable listing, throws before a single
 * mutation, and the foreign tree is left exactly as found.
 */
export async function assertSpecifyWorktreeOwned(
  exec: ExecFn,
  opts: { repoRoot: string; wt: string; baseSha: string; branch: string },
): Promise<void> {
  const foreign = `the directory ${opts.wt} is not a worktree of this repository at ${opts.branch} or ${opts.baseSha} — refusing to reset a tree this step does not own`;
  const registered = await registeredWorktreePaths(exec, opts.repoRoot);
  if (registered === undefined) throw new Error(foreign);
  let real: string;
  try {
    real = realpathSync(opts.wt);
  } catch {
    throw new Error(foreign);
  }
  if (!registered.includes(real)) throw new Error(foreign);
  const head = await exec("git", {
    argv: ["rev-parse", "HEAD"],
    cwd: opts.wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  if (head === undefined) throw new Error(foreign);
  if ((head.stdout ?? "").trim() !== opts.baseSha) throw new Error(foreign);
  const symbolic = await exec("git", {
    argv: ["symbolic-ref", "--short", "-q", "HEAD"],
    cwd: opts.wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "" }));
  const on = (symbolic.stdout ?? "").trim();
  if (on !== "" && on !== opts.branch) throw new Error(foreign);
}

/**
 * Put the specify worktree in a known state at `fromRef`, returning its path
 * and the provisioning result that says which dependency links the tree has.
 *
 * Missing → created. Present → owned-checked, then reset to the base.
 */
export async function ensureSpecifyWorktreeWithProvision(
  exec: ExecFn,
  opts: { repoRoot: string; issue: number; fromRef: string; branch: string },
): Promise<{ wt: string; linked: string[]; problem?: string }> {
  const wt = specifyWorktreePath(opts.repoRoot, opts.issue);
  if (worktreeExists(wt)) {
    await assertSpecifyWorktreeOwned(exec, {
      repoRoot: opts.repoRoot,
      wt,
      baseSha: opts.fromRef,
      branch: opts.branch,
    });
    // The reset cleans WITHOUT exemptions — `git clean -fdx` takes the
    // dependency links too — and provisioning then builds them again, which
    // also re-writes the `info/exclude` entries. One code path for a created
    // tree and a leftover one, so neither can keep a link the other did not.
    await resetWorktreeToBase(exec, wt, opts.fromRef, opts.branch);
    const provision = await provisionWorktree(exec, opts.repoRoot, wt);
    return { wt, linked: provision.linked, ...problemOf(provision) };
  }
  const name = specifyWorktreeName(opts.issue);
  const created = await worktreeCreate(exec, {
    repoRoot: opts.repoRoot,
    name,
    fromRef: opts.fromRef,
  });
  const tree = created.path;
  // The step owns the tree outright (see `resetWorktreeToBase`), so the branch
  // is pointed at the base rather than left detached at it — the commit that
  // freezes the tests is then a commit ON the run's branch. `resetWorktreeToBase`
  // does the `-B` and the `--hard` together and then proves the tree got there.
  await resetWorktreeToBase(exec, tree, opts.fromRef, opts.branch);
  const provision = await provisionWorktree(exec, opts.repoRoot, tree);
  return { wt: tree, linked: provision.linked, ...problemOf(provision) };
}

/** The `problem` field of a provisioning result, spread only when present. */
function problemOf(p: { problem?: string }): { problem?: string } {
  return p.problem === undefined ? {} : { problem: p.problem };
}

/** A porcelain `v1 -z` record: the status letters and the path. */
export interface PorcelainEntry {
  status: string;
  path: string;
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * NUL-terminated records with no quoting or escaping, which is the only
 * porcelain shape that survives a path containing a space, a quote or a
 * newline. A rename/copy record (`R`/`C`) carries its source as a second
 * NUL-terminated field, which is consumed here so it never reaches a caller
 * as a phantom path.
 */
export function parsePorcelainZ(out: string): PorcelainEntry[] {
  const fields = out.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec === undefined || rec === "") continue;
    // `XY <space> path`: two status letters, a space, then the path.
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy[0] === " " && xy[1] === " ") continue;
    if (xy[0] === "R" || xy[0] === "C") i++; // its source path is the next field
    entries.push({ status: xy, path: p });
  }
  return entries;
}

/** Paths git reports as changed, added or deleted in `wt` (base-relative). */
export async function changedPaths(exec: ExecFn, wt: string): Promise<PorcelainEntry[]> {
  const { stdout } = await exec("git", {
    argv: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: wt,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePorcelainZ(stdout ?? "");
}

/** A directory segment the step never accepts a test file inside. */
const FORBIDDEN_SEGMENTS = [".pi", ".git", "node_modules"] as const;

/**
 * Why a NORMALISED relative path is not an acceptable test file, or undefined
 * when it is. Absolute paths are caught by the caller before normalisation
 * (normalising `/etc/passwd` would erase the fact that it is absolute); this
 * refuses traversal and the directories a test never legitimately lives in.
 */
export function pathProblem(p: string): string | undefined {
  const segments = p.split(/[\\/]+/);
  if (segments.includes("..")) return `path contains ".." : ${p}`;
  for (const seg of segments) {
    for (const bad of FORBIDDEN_SEGMENTS) if (seg === bad) return `path under ${bad}/: ${p}`;
  }
  if (segments.some((s) => s === "")) return `empty path segment in ${p}`;
  return undefined;
}

/** Collapse `./x`, `x/./y` and a trailing slash to the git-relative form. */
export function normaliseRelPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Why this path in `wt` is not a file the step may capture, or undefined when
 * it is. The path arrives already normalised and known to exist.
 *
 * The four checks are what a child cannot get past:
 *
 *   - `lstat` (NOT `stat`) so a symlink is a symlink and not the file it
 *     points at — following one would capture, hash and commit bytes from
 *     anywhere on the host;
 *   - a REGULAR file, so a fifo, socket, device or directory is refused;
 *   - `nlink === 1`, so a HARD LINK cannot impersonate a file of the worktree.
 *     A hard link is not a symlink — `lstat` sees an ordinary file and
 *     `realpath` stays inside the tree — so this is the only check that
 *     catches it, and the one the path checks alone cannot: the bytes it
 *     shares with an outside file would have been frozen and committed;
 *   - `realpath` of the file inside `realpath` of the worktree, so no
 *     component of the path escapes through a linked parent.
 */
export function fileProblem(wt: string, rel: string): string | undefined {
  const abs = path.join(wt, rel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return `file ${rel} could not be read`;
  }
  if (st.isSymbolicLink()) return `file ${rel} is a symlink, which the step never follows`;
  if (!st.isFile()) return `file ${rel} is not a regular file`;
  if (st.nlink !== 1) return `file ${rel} has ${st.nlink} hard links — not a file of this worktree`;
  let realFile: string;
  let realTree: string;
  try {
    realFile = realpathSync(abs);
    realTree = realpathSync(wt);
  } catch {
    return `file ${rel} could not be resolved inside ${wt}`;
  }
  if (realFile !== realTree && !realFile.startsWith(realTree + path.sep))
    return `file ${rel} resolves outside the worktree (${realFile})`;
  return undefined;
}

export interface DroppedRow {
  criterionId: string;
  path?: string;
  reason: string;
}

/**
 * The boundary every submitted path passes through.
 *
 * A row is dropped, with a reason, when its criterion is not a `verify:
 * "test"` criterion of THIS spec; when a path is absolute, traverses, or sits
 * under a forbidden directory; when the file is not in the worktree; or when
 * it is not an ordinary file the worktree owns (`fileProblem`). What survives
 * is a criterion -> kept-paths map the step can capture, prove and commit.
 */
export function validateSubmitRows(
  rows: SubmitTestsRow[],
  opts: {
    spec: PiSpec;
    exists: (rel: string) => boolean;
    fileProblem?: (rel: string) => string | undefined;
  },
): { kept: SubmitTestsRow[]; dropped: DroppedRow[] } {
  const testable = new Set(opts.spec.criteria.filter((c) => c.verify === "test").map((c) => c.id));
  const keptByCriterion = new Map<string, string[]>();
  const dropped: DroppedRow[] = [];
  for (const row of rows) {
    if (!testable.has(row.criterionId)) {
      dropped.push({
        criterionId: row.criterionId,
        reason:
          opts.spec.criteria.some((c) => c.id === row.criterionId) === true
            ? `criterion ${row.criterionId} is not a test criterion`
            : `unknown criterion ${row.criterionId} — not in the spec`,
      });
      continue;
    }
    const files = keptByCriterion.get(row.criterionId) ?? [];
    for (const raw of row.testFiles) {
      // The absolute check runs on the RAW string: `path.isAbsolute` on a
      // normalised `//etc/passwd` would have collapsed it to `etc/passwd` and
      // reported it as a relative path that merely does not exist.
      const absolute =
        raw.startsWith("/") ||
        raw.startsWith("\\") ||
        path.isAbsolute(raw) ||
        /^[A-Za-z]:[\\/]/.test(raw);
      if (absolute) {
        dropped.push({
          criterionId: row.criterionId,
          path: raw,
          reason: `absolute path ${raw} is not a worktree-relative test file`,
        });
        continue;
      }
      const rel = normaliseRelPath(raw);
      const problem = rel === "" ? `empty path ${JSON.stringify(raw)}` : pathProblem(rel);
      if (problem !== undefined) {
        dropped.push({ criterionId: row.criterionId, path: raw, reason: problem });
        continue;
      }
      if (!opts.exists(rel)) {
        dropped.push({
          criterionId: row.criterionId,
          path: rel,
          reason: `file ${rel} does not exist in the worktree`,
        });
        continue;
      }
      const notAFile = opts.fileProblem?.(rel);
      if (notAFile !== undefined) {
        dropped.push({ criterionId: row.criterionId, path: rel, reason: notAFile });
        continue;
      }
      if (!files.includes(rel)) files.push(rel);
    }
    if (files.length > 0) keptByCriterion.set(row.criterionId, files);
  }
  const kept: SubmitTestsRow[] = [...keptByCriterion.entries()].map(([criterionId, testFiles]) => ({
    criterionId,
    testFiles,
  }));
  return { kept, dropped };
}

/** One record's path plus the criterion that claimed it. */
export interface DeclaredPath {
  path: string;
  criterionId: string;
}

/** The paths the child submitted and the step kept, deduplicated by path. */
export function declaredPaths(keptByCriterion: Record<string, string[]>): DeclaredPath[] {
  const seen = new Set<string>();
  const out: DeclaredPath[] = [];
  for (const [criterionId, files] of Object.entries(keptByCriterion)) {
    for (const p of files) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, criterionId });
    }
  }
  return out;
}

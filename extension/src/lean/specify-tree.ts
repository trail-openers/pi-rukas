/**
 * lean/specify-tree — the worktree the specify child works in, and what the
 * step does to it afterwards.
 *
 * Three jobs, all deterministic git/file facts with no model in the loop:
 *
 *   1. `ensureSpecifyWorktree` — a path nobody has to guess (`<repoRoot>/
 *      .worktrees/lean-<issue>`), created detached at the run's base sha, or
 *      RESET to that base when it is left over from a crashed run. A re-run
 *      that inherited a half-written worktree would otherwise prove tests red
 *      against code a dead child had already changed.
 *   2. `validateSubmitRows` / `declaredPaths` — the boundary a `submit_tests`
 *      row has to pass before the step believes a file is a test the child
 *      wrote (see submit-tests-extract.ts for the reading half).
 *   3. `revertUndeclared` — everything in the worktree that the child did not
 *      submit as a test is put back to base, so what the step freezes is only
 *      tests. A child that "helpfully" fixed the bug would otherwise sail
 *      through the rest of the run with its fix baked into the frozen state.
 *
 * The worktree itself is created through `worktreeCreate` from ../worktree.ts
 * — so it gets the driver's pre-add guards and its dependency provisioning,
 * which is what lets the project's own runner execute inside a tree that is
 * otherwise only tracked files.
 *
 * Every git call here is argv form: the worktree path and the base sha come
 * from the run, and neither is allowed to become a word a shell re-parses.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { type ExecFn, worktreeCreate, worktreePath } from "../worktree.ts";
import type { PiSpec } from "./spec.ts";
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

/**
 * Create the worktree at `fromRef` and check out the run's branch in it.
 *
 * `worktreeCreate` always adds DETACHED (that is the always-worktree rule,
 * #287), so the named branch is created afterwards with `checkout -B`: `-B`
 * rather than `-b` because a branch left over from a previous attempt of the
 * same run must move to the base rather than make the step fail.
 */
async function create(
  exec: ExecFn,
  opts: { repoRoot: string; issue: number; fromRef: string; branch: string },
): Promise<string> {
  const name = specifyWorktreeName(opts.issue);
  const { path: wt } = await worktreeCreate(exec, {
    repoRoot: opts.repoRoot,
    name,
    fromRef: opts.fromRef,
  });
  const checkout = await exec("git", {
    argv: ["checkout", "-B", opts.branch, opts.fromRef],
    cwd: wt,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (checkout.stdout === undefined && checkout.stderr === undefined) {
    throw new Error(`specify: checkout of ${opts.branch} in ${wt} produced no result`);
  }
  return wt;
}

/**
 * Reset an existing worktree to the base commit and clean it.
 *
 * The step owns this worktree, which is what makes `reset --hard` and
 * `clean -fd` the right verbs here: the alternative — trusting whatever a
 * crashed child left in the tree — is the bug this function exists to close.
 * Both are argv form, and both are bounded.
 */
async function resetToBase(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  branch: string,
): Promise<void> {
  for (const argv of [
    ["reset", "--hard", baseSha],
    ["clean", "-fd"],
    ["checkout", "-B", branch, baseSha],
  ]) {
    await exec("git", { argv, cwd: wt, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  }
}

/**
 * Put the specify worktree in a known state at `fromRef`, returning its path.
 *
 * Missing → created. Present → reset to the base. The branch is (re)pointed at
 * the base either way, so a re-run cannot inherit a commit the last attempt
 * made.
 */
export async function ensureSpecifyWorktree(
  exec: ExecFn,
  opts: { repoRoot: string; issue: number; fromRef: string; branch: string },
): Promise<string> {
  const wt = specifyWorktreePath(opts.repoRoot, opts.issue);
  if (worktreeExists(wt)) {
    await resetToBase(exec, wt, opts.fromRef, opts.branch);
    return wt;
  }
  return create(exec, opts);
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
 * under a forbidden directory; or when the file is not in the worktree. What
 * survives is a criterion -> kept-paths map the step can prove and freeze.
 */
export function validateSubmitRows(
  rows: SubmitTestsRow[],
  opts: { spec: PiSpec; exists: (rel: string) => boolean },
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

/**
 * Revert every changed/added/deleted path in `wt` that is not a kept test.
 *
 * Tracked paths are restored from the base commit; untracked ones (`??`) are
 * removed from disk. Returns the paths it reverted so the outcome can say what
 * the child touched that the step threw away.
 */
export async function revertUndeclared(
  exec: ExecFn,
  wt: string,
  keep: Set<string>,
): Promise<string[]> {
  const reverted: string[] = [];
  for (const entry of await changedPaths(exec, wt)) {
    if (keep.has(entry.path)) continue;
    if (entry.status === "??") {
      await exec("git", {
        argv: ["clean", "-fdx", "--", entry.path],
        cwd: wt,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    } else {
      await exec("git", {
        argv: ["checkout", "HEAD", "--", entry.path],
        cwd: wt,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    }
    reverted.push(entry.path);
  }
  return reverted;
}

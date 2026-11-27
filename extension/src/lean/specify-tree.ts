#!/usr/bin/env bun
/**
 * lean/specify-tree — the worktree the specify child works in, and the
 * CAPTURE / RESET / REWRITE primitives the step drives it with.
 *
 * Four jobs, all deterministic git/file facts with no model in the loop:
 *
 *   1. `ensureSpecifyWorktree` — a path nobody has to guess, created at the run's base sha, plus
 *      `assertSpecifyWorktreeOwned`, which refuses a path at that location the step does not own.
 *   2. `validateSubmitRows` (in submit-tests-cap.ts, re-exported here) — the boundary a `submit_tests`
 *      row must pass before the step believes a file is a test the child wrote. The facade re-exports
 *      only what callers import through it — an unused re-export is a second public surface that drifts.
 *   3. `captureTestBytes` (in specify-capture.ts) — the ONLY thing that survives the child: the bytes of
 *      each kept file, read through one descriptor per file, so a link swapped in after validation is
 *      refused rather than followed.
 *   4. `resetWorktreeToBase` — discard child commits, staging, untracked files and ignore tricks,
 *      re-initialise the submodules `clean -fdx` de-populated, then PROVE the tree is at base and clean,
 *      or throw. A reset nobody confirmed is a claim, not a fact.
 *
 * The worktree is created through `worktreeCreate`, so it gets the driver's pre-add guards and dependency
 * provisioning — what lets the project's runner execute in a tree that is otherwise only tracked files.
 *
 * Every git call here is argv form: the path and the base sha never become a word a shell re-parses.
 */
import { existsSync, realpathSync } from "node:fs";
import { traceWarn } from "../trace.ts";
import { ensureGitExclude } from "../work-driver-git-exclude.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { type ExecFn, worktreeCreate, worktreePath } from "../worktree.ts";
import { NO_HOOKS, headIsDescendant, resetWorktreeToBase } from "./specify-reset.ts";
import { type SubmoduleNote, submoduleNoteClause } from "./specify-submodules.ts";
import { joinNotes } from "./text-fence.ts";
import { ROSTER_REPORT_FILE } from "./verify-roster-command.ts";
export { type DroppedRow, NEWNESS_REASON, validateSubmitRows } from "./submit-tests-cap.ts";

/** The worktree directory name for one issue's specify step. */
function specifyWorktreeName(issue: number): string {
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
      argv: [...NO_HOOKS, "worktree", "list", "--porcelain"],
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = r.stdout;
  } catch {
    // An unreadable listing is NOT "no worktrees here" — the caller refuses.
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
 * The precondition for a worktree that is ALREADY there: this step owns it, or the
 * step does not touch it.
 *
 * `.worktrees/lean-<issue>` is a name another tool — or a human — can also use, and `reset --hard` in a
 * tree the step does not own destroys somebody else's work. Ownership is therefore PROVEN: the path appears
 * in `git worktree list --porcelain` of this repo and its HEAD sits at the required commit — on the run's
 * branch or detached there — or, with `allowAheadOfBase`, on the run's branch descending from it. Anything
 * else, including an unreadable listing, throws before a single mutation.
 *
 * `headMustBe` is what a step other than `specify` asks the tree to sit at: `specify` requires the base,
 * while `build` passes the head the frozen records were hashed at.
 *
 * `allowAheadOfBase` is for the caller that resets HEAD itself next. The probe only ADDS a refusal: one
 * that could not answer throws.
 */
export async function assertSpecifyWorktreeOwned(
  exec: ExecFn,
  opts: {
    repoRoot: string;
    wt: string;
    baseSha: string;
    branch: string;
    /** Default `baseSha` — what `specify` has always required. */
    headMustBe?: string;
    /** Also own a HEAD that descends from `baseSha`. See the header. */
    allowAheadOfBase?: boolean;
  },
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
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
    cwd: opts.wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const actual = (head?.stdout ?? "").trim();
  const want = opts.headMustBe ?? opts.baseSha;
  let aheadOk = false;
  // The failure names what was actually found — "detached at the base" and "on the branch but two
  // commits ahead" are different diagnoses for whoever reads the handback.
  if (actual !== want) {
    aheadOk =
      opts.allowAheadOfBase === true &&
      actual !== "" &&
      (await headIsDescendant(
        exec,
        opts.wt,
        want,
        () => new Error(`could not tell whether HEAD in ${opts.wt} descends from ${want}`),
      ));
    if (!aheadOk)
      throw new Error(
        `${foreign} (its HEAD is ${actual === "" ? "unreadable" : actual}, expected ${want})`,
      );
  }
  const symbolic = await exec("git", {
    argv: [...NO_HOOKS, "symbolic-ref", "--short", "-q", "HEAD"],
    cwd: opts.wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: "" }));
  const on = (symbolic.stdout ?? "").trim();
  // The ahead path is the reset that moves commits, and those belong to the run's branch, so the tree
  // must name it — an empty `on` is refused as foreign. A tree exactly AT the base is where
  // `resetWorktreeToBase` leaves its own detached trees, so there an empty `on` stays owned.
  if (aheadOk ? on !== opts.branch : on !== "" && on !== opts.branch) throw new Error(foreign);
}

/**
 * Put the specify worktree in a known state at `fromRef`, returning its path
 * and the provisioning result that says which dependency links the tree has.
 *
 * Missing → created. Present → owned-checked, then reset to the base.
 */
export async function ensureSpecifyWorktreeWithProvision(
  exec: ExecFn,
  opts: {
    repoRoot: string;
    issue: number;
    fromRef: string;
    branch: string;
    allowAheadOfBase?: boolean;
    /** Threaded to the reset's submodule re-initialisation; observation only, never a product call. */
    beforeSubmoduleInit?: (wt: string) => void | Promise<void>;
  },
): Promise<{ wt: string; linked: string[]; problem?: string }> {
  // Every lean tree lives under `.worktrees/`, and the roster's report is written into a tree; both are
  // excluded per clone, so neither a porcelain scan nor a tool staging the repo root sees them.
  await ensureGitExclude(opts.repoRoot, [".worktrees/", ROSTER_REPORT_FILE]);
  const wt = specifyWorktreePath(opts.repoRoot, opts.issue);
  if (worktreeExists(wt)) {
    await assertSpecifyWorktreeOwned(exec, {
      repoRoot: opts.repoRoot,
      wt,
      baseSha: opts.fromRef,
      branch: opts.branch,
      allowAheadOfBase: opts.allowAheadOfBase,
    });
    // The reset cleans WITHOUT exemptions — `clean -fdx` takes the dependency links AND the submodule
    // contents — and provisioning rebuilds the links. One code path for a created and a leftover tree.
    const notes = await resetWorktreeToBase(
      exec,
      wt,
      opts.fromRef,
      opts.branch,
      opts.beforeSubmoduleInit,
    );
    const provision = await provisionWorktree(exec, opts.repoRoot, wt);
    return { wt, linked: provision.linked, ...problemOf(provision, notes, wt) };
  }
  const name = specifyWorktreeName(opts.issue);
  const created = await worktreeCreate(exec, {
    repoRoot: opts.repoRoot,
    name,
    fromRef: opts.fromRef,
  });
  const tree = created.path;
  // The step owns the tree outright, so the branch is pointed at the base rather than left detached at
  // it — the commit that freezes the tests is then one ON the run's branch.
  const notes = await resetWorktreeToBase(
    exec,
    tree,
    opts.fromRef,
    opts.branch,
    opts.beforeSubmoduleInit,
  );
  const provision = await provisionWorktree(exec, opts.repoRoot, tree);
  return { wt: tree, linked: provision.linked, ...problemOf(provision, notes, tree) };
}

/**
 * The `problem` field of a provisioning result, spread only when present, with the submodule clause
 * appended when the reset's pass could not supply one. Both notes share one field because they are the
 * same kind of thing: a step that went ahead on an incomplete tree and said so.
 */
function problemOf(
  p: { problem?: string },
  notes: readonly SubmoduleNote[],
  wt: string,
): { problem?: string } {
  const note = submoduleNoteClause(notes);
  if (note === undefined) return p.problem === undefined ? {} : { problem: p.problem };
  traceWarn(`lean worktree ${wt}: ${note}`);
  const parts = [p.problem, note].filter((x): x is string => x !== undefined && x !== "");
  return { problem: joinNotes(parts) };
}

/** A porcelain `v1 -z` record: the status letters and the path. */
interface PorcelainEntry {
  status: string;
  path: string;
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * NUL-terminated records with no quoting or escaping — the only porcelain shape that survives a path
 * containing a space, a quote or a newline. A rename/copy record carries its source as a second field,
 * consumed here so it never reaches a caller as a phantom path.
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
    if (xy[0] === "R" || xy[0] === "C") {
      // Both sides are named: the source is where a byte the step is about to discard
      // lived, and a reason that omitted it reads as though nothing was touched there.
      const src = fields[i + 1];
      if (src !== undefined && src !== "") entries.push({ status: xy, path: src });
      i++;
    }
    entries.push({ status: xy, path: p });
  }
  return entries;
}

/** Paths git reports as changed, added or deleted in `wt` (base-relative). */
export async function changedPaths(exec: ExecFn, wt: string): Promise<PorcelainEntry[]> {
  const { stdout } = await exec("git", {
    argv: [...NO_HOOKS, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: wt,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePorcelainZ(stdout ?? "");
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

/**
 * work-retry-tree-clean — #1391: make a worktree clean for a step RETRY,
 * without destroying what the lost attempt left in it.
 *
 * When a step child dies (a severed provider connection, a watchdog kill) the
 * driver re-runs the step by dispatching a brand-new child into the SAME
 * worktree. That child meets the tree the dead one left behind. For `develop`
 * the leftover is a feature (`interruptedDevelopNote` tells the retried
 * developer to continue from it); for `lens-fix` it is a wall: the #981
 * reposition gate refuses to dispatch a fixer onto a dirty base, and the
 * retry's own precondition check is defeated by the failure it is retrying
 * after. Measured on tehas cycle 109-261015-212759 (err.txt:100-103):
 *
 *   retry on step="lens-fix" (attempt 2/3, cause=provider-severed)
 *   lens-fix-reposition: worktree has uncommitted changes: M DESIGN.md, …
 *   work-driver: lens-fix reposition guard parked the cycle — dirty: …
 *   --- step 7/9 lens-fix started (round 3) / done in 1s
 *
 * The dirt the driver is parked for is dirt the driver's own lost attempt
 * made. Retrying it is a loop that only a clean tree can exit, so the driver
 * clears it — but "clears" here means *preserve first*, because the work is
 * the only copy of 22 minutes and 2.8M tokens of the lost child's effort.
 *
 * Preserve-then-clear, in that order, and the clear only ever runs on a
 * successful preserve:
 *
 *  1. read the dirt (the argv-form status read, rename pairs expanded);
 *  2. commit it — driver-attributed, path-limited, driver artefacts under
 *     `.pi/` and `tmp/` never committed (the same rules the #622 safety net
 *     applies, from the same module);
 *  3. name the commit with a durable ref, so clearing HEAD cannot orphan it;
 *  4. copy it out as a binary patch against the pre-save HEAD, into the
 *     cycle's scratch dir — the off-tree copy, for an operator who never
 *     finds the ref;
 *  5. only then reset the tree back to the base the retry is meant to start
 *     from.
 *
 * A failure at 2, 3 or 4 returns `failed` and touches NOTHING: no reset, no
 * clear, no partial patch. Deleting the lost attempt's work to make a gate
 * happy is the exact failure mode this module exists to prevent, so the seam
 * refuses rather than guesses, and the caller parks with the git error.
 *
 * Idempotent by construction: the retry re-enters the step, and a second pass
 * over an already-clean tree reports `clean` and writes nothing. A save that
 * never happened must be invisible to the operator-facing account, which is
 * what lets `lostAttemptLine` name the files without claiming a phantom save.
 *
 * The primitives are all borrowed, none re-implemented: the `.worktrees/`
 * fence, the status read, staging, the work/artefact entry filters and the
 * chunked unstage come from `work-develop-git.ts`; the durable-ref naming
 * follows `worktree-salvage.ts`'s HEAD-tag recipe.
 *
 * CALLER: `work-driver-step-router.ts` calls this from the transient-retry
 * branch, before the re-dispatch, for every step whose child works in a
 * driver worktree. That call is task-b (#1391) and is not wired in this
 * branch yet; `test-seams-wired.ts` records the module as `pending` until it
 * lands, so the seam cannot ship as dead code in the merge state.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import {
  type ExecFn,
  type GitExec,
  assertInsideWorktrees,
  commitEntriesOf,
  errText,
  runGit,
  stageDeletions,
  stagePaths,
  unstagePaths,
  worktreeStatus,
} from "./work-develop-git.ts";

/** The git argv transport for this module (#1016: argv only, no shell re-parse). */
const gitOf = (execFn: ExecFn): GitExec => runGit(execFn);

/** How many preserved paths the event and the retry line may name. */
const MAX_NAMED_FILES = 12;

export interface RetryTreeCleanArgs {
  /** Repo root — the `.worktrees/` fence the clear is confined to. */
  repoRoot: string;
  /** Absolute worktree path whose dirt the lost attempt left. */
  worktree: string;
  /** The step being retried (names the save in the ref, the patch and the event). */
  step: string;
  /** Workstream id whose worktree this is (e.g. "default"). */
  workstreamId: string;
  /** The 1-based attempt that was LOST — the retry is attempt + 1. */
  attempt: number;
  /** The cycle's scratch dir: `<repoRoot>/tmp/issue-<N>`. */
  scratchDir: string;
}

/**
 * - `clean` — the tree needed nothing. Nothing was written, nothing recorded.
 * - `cleaned` — the dirt was preserved and the tree was cleared. `commit` /
 *   `preservedRef` / `patchPath` are the recovery handles, all three of which
 *   the save created before the tree was touched.
 * - `failed` — the save did not land. THE TREE WAS NOT TOUCHED: it still
 *   holds every byte the lost attempt wrote. The caller must park, not retry.
 */
export type RetryTreeCleanResult =
  | { kind: "clean" }
  | {
      kind: "cleaned";
      /** The driver-attributed commit holding the preserved work. */
      commit: string;
      /** Durable ref naming that commit — survives the clear. */
      preservedRef: string;
      /** The off-tree patch copy, or undefined when there was nothing patchable. */
      patchPath?: string;
      /** The preserved paths, verbatim from porcelain (bounded). */
      files: string[];
      /** True when more paths existed than `files` names. */
      truncated: boolean;
    }
  | { kind: "failed"; reason: string };

/** The step / workstream id used as a path component and a ref component. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** The ref the preserved commit lives under. Namespaced per cycle + step. */
function preservedRefFor(args: RetryTreeCleanArgs, base: string): string {
  const cycle = path.basename(path.resolve(args.repoRoot));
  return `refs/pi-rukas/retry-preserved/${cycle}/${args.workstreamId}/${args.step}-${args.attempt}-${base.slice(0, 12)}`;
}

/** `<scratch>/retry-<step>-<attempt>-<shortsha>.patch` — never overwritten. */
function patchPathFor(args: RetryTreeCleanArgs, base: string): string {
  const short = base.slice(0, 12) || "no-base";
  return path.join(
    path.resolve(args.scratchDir),
    `retry-${args.step}-${args.attempt}-${short}.patch`,
  );
}

/**
 * Preserve the lost attempt's dirt and clear the tree for the retry.
 *
 * Never throws: any git or filesystem failure is a `failed` result carrying
 * the git error, and — the load-bearing half — the tree is left exactly as
 * the dead child left it.
 */
export async function cleanWorktreeForRetry(
  execFn: ExecFn,
  args: RetryTreeCleanArgs,
): Promise<RetryTreeCleanResult> {
  const { worktree, step, workstreamId } = args;
  if (!SAFE_NAME.test(step) || !SAFE_NAME.test(workstreamId)) {
    return { kind: "failed", reason: "step/workstream name is not a plain path component" };
  }

  // The same fence the develop reset applies (`assertInsideWorktrees`, from
  // `work-develop-git.ts`): this clears a tree by force, so it runs where the
  // driver's own worktrees live and nowhere else. A caller that hands in the
  // repo root or an arbitrary path gets a refusal, not a `reset --hard`.
  try {
    assertInsideWorktrees(args.repoRoot, worktree);
  } catch (err) {
    return { kind: "failed", reason: errText(err) };
  }

  const git = gitOf(execFn);

  // 1. What did the lost attempt leave? An unreadable status is a `failed`
  //    result — the clear never runs on a state we cannot see.
  const status = await worktreeStatus(git, worktree);
  if (!Array.isArray(status))
    return { kind: "failed", reason: `status unreadable — ${status.unreadable}` };
  const entries = commitEntriesOf(status);
  if (entries.length === 0) return { kind: "clean" };
  const paths = entries.map((e) => e.path);

  // Where the save is anchored: HEAD before we move it. The patch is a diff
  // against exactly this, and the ref must name the commit that FOLLOWS it.
  let baseSha = "";
  try {
    const { stdout } = await git(["rev-parse", "HEAD"], { cwd: worktree, maxBuffer: 64 * 1024 });
    baseSha = stdout.trim();
  } catch (err) {
    return { kind: "failed", reason: `could not read HEAD — ${errText(err)}` };
  }

  // 2. Stage the work (paths present on disk; `rm --cached` for the ones the
  //    attempt deleted) and commit it. A partial stage is unstaged again and
  //    the tree is returned untouched.
  try {
    await stagePaths(
      git,
      worktree,
      paths.filter((p) => existsSync(path.join(worktree, p))),
    );
    await stageDeletions(
      git,
      worktree,
      paths.filter((p) => !existsSync(path.join(worktree, p))),
    );
  } catch (err) {
    await unstagePaths(git, worktree, paths).catch(() => undefined);
    return { kind: "failed", reason: `staging failed — ${errText(err)}` };
  }

  const msg = `wip: preserved lens-fix attempt ${args.attempt} (${workstreamId}) before retry`;
  try {
    // Path-limited, so a `.pi/` or `tmp/` file already sitting in the index
    // (staged by someone else) is never swept in by the wildcard.
    await git(["--literal-pathspecs", "commit", "-q", "--no-verify", "-m", msg, "--", ...paths], {
      cwd: worktree,
      maxBuffer: 256 * 1024,
    });
  } catch (err) {
    await unstagePaths(git, worktree, paths).catch(() => undefined);
    return { kind: "failed", reason: `the preserve commit failed — ${errText(err)}` };
  }

  let savedSha = "";
  try {
    const { stdout } = await git(["rev-parse", "HEAD"], { cwd: worktree, maxBuffer: 64 * 1024 });
    savedSha = stdout.trim();
  } catch (err) {
    return {
      kind: "failed",
      reason: `the preserve commit's sha could not be read — ${errText(err)}`,
    };
  }

  // 3. The durable ref, BEFORE the patch and before the clear. Without it a
  //    failed later step would leave the save reachable only as a dangling
  //    object, which is how the #1391 work became a scratch diff nobody read.
  const ref = preservedRefFor(args, baseSha);
  try {
    await git(["update-ref", ref, savedSha], { cwd: worktree, maxBuffer: 64 * 1024 });
  } catch (err) {
    return {
      kind: "failed",
      reason: `the preserved ref could not be created — ${errText(err)} (nothing was cleared)`,
    };
  }

  // 4. The off-tree patch copy. A failure here fails the whole save: the ref
  //    still exists, but a save the operator cannot see off-tree is a save
  //    they will not find, and the tree stays dirty either way.
  let patchPath: string | undefined;
  try {
    patchPath = await writePreservePatch(git, worktree, baseSha, args);
  } catch (err) {
    return {
      kind: "failed",
      reason: `the patch copy could not be written — ${errText(err)} (nothing was cleared)`,
    };
  }

  // 5. Only now, with both handles durable, is the tree cleared for the retry.
  try {
    await git(["reset", "--hard", baseSha], { cwd: worktree, maxBuffer: 64 * 1024 });
    await git(["clean", "-fd", "-e", "/.pi/", "-e", "/tmp/"], {
      cwd: worktree,
      maxBuffer: 64 * 1024,
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: `the clear failed after the save — ${errText(err)} (the work is preserved at ${ref})`,
    };
  }

  const files = paths.slice(0, MAX_NAMED_FILES);
  trace(
    `work-retry-tree-clean: preserved ${paths.length} path(s) from ${worktree} at ${ref} (${savedSha.slice(0, 12)})${patchPath ? `, patch ${patchPath}` : ""}`,
  );
  return {
    kind: "cleaned",
    commit: savedSha,
    preservedRef: ref,
    patchPath,
    files,
    truncated: paths.length > files.length,
  };
}

/**
 * Write the preserved diff to `<scratch>/retry-<step>-<attempt>-<sha>.patch`.
 *
 * The diff is taken against the PRE-save HEAD (the base the attempt started
 * from) with the saved commit checked out, so the patch reproduces the lost
 * child's work against the same base the retry will use. Written to a temp
 * file and renamed, so a crashed writer never leaves a truncated patch with
 * the final name; an existing patch is never overwritten (a re-entry keeps
 * the first save's patch, matching `savePartialWork`'s refusal to clobber).
 *
 * Returns undefined when the diff is genuinely empty — a worktree whose
 * entire dirt was driver artefacts, which `commitEntriesOf` already excluded.
 */
async function writePreservePatch(
  git: GitExec,
  worktree: string,
  baseSha: string,
  args: RetryTreeCleanArgs,
): Promise<string | undefined> {
  const { stdout: diff } = await git(["diff", "--binary", baseSha, "HEAD"], {
    cwd: worktree,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!diff.trim()) return undefined;
  const finalPath = patchPathFor(args, baseSha);
  await mkdir(path.dirname(finalPath), { recursive: true });
  if (existsSync(finalPath)) return finalPath;
  const tmp = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmp, diff, "utf8");
  await rename(tmp, finalPath);
  return finalPath;
}

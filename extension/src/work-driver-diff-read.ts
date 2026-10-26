/**
 * work-driver-diff-read — #1634: the worktree diff read that can say
 * "I could not tell".
 *
 * `fetchDiff` returns `""` for every failure — no cwd, a directory that is
 * not a repository, a `git diff` that throws or exits non-zero — and the
 * adversarial gate reads `""` as a clean tree: `adversarial-skipped-empty-diff`
 * plus `adversarial-approved {rounds: 0}`. A killed develop round whose tree
 * nobody could read was therefore "approved" and merged. That is the same
 * defect #384 removed from the lens path (`readIntegratedDiff` returning a
 * discriminated result, empty established POSITIVELY), reproduced on the
 * pre-commit read the gate actually uses.
 *
 * Split from work-driver-diff.ts, which was already at the §12 size cap and
 * whose callers that do NOT gate an approval keep the old best-effort shape.
 *
 * #1634 round 2 — the read is ONE `git diff` of the base commit against the
 * working tree, so committed and uncommitted work are both in what the gate
 * sees. It used to try `base..HEAD` and, when that came back empty, re-run the
 * same range as its own "fallback": uncommitted changes were never asked about,
 * and a tree whose work was never committed read as empty and was approved.
 */

import { realpathSync } from "node:fs";
import { execp } from "./exec.ts";
import { errorText, execGit } from "./git-range.ts";
import { FULL_SHA } from "./work-driver-diff.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Resolve a path for the toplevel comparison. An unresolvable path is NOT a
 * near-miss to wave through: this read gates an approval, and a directory that
 * the kernel cannot name is a directory whose diff nobody can vouch for.
 */
function realpathOrError(
  p: string,
  cwd: string,
  what: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    return { ok: true, path: realpathSync(p) };
  } catch (err) {
    return {
      ok: false,
      reason: `cannot resolve ${what} ${p} (read from ${cwd}): ${errorText(err)}`,
    };
  }
}

/** The 1 MiB cap `fetchDiff` uses; a runaway worktree must not bloat the prompt. */
const DIFF_MAX_BUFFER = 1024 * 1024;

/**
 * A path safe to interpolate into a git argv. Absolute, printable, no shell
 * metacharacters, and — unlike a bare character class that keeps `-` first — no
 * leading `-` either: git reads an argument beginning with `-` as an option, and
 * this value reaches it as `cwd`. A rejected path is a `{ ok: false }` read, so
 * the strictness costs an approval at worst and never a surprise option.
 */
const SAFE_CWD = /^\/[A-Za-z0-9._/~:][A-Za-z0-9._~/:-]*$/;

export type WorktreeDiff = { ok: true; diff: string } | { ok: false; reason: string };

/**
 * Read a worktree's diff for the adversarial gate, distinguishing "nothing to
 * review" from "could not find out".
 *
 * `empty` is established POSITIVELY: the toplevel read named a repository and
 * `git diff` exited 0 producing nothing. Anything else — no cwd, a directory
 * that is not a repository, a read that threw, hung or overflowed its buffer —
 * is `{ ok: false }`, and the caller must treat that as no evidence rather
 * than as approval.
 *
 * WHAT it compares, in ONE call: with a `baseSha` that is a full 40-hex id, the
 * base commit against the WORKING TREE (`git diff <baseSha>`) — committed work
 * since the base plus the uncommitted tracked changes, which is the whole of
 * what a pre-commit gate reviews. With no `baseSha` at all, the working tree
 * against `HEAD`. A `baseSha` that is present but is NOT a full object id is a
 * FAILED read, never a silently degraded comparison: the caller gets no evidence
 * rather than evidence about the wrong pair (#1634 round 2).
 *
 * `execFn` is the driver's exec seam (the same one `verifyExecFn` injects), so
 * a test fake answers both reads; production defaults to `execp`. Every call
 * goes through `execGit`: argv always, a bounded timeout always
 * (`DEFAULT_GIT_TIMEOUT_MS`, git-range.ts), never a command string.
 */
export async function readWorktreeDiff(
  cwd: string | undefined,
  baseSha?: string,
  execFn?: ExecFn,
): Promise<WorktreeDiff> {
  const exec = execFn ?? execp;
  if (!cwd) return { ok: false, reason: "no worktree path was recorded for this workstream" };
  if (!SAFE_CWD.test(cwd)) return { ok: false, reason: `worktree path ${cwd} is not usable` };
  // The read only means something about the directory it names. Without this
  // probe a plain directory under a repo would resolve git's PARENT repository
  // and its clean tree would read as "this workstream changed nothing".
  let toplevel: string;
  try {
    toplevel = (
      await execGit(exec, cwd, ["rev-parse", "--show-toplevel"], { maxBuffer: 64 * 1024 })
    ).trim();
  } catch (err) {
    return {
      ok: false,
      reason: `git rev-parse --show-toplevel failed in ${cwd}: ${errorText(err)}`,
    };
  }
  if (!toplevel) {
    return { ok: false, reason: `git reported no worktree root for ${cwd} (empty output)` };
  }
  // #1634 — compare the DIRECTORIES, not the two strings. A raw comparison made
  // a worktree whose path arrives through a symlink, with a trailing slash, or
  // as `..`/`.`-padded reject itself: the read was sound, and the gate parked on
  // "not its own worktree root" for a tree that was. `realpathSync` resolves both
  // sides to the same kernel answer, so the check means what it says.
  //
  // It fails CLOSED: either path unresolvable is a failed read, not a pass.
  // A worktree that cannot be resolved is precisely the case this gate exists for
  // — the driver does not know what it would be comparing.
  const resolvedToplevel = realpathOrError(toplevel, cwd, "git-reported worktree root");
  if (!resolvedToplevel.ok) return { ok: false, reason: resolvedToplevel.reason };
  const resolvedCwd = realpathOrError(cwd, cwd, "worktree path");
  if (!resolvedCwd.ok) return { ok: false, reason: resolvedCwd.reason };
  if (resolvedToplevel.path !== resolvedCwd.path) {
    return {
      ok: false,
      reason: `${cwd} is not its own worktree root — git reported ${toplevel}`,
    };
  }
  const unreadable = (args: string[], err: unknown): WorktreeDiff => ({
    ok: false,
    reason: `git ${args.join(" ")} failed in ${cwd}: ${errorText(err)}`,
  });
  // #1634 round 2 — ONE read, comparing the base commit against the WORKING
  // TREE: `git diff <baseSha>` (no `..HEAD`). That single form carries both
  // halves of what the gate must see — everything committed since the base AND
  // whatever is still uncommitted — so the pair this used to run (`base..HEAD`
  // first, then `git diff HEAD` when it came back empty) is gone.
  //
  // The pair was the bug. When the committed range was empty the fallback re-ran
  // the SAME range a second time and returned its emptiness as the answer, so a
  // worktree whose change was never committed — the exact shape #1634 was
  // reported on, and the shape a develop round that died before its commit
  // leaves behind — read as "nothing to review". One identical second call could
  // not have discovered the uncommitted change; the tree was never asked.
  //
  // #1634 round 3 — the base is pinned by FULL_SHA, the SAME 40-hex gate
  // `fetchDiff` applies (one predicate, imported, not a second pattern that can
  // drift), and a base that is PRESENT but not a full object id is a FAILED
  // read rather than a degraded one. The loose ref shape this used to test
  // admitted a leading `-`, which git reads as an OPTION even after
  // `--end-of-options`, and a symbolic ref whose movement would silently change
  // what the gate compared. `--end-of-options` stays: it is what makes the
  // positional below unable to be read as a flag by a git that sees it first.
  if (baseSha !== undefined && !FULL_SHA.test(baseSha)) {
    return {
      ok: false,
      reason: `baseSha ${JSON.stringify(baseSha)} is not a full commit id — refusing to guess what to compare`,
    };
  }
  const args = ["diff", "--end-of-options", baseSha ?? "HEAD"];
  try {
    return {
      ok: true,
      diff: await execGit(exec, cwd, args, { maxBuffer: DIFF_MAX_BUFFER }),
    };
  } catch (err) {
    return unreadable(args, err);
  }
}

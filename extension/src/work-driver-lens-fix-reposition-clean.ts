/**
 * work-driver-lens-fix-reposition-clean — #1391 — preserve-then-clean for the
 * lens-fix worktree a lost step attempt dirtied.
 *
 * The round-2+ reposition gate (`work-driver-lens-fix-reposition-gate.ts`)
 * refuses to dispatch a fixer onto a dirty tree, which is right when the dirt
 * is someone's in-progress work and wrong when the dirt is the residue of the
 * child THIS cycle just lost: a step retry dispatches a brand-new child into
 * the SAME worktree, so the half-written edits are sitting on the path the
 * fixer is about to walk. Cycle 109 is the measured case — the round-2 lens-fix
 * developer died at 01:56:00, the router retried, and the retry's own
 * precondition check parked the cycle one second later on
 * `M DESIGN.md, M host/fun/game-view.css, M host/fun/game-view.js, M
 * test/front_page_test.sh`.
 *
 * This module owns the driver's half of that: save the residue, then make the
 * tree clean. It is split from the gate for the AGENTS.md §12 500-line gate —
 * the preserve/clean is the piece that touches git destructively, so it is also
 * the piece worth reading on its own.
 */
import { trace } from "./trace.ts";
import {
  type ExecFn as DevelopExecFn,
  assertInsideWorktrees,
  errText,
  nextRetryAttempt,
  retryPatchPath,
  runGit,
  savePartialWork,
  workEntriesOf,
  worktreeStatus,
} from "./work-develop-git.ts";
import { GIT_TIMEOUT_MS } from "./work-driver-lens-fix-reposition-queries.ts";
import type { ExecFn } from "./worktree.ts";

/** The dirty-path clean's `git clean`, mirroring `work-develop-git.ts`'s
 *  `RESET_CLEAN_ARGS`: the driver's own scratch dirs survive a clean, so a
 *  preserved patch written under `tmp/` is never the thing the clean destroys.
 *  Case-sensitive by design (see that file). */
const LENS_FIX_CLEAN_ARGS = ["-fd", "-e", "/.pi/", "-e", "/tmp/"];

/**
 * #1391 — the driver's half of "a lost step attempt leaves its edits in the
 * worktree": make the lens-fix tree clean for the retry, AFTER saving what the
 * dead child wrote.
 *
 * Preserving first is not ceremony: the dead child's conversation is gone
 * (cycle 109's 22m49s / 2.82M tokens are unrecoverable), so on a tree the driver
 * itself dirtied, the working tree IS the only copy. The save reuses the develop
 * path's `savePartialWork` (stage → `git diff --binary --cached HEAD` → write
 * with `wx`, refuse to clobber), and a failed save returns "not cleaned":
 * nothing destructive runs after it, and the caller parks with the evidence
 * rather than losing work.
 *
 * Two refusals, both fail-closed:
 *  - the tree must sit under `<repoRoot>/.worktrees/` (`assertInsideWorktrees`)
 *    — a lens-fix tree is always driver-owned, so a persisted path that says
 *    otherwise is a corrupt state file, not something to `clean`;
 *  - the tree must carry NO commits. Unlike `resetWorktreeToBase`, this helper
 *    does not move HEAD: a lens-fix child that committed its work did the right
 *    thing, and the #749 committed-fix integration is what lands it. Resetting
 *    here would destroy work the rest of the driver already knows how to
 *    recover, so such a tree is refused and left exactly as found.
 *
 * Returns the saved patch path when there was work to save, nothing when the
 * tree was already clean, and `{ error }` when the state could not be read or
 * saved (in which case nothing was destroyed).
 */
export async function cleanLensFixTreeAfterLostAttempt(args: {
  execFn: ExecFn;
  repoRoot: string;
  tree: string;
  /** The scratch dir (`<repoRoot>/tmp/issue-<N>`) the preserved patch lands in. */
  scratchDir: string;
  /** Names the patch file; "lens-fix" in production, a round tag in tests. */
  id: string;
  /** Names the trace line so a reader can tell which caller cleaned the tree. */
  tracePrefix?: string;
}): Promise<{ patched?: string; error?: string }> {
  const prefix = args.tracePrefix ?? "lens-fix-reposition";
  const git = runGit(args.execFn as unknown as DevelopExecFn);
  try {
    assertInsideWorktrees(args.repoRoot, args.tree);
  } catch (err) {
    return { error: `worktree path refused — ${errText(err)}` };
  }
  // Commits are not this helper's business (see the header): refuse rather than
  // reset, so a committed fix stays available to the #749 integration path.
  try {
    const { stdout } = await args.execFn("git", {
      cwd: args.tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
    });
    const count = Number(stdout.trim());
    if (!Number.isFinite(count)) {
      return { error: `commit count unreadable: ${stdout.slice(0, 80)}` };
    }
    if (count > 0) {
      return { error: `worktree has ${count} commit(s) ahead of the remote — left untouched` };
    }
  } catch (e) {
    return { error: `commit check failed: ${errText(e)}` };
  }
  const status = await worktreeStatus(git, args.tree);
  if (!Array.isArray(status)) {
    return { error: `uncommitted state unreadable — ${status.unreadable}` };
  }
  const work = workEntriesOf(status).map((e) => e.path);
  let patched: string | undefined;
  if (work.length > 0) {
    try {
      const attempt = await nextRetryAttempt(args.scratchDir, args.id);
      const patchPath = retryPatchPath(args.scratchDir, args.id, attempt);
      patched = await savePartialWork(git, args.tree, "HEAD", work, patchPath);
    } catch (e) {
      // Fail closed: the tree is the only copy of a lost child's work, so a
      // failed save means the clean does not happen.
      return { error: `could not preserve the lost attempt's work: ${errText(e)}` };
    }
  }
  try {
    // `reset --hard HEAD` + `clean -fd`, the same pair `resetWorktreeToBase`
    // uses (here against HEAD, not a base SHA, because this helper never moves
    // HEAD — see the header). `checkout HEAD` would NOT do: the preserve above
    // STAGED the work to build its patch, and `checkout` leaves the index
    // alone, so a tree "cleaned" that way is still `M `/`A ` to the very
    // `status --porcelain` the caller re-reads.
    await args.execFn("git", {
      cwd: args.tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: ["reset", "--hard", "HEAD"],
    });
    await args.execFn("git", {
      cwd: args.tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: ["clean", ...LENS_FIX_CLEAN_ARGS],
    });
  } catch (e) {
    return {
      error: `clean after the preserve failed: ${errText(e)}`,
      ...(patched ? { patched } : {}),
    };
  }
  trace(
    `${prefix}: cleaned the residue a lost lens-fix attempt left in ${args.tree}${patched ? ` (preserved to ${patched})` : " (nothing to preserve)"} — the retry gets a clean tree`,
  );
  return patched === undefined ? {} : { patched };
}

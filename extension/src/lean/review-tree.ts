/**
 * lean/review-tree — the DISPOSABLE half of the review step's git surface.
 *
 * Everything here concerns a tree that exists to be thrown away: the fixer's worktree (named for one
 * round of one run, created detached, provisioned, proven clean, destroyed) and the run's own tree put
 * back where the gates read it after a refusal. The claims that decide whether a fix may reach origin
 * are `review-git.ts`. The seam is lifetime rather than topic: one file mutates trees nobody will read
 * afterwards, the other moves the one ref everybody will.
 *
 * Same rule as the rest of `lean/review*`: every git call is argv form through `ReviewDeps.exec`, so a
 * test drives the whole surface against a real temp repo with no model in the loop.
 */

import { existsSync } from "node:fs";
import { traceWarn } from "../trace.ts";
import { worktreePath } from "../worktree.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import type { FixRunId, ReviewDeps } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";

/**
 * The fixer's tree for ONE FIX OF ONE ATTEMPT: `<repoRoot>/.worktrees/lean-<issue>-fix-<arm>-<wave>-
 * <attempt>-<epoch>`. Every component is read out of the durable run, never out of anything the process
 * remembers: a discriminator the step counted in memory restarts at zero on a resume and derives a
 * DIFFERENT name for the same fix.
 *
 * - `arm` ("a" = adversarial-only findings, "l" = lens-round findings) and `wave` make one run's fix
 *   trees distinct.
 * - `attempt` is the step key's own `:N` — it keeps two concurrent attempts on one issue apart.
 * - `epoch` is `fixRunId`'s: read back off the step log so a resumed attempt re-enters the paths its
 *   killed self left.
 *
 * The layout is `worktreePath`'s — the repo's single expression of where worktrees live.
 */
export function fixTreeName(
  repoRoot: string,
  issue: number,
  arm: FixArm,
  wave: ReviewWave,
  attempt: number,
  runId: FixRunId,
): string {
  return worktreePath(
    repoRoot,
    `lean-${String(issue)}-fix-${arm}-${wave}-${String(attempt)}-${runId}`,
  );
}

/** Which gate asked for this fix, and therefore which tree it is worked in. */
export type FixArm = "a" | "l";

/**
 * Drop the disposable tree, and SAY so when the removal refused: not a failure of the step, so it does
 * not throw, and not silence either — the round stays blocked on that path until the operator prunes
 * it.
 */
export async function removeWorktree(
  deps: ReviewDeps,
  repoRoot: string,
  wt: string,
): Promise<void> {
  const removed = await gitQuiet(deps.exec, repoRoot, ["worktree", "remove", "--force", wt]);
  if (removed === undefined)
    traceWarn(
      `lean review: could not remove the fix worktree ${wt} — it stays registered and this round's path is occupied until a \`git worktree prune\` clears it`,
    );
  // Prune the registration even when `remove` refused: `add` below rejects a path whose registration
  // is taken and whose directory is gone, and a path this step owns exclusively is what makes the
  // prune safe.
  await gitQuiet(deps.exec, repoRoot, ["worktree", "prune"]);
}

/**
 * Destroy the disposable trees THIS ATTEMPT opened, whatever ended the step. The step's `finally` calls
 * this; a round that threw between `worktree add` and the child would otherwise leave a registered tree
 * the next attempt could not create again.
 *
 * **Scoped to what this attempt could have created.** A selector that matched `-fix-` anywhere deleted a
 * sibling attempt's LIVE tree out from under a running fixer; the prefix carries the issue, the attempt
 * and the epoch read from the log.
 *
 * The registry is a `git` question, not a memory one: `worktree list` finds a tree this PROCESS never
 * made, which a Set in memory could only find after a restart that had already lost it.
 */
export async function closeFixTrees(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  attempt: number,
  runId: FixRunId,
): Promise<void> {
  const listed = await gitQuiet(deps.exec, ctx.repoRoot, [
    "worktree",
    "list",
    "--porcelain",
    "--expire",
    "now",
  ]);
  // An unreadable list is not a claim that nothing is attached, so this does not fall through to
  // "no trees" — it prunes stale registrations and moves on. The head stops before `<arm>` because
  // the tail is `<attempt>-<epoch>`, and those two are what exclude a concurrent attempt's LIVE tree.
  const head = `${worktreePath(ctx.repoRoot, `lean-${String(ctx.issue)}-fix-`)}`;
  const tail = `-${String(attempt)}-${runId}`;
  for (const line of (listed?.stdout ?? "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length).trim();
    if (!wt.startsWith(head) || !wt.endsWith(tail)) continue;
    await removeWorktree(deps, ctx.repoRoot, wt);
  }
}

/** What a restore attempt established about the run's tree. */
export type Restored = "restored" | "failed" | "absent";

/**
 * Put the run's tree and its branch ref back at the commit the gates read, and say which of three things
 * happened. It never throws, because it runs on a path that is already throwing — but it does not
 * stay silent: the caller folds the answer into the thrown cause.
 */
export async function restore(
  deps: ReviewDeps,
  wt: string,
  branch: string,
  head: string,
): Promise<Restored> {
  if (!existsSync(wt)) {
    traceWarn(`lean review: ${wt} is gone, so ${branch} was left where the failed round put it`);
    return "absent";
  }
  const back = await gitQuiet(deps.exec, wt, ["checkout", "-B", branch, head]);
  if (back === undefined) {
    traceWarn(`lean review: could not put ${wt} back at ${head.slice(0, 12)}`);
    return "failed";
  }
  return "restored";
}

/**
 * The sentence the cause carries about the restore. The two non-restored members warn, because for both
 * `verify` and `publish` are about to read a tree that is NOT the one the gates reviewed. The `why`
 * annotation narrows `what` to those two, so a fourth `Restored` fails to type here.
 */
export function restoredSentence(what: Restored, wt: string, head: string): string {
  if (what === "restored") return ` — the run's tree was put back at ${head.slice(0, 12)}`;
  const why: "failed" | "absent" = what;
  return ` — WORKTREE LEFT AT THE FIXER'S HEAD: ${wt} is ${
    why === "absent" ? "gone" : "not restored"
  } and verify and publish will read that tree`;
}

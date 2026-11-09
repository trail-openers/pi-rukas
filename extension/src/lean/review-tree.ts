/**
 * lean/review-tree — the DISPOSABLE half of the review step's git surface.
 *
 * Everything here concerns a tree that exists to be thrown away: the fixer's worktree (named for one
 * round of one run, created detached, provisioned, proven clean, destroyed) and the run's own tree
 * put back where the gates read it after a refusal. The claims that decide whether a fix may reach
 * origin — ownership, ancestry, the frozen contract, the push — are `review-git.ts`. The seam is
 * lifetime rather than topic: one file mutates trees nobody will read afterwards, the other moves the
 * one ref everybody will.
 *
 * Same rule as the rest of `lean/review*`: every git call is argv form through `ReviewDeps.exec`, so
 * a test drives the whole surface against a real temp repo with no model in the loop.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { traceWarn } from "../trace.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { worktreePath } from "../worktree.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import type { FixRunId } from "./review.ts";
import { type ReviewDeps, ReviewInfraError } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The fixer's tree for ONE FIX OF ONE ATTEMPT: `<repoRoot>/.worktrees/lean-<issue>-fix-<arm>-<wave>-
 * <attempt>-<epoch>`. Every component is read out of the durable run, never out of anything the
 * process remembers: the engine re-runs exactly the undecided `review` step, so a discriminator the
 * step counted in memory restarts at zero on a resume and derives a DIFFERENT name for the same fix.
 *
 * Four values, three jobs:
 *
 * - `arm` ("a" = adversarial-only findings, "l" = lens-round findings) and `wave` make one run's fix
 *   trees distinct from each other.
 * - `attempt` is the step key's own `:N` — it keeps two CONCURRENT attempts on one issue from naming
 *   the same tree.
 * - `epoch` is `fixRunId`'s: the same value for the whole attempt, read back off the step log so a
 *   resumed attempt re-enters the paths its killed self left.
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
 * The fixer's tree: created fresh, detached at the reviewed commit, provisioned, and proven clean
 * before the child is paid. The clean proof is the claim every lean step makes of a tree it is about
 * to hand a model: anything already in it is a leftover from a killed round, and a leftover the child
 * inherits becomes part of what the integration moves onto the branch. `--force` is for this step's
 * own path only.
 *
 * **The path is unique to this round, so the claim is not a race.** A fixed path made `worktree add`
 * the only thing that could refuse a non-empty directory, and two awaits sat before the clean read.
 * With a per-round name, `add` refusing a path it created for a round that never completed is the
 * only collision left, and it is a refusal rather than an adoption.
 *
 * The clean proof is read WITHOUT `-uall`, deliberately: `provisionWorktree` has just linked the
 * project's dependency trees into this directory, and `-uall` expands a directory of links into every
 * file inside it, so a proof read that way would refuse every fix round. The default form still lists
 * any untracked path, so a leftover from a killed round cannot pass.
 */
export async function fixTree(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  head: string,
  arm: FixArm,
  wave: ReviewWave,
  attempt: number,
  runId: FixRunId,
  rows: DispatchUsageRow[],
): Promise<string> {
  const { repoRoot, issue } = ctx;
  const wt = fixTreeName(repoRoot, issue, arm, wave, attempt, runId);
  // `add --force` is for THIS step's own path only, which is also why the name must be unique per
  // VISIT: `--force` makes collision with a path this step made itself a silent ADOPTION rather than
  // a refusal.
  const created = await gitQuiet(deps.exec, repoRoot, [
    "worktree",
    "add",
    "--force",
    "--detach",
    wt,
    head,
  ]);
  if (created === undefined)
    throw new ReviewInfraError(
      `could not create the fix worktree at ${wt} for ${head.slice(0, 12)} — a path this step names for this visit alone already exists, and adopting it would move somebody else's bytes onto the branch`,
      rows,
    );
  // Registered the moment the tree exists: the only thing that removes it is `closeFixTrees`, which
  // the step's `finally` runs whatever happens.
  // No catch: `provisionWorktree` resolves whatever happens — every fault inside it becomes a
  // `problem` field rather than a rejection. A bare tree costs the fixer a failed typecheck, not the
  // run.
  const provision = await provisionWorktree(deps.exec, repoRoot, wt);
  if (provision.problem !== undefined)
    traceWarn(`lean review #${String(issue)}: fix worktree ${provision.problem}`);
  // Read AFTER provisioning and still a claim: the path is this round's alone, so anything git
  // reports here came from `add` or from the provisioner (whose links the default form does not list).
  const dirty = await gitQuiet(deps.exec, wt, ["status", "--porcelain=v1"]);
  if (dirty === undefined) {
    await removeWorktree(deps, repoRoot, wt);
    throw new ReviewInfraError(`could not read the fix worktree's state in ${wt}`, rows);
  }
  const left = dirty.stdout.split("\n").filter((s) => s.trim() !== "");
  if (left.length > 0) {
    await removeWorktree(deps, repoRoot, wt);
    throw new ReviewInfraError(
      `the fix worktree ${wt} is not clean before the fixer: ${left.slice(0, 8).join(", ")}`,
      rows,
    );
  }
  return wt;
}

/**
 * Drop the disposable tree, and SAY so when the removal refused. A refusal is not a failure of the
 * step, so it does not throw; it is not silence either — the round stays blocked on that path until
 * the operator prunes it, and the operator is the one who has to know.
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
 * Destroy the disposable trees THIS ATTEMPT opened, whatever ended the step. The step's `finally`
 * calls this; a round that threw between `worktree add` and the child would otherwise leave a
 * registered tree the next attempt could not create again.
 *
 * **Scoped to what this attempt could have created.** A selector that matched `-fix-` anywhere deleted
 * a sibling attempt's LIVE tree out from under a running fixer. The prefix now carries the issue, the
 * attempt and the epoch this attempt read from the log, so a sibling attempt's tree is not a candidate.
 *
 * The registry is a `git` question, not a memory one: `worktree list` finds a tree this PROCESS never
 * made, including one a killed attempt of the same run left behind, which a Set in memory could only
 * find after a restart that had already lost it.
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
 * Put the run's tree and its branch ref back at the commit the gates read, and say which of three
 * things happened. Best effort by design — it never throws, because it runs on a path that is already
 * throwing. What it does NOT do is stay silent: the caller folds the answer into the thrown cause.
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
 * The sentence the cause carries about the restore. "restored" gets one clause; the other two warn,
 * because for both `verify` and `publish` are about to read a tree that is NOT the one the gates
 * reviewed. The `why` binding makes the union's exhaustiveness a compile-time fact.
 */
export function restoredSentence(what: Restored, wt: string, head: string): string {
  if (what === "restored") return ` — the run's tree was put back at ${head.slice(0, 12)}`;
  const why: "failed" | "absent" = what;
  return ` — WORKTREE LEFT AT THE FIXER'S HEAD: ${wt} is ${
    why === "absent" ? "gone" : "not restored"
  } and verify and publish will read that tree`;
}

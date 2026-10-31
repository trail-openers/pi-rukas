/**
 * lean/review-tree — the DISPOSABLE half of the review step's git surface.
 *
 * Everything here concerns a tree that exists to be thrown away: the fixer's
 * worktree (named for one round of one run, created detached, provisioned,
 * proven clean, destroyed) and the run's own tree put back where the gates read
 * it after a refusal. The claims that decide whether a fix may reach origin —
 * ownership, ancestry, the frozen contract, the push — are `review-git.ts`, and
 * so is `reviewedHead`/`rangeDiff`, the two reads that establish what the step
 * is even allowed to have an opinion about.
 * The seam is lifetime rather than topic: one file mutates trees nobody will
 * read afterwards, the other moves the one ref everybody will.
 *
 * Same rule as the rest of `lean/review*`: every git call is argv form through
 * `ReviewDeps.exec`, so a test drives the whole surface against a real temp repo
 * with no model in the loop.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { traceWarn } from "../trace.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { worktreePath } from "../worktree.ts";
import type { HandlerCtx } from "./engine.ts";
import type { FixRunId } from "./review.ts";
import { type ReviewDeps, ReviewInfraError } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The fixer's tree for ONE FIX OF ONE ATTEMPT: `<repoRoot>/.worktrees/lean-
 * <issue>-fix-<arm>-<round>-<attempt>-<epoch>`.
 *
 * Every component is read out of the durable run, never out of anything the
 * process remembers, and that is the property the name has to have: the engine
 * re-runs exactly the undecided `review` step, so a discriminator the step
 * counted in memory (`let visit = 0`) restarts at zero on a resume and derives a
 * DIFFERENT name for the same fix — the resumed run then cannot find the tree it
 * already made, mints a second path, orphans the first, and pays to provision it
 * twice. That is the defect the row's `runId` field exists to prevent, so a
 * counter would have reintroduced it while looking like the fix.
 *
 * Four values, three jobs:
 *
 * - `arm` ("a" for the adversarial gate's pass-with-findings, "l" for the six-lens
 *   round's findings) and `round` together make one run's fix trees distinct from
 *   each other. One review round dispatches a fixer on TWO arms, so the round
 *   number alone named the same path twice — and `worktree add --force` does not
 *   refuse a collision with a path this step made itself (it only refuses paths
 *   it does not own), so the second visit silently ADOPTED a live tree, git
 *   reused its registration, left the first visit's commits in place, and the
 *   step read back a head that already contained them: "the fixer fixed nothing",
 *   for a fixer that had done its work one round earlier.
 * - `attempt` is the step key's own `:N`, the engine's per-attempt counter. It is
 *   what keeps two CONCURRENT attempts on one issue from naming the same tree:
 *   both read the same epoch (the log's, so a resume re-enters its own tree) and
 *   the same round, and only the attempt number they were each appended with
 *   separates them. With no prior attempt recorded both resolve to 0 and
 *   `worktree add` — not `--force`'s adoption, which needs a registration this
 *   step owns — is the one that refuses.
 * - `epoch` is `fixRunId`'s: the same value for the whole attempt, read back off
 *   the step log so a resumed attempt re-enters the paths its killed self left.
 *
 * The layout is `worktreePath`'s — the repo's single expression of where
 * worktrees live, which `specify-tree.ts` already uses. Re-spelling
 * `.worktrees/<name>` here meant two definitions of one path, and only one of
 * them moved if the layout ever did.
 */
export function fixTreeName(
  repoRoot: string,
  issue: number,
  arm: FixArm,
  round: number,
  attempt: number,
  runId: FixRunId,
): string {
  return worktreePath(
    repoRoot,
    `lean-${String(issue)}-fix-${arm}-${String(round)}-${String(attempt)}-${runId}`,
  );
}

/** Which gate asked for this fix, and therefore which tree it is worked in. */
export type FixArm = "a" | "l";

/**
 * The fixer's tree: created fresh, detached at the reviewed commit, provisioned,
 * and proven clean before the child is paid.
 *
 * The clean proof is the claim every lean step makes of a tree it is about to
 * hand a model: this worktree is this step's, so anything already in it is a
 * leftover from a killed round, and a leftover the child inherits becomes part of
 * what the integration moves onto the branch. `--force` is for this step's own
 * path only — `worktree remove` refuses a path it does not own, so no tree at any
 * other location is ever touched here.
 *
 * **The path is unique to this round, so the claim is not a race.** A fixed path
 * made `worktree add` the only thing that could refuse a non-empty directory, and
 * two awaits then sat before the read that says the tree is clean —
 * `provisionWorktree`, which creates parent directories and links into the tree,
 * and the `status` itself. Anything written into that window was adopted:
 * dispatched to the fixer, `git add -A`'d by it, and integrated onto the branch.
 * `add` still refuses a path it has just created for a round that never completed,
 * which is the only collision a per-run name can still meet, and it is a refusal
 * rather than an adoption. The dirty read is then a genuine claim: there is no
 * directory at this path that this round did not create.
 *
 * The clean proof is read WITHOUT `-uall`, and that is deliberate rather than
 * loose: `provisionWorktree` has just linked the project's dependency trees into
 * this directory, and `git status --porcelain -uall` expands a directory of links
 * into every file inside it (measured: `?? node_modules/pkg/j.js` for a tree the
 * provisioner made, with nothing in `git status`'s default view). A proof that
 * read it that way would report every provisioned tree as dirty and refuse every
 * fix round on the very step that prepares it. What the default form still
 * reports is enough for the claim being made: any untracked path — a whole
 * directory included — is listed, so a leftover from a killed round cannot pass,
 * and a child's edits to tracked files are listed too.
 */
export async function fixTree(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  head: string,
  arm: FixArm,
  round: number,
  attempt: number,
  runId: FixRunId,
  rows: DispatchUsageRow[],
): Promise<string> {
  const { repoRoot, issue } = ctx;
  const wt = fixTreeName(repoRoot, issue, arm, round, attempt, runId);
  // `add --force` is for THIS step's own path only — `worktree remove` refuses a
  // path it does not own, so no tree at any other location is ever touched here.
  // That is also why the name has to be unique per VISIT: `--force` makes
  // collision with a path this step made itself a silent ADOPTION rather than a
  // refusal, and git happily reuses a live registration while the tree it points
  // at keeps whatever the earlier visit left in it (measured: a second visit to a
  // colliding name inherited the first visit's commit, so the second fixer
  // committed nothing, its head equalled the head the step had just integrated,
  // and the step reported "fixed nothing" — then billed the whole run to it).
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
  // Registered the moment the tree exists: every path that throws below has
  // already made a directory, and the only thing that removes it is
  // `closeFixTrees`, which the step's `finally` runs whatever happens.
  // No catch: `provisionWorktree` resolves whatever happens — every probe and git
  // call inside it turns a fault into a `problem` field rather than a rejection
  // (#1394, because a rejected provision used to fail the branch step) — so a
  // rejection-handling arm here would be code for a failure that cannot occur.
  // The `problem` it does report is traced and carried on: a bare or partly
  // linked tree costs the fixer a failed typecheck, not the run.
  const provision = await provisionWorktree(deps.exec, repoRoot, wt);
  if (provision.problem !== undefined)
    traceWarn(`lean review #${String(issue)}: fix worktree ${provision.problem}`);
  // Read AFTER provisioning and still a claim: the path is this round's alone,
  // so anything git reports here came from `add` or from the provisioner, and
  // the provisioner only ever creates dependency links from the repo root —
  // which the default `status` form does not list (see the note above).
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
 * Drop the disposable tree, and SAY so when the removal refused.
 *
 * A refusal there is not a failure of the step, so it does not throw. It is not
 * silence either: `worktree remove` refusing leaves a registered tree under a
 * path this step named, and the round stays blocked on it until something prunes
 * it — which the operator is the one to do, and the one who has to know.
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
  // Prune the registration even when `remove` refused. `add` below rejects a
  // path whose registration is already taken and whose directory is gone — a
  // killed round leaves exactly that — and a path this step owns exclusively,
  // under a name no other code writes, is what makes the prune safe.
  await gitQuiet(deps.exec, repoRoot, ["worktree", "prune"]);
}

/**
 * Destroy every disposable tree this attempt opened, whatever ended the step.
 *
 * The step's `finally` calls this. A round that threw between `worktree add` and
 * the child would otherwise leave a registered tree under a path this step owns
 * exclusively, and the next attempt for the same issue and round could not create
 * it again.
 *
 * The registry is a `git` question, not a memory one: it lists every attached
 * worktree under this clone's own `.git` (which `worktreePath` is), so it finds a
 * tree this process never made — including the one a killed attempt left behind,
 * which a Set in memory could only ever find after a restart that had already
 * lost it. A fix tree that survived a crash is exactly the tree a resume must not
 * adopt: it holds the dead attempt's commits, and `--force` would have it adopted
 * rather than refused. A tree that is absent from the list costs one `prune`.
 */
/**
 * Destroy the disposable trees THIS ATTEMPT opened, whatever ended the step.
 *
 * The step's `finally` calls this. A round that threw between `worktree add` and
 * the child would otherwise leave a registered tree under a path this step owns
 * exclusively, and the next attempt for the same issue and round could not create
 * it again.
 *
 * **Scoped to what this attempt could have created, and that is the whole point.**
 * The selector used to be `-fix-` anywhere in the path, which matched every fix
 * tree of EVERY attempt: two attempts in flight — a resumed run, or a second cycle
 * on the same issue — and one step's `finally` deleted the other's LIVE tree out
 * from under a running fixer, so that child's `git commit` landed in a directory
 * that no longer existed. The prefix now carries the issue, the attempt and the
 * epoch this attempt read from the log (`fixTreeName`'s own shape, up to the
 * per-visit arm/round part), so a sibling attempt's tree is not even a candidate.
 *
 * The registry is a `git` question, not a memory one: it lists every attached
 * worktree under this clone's own `.git` (which `worktreePath` is), so it finds a
 * tree this PROCESS never made — including the one a killed attempt of THE SAME
 * run left behind, which a Set in memory could only ever find after a restart that
 * had already lost it. A fix tree that survived a crash is exactly the tree a
 * resume must not adopt: it holds the dead attempt's commits, and `--force` would
 * have it adopted rather than refused. A tree that is absent from the list costs
 * one `prune`.
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
  // An unreadable list is not a claim that nothing is attached, so this does not
  // fall through to "no trees" — it prunes stale registrations and moves on, and
  // a tree that was there stays registered and traced by `removeWorktree`.
  // Built from `fixTreeName`'s own components rather than spelled out here: the
  // layout comes from `worktreePath` (the repo's one expression of where worktrees
  // live) and the component ORDER is the writer's —
  // `lean-<issue>-fix-<arm>-<round>-<attempt>-<epoch>` — so the prefix and the names
  // it selects cannot drift apart. The head stops before `<arm>` because one attempt
  // opens trees on both arms and at every round; the tail is `<attempt>-<epoch>`,
  // and those two components are what exclude a concurrent attempt's LIVE tree,
  // which is the whole point of the scope. A tree of the same issue and attempt is
  // named solely by this attempt's `fixTreeName` calls, so the pair selects exactly
  // this attempt's fix trees and nothing a sibling or another issue owns.
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
 * Put the run's tree and its branch ref back at the commit the gates read, and
 * say which of three things happened.
 *
 * Best effort by design — it never throws, because it runs on a path that is
 * already throwing and a second failure there would replace the reason the
 * operator needs with a complaint about the cleanup. What it does NOT do is stay
 * silent: the caller folds the answer into the thrown cause, so the handback
 * states whether the tree really went back. A tree that is not even there is
 * reported, never assumed fixed — the ref move the integration made would
 * otherwise be left behind with nobody saying so.
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
 * The sentence the cause carries about the restore, for the two answers the
 * operator has to act on.
 *
 * "restored" gets one clause, because nothing follows from it; the other two get
 * the same warning, because for both of them `verify` and `publish` are about to
 * read a tree that is NOT the one the gates reviewed — a tree that is gone is not
 * "back at the reviewed commit" either. Naming which happened is the point: the
 * cause is the only surface an operator reads (this step's header says so), and a
 * trace line is not.
 *
 * The `why` binding makes the union's exhaustiveness a compile-time fact: the
 * final arm is only reachable once `"restored"` and `"absent"` are ruled out, so
 * a fourth member of `Restored` fails to type here rather than being described by
 * the sentence meant for a tree that went back.
 */
export function restoredSentence(what: Restored, wt: string, head: string): string {
  if (what === "restored") return ` — the run's tree was put back at ${head.slice(0, 12)}`;
  const why: "failed" | "absent" = what;
  return ` — WORKTREE LEFT AT THE FIXER'S HEAD: ${wt} is ${
    why === "absent" ? "gone" : "not restored"
  } and verify and publish will read that tree`;
}

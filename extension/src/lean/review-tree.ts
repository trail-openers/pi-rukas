/**
 * lean/review-tree — the DISPOSABLE half of the review step's git surface.
 *
 * Everything here concerns a tree that exists to be thrown away: the fixer's
 * worktree (named for one round of one run, created detached, provisioned,
 * proven clean, destroyed) and the run's own tree put back where the gates read
 * it after a refusal. The claims that decide whether a fix may reach origin —
 * ownership, ancestry, the frozen contract, the push — are `review-integrate.ts`.
 * The seam is lifetime rather than topic: one file mutates trees nobody will
 * read afterwards, the other moves the one ref everybody will.
 *
 * Same rule as the rest of `lean/review*`: every git call is argv form through
 * `ReviewDeps.exec`, so a test drives the whole surface against a real temp repo
 * with no model in the loop.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { LensRunResult } from "../lens-review-types.ts";
import { traceWarn } from "../trace.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewDeps } from "./review.ts";
import { ReviewInfraError } from "./review.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** git in `cwd` as an argv command; `undefined` when git refused rather than said no. */
async function git(
  deps: ReviewDeps,
  cwd: string,
  argv: string[],
): Promise<{ stdout: string } | undefined> {
  try {
    const r = await deps.exec("git", {
      argv: [...NO_HOOKS, ...argv],
      cwd,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: r.stdout ?? "" };
  } catch {
    return undefined;
  }
}

/** Drop the disposable tree. A refusal there is not a failure of the step. */
export async function removeWorktree(
  deps: ReviewDeps,
  repoRoot: string,
  wt: string,
): Promise<void> {
  await git(deps, repoRoot, ["worktree", "remove", "--force", wt]);
  // Prune the registration even when `remove` refused. `add` below rejects a
  // path whose registration is already taken and whose directory is gone — a
  // killed round leaves exactly that — and a path this step owns exclusively,
  // under a name no other code writes, is what makes the prune safe.
  await git(deps, repoRoot, ["worktree", "prune"]);
}

/**
 * The fixer's tree for ONE round of ONE run: `<repoRoot>/.worktrees/lean-<issue>
 * -fix-<round>-<runId>`.
 *
 * Round AND run are both in the name because each closes a different hole. The
 * round makes two rounds of one run unable to share a tree; the run id makes a
 * concurrent or restarted cycle for the same issue unable to name the same path
 * at the same round. A name nobody else can produce is the whole fix: there is
 * no pre-existing directory to adopt, so `worktree add` is not guarding a shared
 * path and the clean read below has nothing to race with. It is derived
 * (`fixTree` is its only caller) rather than remembered, like every other
 * worktree path in lean.
 */
export function fixTreeName(repoRoot: string, issue: number, round: number, runId: string): string {
  return path.join(repoRoot, ".worktrees", `lean-${String(issue)}-fix-${String(round)}-${runId}`);
}

/**
 * The fixer's tree: created fresh, detached at the reviewed commit, provisioned,
 * and proven clean before the child is paid.
 *
 * The clean proof is the claim every lean step makes of a tree it is about to
 * hand a model: this worktree is this step's, so anything already in it is a
 * leftover from a killed round, and a leftover the child inherits becomes part of
 * what the integration moves onto the branch. `--force` is for this step's own
 * path only — `worktree remove` refuses a path it does not own, so no tree at
 * any other location is ever touched here.
 *
 * **The path is unique to this round, so the claim is not a race.** A fixed
 * path made `worktree add` the only thing that could refuse a non-empty
 * directory, and two awaits then sat before the read that says the tree is
 * clean — `provisionWorktree`, which creates parent directories and links into
 * the tree, and the `status` itself. Anything written into that window was
 * adopted: dispatched to the fixer, `git add -A`'d by it, and integrated onto
 * the branch. `add` still refuses a path it has just created for a round that
 * never completed, which is the only collision a per-run name can still meet,
 * and it is a refusal rather than an adoption. The dirty read is then a genuine
 * claim: there is no directory at this path that this round did not create.
 *
 * The clean proof is read WITHOUT `-uall`, and that is deliberate rather than
 * loose: `provisionWorktree` has just linked the project's dependency trees into
 * this directory, and `git status --porcelain -uall` expands a directory of
 * links into every file inside it (measured: `?? node_modules/pkg/j.js` for a
 * tree the provisioner made, with nothing in `git status`'s default view). A
 * proof that read it that way would report every provisioned tree as dirty and
 * refuse every fix round on the very step that prepares it. What the default
 * form still reports is enough for the claim being made: any untracked path — a
 * whole directory included — is listed, so a leftover from a killed round cannot
 * pass, and a child's edits to tracked files are listed too.
 */
export async function fixTree(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  head: string,
  round: number,
  runId: string,
  rows: DispatchUsageRow[],
): Promise<string> {
  const { repoRoot, issue } = ctx;
  const wt = fixTreeName(repoRoot, issue, round, runId);
  const created = await git(deps, repoRoot, ["worktree", "add", "--force", "--detach", wt, head]);
  if (created === undefined)
    throw new ReviewInfraError(
      `could not create the fix worktree at ${wt} for ${head.slice(0, 12)} — a path this step names for this round alone already exists, and adopting it would move somebody else's bytes onto the branch`,
      rows,
    );
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
  const dirty = await git(deps, wt, ["status", "--porcelain=v1"]);
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
  const back = await git(deps, wt, ["checkout", "-B", branch, head]);
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
 */
export function restoredSentence(what: Restored, wt: string, head: string): string {
  if (what === "restored") return ` — the run's tree was put back at ${head.slice(0, 12)}`;
  return ` — WORKTREE LEFT AT THE FIXER'S HEAD: ${wt} is ${
    what === "absent" ? "gone" : "not restored"
  } and verify and publish will read that tree`;
}

/**
 * One six-lens round's cost, as one row per lens child that ran.
 *
 * NOT one synthetic row for the round. The step's `dispatches` fold into
 * `usage.byRole` through `leanUsage`, and a round collapsed to a single row both
 * loses five children's wall clock (`ms: 0`, so every lean lens round reports
 * itself as taking no time) and halves the child count a host compares against
 * the frozen driver's per-lens dispatch events. The rows are built from the
 * per-lens records the review layer already returns — no new machinery — and a
 * lens that reported no usage is billed a zero row rather than dropped, since
 * `foldUsage` counts a dispatch whether or not it carried numbers.
 */
export function lensRows(lenses: LensRunResult[]): DispatchUsageRow[] {
  return lenses.map((lens) => ({
    role: "code-review-specialist",
    // `ms` is what the lens took; a child that died mid-spawn reported none, and
    // zero is the honest "nobody measured it", not a claim of an instant review.
    ms: lens.ms,
    // `blocked` is a lens that never ran (a missing skill, an unreadable roster
    // entry); `killCause` is the dispatch-cap kill. Neither is a review that
    // happened, and a cost record that said otherwise priced the next run wrong.
    ok: lens.ok && lens.blocked !== true && lens.killCause === undefined,
    usage: lens.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
  }));
}

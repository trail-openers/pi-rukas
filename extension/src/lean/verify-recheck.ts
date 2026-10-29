/**
 * lean/verify-recheck — reading the tree again, after the runs touched it.
 *
 * Every verify tier runs as a shell command or a test process INSIDE the worktree,
 * so between the checks that licensed this run and the green it is about to record,
 * a tier may have rewritten a frozen test, left bytes uncommitted, rewritten a file
 * it was judged on, committed and moved the head, or taken the tree off its branch.
 * A green decided about the commit at `head` while the tree now sits somewhere else
 * is a verdict about bytes no commit holds, so each licence is read again here.
 *
 * Two kinds of answer come back, and the distinction is the module's whole point.
 * A **red** is a verdict about the work — a tier altered the contract, or a command
 * criterion rewrote the file it was meant to leave alone, and the developer (or the
 * spec author) is told which. A **throw** is a machine that could not answer: an
 * unreadable HEAD, a porcelain that failed, a `symbolic-ref` that errored loudly.
 * Blaming a tier for git refusing to reply accuses the wrong party and hands the
 * run back with a verdict nobody observed, so those paths throw and never red.
 */

import { porcelain } from "./build-git.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { commandCriteriaTouched } from "./verify-commands.ts";
import type { CommandCriteriaOutcome } from "./verify-commands.ts";
import { frozenTamperReason } from "./verify-frozen.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** What a post-run re-read concluded: a verdict, or nothing to report. */
export type RecheckVerdict = { kind: "red"; reason: string } | { kind: "clean" };

/** A git read whose failure must not be blamed on the work. */
function unreadable(what: string, err: unknown): VerifyInfraError {
  return new VerifyInfraError(
    `could not re-check ${what}: ${(err as Error)?.message ?? String(err)}`,
  );
}

/** `git rev-parse HEAD`, or a throw — never an empty string read as "unchanged". */
async function headNow(exec: VerifyExec, wt: string, when: string): Promise<string> {
  const ran = await exec("git", {
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    throw unreadable(`HEAD after ${when}`, err);
  });
  return (ran?.stdout ?? "").trim();
}

/**
 * The porcelain state, or a throw.
 *
 * A porcelain that fails is not a clean tree: it is git that would not say, and a
 * step that read that silence as "nothing changed" would certify a tree it never
 * looked at.
 */
async function porcelainNow(exec: VerifyExec, wt: string, when: string): Promise<string> {
  return await porcelain(exec, wt).catch((err: unknown) => {
    throw unreadable(`the tree after ${when}`, err);
  });
}

/**
 * Re-read every licence the tiers were trusted with, in the order a reader would
 * ask about them: the contract, the tree, the head.
 *
 * `who` names the party a handback should blame — "the tiers" for the project's own
 * commands, "the command criteria" for the preservation runs — because each of
 * these failures used to read as a generic verify error and send a developer to
 * fix code nobody had touched.
 */
export async function recheckAfterRuns(opts: {
  exec: VerifyExec;
  wt: string;
  head: string;
  branch: string;
  baseSha: string;
  frozen: Record<string, string>;
  commands: CommandCriteriaOutcome;
  who: string;
}): Promise<RecheckVerdict> {
  const { exec, wt, head, branch, baseSha, frozen, commands } = opts;
  // The subject of every message below: "a verify tier moved HEAD" when the
  // project's own commands are the only suspects, "a command criterion moved HEAD"
  // when the preservation runs ran last. Naming the wrong party is how a developer
  // spends a build round on code nobody touched.
  const who = opts.who;
  const tampered = await frozenTamperReason(exec, wt, head, frozen);
  if (tampered !== undefined)
    return { kind: "red", reason: `${who} altered frozen tests: ${tampered}` };

  const dirty = await porcelainNow(exec, wt, "the tiers");
  if (dirty !== "")
    throw new VerifyInfraError(`${who} left the worktree dirty: ${dirty.slice(0, 500)}`);

  if ((await headNow(exec, wt, "the tiers")) !== head)
    throw new VerifyInfraError(`${who} moved HEAD`);

  // A tier may move HEAD without moving a commit: `git checkout --detach` leaves
  // the same sha sitting on no branch, which the read above cannot see. The run
  // owns a branch, not a sha, and everything after this step — publish, the land
  // gate — pushes and compares `ctx.run.branch`, so a detached tree is a tier that
  // took the run off its own branch.
  //
  // `symbolic-ref -q` EXITs 1 when HEAD is detached, and its answer is silence: an
  // empty stdout/stderr on that status is git saying "no branch". Any OTHER exit-1
  // failure — git wrote something on its way out — is a machine that could not
  // reply, and is never blamed on the tier.
  const symbolic = await exec("git", {
    argv: [...NO_HOOKS, "symbolic-ref", "--short", "-q", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    const e = err as { code?: unknown; stderr?: unknown };
    if (e?.code === 1 && String(e.stderr ?? "").trim() === "") return { stdout: "" };
    throw unreadable("the branch after the tiers", err);
  });
  // Compared against the branch THIS step owns — the same value handed to the
  // ownership probe before the runs — because that is the ref the worktree was
  // created on and the one everything after this step pushes.
  if ((symbolic?.stdout ?? "").trim() !== branch)
    throw new VerifyInfraError(`${who} detached HEAD from the run's branch`);

  // The command tier runs TEST CODE, and test code writes: a criterion whose own
  // script rewrote the file it was named for would otherwise be recorded as a
  // preservation criterion about bytes nobody observed. Its licences are compared
  // against what the gate saw BEFORE the runner started, not a fresh read.
  const touched = await commandCriteriaTouched(commands.executed, wt, baseSha, exec);
  if (touched !== undefined) return { kind: "red", reason: touched };

  return { kind: "clean" };
}

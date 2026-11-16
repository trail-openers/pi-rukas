/**
 * lean/verify-recheck — reading the tree again, after the runs touched it.
 *
 * Every verify tier runs as a shell command or a test process INSIDE the worktree, so between the
 * checks that licensed this run and the green it is about to record, a tier may have rewritten a frozen
 * test, left bytes uncommitted, rewritten a file it was judged on, committed and moved the head, or
 * taken the tree off its branch. A green decided about the commit at `head` while the tree now sits
 * somewhere else is a verdict about bytes no commit holds, so each licence is read again here.
 *
 * Two kinds of answer come back, and the distinction is the module's whole point. A **red** is a verdict
 * about the work — a tier altered the contract, or a command criterion rewrote the file it was meant to
 * leave alone, and the developer is told which. A **throw** is a machine that could not answer: an
 * unreadable HEAD, a porcelain that failed, a `symbolic-ref` that errored loudly. Blaming a tier for git
 * refusing to reply accuses the wrong party, so those paths throw and never red.
 */

import { porcelain } from "./build-git.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { oneLine } from "./text-fence.ts";
import { commandCriteriaTouched } from "./verify-commands.ts";
import type { CommandCriteriaOutcome } from "./verify-commands.ts";
import { frozenTamperReason } from "./verify-frozen.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** What a post-run re-read concluded: a verdict, or nothing to report. */
type RecheckVerdict = { kind: "red"; reason: string } | { kind: "clean" };

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
 * A porcelain that fails is not a clean tree: it is git that would not say, and a step that read that
 * silence as "nothing changed" would certify a tree it never looked at.
 *
 * `when` names the moment inside the refusal; `before: true` makes the message read "the tree before X"
 * rather than "after X" — a handback that blames a step for work it has not done yet sends the operator
 * to the wrong place.
 */
async function porcelainNow(
  exec: VerifyExec,
  wt: string,
  when: string,
  before?: boolean,
): Promise<string> {
  return await porcelain(exec, wt).catch((err: unknown) => {
    throw unreadable(`the tree ${before === true ? "before" : "after"} ${when}`, err);
  });
}

/**
 * THE clean-tree check, for a step that is about to run something and holds no frozen contract to
 * re-hash. `ci` calls it immediately before its full tier: the gate that ran at the build/verify
 * boundary says nothing about the bytes on disk when a later step starts a command in this same
 * worktree.
 *
 * This is the ONE clean-tree check — it goes through `porcelainNow` above, the same `porcelain` call
 * with `--untracked-files=all` that every other gate in lean uses.
 *
 * A dirty tree is INFRASTRUCTURE and throws: uncommitted bytes are not evidence that the code is wrong.
 */
export async function assertTreeClean(exec: VerifyExec, wt: string, who: string): Promise<void> {
  const dirty = await porcelainNow(exec, wt, who, true);
  if (dirty !== "")
    throw new VerifyInfraError(
      `${who} found the worktree ${wt} dirty — refusing to run on uncommitted bytes: ${dirty.slice(0, 500)}`,
    );
}

/**
 * Re-read every licence the tiers were trusted with, in the order a reader would ask about them:
 * the contract, the tree, the head.
 *
 * `who` names the party a handback should blame, and the gate calls this TWICE — once after the
 * project's own tiers (`who: "a verify tier"`), once after the spec's preservation runs (`who: "a
 * command criterion"`) — because a generic verify error here would send a developer to fix code nobody
 * had touched. The second pass adds the case the first cannot see: a criterion that disturbed the tree
 * while the tiers stayed clean.
 *
 * `when` is only the moment named in a "could not re-check X" message and is deliberately not derived
 * from `who`.
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
  /** The moment named in an unreadable-read message; defaults to "the tiers". */
  when?: string;
}): Promise<RecheckVerdict> {
  const { exec, wt, head, branch, baseSha, frozen, commands } = opts;
  // The subject of every message below: naming the wrong party is how a developer spends a build
  // round on code nobody touched.
  const who = opts.who;
  // The moment named in an unreadable-read message; deliberately NOT `who` — see the header.
  const when = opts.when ?? "the tiers";
  // Read by BOTH passes: a preservation run is test code, and test code can rewrite an acceptance
  // test exactly as a tier can.
  const tampered = await frozenTamperReason(exec, wt, head, frozen);
  if (tampered !== undefined)
    return { kind: "red", reason: `${who} altered frozen tests: ${tampered}` };

  const dirty = await porcelainNow(exec, wt, when);
  if (dirty !== "")
    throw new VerifyInfraError(`${who} left the worktree dirty: ${dirty.slice(0, 500)}`);

  if ((await headNow(exec, wt, when)) !== head) throw new VerifyInfraError(`${who} moved HEAD`);

  // A tier may move HEAD without moving a commit: `git checkout --detach` leaves the same sha on no
  // branch, which the read above cannot see. The run owns a branch, not a sha.
  //
  // `symbolic-ref -q` EXITs 1 when HEAD is detached and its answer is silence: empty stdout/stderr on
  // that status is git saying "no branch". Any OTHER exit-1 failure is a machine that could not reply.
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
  // Compared against the branch THIS step owns — the ref the worktree was created on and the one
  // everything after this step pushes.
  if ((symbolic?.stdout ?? "").trim() !== branch)
    throw new VerifyInfraError(`${who} detached HEAD from the run's branch`);

  // The command tier runs TEST CODE, and test code writes: a criterion whose own script rewrote the
  // file it was named for must be audited against what the gate saw BEFORE the runner started.
  const touched = await commandCriteriaTouched(commands.executed, wt, baseSha, exec);
  if (touched !== undefined) return { kind: "red", reason: touched };

  const dirtyAfterCommands = await porcelainNow(exec, wt, "the command criteria");
  if (dirtyAfterCommands !== "")
    // A durable record that reaches the PR body, quoting bytes a test wrote: clipped with the
    // untrusted-text renderer.
    throw new VerifyInfraError(
      `${who} left the worktree dirty after the command criteria: ${oneLine(dirtyAfterCommands, 200)}`,
    );

  if ((await headNow(exec, wt, "the command criteria")) !== head)
    throw new VerifyInfraError(`${who} moved HEAD after the command criteria`);

  const detachedAfterCommands = await exec("git", {
    argv: [...NO_HOOKS, "symbolic-ref", "--short", "-q", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    const e = err as { code?: unknown; stderr?: unknown };
    if (e?.code === 1 && String(e.stderr ?? "").trim() === "") return { stdout: "" };
    throw unreadable("the branch after the command criteria", err);
  });
  if ((detachedAfterCommands?.stdout ?? "").trim() !== branch)
    throw new VerifyInfraError(
      `${who} detached HEAD from the run's branch after the command criteria`,
    );

  return { kind: "clean" };
}

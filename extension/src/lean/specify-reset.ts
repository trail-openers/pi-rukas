/**
 * lean/specify-reset — the RESET of CAPTURE / RESET / REWRITE, the submodule
 * re-initialisation that reset makes necessary, and the verification of the COMMIT
 * that follows it.
 *
 * Both halves exist because the step's claims are git claims, and a git claim nobody
 * checked is a claim. This module does not consult HEAD at all — it names the base
 * sha, discards everything else, and then proves the tree actually got there.
 *
 * `clean -fdx` (not `-fd`) is deliberate: `-x` also removes ignored files, and a
 * child that wrote a `.gitignore` hiding a stray file would otherwise keep that file
 * through the reset, outside what `git status` reports. There is no exemption list:
 * the provisioned dependency links go with everything else and are rebuilt, so the
 * tree after a reset is built by one code path.
 *
 * `writeCaptured` follows no link either way: every ancestor of a target must be a
 * real directory, and each file lands through a `wx` temp write plus a rename, so an
 * existing name is never written through.
 *
 * The COMMIT that follows the freeze — `commitTestFiles`, and the `committedBlob` the
 * freeze hashes — is `specify-commit.ts`: discard-and-prove and record-and-prove are
 * two contracts, and the commit is the seam between them.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { leanRunnerPreflightEnabled } from "./runner-preflight-switch.ts";
import {
  type SubmoduleNote,
  initSubmodules as initWorktreeSubmodules,
  notesFor,
  submoduleState,
} from "./specify-submodules.ts";
import { changedPaths } from "./specify-tree.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { checkoutHolds } from "./submodule-verify.ts";
import { leanSubmodulesLocalEnabled } from "./submodules-local-switch.ts";

/** A reset the step cannot confirm. The engine turns this into handed-back 10. */
export class SpecifyResetError extends Error {
  override readonly name = "SpecifyResetError";
}

/** A commit the step cannot verify. Same treatment. */
export class SpecifyCommitError extends Error {
  override readonly name = "SpecifyCommitError";
}

/**
 * The git flags every lean step's git calls carry. The hooks a repository has are
 * somebody else's policy, and a repo-supplied fsmonitor is a program git runs on
 * every status: either could write into a commit the step never captured.
 */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;

/** The wall clock on a local git write (`checkout`, `reset`, `worktree add`). */
const LOCAL_GIT_MS = 120_000;
/** The wall clock on a short local read (`rev-parse`). */
const QUICK_GIT_MS = 30_000;
/** The largest git stdout a step will hold. */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * One local git call as argv, or `undefined` when git refused rather than said no.
 *
 * The shared shape — the `NO_HOOKS` prefix, the 120s bound, the buffer cap, the
 * swallow-to-`undefined` — that every lean step except `build` wants; `build` keeps
 * its own for a per-call timeout and a different cap.
 *
 * A refusal is `undefined` rather than a throw by design: callers decide what a
 * failed read means, and the review step's reads distinguish "git could not run"
 * from "git found nothing" through the outcome-returning resolver.
 */
export async function gitQuiet(
  exec: ExecFn,
  cwd: string,
  argv: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string } | undefined> {
  try {
    const r = await exec("git", {
      argv: [...NO_HOOKS, ...argv],
      cwd,
      timeout: opts.timeout ?? LOCAL_GIT_MS,
      maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
    });
    return { stdout: r.stdout ?? "" };
  } catch {
    return undefined;
  }
}

/** Counter for temp names, so two files of one capture never share one. */
let writeSeq = 0;

/**
 * Why writing `abs` would follow a link, or undefined when it would not.
 *
 * Every EXISTING ancestor from `wt` down to `abs`'s parent is `lstat`'d. A symlinked
 * directory anywhere on that path turns "write the test back into the worktree" into
 * "write it wherever the link points", and the clean-tree assertion afterwards would
 * still pass — the outside file is not in `git status`.
 */
function ancestorProblem(wt: string, abs: string): string | undefined {
  // The chain is the ancestors BELOW `wt`, innermost last: `wt` itself is the
  // boundary the step owns and is not inspected.
  const chain: string[] = [];
  for (let dir = path.dirname(abs); dir !== wt && dir !== path.dirname(dir); ) {
    chain.unshift(dir);
    dir = path.dirname(dir);
  }
  for (const d of chain) {
    if (existsSync(d)) {
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(d);
      } catch (err) {
        return `ancestor ${d} could not be read: ${(err as Error).message}`;
      }
      if (st.isSymbolicLink()) return `ancestor ${d} is a symlink`;
      if (!st.isDirectory()) return `ancestor ${d} is not a directory`;
    }
  }
  return undefined;
}

/**
 * Create the missing ancestors of `abs`, ONE LEVEL AT A TIME, `lstat`ing each new
 * directory to prove it is a directory and not a link.
 *
 * `mkdirSync(recursive: true)` is not used: it creates every component in one call
 * and reports nothing about them, so a component that already existed as a symlink
 * would be accepted silently.
 */
function ensureRealDirs(wt: string, abs: string): void {
  const segments = path.relative(wt, abs).split(path.sep).slice(0, -1);
  let dir = wt;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir);
      } catch (err) {
        throw new SpecifyInfraError(`could not create ${dir}: ${(err as Error).message}`);
      }
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) throw new SpecifyInfraError(`created ancestor ${dir} is a symlink`);
    if (!st.isDirectory())
      throw new SpecifyInfraError(`created ancestor ${dir} is not a directory`);
  }
}

/**
 * A write the step refuses because following it would leave the worktree.
 *
 * Also the type the `specify` dispatch throws for a child that died, and it
 * carries that dispatch's cost rows (`BuildInfraError` says why): the child
 * spent tokens before it died and a throw records no outcome.
 */
export class SpecifyInfraError extends Error {
  override readonly name = "SpecifyInfraError";

  /** The cost rows this failure already observed, when it knows them. */
  readonly dispatches?: DispatchUsageRow[];

  constructor(message: string, dispatches?: DispatchUsageRow[]) {
    super(message);
    if (dispatches !== undefined) this.dispatches = dispatches;
  }
}

/**
 * Write captured bytes back to their paths, creating parent directories.
 *
 * Three rules, each against a way the rewrite could land somewhere other than the
 * path it names: no symlinked ancestor (`ancestorProblem` before the write,
 * `ensureRealDirs` after each creation), and a `wx` write to a temp name in the FINAL
 * directory followed by `renameSync` into place — so a path the child left as a link
 * or a device is never opened for writing, and the bytes appear atomically.
 */
export function writeCaptured(wt: string, captured: Map<string, Buffer>): void {
  for (const [rel, bytes] of captured) {
    const abs = path.join(wt, rel);
    const problem = ancestorProblem(wt, abs);
    if (problem !== undefined) throw new SpecifyInfraError(`could not write ${rel}: ${problem}`);
    ensureRealDirs(wt, abs);
    const dir = path.dirname(abs);
    // `wx` — fail if the name exists. A name already there means the tree is not the
    // tree the reset made, and the caller resets again rather than writing through it.
    let tmp = `${dir}/.lean-capture-${process.pid}-${writeSeq++}`;
    for (let n = 0; ; n++) {
      try {
        writeFileSync(tmp, bytes, { flag: "wx" });
        break;
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code !== "EEXIST" || n > 8)
          throw new SpecifyInfraError(`could not write ${rel}: ${(err as Error).message}`);
        tmp = `${dir}/.lean-capture-${process.pid}-${writeSeq}-${n}`;
      }
    }
    try {
      renameSync(tmp, abs);
    } catch (err) {
      try {
        // Never leave the temp file behind for the clean-tree assertion to trip on.
        rmSync(tmp, { force: true });
      } catch {
        /* nothing else to do */
      }
      throw new SpecifyInfraError(`could not place ${rel}: ${(err as Error).message}`);
    }
  }
}

/**
 * Reset `wt` completely to `baseSha`: child commits, staged changes, untracked
 * files, ignore tricks AND the provisioned dependency links all go, and the run's
 * branch is pointed at the base. A caller whose tree owns no branch passes `""` for
 * `branch` and is checked out detached, since git refuses to `-B` a name onto a
 * tree whose branch somebody else holds.
 *
 * Both checkout forms carry `-f`. Without it git refuses to move a tree whose
 * tracked files are dirty (exit 1) — exactly what a build child leaves behind when
 * it committed a file and then kept editing it, so a routine budget stop would hand
 * the run back as a reset failure. Nothing here is worth protecting: the bytes a
 * caller keeps were read into memory before this ran, and the `reset --hard` and
 * `clean -fdx` below discard everything the forced checkout walked past anyway.
 *
 * The clean carries no `-e` exemptions. Exempting the links by name meant a leftover
 * tree kept whatever links its first provisioning made, with nothing checking they
 * still pointed anywhere; now the tree is emptied and re-provisioned, so a link is
 * always the one built at this reset. The clean-tree assertion runs AFTER the
 * submodule re-initialisation, because the tree the reset actually produces — the one
 * every caller hands its child — is the populated one: proof and product then
 * describe the same bytes.
 *
 * `git clean -fdx` de-populates every submodule the base carries, and a test that
 * imports from one then fails before collection — so a runner that cannot collect is
 * blamed on the adversary. `initSubmodules` runs inside this function rather than in
 * one caller after it, because every reset has to restore them. It is also why
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` is honoured HERE rather than at any caller:
 * the one place that makes no reset ask git to populate anything, so the switch-off
 * state holds for build's fold and the review fix round too.
 *
 * Throws `SpecifyResetError` unless `rev-parse HEAD` equals `baseSha` and
 * `status --porcelain` reports nothing — that confirmation is the function: the
 * commands are routine, and the only failure that matters is the one where they did
 * not do what they say.
 *
 * It RETURNS what the submodule pass did (see `lean/specify-submodules.ts`) rather
 * than only tracing it: a disclosure that lives in one caller's log is a disclosure
 * most steps never report, and the same empty gitlink is a fact `challenge`'s verdict,
 * `build`'s fold and the review fix round all have to be able to say. Callers that have
 * nowhere to put it ignore the value, which is why widening the return rather than
 * adding a note-list parameter leaves all six call sites compiling unchanged.
 */
export async function resetWorktreeToBase(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  branch: string,
  /**
   * Called with the tree the clean left — a submodule the base carries present as a
   * gitlink, nothing fetched — before this function asks git to populate it. Product
   * code never supplies it; it is how a smoke test sabotages a submodule between the
   * clean and the command that has to recover it, which is the only way to watch git
   * fail that command rather than assert what it would have done.
   */
  beforeSubmoduleInit?: (wt: string) => void | Promise<void>,
): Promise<SubmoduleNote[]> {
  // `-B` first so the branch — not a detached HEAD — is what `reset --hard` moves:
  // the frozen commit has to land on the run's branch, and a leftover branch from a
  // previous attempt must move to the base rather than keep its commits.
  // The tree is put at the base in THREE steps rather than one `worktree add --detach` +
  // `reset --hard`, and the order is load-bearing: `-B` first so the branch (not a detached
  // HEAD) is what `reset --hard` moves — the frozen commit has to land on the run's branch and
  // a leftover branch from a previous attempt must move to the base rather than keep its
  // commits — and `clean -fdx` LAST because it is what takes the dependency links away, so
  // every shape of leftover (child commits, staging, untracked files, ignore tricks, links,
  // and a submodule's checkout) is gone before the pass below is asked to rebuild any of them.
  const steps: string[][] = [
    branch === ""
      ? [...NO_HOOKS, "checkout", "-f", "--detach", baseSha]
      : [...NO_HOOKS, "checkout", "-f", "-B", branch, baseSha],
    [...NO_HOOKS, "reset", "--hard", baseSha],
    [...NO_HOOKS, "clean", "-fdx"],
  ];
  for (const argv of steps) {
    try {
      await exec("git", { argv, cwd: wt, timeout: LOCAL_GIT_MS, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      throw new SpecifyResetError(
        `git ${argv.join(" ")} failed in ${wt}: ${(err as Error).message}`,
      );
    }
  }
  // What the pass did, kept for the caller: `challenge` and the review fix round fold
  // it into their own reason, and an unseeded submodule is a fact about the tree they
  // are about to judge. The clean-tree proof below runs AFTER the pass, so the tree it
  // proves is the one the child gets — including any gitlink this step left empty.
  //
  // The outer gate is honoured HERE rather than only inside the pass. With the runner
  // untrusted the claim of that switch is that the step asks git to populate NOTHING,
  // and a probe issued after the pass would contradict it in the argv even though it
  // fetches nothing: the pre-fix reset issued no submodule command at all in this shape,
  // and the case pinning that shape reads the argv the step issued.
  if (!leanRunnerPreflightEnabled()) return [];
  const notes = await initSubmodules(exec, wt, beforeSubmoduleInit);
  // Two reads decide whether the tree is asked about, and they are decided differently.
  //
  //   - the local rule off: the switch-off arm is the release's own argv byte for byte (which
  //     a case pins), and that argv contained no submodule call of any kind — so with
  //     `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=0` nothing further leaves here, not even a read.
  //   - nothing seeded: with no populating call there is no pass to disbelieve. A tree nobody
  //     populated needs no disclosure either — the pass said so itself, with an `absent` note
  //     for every path it could not supply — and a read would put a submodule command on a run
  //     that issued none, which is the claim `test-lean-specify-submodule.ts` (g) reads off
  //     the argv. The test is asked of the pass's OWN account rather than of the file system:
  //     whether something was seeded is what this step knows about its own work, and asking
  //     the tree whether anything arrived is the question the read below exists to answer — a
  //     pass that seeded nothing and a pass that seeded nothing-into-place must not be
  //     distinguished by the very probe under test, or the probe decides its own case.
  if (!leanSubmodulesLocalEnabled() || !notes.some((n) => n.kind === "seeded")) return notes;
  // And then git is asked what the tree actually holds. A step's own account of a pass it
  // ran is not evidence that the tree ended up populated: `git submodule status` prints
  // `U` for a gitlink with no git dir behind it, and a seeded submodule whose checkout
  // does not hold the file its recorded commit names is empty whatever the pass reported.
  // Both reads are of the tree, never of the source the step chose — which is exactly the
  // case they catch, a local source that quietly lost its content. Anything this step
  // already named keeps its own account; these reads only fill silence.
  const withContent = notes.map((n) =>
    n.kind === "seeded" && n.expect !== undefined && !checkoutHolds(wt, n.path, n.expect)
      ? { ...n, emptyCheckout: true }
      : n,
  );
  const state = await submoduleState(exec, wt);
  const claimed = new Set(notes.filter((n) => n.kind !== "seeded").map((n) => n.path));
  const unproven = (state?.unpopulated ?? []).filter((p) => !claimed.has(p));
  // Three shapes of the same carry. With nothing unproven the notes are already the
  // account; with nothing in the account at all, git's answer IS the account; and when
  // both have something, git's finding rides on the first note rather than as a note of
  // its own, because the clause the caller builds reads one list and a reader must not
  // have to know which of the two reads produced a path.
  const first = withContent[0];
  const carried: SubmoduleNote[] =
    unproven.length === 0
      ? withContent
      : withContent.length === 0
        ? notesFor(unproven)
        : first === undefined
          ? notesFor(unproven)
          : [{ ...first, unproven }, ...withContent.slice(1)];
  // Retargeting a submodule's URL rewrites `.gitmodules` in the work tree, which is the
  // one file the seed is allowed to touch and the one file the proof below would
  // otherwise (correctly, on its own terms) refuse the tree for. Restoring it from the
  // base commit costs one local `checkout`, is exactly the bytes `reset --hard` had
  // already put there before the clean, and leaves the pass writing nothing that
  // survives it. Restored ONLY where the pass seeded something: a tree it never touched
  // must stay dirty-if-dirty, or the proof would be forgiving a child's edit.
  if (withContent.some((n) => n.kind === "seeded")) {
    try {
      await exec("git", {
        // `--no-overlay` is not an aesthetic choice. The plain form of this command
        // resolves its pathspec through the index, and a path registered as a gitlink
        // is not a file the index can resolve — so `git checkout -- .gitmodules` in a
        // tree WITH a submodule dies with `pathspec '.gitmodules' did not match any
        // file(s) known to git` and the rewrite survives. Asking git to read the
        // version out of the commit rather than through the index is the one form that
        // works in both a tree with submodules and a tree without.
        argv: [...NO_HOOKS, "checkout", "--no-overlay", "HEAD", "--", ".gitmodules"],
        cwd: wt,
        timeout: QUICK_GIT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // Best-effort: a tree whose `.gitmodules` this cannot restore is caught two lines
      // later by the clean-tree proof, which refuses it. Silence here cannot make an
      // unproven tree look proven.
    }
  }
  const head = await exec("git", {
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const headSha = (head?.stdout ?? "").trim();
  if (headSha !== baseSha)
    throw new SpecifyResetError(
      `worktree ${wt} is at ${headSha === "" ? "an unreadable commit" : headSha}, not the base ${baseSha}`,
    );
  const dirty = await changedPaths(exec, wt);
  if (dirty.length > 0)
    throw new SpecifyResetError(
      `worktree ${wt} is not clean at the base: ${dirty
        .slice(0, 8)
        .map((e) => `${e.status} ${e.path}`)
        .join(", ")}${dirty.length > 8 ? ` (+${dirty.length - 8} more)` : ""}`,
    );
  return carried;
}

/**
 * Populate the worktree's submodules, when its commit has any — the seam into
 * `lean/specify-submodules.ts`, which owns WHERE submodules come from, both arms of
 * `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL`, and the disclosure of a submodule this host
 * never had. This is the one call the reset makes.
 *
 * Why it sits INSIDE the reset rather than beside it: the reset's own
 * `git clean -fdx` is the most reliable de-populator a submodule has — it takes the
 * submodule contents along with `node_modules` and the dependency links — so a tree
 * that looks clean is not a tree that is complete. Anything that runs after the
 * reset and before a child inherits the emptiness. The disclosure its pass produces
 * is reported by the worktree's owner (`ensureSpecifyWorktreeWithProvision`) and kept
 * out of this signature on purpose: the six reset call sites — `specify`'s two,
 * `build`'s fold, `challenge`'s two and the review fix round's — stay as they were,
 * which matters because the switch's claim covers every one of them.
 *
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` still returns before git is asked anything;
 * that gate lives in the module called here, so the switch-off state holds for
 * `build`'s fold and the review fix round exactly as it does for `specify`.
 */
async function initSubmodules(
  exec: ExecFn,
  wt: string,
  /** Passed through from {@link resetWorktreeToBase}; product code never supplies it. */
  beforeInit?: (wt: string) => void | Promise<void>,
): Promise<SubmoduleNote[]> {
  return initWorktreeSubmodules(exec, wt, beforeInit);
}

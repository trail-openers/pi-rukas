/**
 * lean/specify-reset — the RESET of CAPTURE / RESET / REWRITE, the submodule
 * re-initialisation that reset makes necessary, and the verification of the COMMIT
 * that follows it.
 *
 * Both halves exist because the step's claims are git claims, and a git claim nobody checked is a claim. The
 * reset never consults HEAD — it names the base sha, discards everything else, then proves the tree got there.
 *
 * `clean -fdx` (not `-fd`) is deliberate: `-x` also removes ignored files, and a child that wrote a
 * `.gitignore` hiding a stray file would keep it through the reset, outside what `git status` reports. No
 * exemption list: the provisioned dependency links go with everything else and are rebuilt, so the tree after
 * a reset is built by one code path.
 *
 * `writeCaptured` follows no link: every ancestor must be a real directory, and each file lands through a `wx`
 * temp write plus a rename, so an existing name is never written through.
 *
 * The COMMIT that follows the freeze — `commitTestFiles` and the `committedBlob` the freeze hashes — is
 * `specify-commit.ts`: discard-and-prove and record-and-prove are two contracts, and the commit is the seam.
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

/** A reset the step cannot confirm. The engine turns this into handed-back 10. */
export class SpecifyResetError extends Error {
  override readonly name = "SpecifyResetError";
}

/** A commit the step cannot verify. Same treatment. */
export class SpecifyCommitError extends Error {
  override readonly name = "SpecifyCommitError";
}

// `NO_HOOKS`, the flags every lean git call carries, arrives from `submodule-reads.ts` — a leaf — so the
// submodule modules carry it without importing the reset back. Re-exported for call sites outside `lean/`.
import { NO_HOOKS } from "./submodule-reads.ts";
export { NO_HOOKS } from "./submodule-reads.ts";
/** The wall clock on a local git write (`checkout`, `reset`, `worktree add`). */
const LOCAL_GIT_MS = 120_000;
/** The wall clock on a short local read (`rev-parse`). */
const QUICK_GIT_MS = 30_000;
/** The largest git stdout a step will hold. */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * One local git call as argv, or `undefined` when git refused rather than said no.
 *
 * The shared shape — `NO_HOOKS` prefix, 120s bound, buffer cap, swallow-to-`undefined` — that every lean
 * step except `build` wants. A refusal is `undefined` not a throw by design: callers decide what a failed
 * read means.
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

/**
 * `git merge-base --is-ancestor sha HEAD` in `wt`: success is `true`, git's own exit 1 is `false`, and any
 * other rejection (no code, a kill's `null`) throws `fail()` — "could not tell" never reads as "descends".
 * Success is tagged by the fulfilled branch, and the call bypasses `gitQuiet`, which erases the exit code.
 */
export async function headIsDescendant(
  exec: ExecFn,
  wt: string,
  sha: string,
  fail: () => Error,
): Promise<boolean> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "merge-base", "--is-ancestor", sha, "HEAD"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, code: (err as { code?: unknown })?.code }),
  );
  if (r.ok) return true;
  if (r.code === 1) return false;
  throw fail();
}

/** Counter for temp names, so two files of one capture never share one. */
let writeSeq = 0;

/**
 * Why writing `abs` would follow a link, or undefined when it would not.
 *
 * Every EXISTING ancestor from `wt` down to `abs`'s parent is `lstat`'d. A symlinked directory anywhere on
 * that path turns "write the test back into the worktree" into "write it wherever the link points" — and the
 * clean-tree assertion would still pass.
 */
function ancestorProblem(wt: string, abs: string): string | undefined {
  // Ancestors BELOW `wt`, innermost last — `wt` itself is the boundary the step owns, not inspected.
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
 * Create the missing ancestors of `abs`, ONE LEVEL AT A TIME, `lstat`ing each new directory to prove it is a
 * directory and not a link. `mkdirSync(recursive: true)` is not used: it creates every component in one call
 * and reports nothing about them, so one that already existed as a symlink would be accepted silently.
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
 * Also the type the `specify` dispatch throws for a child that died, carrying that dispatch's cost rows
 * (`BuildInfraError` says why): the child spent tokens before it died and a throw records no outcome.
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
 * Three rules, each against a way the rewrite could land somewhere other than the path it names: no symlinked
 * ancestor (`ancestorProblem` before the write, `ensureRealDirs` after each creation), and a `wx` write to a
 * temp name in the FINAL directory then `renameSync` into place — bytes appear atomically, a link never opens.
 */
export function writeCaptured(wt: string, captured: Map<string, Buffer>): void {
  for (const [rel, bytes] of captured) {
    const abs = path.join(wt, rel);
    const problem = ancestorProblem(wt, abs);
    if (problem !== undefined) throw new SpecifyInfraError(`could not write ${rel}: ${problem}`);
    ensureRealDirs(wt, abs);
    const dir = path.dirname(abs);
    // `wx` — fail if the name exists: a name already there means the tree is not the one the reset made,
    // and the caller resets again rather than writing through it.
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
        // Never leave the temp file for the clean-tree assertion to trip on.
        rmSync(tmp, { force: true });
      } catch {
        /* nothing else to do */
      }
      throw new SpecifyInfraError(`could not place ${rel}: ${(err as Error).message}`);
    }
  }
}

/**
 * Reset `wt` completely to `baseSha`: child commits, staged changes, untracked files, ignore tricks AND the
 * provisioned dependency links all go, and the run's branch is pointed at the base. A caller whose tree owns no
 * branch passes `""` and is checked out detached — git refuses to `-B` a name onto a tree whose branch somebody
 * else holds.
 *
 * Both checkout forms carry `-f`. Without it git refuses to move a tree with dirty tracked files (exit 1) —
 * exactly what a build child leaves behind after committing a file and keeping edits, so a routine budget stop
 * would hand the run back as a reset failure.
 *
 * The clean carries no `-e` exemptions: exempting the links by name meant a leftover tree kept whatever links
 * its first provisioning made, nothing checking they still pointed anywhere. The clean-tree assertion runs AFTER
 * the submodule re-initialisation, so proof and product describe the same bytes.
 *
 * `git clean -fdx` de-populates every submodule the base carries, and a test importing from one fails before
 * collection — so a runner that cannot collect is blamed on the adversary. `initSubmodules` runs inside this
 * function because every reset must restore them, and `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` is honoured HERE for
 * the same reason: the one place that makes no reset ask git to populate anything.
 *
 * Throws `SpecifyResetError` unless `rev-parse HEAD` equals `baseSha` and `status --porcelain` reports nothing —
 * that confirmation IS the function: the commands are routine, and the only failure that matters is the one
 * where they did not do what they say.
 *
 * It RETURNS what the submodule pass did (see `lean/specify-submodules.ts`) rather than only tracing it: a
 * disclosure in one caller's log is one most steps never report, and the same empty gitlink is a fact the later
 * verdicts must be able to say.
 */
export async function resetWorktreeToBase(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  branch: string,
  /**
   * Called with the tree the clean left — a submodule the base carries present as a gitlink, nothing fetched —
   * before this function asks git to populate it. Product code never supplies it; it is how a smoke test
   * sabotages a submodule between the clean and the command that must recover it.
   */
  beforeSubmoduleInit?: (wt: string) => void | Promise<void>,
): Promise<SubmoduleNote[]> {
  // THREE steps, order load-bearing: `-B` first so the branch (not a detached HEAD) is what `reset --hard`
  // moves — the frozen commit must land on the run's branch, and a leftover branch from a previous attempt
  // moves to the base rather than keep its commits — and `clean -fdx` LAST because it takes the dependency
  // links away, so every leftover shape is gone before the pass below rebuilds them.
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
  // What the pass did, kept for the caller: `challenge` and the review fix round fold it into their reason,
  // since an unseeded submodule is a fact about the tree they judge. The clean-tree proof below runs AFTER the
  // pass, so the tree it proves is the one the child gets — including any gitlink this step left empty.
  //
  // The outer gate is honoured HERE, not only inside the pass: with the runner untrusted the switch's claim is
  // that the step asks git to populate NOTHING. The case pinning this reads the argv the step issued.
  if (!leanRunnerPreflightEnabled()) return [];
  const notes = await initSubmodules(exec, wt, beforeSubmoduleInit);
  // Nothing seeded: with no populating call there is no pass to disbelieve — the test is asked of the
  // pass's OWN account, not the file system.
  if (!notes.some((n) => n.kind === "seeded")) return notes;
  // Then git is asked what the tree holds, because a step's account of a pass it ran is not evidence the tree
  // ended up populated. `git submodule status` marks a gitlink nothing checked out (parser in
  // `specify-submodules.ts`), and a seeded submodule whose checkout lacks the file its recorded commit names
  // is empty whatever the pass reported. Both reads are of the tree, never the source the step chose.
  const withContent = notes.map((n) =>
    n.kind === "seeded" && n.expect !== undefined && !checkoutHolds(wt, n.path, n.expect)
      ? { ...n, emptyCheckout: true }
      : n,
  );
  const state = await submoduleState(exec, wt);
  const claimed = new Set(notes.filter((n) => n.kind !== "seeded").map((n) => n.path));
  const unproven = state.unpopulated.filter((p) => !claimed.has(p));
  // The backstop's own death is a finding, not an absence: it either becomes a note of its own or rides on
  // the first, but either way the clause says the tree could not be proved.
  if (state.unreadable === true) {
    const head = withContent[0];
    const marked: SubmoduleNote = { path: "", kind: "failure", detail: "", unreadable: true };
    return head === undefined ? [marked] : [{ ...head, unreadable: true }, ...withContent.slice(1)];
  }
  // Three shapes of one carry: nothing unproven, the pass's account stands; nothing in the account, git's
  // answer IS the account; both, git's finding rides on the first note rather than becoming its own.
  const first = withContent[0];
  const carried: SubmoduleNote[] =
    unproven.length === 0
      ? withContent
      : first === undefined
        ? notesFor(unproven)
        : [{ ...first, unproven }, ...withContent.slice(1)];
  // The seeding's ONLY durable write is the submodule's own checkout — what the step was asked to create and
  // what the clean-tree proof is entitled to see. `submodule set-url` is what leaves residue: it rewrites
  // `.gitmodules` in this work tree AND writes `submodule.<name>.url` into the shared `.git/config`, so both
  // assignments here are command-line `-c` on the one call that reads them.
  // Restored ONLY where the pass seeded something: a tree it never touched stays dirty-if-dirty, or the proof
  // would be forgiving a child's edit.
  if (withContent.some((n) => n.kind === "seeded")) {
    try {
      await exec("git", {
        // `--no-overlay` is not aesthetic: the plain form resolves its pathspec through the index, and a path
        // registered as a gitlink is not a file the index can resolve — so `git checkout -- .gitmodules` in a
        // tree WITH a submodule dies. Reading the version out of the commit is the one form that works either way.
        argv: [...NO_HOOKS, "checkout", "--no-overlay", "HEAD", "--", ".gitmodules"],
        cwd: wt,
        timeout: QUICK_GIT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // Best-effort: a tree whose `.gitmodules` this cannot restore is refused two lines later by the
      // clean-tree proof.
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
 * Populate the worktree's submodules when its commit has any — the seam into `lean/specify-submodules.ts`,
 * which owns WHERE submodules come from and the disclosure of a submodule this host never had.
 *
 * It sits INSIDE the reset rather than beside it because the reset's own `git clean -fdx` is the most reliable
 * de-populator a submodule has — a tree that looks clean is not a complete one. The disclosure its pass
 * produces is reported by the worktree's owner (`ensureSpecifyWorktreeWithProvision`), kept out of this
 * signature on purpose. `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` returns before git is asked anything.
 */
async function initSubmodules(
  exec: ExecFn,
  wt: string,
  /** From {@link resetWorktreeToBase}; product code never supplies it. */
  beforeInit?: (wt: string) => void | Promise<void>,
): Promise<SubmoduleNote[]> {
  return initWorktreeSubmodules(exec, wt, beforeInit);
}

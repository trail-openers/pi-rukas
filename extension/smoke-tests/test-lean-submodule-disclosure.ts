#!/usr/bin/env bun
/**
 * lean/submodule-disclosure — the empty gitlink is said, not swallowed.
 *
 * The bug this exists for is quieter than the one the local seeding fixed. The seeding
 * arm of #2319 deliberately leaves a submodule the superproject never held as an EMPTY
 * gitlink and reports it. The reset then proved the tree clean and the step carried on,
 * and the child's test failed with `cannot import vendor/lib` — the symptom #2172 was
 * opened for, reached by a different road. A run that knows its tree is incomplete and
 * says nothing about it hands the operator a red test with no cause: the reason line is
 * the only place that knowledge can live, because nothing else about the run looks
 * unusual.
 *
 *   (a) a pass that finished and reported an unseeded submodule — the disclosure has to
 *       reach the caller's `problem` and the trace, and it has to rest on a READ of the
 *       tree rather than on the pass's own account;
 *   (b) a pass that reported a clean seed over a tree whose submodule holds nothing —
 *       the lie the read of the tree must outrank;
 *   (c) the clause's own rules, including the fully-seeded case that must stay quiet.
 *
 * (a) runs over a stub git, because it is about what the step REPORTS about a pass it
 * was told succeeded, and a real repository would put git's submodule parser between the
 * assertion and the reporting. (b) runs over a real repository, because a stubbed lie is
 * a stub's opinion about a lie.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { resetWorktreeToBase } from "../src/lean/specify-reset.ts";
import {
  type SubmoduleNote,
  notesFor,
  submoduleNoteClause,
} from "../src/lean/specify-submodules.ts";
import { ensureSpecifyWorktreeWithProvision } from "../src/lean/specify-tree.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { INSIDE, SUB } from "./lib/lean-specify-submodule-fixture.ts";
import {
  gitAsk,
  holds,
  hollowSubmoduleRepo,
  isSubmodulePopulate,
} from "./lib/lean-submodule-hollow.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Every git argv the stub saw, for the claims about what the step ASKED git to do. */
const calls: string[][] = [];

/**
 * The main checkout of a tree the stub is asked about, read from the shape the fixture builds.
 *
 * `treeWithGitmodules` puts the run's tree at `<root>/.worktrees/lean-<n>`, so the tree holding
 * the base's submodule records — the one the stub must name as the common dir's parent — is two
 * components up. It is derived rather than captured because the stub is handed a `cwd`, and a
 * stub that guessed the wrong directory here would have the seed read a place nobody wrote to.
 */
const repoRootOf = (cwd: string): string => {
  const marker = `${path.sep}.worktrees${path.sep}`;
  const at = cwd.lastIndexOf(marker);
  return at === -1 ? cwd : cwd.slice(0, at);
};

/** A distinct 40-hex sha per case, so a stub can be told which base to confirm. */
const sha = (n: number): string => n.toString(16).padStart(40, "0");

/**
 * A directory tree whose base carries one submodule: `.gitmodules` at the superproject
 * AND in the worktree the step is about to reset.
 *
 * Both are read from DISK — `initSubmodules` and the read of the tree each begin by
 * asking whether the file exists at the tree they were handed, and a path they did not
 * pass through `exec` cannot be answered by a stub. Only git's ANSWERS are stubbed.
 * Deliberately not a repository: this is about what the step reports, and a real repo
 * would put git's submodule parser between the assertion and the behaviour under test.
 */
function treeWithGitmodules(tag: string, issue: number): string {
  const root = path.join("/tmp", `lean-submodule-disclosure-${tag}`);
  const wt = path.join(root, ".worktrees", `lean-${issue}`);
  const file = `[submodule "${SUB}"]\n\tpath = ${SUB}\n`;
  for (const dir of [root, wt]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".gitmodules"), file);
    if (!existsSync(path.join(dir, ".gitmodules")))
      throw new Error(`the disclosure fixture could not write ${dir}/.gitmodules`);
  }
  return root;
}

/**
 * A git that agrees with everything, over a tree whose base carries one submodule.
 *
 * The reset proves its own work — it asks git where HEAD landed and refuses a tree it
 * cannot confirm at the base — so a stub that wants to be believed has to answer that
 * with the sha the caller asked for. The ownership check's one question (`worktree list`)
 * is answered with the case's own tree, because the case is about the pass that runs
 * AFTER ownership was settled. None of that is the thing under test: the stub agrees
 * about everything except the submodule.
 */
const agreeToEverything =
  (want: string, issue: number): ExecFn =>
  async (cmd, o) => {
    const argv = (o?.argv ?? []) as string[];
    const joined = argv.join(" ");
    calls.push([...argv]);
    if (joined.includes("worktree") && joined.includes("list"))
      return {
        stdout: `worktree ${String(o?.cwd ?? "")}/.worktrees/lean-${issue}\n`,
        exitCode: 0,
      } as never;
    if (joined.includes("--get-regexp"))
      return { stdout: `submodule.${SUB}.path ${SUB}\n`, exitCode: 0 } as never;
    if (joined.includes("submodule") && joined.includes("status"))
      return { stdout: `U${"0".repeat(39)} ${SUB}\n`, exitCode: 0 } as never;
    if (joined.includes("rev-parse")) {
      // The seeding's two git-dir questions have to be answered with the SHAPE of a git dir, not
      // with the base's sha: `superprojectRoot` reads git's answer for its shape and refuses
      // anything that is not `<…>/.git` or `<…>/.git/worktrees/<name>`, so a stub that returned
      // `want` here was refused and the case never reached the disclosure it is about. Every
      // other question keeps the base's sha, which is what the reset's own proof asks for.
      if (joined.includes("--git-common-dir"))
        return { stdout: `${repoRootOf(String(o?.cwd ?? ""))}${path.sep}.git\n`, exitCode: 0 } as never;
      if (joined.includes("--absolute-git-dir") || joined.includes("--git-dir"))
        return {
          stdout: `${path.join(repoRootOf(String(o?.cwd ?? "")), ".git", "worktrees", `lean-${issue}`)}\n`,
          exitCode: 0,
        } as never;
      return {
        stdout: joined.includes("--show-toplevel") ? `${String(o?.cwd ?? "")}\n` : `${want}\n`,
        exitCode: 0,
      } as never;
    }
    return { stdout: "", exitCode: 0 } as never;
  };

// ── (a) an empty gitlink is named in the problem the caller gets
{
  calls.length = 0;
  const repoRoot = treeWithGitmodules("a", 1);
  const baseSha = sha(1);
  const { problem, wt } = await ensureSpecifyWorktreeWithProvision(agreeToEverything(baseSha, 1), {
    repoRoot,
    issue: 1,
    fromRef: baseSha,
    branch: "lean/issue-1",
  });
  assert(
    problem?.includes(SUB) === true,
    `(a) a reset whose submodule came back empty names the submodule in the problem it returns (got ${String(problem)})`,
  );
  assert(
    problem !== undefined && /nothing on this host could supply them/.test(problem),
    `(a) and says why rather than leaving it a bare path (got ${String(problem)})`,
  );
  // The disclosure has to be ASKED for, not assumed: a step that reasoned about the tree
  // instead of reading it would print the same sentence and be wrong about a tree that
  // was in fact fine. The read is git's own, and its absence is a defect.
  assert(
    calls.some((a) => a.includes("submodule") && a.includes("status")),
    `(a) and the disclosure rests on a read of the tree, not on the pass's own claim (got ${JSON.stringify(calls.map((a) => a.slice(-3)))})`,
  );
  assert(
    wt === path.join(repoRoot, ".worktrees", "lean-1"),
    `(a) the tree is the one the step works in (got ${wt})`,
  );
}

// ── (b) the tree is asked, and its answer outranks the pass's own claim of a clean seed
{
  // The property `specify-reset.ts` owes and nothing else proves: a seeded note whose
  // `expect` names a file the checkout does not hold is flagged `emptyCheckout`, so the
  // clause names the path. It is driven through the REAL reset over a real repository, and
  // every git but one runs for real — the reads of the tree, the inventory of the recorded
  // commit and the clause are the code under test, not stubs.
  //
  // The single intercepted command is git's populating call, the only part of a real pass
  // that can be replaced without touching the judgement. What stands in for it is git's own
  // way to make an empty checkout at a commit — `git init`, a fetch of the store so the
  // commit exists, `update-ref` to it, `git read-tree --empty`, `git checkout-index -a -f` —
  // so the emptiness is git's answer about a real index and a real work tree rather than a
  // fiction the fixture asserted, and the reset's reads cannot be argued to be reading one.
  // The argv is then dropped, which IS the pass's claim of success: git was asked to fill
  // the path and nothing complained.
  //
  // The stand-in registers its git dir with the superproject and is verified as a checkout
  // BEFORE the files are taken away. Both matter: a `vendor/lib/.git` directory the seeding
  // never wrote is read by git's clean-tree proof as a modified gitlink, so the reset would
  // refuse the tree and the case would report a clean seed that never happened; and a
  // checkout whose emptiness was never git's own answer about a full index would let the
  // case assert about a directory that was empty for a reason nobody asked git about.
  //
  // The alternative route to this state is unavailable, and knowing why is what makes the
  // case honest: emptying the SOURCE cannot produce it, because `firstTrackedFile` reads the
  // source to decide what to look for and rightly reports `undefined` for a commit with no
  // files — so the expectation would be absent, no disclosure would be owed, and the case
  // would pass while testing nothing. Hence intercepting the one command whose job is to
  // write the directory.
  const { wt, baseSha, recorded, store, withheld } = hollowSubmoduleRepo("hollow");
  // The precondition the whole case rests on, read off the fixture's own witness rather than
  // assumed: the recorded commit holds a file, and the run's checkout does not.
  assert(
    withheld.tracked && withheld.deleted && withheld.path === INSIDE,
    `(b) the fixture witnessed a file the recorded commit holds deleted from the run's submodule checkout (tracked ${String(withheld.tracked)}, deleted ${String(withheld.deleted)})`,
  );
  const env: Record<string, string> = {
    ...gitTestEnv(),
    // The fixture's remotes are local paths and git's `file` policy is the operator's to
    // set — the product adds its own for the one call whose source it computed, which
    // (e3) of `test-lean-submodule-local-source` pins from the other side.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
  };
  const populate = (dir: string): void => {
    // Re-create exactly what `clean -fdx` would have removed — the module store's git dir
    // registered with the superproject, and the checkout git itself writes there. A
    // `vendor/lib/.git` left in place instead is read as a modified gitlink, and the
    // clean-tree proof rightly refuses the tree before any judgement of the notes runs.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".git"), `gitdir: ${store}\n`);
    gitAsk(dir, "read-tree", "-m", recorded);
    gitAsk(dir, "checkout", "-f", "--detach", "HEAD");
    // The emptiness the case asserts is the FIXTURE's, created and verified before this call
    // ever ran; the stand-in restores only the checkout, so it withholds the same path again.
    // Asserting an emptiness this file created would have the case examine its own artefact
    // and pass on it — git was never asked.
    rmSync(path.join(dir, INSIDE), { recursive: true, force: true });
    if (gitAsk(dir, "rev-parse", "HEAD") !== recorded)
      throw new Error(`the case's stand-in checkout is not at the recorded commit ${recorded}`);
    if (gitAsk(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(withheld.path.slice(SUB.length + 1)) === false)
      throw new Error(
        `the case's stand-in checkout's commit holds no ${INSIDE}, so its emptiness there proves nothing (${dir})`,
      );
    if (existsSync(path.join(dir, INSIDE)))
      throw new Error(
        `the case's stand-in did not withhold ${INSIDE} from the checkout it built (${dir})`,
      );
  };
  const exec: ExecFn = async (cmd, o) => {
    calls.push([...((o?.argv ?? []) as string[])]);
    if (isSubmodulePopulate(o?.argv ?? [])) {
      populate(path.join(wt, SUB));
      return { stdout: "", stderr: "" };
    }
    return execp(cmd, { ...o, env: { ...env, ...(o?.env ?? {}) } });
  };
  const before = calls.length;
  let notes: readonly SubmoduleNote[] | undefined;
  let threw: Error | undefined;
  try {
    notes = await resetWorktreeToBase(exec, wt, baseSha, "");
  } catch (err) {
    threw = err as Error;
  }
  // The precondition first, because it is the whole case: the pass reported the submodule
  // SEEDED — its account carries the source and no complaint — while the tree it left holds
  // nothing. Either half alone is uninteresting; the pair is the lie.
  assert(
    threw === undefined &&
      (notes?.length ?? 0) > 0 &&
      notes?.every((n) => n.kind === "seeded") === true,
    `(b) the step's OWN account of the pass is a clean seed (threw ${threw?.name ?? "no"}: ${threw?.message?.split("\n")[0] ?? "none"}, notes ${JSON.stringify(notes)})`,
  );
  assert(
    threw === undefined && (notes?.[0]?.expect ?? "") !== "",
    `(b) and that account names a file the submodule's recorded commit holds, so the emptiness below is a contradiction and not a submodule with no files (expect ${String(notes?.[0]?.expect)})`,
  );
  assert(
    threw !== undefined || !holds(wt, INSIDE),
    `(b) while the tree it left holds no such file — what the child will call a broken test (got ${
      holds(wt, INSIDE) ? "there" : "empty"
    })`,
  );
  assert(
    threw === undefined && notes?.[0]?.emptyCheckout === true,
    `(b) and the reset flagged it rather than reporting a clean seed (emptyCheckout ${String(notes?.[0]?.emptyCheckout)})`,
  );
  assert(
    threw === undefined &&
      submoduleNoteClause(notes ?? []) !== undefined &&
      (submoduleNoteClause(notes ?? []) ?? "").includes(SUB),
    `(b) yet the clause built from those notes names the path BY PATH, which is the only form an operator can act on (got ${String(submoduleNoteClause(notes ?? []))})`,
  );
  assert(
    threw === undefined &&
      calls.slice(before).some((a) => a.includes("submodule") && a.includes("status")),
    `(b) and the only thing that made the difference was ASKING the tree — the pass's own account was silent (got ${JSON.stringify(calls.slice(before).map((a) => a.slice(-3)))})`,
  );
}

// ── (c) the clause's own rules
{
  // The one note of a fully seeded tree, written out rather than indexed: the cases
  // below spread it into variants, and a spread of `undefined` is a spread of nothing.
  const seed: SubmoduleNote = {
    path: "vendor/a",
    kind: "seeded",
    detail: "/x/.git/modules/vendor/a",
  };
  const seeded: SubmoduleNote[] = [seed];
  assert(
    submoduleNoteClause(seeded) === undefined,
    `(c) a fully seeded tree says nothing — the clause is a disclosure, not a log (got ${String(submoduleNoteClause(seeded))})`,
  );
  assert(
    submoduleNoteClause([]) === undefined,
    `(c) and neither does a tree with no submodules at all (got ${String(submoduleNoteClause([]))})`,
  );
  const both = [seed, { path: "vendor/b", kind: "absent" as const, detail: "nothing here" }];
  const clause = submoduleNoteClause(both);
  assert(
    clause?.startsWith("some submodules") === true,
    `(c) a partly seeded tree says SOME, not all, so the reader learns which to trust (got ${String(clause)})`,
  );
  assert(
    clause !== undefined && !clause.includes("vendor/a") && clause.includes("vendor/b"),
    `(c) and names only the paths that did not arrive (got ${String(clause)})`,
  );
  // The silence rule: an entry carrying git's own finding is disclosed even when the
  // step's pass reported nothing about it.
  const carried = [{ ...seed, unproven: ["vendor/c"] }];
  const carriedClause = submoduleNoteClause(carried);
  assert(
    carriedClause?.includes("vendor/c") === true,
    `(c) an unproven path rides on the notes and is disclosed with them (got ${String(carriedClause)})`,
  );
  assert(
    notesFor(["vendor/d"])[0]?.kind === "failure" && notesFor([]).length === 0,
    `(c) git's own answer becomes a note of the kind the clause discloses (got ${JSON.stringify(notesFor(["vendor/d"]))})`,
  );
  assert(
    submoduleNoteClause([{ path: "vendor/e", kind: "failure", detail: "git refused" }]) !==
      undefined,
    "(c) a pass git itself refused is as much a caveat as one nothing supplied",
  );
  // The seeded-but-empty case, which is the one the read of the tree alone can produce.
  const hollow = [{ ...seed, emptyCheckout: true }];
  assert(
    (submoduleNoteClause(hollow) ?? "").includes("vendor/a"),
    `(c) a seeded submodule whose checkout holds nothing is disclosed too (got ${String(submoduleNoteClause(hollow))})`,
  );
}

for (const tag of ["a", "c"])
  rmSync(path.join("/tmp", `lean-submodule-disclosure-${tag}`), { recursive: true, force: true });

process.exit(exit);

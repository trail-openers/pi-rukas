/**
 * clean-repo-fixture — a REAL, clean git repository for smoke tests that hand
 * the driver a `repoRoot`.
 *
 * #1438's `worktree-provision` symlinks `extension/node_modules` into every
 * worktree it provisions. `stagePorcelainPaths` runs inside such a tree, and
 * gitignored build output that is a SYMLINK is not matched by the directory
 * pattern in `.gitignore` — so `git status --porcelain` reports it as untracked
 * and the driver's own staging loop puts a `mode 120000` entry into the patch.
 * A test that fakes `repoRoot` with a bare `mkdirSync` therefore models a shape
 * the driver never actually meets: `git add` succeeds in a plain directory
 * where git would have refused, and the assertion passes on a lie.
 *
 * `initCleanRepo` builds what the driver really sees — a repository whose tree
 * is clean, with `.pi/work-state` excluded the way a real cycle's clone is, so
 * the driver's own state file cannot make the tree dirty and a fixture asserting
 * "clean worktree" is asserting something git agrees with.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { commandOf } from "./argv-shell.ts";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * Git rejects a commit without an identity, and CI containers have none.
 * Set on the command line rather than in config so a fixture never depends on
 * (or pollutes) the host's `~/.gitconfig`.
 */
const IDENTITY = ["-c", "user.email=t@t", "-c", "user.name=t"] as const;

/** Run one git command in `dir`; throws with the stderr on failure. */
function run(dir: string, args: string[]): string {
  const r = spawnSync("git", [...IDENTITY, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr || "").trim()}`);
  }
  return (r.stdout ?? "").trim();
}

/**
 * Make `dir` a real git repository whose working tree is CLEAN: `git init`,
 * one empty commit, `HEAD` at that commit. Idempotent in effect (a second call
 * on an already-initialised dir adds nothing), so a fixture may call it twice.
 *
 * Returns the commit SHA, which a fixture that wants `git diff <baseSha>..HEAD`
 * to be NON-empty then commits a change on top of — the shape each caller
 * builds itself, in the words its own case needs. A helper for that second
 * step was dropped once no caller used it: an unused export in a shared lib is
 * a second way to build a fixture that can drift from the first.
 */
export function initCleanRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  // #1634 — `dir` may already be a repository when a fixture set it up by hand
  // (`git init` + one commit) rather than through this helper; `git init` is
  // idempotent on an existing repo, so this stays safe either way.
  // A fixture branch is named, not git's default: some fixtures assert on the
  // branch they set up, and the default varies with the host's init.defaultBranch.
  run(dir, ["init", "-q", "-b", "main", "."]);
  // The driver's state file lives under .pi/work-state; a real cycle excludes
  // it (and an earlier fixture shape pre-created .git/info for exactly this
  // reason), so a fixture that leaves it UNTRACKED still reads as a clean tree.
  mkdirSync(path.join(dir, ".pi", "work-state"), { recursive: true });
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "info", "exclude"), ".pi/\ntmp/\n");
  run(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  return run(dir, ["rev-parse", "HEAD"]);
}

/**
 * #1634 — the two git reads the adversarial gate makes of a worktree, matched
 * on the argv prefix `readWorktreeDiff` issues through the driver's exec seam
 * (`execFn("git", { argv, cwd })`). That argv form is the only transport
 * production uses, so it is the only form matched here.
 *
 * The diff read is ONE call — `git diff --end-of-options <baseSha>` (or
 * `HEAD`) — comparing the base against the WORKING TREE. `readWorktreeDiff`
 * validates `base` before it reaches git, so the positional is a 40-hex SHA when
 * the cycle recorded one and `HEAD` when it did not; `GateDiffArgv` states that
 * exactly, so a fixture that matches some other argv fails to compile rather
 * than answering a command production never sends.
 */
/**
 * The gate's scripted reads, spelled as the argv types rather than as a bare
 * tuple list. `GATE_ARGV_READS.find(...)` used to return the union of those
 * tuples, which the declared return type rejected — the 2-tuple `["diff",
 * "--end-of-options"]` is not a `GateDiffArgv` (which carries the path) — so
 * `gateArgvRead` only compiled because the whole tree sat outside every tsc
 * project's `include`. Annotated with the types it claims, so the reads it can
 * answer are checked against them: the diff read must name a path.
 */
const GATE_ARGV_READS: readonly (GateDiffArgv | GateToplevelArgv)[] = [
  ["rev-parse", "--show-toplevel"],
  ["diff", "--end-of-options", "<path>"],
] as const;

/** The gate's ONE diff argv, typed as the shape `readWorktreeDiff` builds. */
export type GateDiffArgv = readonly ["diff", "--end-of-options", string];

/** The gate's toplevel probe. */
type GateToplevelArgv = readonly ["rev-parse", "--show-toplevel"];

function gateArgvRead(argv: string[] | undefined): GateDiffArgv | GateToplevelArgv | undefined {
  if (!argv) return undefined;
  const third = argv[2];
  // `argv[2]` is checked, not assumed: the length test above does not narrow an
  // indexed access, and `noUncheckedIndexedAccess` rightly reads it as
  // possibly-undefined. The shape is a three-part diff read, so a missing third
  // part is not a read at all.
  if (
    argv.length === 3 &&
    third !== undefined &&
    argv[0] === "diff" &&
    argv[1] === "--end-of-options"
  ) {
    return ["diff", "--end-of-options", third];
  }
  return GATE_ARGV_READS.find((read) => read.every((part, i) => argv[i] === part));
}

/**
 * #1634 — wrap a fixture's scripted `verifyExecFn` so it answers the
 * adversarial gate's two reads HONESTLY instead of falling through to the
 * fake's catch-all `""`.
 *
 * The gate (`readWorktreeDiff`) runs `git rev-parse --show-toplevel` in the
 * worktree — which must name the worktree itself — and then ONE
 * `git diff --end-of-options <base-or-HEAD>` that compares that base against
 * the working tree. A fake that answers those with `""` (which is what a
 * catch-all `return { stdout: "" }` does) is REFUSED: the gate cannot tell a
 * fake's silence from git's, so it parks with `adversarial-diff-unreadable` and
 * the cycle never reaches commit-pr. A fixture that scripts git therefore has to
 * answer the toplevel probe as what the tree is (`cwd` itself) and the diff read
 * as what the tree holds. Every other command passes through untouched, so the
 * fixture's own scripted answers — cherry-pick, push, `gh pr create` — are
 * unaffected.
 *
 * `diffFor` lets a fixture return the diff it wants the gate to see (non-empty
 * = the reviewer actually runs instead of skipping on an empty diff) — the
 * kill-cause fixture is that caller. Its second argument is the COMPARISON
 * TARGET the gate asked for: the 40-hex base when the cycle recorded one, `HEAD`
 * when it did not. A fixture that replays that token straight into a real
 * `git diff` sees committed and uncommitted work alike, which is exactly what
 * the gate reads.
 *
 * A fake that SCRIPTS git answers these reads for a tree git never made: such a
 * fixture scripts `git worktree add` as a no-op and models its worktrees as
 * paths in the branch reply. The gate resolves the path with `realpathSync` and
 * fail-closes on a directory that does not exist, so the wrapper makes the tree
 * it is about to answer for — a bare `mkdir`, deliberately, not `addWorktree`:
 * `inspectWorktreeForLoss` treats an absent directory as "nothing on disk to
 * inspect" and treats a directory WITHOUT a `.git` file as a non-worktree
 * holding unrecoverable work (#1170), and these fixtures never reach that
 * guard with the tree present, because a scripted fake answers `git worktree
 * add` too. A fixture that needs a real worktree at the path (the ones that
 * assert on the integrate step's own loss guard) creates it itself with a plain
 * `git worktree add` through its own scripted exec — this wrapper makes bare
 * directories and nothing else, because a directory it invented where a real
 * worktree lives is the #1170 shape. Keyed on the CALL's transport: a shell-form
 * call is the shape a scripted fake produces (they all normalise with
 * `commandOf` before matching), while an argv call is production's and must
 * never touch the disk.
 */
export function answerDiffReads(
  exec: NonNullable<DriverContext["verifyExecFn"]>,
  diffFor?: (cwd: string, target: string) => string,
): NonNullable<DriverContext["verifyExecFn"]> {
  // The comparison target argv names after the flag. Absent means the fake was
  // never asked for a diff, which reads as a CLEAN tree rather than as "nobody
  // answered" — the same answer real git gives for an empty comparison.
  const diff = (cwd: string, target: string | undefined) => ({
    stdout: diffFor && target ? diffFor(cwd, target) : "",
  });
  // The gate resolves the path with `realpathSync` and fail-closes on a
  // directory that does not exist, so a fixture whose worktrees exist only as
  // paths in the branch reply has to have one made for the read to be about.
  // Whether that is the wrapper's job or the fixture's is decided by what the
  // fixture does with `git worktree add`:
  //
  //   - a fake that SCRIPTS `git worktree add` as a no-op is saying "no tree is
  //     ever created", yet the driver still hands the gate a path under
  //     `<repoRoot>/.worktrees/`. The wrapper makes a bare directory for the
  //     read to be about: `realpathSync` resolves it, `git rev-parse
  //     --show-toplevel` is answered by this wrapper rather than by git, and
  //     every later read of the path is the fixture's own scripted answer, so
  //     nothing inspects its content and a bare directory is the whole of what
  //     the fixture needs. That is also why it is `mkdir` and not
  //     `addWorktree`: the loss guard at `inspectWorktreeForLoss` treats a path
  //     with no directory as "nothing on disk to inspect" and a directory with
  //     no `.git` as a non-worktree holding unrecoverable work (#1170), so a
  //     tree this wrapper invented and left behind would halt `integrate()` on
  //     the next step. The fixture's temp dir goes when the case does.
  //   - a fake that LETS `git worktree add` reach git creates its own trees and
  //     knows where they are; the wrapper answers those reads without touching
  //     disk, because a directory it invented where a real worktree lives is
  //     the #1170 shape again. Such a fixture reaches the gate with `cwd` set to
  //     a path that already exists, so `realpathSync` is satisfied on its own.
  //
  // Keyed on the CALL's transport: a shell-form call is the shape a scripted
  // fake produces (they all normalise with `commandOf` before matching), an
  // argv call is production's and must never touch the disk.
  //
  // The path a gate read names is whatever the fixture's branch reply said, so
  // the test is "a worktree path", not "the driver's own `<repoRoot>/.worktrees/`
  // layout": a fixture that models its trees as `dir/wta` is the same kind of
  // path as far as the gate is concerned, and M3 is that fixture.
  const materialise = (cmd: unknown, cwd: string | undefined): void => {
    if (typeof cmd !== "string" || !cwd?.startsWith("/")) return;
    // A failure to create the directory the read is about is a BROKEN FIXTURE,
    // not a state to answer around. Throwing is the point: swallow it and the
    // gate fails closed with "could not resolve worktree path", and the reader
    // blames the driver for a bug that lives in the fixture. `mkdirSync` throws
    // on any real failure (EACCES, ELOOP, a file in the way); the one case that
    // is NOT a failure is the directory already being there, which is what
    // `recursive: true` makes a no-op.
    mkdirSync(cwd, { recursive: true });
  };
  // The directory exists for the gate's `realpathSync` and for nothing else:
  // once the read has been answered it is residue, and the next step's loss
  // guard reads a leftover directory at a worktree path as a non-worktree
  // holding work (#1170) and halts `integrate()`. So the wrapper takes it back,
  // and only for the driver's own layout — a path the fixture chose itself is
  // the fixture's to remove. `rmdir` (not `rm -r`) is the safety: it fails on a
  // directory that has acquired content, so a fixture that put something in the
  // path keeps it.
  const dematerialise = (cmd: unknown, cwd: string | undefined): void => {
    if (typeof cmd !== "string" || !cwd?.includes("/.worktrees/")) return;
    try {
      rmdirSync(cwd);
    } catch {
      // Not empty, already gone, or never ours — none of which is ours to fix.
    }
  };
  return (async (cmd, o) => {
    const read = gateArgvRead(o?.argv);
    // A shell-form fake may already have folded argv into the command string,
    // in which case `o.argv` is gone and only the line below matches. The tree
    // the read is answered against is the one the caller named, so a call with
    // no cwd cannot be answered — it falls through to the scripted fake.
    if (cmd === "git" && read !== undefined && o?.cwd !== undefined) {
      const cwd = o.cwd;
      materialise(cmd, cwd);
      const answered = read[0] === "rev-parse" ? { stdout: `${cwd}\n` } : diff(cwd, read[2]);
      // The toplevel probe is the read that NEEDED the directory; the diff read
      // is the last one the gate makes, so the tree is residue from here on.
      if (read[0] !== "rev-parse") dematerialise(cmd, cwd);
      return answered;
    }
    const line = typeof cmd === "string" ? commandOf(cmd, o) : "";
    if (line === "git rev-parse --show-toplevel") {
      materialise(cmd, o?.cwd);
      return { stdout: `${o?.cwd ?? ""}\n` };
    }
    if (line.startsWith("git diff --end-of-options ")) {
      const answered = diff(o?.cwd ?? "", line.slice("git diff --end-of-options ".length));
      dematerialise(cmd, o?.cwd);
      return answered;
    }
    return exec(cmd, o);
  }) as NonNullable<DriverContext["verifyExecFn"]>;
}

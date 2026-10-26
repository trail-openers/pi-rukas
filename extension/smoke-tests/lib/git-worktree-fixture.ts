/**
 * Test fixture: real git worktrees, and the two shapes a diff read must be
 * able to tell apart.
 *
 * #1016 — the develop fan-out needs commits ahead of a base, so fixtures that
 * stage a passing developer must make real commits. `makeBaseWorktrees` and
 * `gitIn` are that half.
 *
 * #1634 — `readWorktreeDiff` (work-driver-diff.ts) distinguishes "this tree is
 * clean, there is nothing to review" from "this tree could not be read", and
 * the adversarial gate routes the second case as an infrastructure failure
 * rather than the empty-diff approval #286 introduced. A fixture built with
 * `mkdtempSync` and no `git init` is the SECOND case: there is no repository,
 * so the gate must refuse to approve it. That is the correct production answer
 * — a worktree that is not a git repo must never be auto-approved — so the
 * fixtures, not the gate, are what changed. `initScratchRepo` gives a fixture
 * tree the two things the read needs: one commit on `main` (so `HEAD` resolves
 * and `git diff HEAD` answers), and an identity so `git commit` works from a
 * bare temp directory — the developer's global config is not present on every
 * host and CI's runner has none.
 *
 * The unreadable half is `scratchDirWithoutGit` (a directory with files in it
 * and no repository). A git binary that itself fails is NOT simulated here by
 * mangling `PATH`: `readWorktreeDiff` takes an injectable `exec`, so a test
 * hands it a failing executor instead of mutating process-global state that any
 * sibling test spawning git would race with. See the `failingExec` export.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "../../src/worktree.ts";
import { execp } from "../../src/exec.ts";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * The safety net's `git commit` runs through the inherited environment, not
 * through gitIn's per-call `-c` flags. A CI runner has no global git identity,
 * so the commit fails with "Author identity unknown" and the test sees no commit.
 * Call this at the top of every test file that commits through the safety net.
 * It supplies an identity to this test process only (never `git config --global`),
 * and keeps any identity the operator already has.
 */
export function ensureGitIdentity(): void {
  for (const [key, value] of Object.entries({
    GIT_AUTHOR_NAME: "pi-rukas test",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "pi-rukas test",
    GIT_COMMITTER_EMAIL: "t@t",
  })) {
    process.env[key] ??= value;
  }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    // #1145 — `execFileSync` with no `env` inherits the REAL `environ` on bun
    // 1.3, so a test that never called `gitTestEnv()` itself (or ran outside
    // lib/verify-loop.sh, which exports the isolated set for the whole run)
    // built its throwaway repo against the operator's global git config. That
    // is the same leak the seven host-red fixtures had, one level down: the
    // helper is shared, so the leak was inherited by every suite importing it.
    env: gitTestEnv(),
  }).trim();
}

/**
 * Run git with the #1145 isolated view PLUS a pinned `core.hooksPath`. The env
 * comes from `gitTestEnv()` — the repo's own fixture isolation (isolated HOME /
 * XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM, and the
 * `core.excludesFile=/dev/null` entry it carries), which is what `gitIn` hands
 * every other fixture repo. Two reasons not to hand-roll this:
 *
 *  - a fixture that becomes a real repository is subject to whatever the host's
 *    git config ignores; on a host whose global config ignores `.pi/` the
 *    driver's own `git diff` / `git status` reads change shape;
 *  - a second isolation mechanism that disagrees with the first is a second set
 *    of git defaults, and the two then differ per host — the exact state #1145
 *    exists to make impossible.
 *
 * `core.hooksPath` is added on top: a host- or repo-installed `pre-commit` hook
 * must neither run nor block a fixture's commit. `timeout` bounds every call, so
 * a git child waiting for input (a credential prompt, a hook) fails the test
 * rather than hanging it.
 */
function git(cwd: string, args: string[]): void {
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
      env: gitTestEnv(),
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr ?? String(err)}`);
  }
}

/** #1016 — the mock developer's work: task-c leaves its edit UNCOMMITTED (the
 *  case the #622 safety net commits); every other developer commits. */
export function mockDeveloperWork(cwd: string, label: string | undefined): void {
  if (label === "developer[task-c]") writeFileSync(path.join(cwd, "edit.txt"), "uncommitted");
  else gitIn(cwd, ["commit", "--allow-empty", "-qm", `work ${label}`]);
}

/** Create `<dir>/.worktrees/<id>` as a repo with one base commit; returns id → base SHA. */
export async function makeBaseWorktrees(
  dir: string,
  ids: string[],
): Promise<Record<string, string>> {
  const shas: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, ".worktrees", id);
    await mkdir(wt, { recursive: true });
    gitIn(wt, ["init", "-q"]);
    gitIn(wt, ["commit", "--allow-empty", "-qm", "base"]);
    shas[id] = gitIn(wt, ["rev-parse", "HEAD"]);
  }
  return shas;
}

/** A fresh temp directory, not a repository — the caller cleans it up. */
export function scratchDir(prefix = "pi-ens-gitfix-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Make `dir` a git working tree with one empty commit on `main`, so `git diff
 * HEAD` and `git status --porcelain -z` both answer.
 * Idempotent: a directory that already has a repository is returned untouched.
 */
export function initScratchRepo(dir: string): string {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 30_000,
    });
    return dir;
  } catch {
    // Not a repo yet — the ordinary case for a mkdtemp fixture.
  }
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  git(dir, ["config", "user.email", "smoke-test@pi-rukas.invalid"]);
  git(dir, ["config", "user.name", "pi-rukas smoke test"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "fixture baseline"]);
  return dir;
}

/**
 * A git working tree with one empty commit, built from scratch. The fixture
 * every diff-read test starts from: `git diff HEAD` is empty — so the read
 * reports a POSITIVELY proven empty diff — until the test writes a file.
 */
export function initScratchRepoFresh(prefix = "pi-ens-gitfix-"): string {
  return initScratchRepo(scratchDir(prefix));
}

/** Write `content` to `rel` inside `dir`, creating parent directories. */
export function seedFile(dir: string, rel: string, content: string): string {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Stage (but do not commit) `rel`, so the diff read sees a tracked change. */
export function stageFile(dir: string, rel: string): void {
  git(dir, ["add", "--", rel]);
}

/** Commit everything currently in `dir` (the fixture's own identity makes this work). */
export function commitAll(dir: string, message = "fixture commit"): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

/**
 * Run `git` with the fixture's isolated view, for a test that needs to change a
 * tree's staged/unstaged state (e.g. unstage a seeded change so the SECOND read
 * of one workstream is the blank-and-unprobeable shape).
 */
export function gitFixture(cwd: string, args: string[]): void {
  git(cwd, args);
}

/**
 * The same, for a call whose STDOUT is the answer (`rev-parse HEAD`, a file at
 * a ref). `gitFixture` discards stdout because its callers mutate the tree.
 */
export function gitFixtureOut(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: gitTestEnv(),
  }).trim();
}

/**
 * A directory that holds files but is NOT a git repository — the shape the
 * gate must treat as UNREADABLE rather than empty. `files` are written so the
 * tree is not trivially empty on disk either.
 */
export function scratchDirWithoutGit(
  prefix = "pi-ens-norepo-",
  files: Record<string, string> = {},
): string {
  const dir = scratchDir(prefix);
  for (const [rel, content] of Object.entries(files)) seedFile(dir, rel, content);
  return dir;
}

/**
 * An executor whose every call fails — the fixture for "git itself failed", as
 * distinct from `scratchDirWithoutGit`'s "there is no repository here". Both
 * must be unreadable, and a gate that handles only one of them is a gate that
 * can still be fooled.
 *
 * It replaces the old `withGitBroken`, which removed `git` from
 * `process.env.PATH` for the duration of a callback. That worked, but it is
 * process-global: it mutated shared state every sibling git read in the same
 * process (including any concurrent test) would have raced with, and it could
 * not be scoped to one call. The diff reads take an `exec` parameter precisely
 * so this can be handed to ONE read instead — deterministic, scoped, reversible
 * by doing nothing.
 */
export function failingExec(reason = "git is not available (smoke-test executor)"): ExecFn {
  return (cmd: string) =>
    Promise.reject(new Error(`${cmd} failed: ${reason}`)) as Promise<{
      stdout: string;
      stderr: string;
    }>;
}

/**
 * The default executor, behind the same `ExecFn` type — so a fixture that needs
 * the read to SUCCEED can pass an executor explicitly instead of relying on the
 * parameter's default. Matters for the "proven empty" case: `empty` is
 * established by a real read, so a test that wants that answer must supply a
 * working git rather than inherit one by omission.
 */
export function passthroughExec(): ExecFn {
  return (cmd, opts) => execp(cmd, opts);
}

/**
 * An executor that fails only for `git` invocations whose argv contains EVERY
 * token in `failWhenArgsInclude` — for making just the dirt probe fail while
 * the diff read itself succeeds, which is the shape of "the diff came back
 * blank and the thing that decides what a blank means could not be read".
 */
export function execFailingArgs(failWhenArgsInclude: readonly string[]): ExecFn {
  return async (cmd, opts) => {
    if (failWhenArgsInclude.every((tok) => (opts?.argv ?? []).includes(tok))) {
      throw new Error(`${cmd} ${(opts?.argv ?? []).join(" ")}: forced failure (smoke test)`);
    }
    return execp(cmd, opts);
  };
}

/** A 40-hex object id for a stubbed `rev-parse --verify` (the shape `refResolves` demands). */
const STUB_OBJECT_ID = `${"f".repeat(39)}1`;

/** The argv `readWorktreeDiff`'s dirt probe sends (work-driver-diff.ts). */
const WORKTREE_DIFF_STATUS_ARGV = ["status", "--porcelain", "-z", "--untracked-files=all"] as const;

/**
 * Does `cmd` (as `commandOf` renders it) name a dirty-worktree probe that also
 * asks about UNTRACKED files?
 *
 * The mechanized-commit fixtures script `git status --porcelain` to make each
 * worktree look dirty to the develop/commit-pr gates. Those reads now arrive in
 * ARGV form, so a `cmd.startsWith("git status --porcelain")` test matches only
 * the shell-string caller and the argv one falls through to the stub's default
 * `{stdout:""}` — a worktree that reads clean, and an integration the fixture
 * meant to exercise never runs. Both spellings render to the same string here.
 *
 * It is deliberately NOT a bare `git status --porcelain` match: `git status
 * --ignored=matching --porcelain -uall` is a DIFFERENT question ("what residue
 * did the cycle leave behind?") and the fixtures whose whole point is a dirty
 * or residue-laden root distinguish the two. Requiring an untracked flag keeps
 * that distinction, and every untracked flag `git` accepts appears here so a
 * future rename in `src/` widens the match rather than silently narrowing it.
 */
export function isDirtyWorktreeRead(cmd: string): boolean {
  if (!cmd.startsWith("git status --porcelain")) return false;
  return /(?:^|\s)(?:-z|-u|-uall|--untracked-files(?:=\S+)?)(?:\s|$)/.test(cmd);
}

/**
 * The argv-form sibling of `isDirtyWorktreeRead`, for a stub that receives the
 * raw `opts.argv` (work-driver-diff.ts's dirt probe and its `-z` twin).
 */
export function isDirtyWorktreeArgv(argv: readonly string[] | undefined): boolean {
  if (!argv) return false;
  return (
    argv.length >= WORKTREE_DIFF_STATUS_ARGV.length &&
    WORKTREE_DIFF_STATUS_ARGV.every((tok, i) => argv[i] === tok)
  );
}

/**
 * An executor that answers the adversarial diff read the way a real, committed,
 * CLEAN tree does, without the tree existing.
 *
 * Dozens of driver fixtures declare worktree paths they never create
 * (`${dir}/.worktrees/task-a`) because the test exercises a step AFTER the
 * review — commit-pr consolidation, the converge gate, deck ownership, routing.
 * That was harmless while `readWorktreeDiff` answered `""` for every failure
 * mode and the gate read `""` as approved-with-zero-rounds. Since #1634 a tree
 * that is not a repository (or has vanished) is the UNREADABLE class and the
 * gate parks the cycle on an infrastructure failure, so a fixture that never
 * reaches the step it names is measuring something else.
 *
 * The alternative — `driverWorktrees()` on the map — is the right answer when
 * the test inspects the tree (the fix pass writes into it, a status read is
 * asserted). It is the wrong answer when the fixture's whole point is the
 * driver's own untracked records sitting inside the tree: a real repository
 * then sees `.pi/verify-cmd` and friends as dirt, and the read legitimately
 * refuses to call the diff empty. This executor is the third option: it answers
 * the five git calls `readWorktreeDiff` makes — `rev-parse --verify --quiet HEAD`
 * (a HEAD exists), the committed range (blank), `diff HEAD` (blank) and
 * `status --porcelain -z` (no entries) — so the read returns
 * `{ ok: true, empty: true }` and the gate records its normal empty-diff skip.
 *
 * It is scoped to `ctx.diffExecFn`, which reaches the fan-out's FIRST read and
 * its per-round re-read and NOTHING else: every other git call in the cycle
 * still goes through the test's own `verifyExecFn` stub or the real `execp`.
 * A command it does not recognise resolves to an empty stdout rather than
 * throwing, so a stray call cannot manufacture an unreadable verdict; if that
 * ever hides a real question, `passthroughExec()` is the sibling for a fixture
 * whose tree really is a repository.
 */
export function cleanTreeDiffExec(): ExecFn {
  return async (_cmd, opts) => {
    const argv = opts?.argv ?? [];
    // Only the HEAD probe prints anything; every other call (the range diff,
    // the fallback diff, the porcelain probe) answers with a blank stdout,
    // which is what a clean committed tree prints.
    const stdout = argv[0] === "rev-parse" ? `${STUB_OBJECT_ID}\n` : "";
    return { stdout, stderr: "" };
  };
}

/**
 * #1634 — upgrade the very common `mkdtempSync` + `mkdirSync(<dir>/.git/info)`
 * fake-tree fixture into something git can actually answer, WITHOUT changing
 * what the test asserts.
 *
 * Dozens of driver tests build a scratch "worktree" by making a directory and a
 * `.git/info` path inside it so the driver's state file has somewhere to live.
 * That directory is not a repository, which was invisible while the diff read
 * answered `""` for every failure mode and the adversarial gate read `""` as
 * approved-with-zero-rounds. Once the gate can tell the two apart (this issue)
 * such a fixture is UNREADABLE, and a test whose fixture never reaches the
 * reviewer it means to exercise is measuring something else.
 *
 * `initScratchRepo` cannot detect the case (it probes with `git rev-parse`,
 * which needs the binary), so this recognises the FAKE admin dir by shape — a
 * `.git` directory with no `HEAD`, which a real `git init` never leaves behind —
 * and turns it into a real tree with one empty commit. A directory with no
 * `.git` at all is left alone: those fixtures are deliberately the
 * not-a-repository case and their tests say so.
 *
 * The driver artefacts already in the tree (`.pi/work-state/*.json`, `tmp/**`)
 * are untracked, so `isDriverArtefactPath` spares them and the tree still reads
 * as a POSITIVELY proven empty diff — which is what the fixture meant to be.
 * A caller that wants a diff puts a file in itself.
 *
 * ⚠ Every command here goes through `git` above, which pins the isolated git
 * view. Do NOT route these through the ambient environment: see that helper.
 */
export function makeFakeGitDirReal(dir: string): string {
  const gitDir = path.join(dir, ".git");
  let isFake = false;
  try {
    isFake = existsSync(gitDir) && !existsSync(path.join(gitDir, "HEAD"));
  } catch {
    return dir;
  }
  if (!isFake) return dir;
  // The fixture's `.git` is a plain directory, so `git init` here is the repair:
  // git writes the admin files it was never given.
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  git(dir, ["config", "user.email", "smoke-test@pi-rukas.invalid"]);
  git(dir, ["config", "user.name", "pi-rukas smoke test"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "fixture baseline"]);
  return dir;
}

/**
 * #1634 — one call for the `mkdtempSync` + `mkdirSync(dir, ".git", "info")`
 * fixture shape this suite uses everywhere: the scratch directory that stands in
 * for a worktree so the driver's state file has somewhere to live.
 *
 * That directory is not a repository, which was harmless while the diff read
 * answered `""` for every failure mode — and stays harmless for the tests that
 * never reach the review step. But the `.git` ENTRY makes `readWorktreeDiff` ask
 * git whether the tree is clean, and for a directory that was never a repository
 * that probe fails: the read comes back unreadable, the failure classifies as an
 * environment fault, and — before #1634's non-retryable cause — the retry ladder
 * slept through its whole budget. Two tests of this shape measured 109 s and
 * 110 s against a 45 s per-test bound — which is how the previous dispatch hung
 * for 40 minutes without reaching its assertions.
 *
 * Making the tree real costs one `git init` per fixture and answers every
 * question the driver asks of it, so the test exercises the path it names
 * instead of an infrastructure failure nobody intended. The driver's own
 * untracked records stay non-dirt, so a fixture that meant "clean worktree"
 * still reads as a POSITIVELY proven empty diff.
 */
export function driverWorktree(dir: string): string {
  // The `.git/info` path is what the callers created; some build it with
  // `fs/promises.mkdir` and have no sync mkdir at the call site, so this
  // guarantees it rather than depending on the call order. `git init` writes
  // into `.git` and needs the parent to exist.
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return makeFakeGitDirReal(dir);
}

/**
 * #1634 — the same repair for a whole `pipelineState.worktrees` map, in place.
 *
 * Every driver smoke fixture that reaches the adversarial gate declares worktree
 * paths it never creates (`${dir}/.worktrees/task-a`), which was harmless while
 * the diff read answered `""` for everything and the gate read `""` as approved
 * with zero rounds. It is no longer harmless: a missing tree is the UNREADABLE
 * class, the gate now routes that as an infrastructure failure, and a test
 * written to assert a verdict ends up asserting a retry ladder. Creating the
 * directories and making each a one-commit repo costs nothing and returns the
 * fixture to the path it names. Idempotent, and it leaves a path that is already
 * a repository alone.
 */
export function driverWorktrees(
  worktrees: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!worktrees) return worktrees;
  for (const wt of Object.values(worktrees)) {
    mkdirSync(wt, { recursive: true });
    driverWorktree(wt);
  }
  return worktrees;
}

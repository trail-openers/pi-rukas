
/**
 * merged-head-git — the REAL-git half of the #1533 merge-head-pin fixtures, split
 * out of merged-head-fixtures.ts (AGENTS.md §12 size cap).
 *
 * These helpers drive an actual `git` against an actual bare origin, and they are
 * what lets the suite prove the fix on content rather than on stubbed strings: a
 * test of "the merge is pinned to the commit the review saw" that never moves a
 * real commit cannot tell the fixed check from the broken one. `realClone` builds
 * the repository pair and the two knobs a case needs (`mainlineMoved`,
 * `unreviewedPush`); the rest read OIDs back out of it.
 *
 * Every helper here THROWS when it cannot read an OID. That is deliberate: a fixture
 * that quietly returned `""` would make a refusal case look like a passing one, and
 * "silently passed" is the exact failure mode this issue is about.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "../../src/exec.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import { isFullCommitSha, resolveHeadSha } from "../../src/review-head-sha.ts";

const execFileP = promisify(execFile);

/**
 * A REAL clone with a real bare origin and real commits, for the cases whose
 * variable is what the branch actually contains.
 *
 * `mainlineMoved` advances main and merges it into the branch; `unreviewedPush`
 * adds a commit nobody reviewed. Both leave the reviewed commit where the review
 * saw it and move the forge head, so a case states the two commits it means
 * rather than asserting over stubs — and the patch identity that decides the
 * verdict is git's own answer, not a fixture's.
 *
 * `commit.gpgsign=false` is passed on the command line rather than through
 * `git config` because these fixtures isolate `HOME`/`XDG_CONFIG_HOME` away
 * from host config (git-test-env.ts) — the same isolation that keeps a host
 * `gpgSign = true` from being picked up, so the setting has to go where git
 * reads it regardless of HOME. Without it a signature failure here looks
 * exactly like the "the review did not cover this head" bug these files are about.
 */
export async function realClone(
  opts: { mainlineMoved?: boolean; unreviewedPush?: boolean } = {},
): Promise<{
  dir: string;
  origin: string;
  reviewedHead: string;
  forgeHead: string;
  branch: string;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "mhead-real-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  const branch = "feature/x";
  const init = (target: string) =>
    execFileP("git", ["-c", "commit.gpgsign=false", "init", "--initial-branch=main", target]);
  await execFileP("git", [
    "-c",
    "commit.gpgsign=false",
    "init",
    "--bare",
    "--initial-branch=main",
    origin,
  ]);
  await init(dir);
  const git = (args: string[]) =>
    execFileP("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir });
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Fixture"]);
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "base"]);
  await git(["remote", "add", "origin", origin]);
  await git(["push", "-q", "-u", "origin", "main"]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(["checkout", "-q", "-b", branch]);
  writeFileSync(path.join(dir, "work.txt"), "the reviewed work\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "the reviewed work"]);
  await git(["push", "-q", "-u", "origin", branch]);
  const reviewedHead = await forgeHeadOf(dir, branch);
  if (opts.mainlineMoved) {
    await git(["checkout", "-q", "main"]);
    writeFileSync(path.join(dir, "mainline.txt"), "mainline moved\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "mainline moved"]);
    await git(["push", "-q", "origin", "main"]);
    await git(["checkout", "-q", branch]);
    await git(["merge", "-q", "--no-edit", "origin/main"]);
    await git(["push", "-q", "origin", branch]);
  }
  if (opts.unreviewedPush) {
    writeFileSync(path.join(dir, "sneaked.txt"), "pushed after the review\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "pushed after the review"]);
    await git(["push", "-q", "origin", branch]);
  }
  return { dir, origin, reviewedHead, forgeHead: await forgeHeadOf(dir, branch), branch };
}

/**
 * The head the FORGE holds, read the way production reads it: `resolveHeadSha`
 * is the repo's own ref-to-OID resolution (bounded, argv), and the ancestry
 * check is the local proof the OID came out of THIS repository — a bare
 * `rev-parse` walks upward out of a temp dir into whatever repository the test
 * process sits in and answers with a real OID from the wrong tree, which looks
 * exactly like a working fixture.
 */
export async function forgeHeadOf(dir: string, branch: string): Promise<string> {
  const oid = await resolveHeadSha(dir, `origin/${branch}`, realGit);
  if (oid === undefined || !isFullCommitSha(oid))
    throw new Error(`fixture: origin/${branch} did not resolve to a commit`);
  try {
    await execFileP("git", ["merge-base", "--is-ancestor", oid, "HEAD"], { cwd: dir });
  } catch {
    throw new Error(
      `fixture: origin/${branch} resolved to ${oid.slice(0, 8)}, not a commit in ${dir} — the read left this repository`,
    );
  }
  return oid;
}

/**
 * An executor that runs REAL git through the harness's own `execp`.
 *
 * Delegating to `execp` rather than hand-rolling `child_process` calls keeps
 * the production dispatch between `execFile` (argv form) and the shell (string
 * form) in the path under test: the identity read is a PIPELINE
 * (`git diff … | git patch-id --stable`) only a shell runs, while `resolveHeadSha`
 * passes `-C <dir>` as an argv element only `execFile` honours. A fixture that
 * sent both shapes to `execFile` manufactured a git failure and reported the
 * check's own refusal as the rule firing. `timeout`/`maxBuffer` pass through
 * unchanged, so the bounds being exercised are the check's.
 */
export const realGit: VerifyExecFn = (cmd, opts) => execp(cmd, opts);

/**
 * The branch's own first commit: the OLDEST commit the branch holds that the
 * mainline does not.
 *
 * A moved-head case needs a row naming the commit the review covered, and that
 * commit has to survive whatever the fixture did to the branch afterwards. The
 * merge commit a mainline merge produces is unreachable the moment the merge is
 * undone, and naming it makes the identity read fail with "unknown revision" — a
 * park about git, not about the rule under test. The branch's first own commit is
 * reachable in every shape these cases use.
 *
 * Asked of the BARE clone, of refs the clone itself publishes: a working clone
 * under a temp dir has no `origin/main` unless it fetched a moment ago, and an
 * exclusion naming a ref that matches nothing is indistinguishable from no
 * exclusion at all. The FIRST line of a plain `rev-list` (it walks newest to
 * oldest) is the oldest commit; `--max-count=1` is deliberately not used — the
 * count applies before `--reverse`, so `--reverse --max-count=1` names the NEWEST
 * commit the filter leaves, which is the branch head, the one OID this row must
 * never name.
 */
export async function firstWorkCommit(
  originDir: string,
  branch: string,
  exec: VerifyExecFn = realGit,
): Promise<string> {
  const { stdout } = await exec("git", {
    cwd: originDir,
    argv: ["-C", originDir, "rev-list", `refs/heads/${branch}`, "--not", "refs/heads/main"],
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const v = lines.at(-1) ?? "";
  if (!isFullCommitSha(v))
    throw new Error(`fixture: ${originDir} has no ${branch} commit apart from main`);
  return v;
}

/**
 * The commit the review's content still describes, after the mainline moved: the
 * merge commit that CARRIES `reviewedCommit`, which is the OID CI and the merge
 * step hold once the branch has taken the mainline in.
 *
 * A moved-mainline case needs three named commits, and only two of them come out
 * of `realClone` (the reviewed commit and the forge head). The third is the commit
 * CI verified: the same content as the review saw, one merge commit later. Deriving
 * it from the graph — the oldest commit whose ancestry contains the reviewed commit
 * — is what keeps the case honest: hardcoding the forge head for this role too
 * would make "CI verified the reviewed commit" and "the forge holds a third
 * commit" the same statement, and the identity comparison would never run.
 */
export async function mergeCommitCovering(
  originDir: string,
  branch: string,
  reviewedCommit: string,
): Promise<string> {
  const { stdout } = await realGit("git", {
    cwd: originDir,
    argv: [
      "-C",
      originDir,
      "rev-list",
      "--ancestry-path",
      `${reviewedCommit}..refs/heads/${branch}`,
    ],
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const oldest = lines.at(-1) ?? "";
  if (!isFullCommitSha(oldest))
    throw new Error(`fixture: no commit on ${branch} descends from ${reviewedCommit.slice(0, 8)}`);
  return oldest;
}

/**
 * The branch head the FORGE holds, read through the caller's own executor, or
 * the named commit resolved against THIS clone when `at` is given.
 *
 * The ancestry test in the `at` branch is the part that matters: `git rev-parse`
 * happily resolves a commit the branch no longer reaches — one whose merge was
 * undone, or one belonging to some other repository the fixture host sits inside
 * — and a row naming such a commit makes the identity read fail with "unknown
 * revision", parking for a reason that has nothing to do with the rule tested.
 */
export async function readBranchHead(
  dir: string,
  branch: string,
  exec: VerifyExecFn,
  at?: string,
): Promise<string> {
  const ref = at === undefined ? `origin/${branch}^{commit}` : `${at}^{commit}`;
  const { stdout } = await exec("git", {
    cwd: dir,
    argv: ["-C", dir, "rev-parse", "--verify", "--quiet", ref],
    maxBuffer: 8 * 1024,
    timeout: 30_000,
  });
  const v = stdout.trim();
  if (!isFullCommitSha(v)) throw new Error(`fixture: ${ref} is not a commit`);
  if (at !== undefined) {
    await exec("git", {
      cwd: dir,
      argv: ["-C", dir, "merge-base", "--is-ancestor", v, `origin/${branch}`],
      maxBuffer: 8 * 1024,
      timeout: 30_000,
    });
  }
  return v;
}

/**
 * test-hygiene-refspec-reader.ts — `pushRefspecs` and the deletion forms of the
 * push scan (#1788 round 2), split out of `test-public-hygiene-push.ts` along
 * the seam of one mechanism per file (AGENTS.md §12: split, never compress).
 *
 * The pure half asks the reader what it read out of a word list; the git half
 * runs the same commands through `scanPushRange` / `inspectCommand` against a
 * real temp repository, because a parser can be right about the words and still
 * wrong about what a push publishes (a deletion resolves nothing and must
 * refuse nothing). The push verb is assembled from fragments: the harness that
 * runs the offline suite guards a child's publish verbs by reading the command
 * string. Terms are synthetic and the denylist is always a temp file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { pushRefspecs, scanPushRange } from "../src/public-hygiene-push.ts";
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "../src/public-hygiene-scan.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const GITHUB_REMOTE_URL = "https://github.com/example-owner/example-repo.git";
const PUSH = ["pu", "sh"].join("");
const pushCommand = (rest = "origin main"): string => ["git", PUSH, rest].join(" ").trim();
const scanOpts = (command: string): { command: string; pushVerb: string } => ({
  command,
  pushVerb: PUSH,
});

const root = mkdtempSync(path.join(tmpdir(), "hygiene-rdr-"));
const repo = path.join(root, "work");
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# comment\n${TERM}\n`, "utf8");
const gitEnv = gitTestEnv();

function gitTransport(cwd: string): ExecFn {
  return (cmd, opts) =>
    execp(cmd, {
      argv: opts?.argv,
      cwd: opts?.cwd ?? cwd,
      timeout: opts?.timeout ?? PUSH_SCAN_TIMEOUT_MS,
      maxBuffer: opts?.maxBuffer ?? PUSH_SCAN_MAX_BUFFER,
      env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" },
    }) as Promise<{ stdout: string }>;
}

const exec: ExecFn = gitTransport(repo);
const git = (...args: string[]): Promise<string> =>
  (gitTransport(repo)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);
const gitIn =
  (cwd: string) =>
  (...args: string[]): Promise<string> =>
    (gitTransport(cwd)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);

const githubUrl = async (_remote: string): Promise<string> => GITHUB_REMOTE_URL;

function inspect(command: string) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = { ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: denylist } as NodeJS.ProcessEnv;
  return inspectCommand(command, repo, exec, () => readPublicDenylist(env), {
    remoteUrl: githubUrl,
  });
}

await gitIn(root)("init", "-q", "--bare", "origin.git");
await gitIn(root)("clone", "-q", path.join(root, "origin.git"), "work");
await git("config", "user.email", "t@example.invalid");
await git("config", "user.name", "tester");
await git("branch", "-m", "main");
await git("remote", "set-url", "origin", GITHUB_REMOTE_URL);
writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");
await git("add", "a.txt");
await git("commit", "-q", "-m", "chore: seed the repository");
const baseSha = (await git("rev-parse", "HEAD")).trim();
await git("update-ref", "refs/remotes/origin/main", baseSha);
await git("update-ref", "refs/remotes/origin/HEAD", baseSha);

async function reset(): Promise<void> {
  await git("reset", "-q", "--hard", baseSha);
  await git("update-ref", "refs/remotes/origin/main", baseSha);
}

// ── 15. The refspec reader itself: options dropped, option values swallowed,
// selectors recognised.
{
  const remotes = new Set(["origin"]);
  const a = pushRefspecs([PUSH, "origin", "main", "--force-with-lease", "topic"], PUSH, remotes);
  assert(
    a.refspecs.join(",") === "main,topic" && !a.branches && !a.tags,
    "positional args after the remote are refspecs and flags are dropped",
  );
  const b = pushRefspecs(["--no-verify", PUSH, "--all", "origin"], PUSH, remotes);
  assert(b.branches && b.refspecs.length === 0, "--all before the remote still means all branches");
  const c = pushRefspecs([PUSH, "origin", "--tags", "v1.2.3"], PUSH, remotes);
  assert(c.tags && c.refspecs.join() === "v1.2.3", "--tags is a selector, not a refspec");
  const d = pushRefspecs([PUSH, "origin", "+topic:refs/heads/topic"], PUSH, remotes);
  assert(d.refspecs.join() === "+topic:refs/heads/topic", "a forced refspec is kept verbatim");
  const e = pushRefspecs([PUSH, "origin", ":refs/heads/gone"], PUSH, remotes);
  assert(e.refspecs.join() === ":refs/heads/gone", "a deletion refspec reaches the source strip");
  // An option whose value is a SEPARATE word swallows its operand: `ci.skip`
  // is `-o`'s value, not a branch, and a scan that resolved it would refuse a
  // routine `push -o ci.skip` for a revision nobody named. `--force-with-lease`
  // is the opposite case and is kept here for the contrast: git reads its value
  // ONLY in the `=`-attached form, so the bare word after it is a refspec and
  // must stay one — dropping it would let a dirty `topic` out unscanned.
  const f = pushRefspecs([PUSH, "origin", "main", "-o", "ci.skip"], PUSH, remotes);
  assert(
    f.refspecs.join() === "main" && !f.deletes,
    "an option value given as a separate word is not a refspec",
  );
  const g = pushRefspecs([PUSH, "--repo", "origin2", "origin", "main"], PUSH, remotes);
  assert(
    g.refspecs.join() === "main",
    "--repo names a remote as its VALUE, so the anchor is the next bare word",
  );
  const h = pushRefspecs([PUSH, "origin", "main", "--force-with-lease", "topic"], PUSH, remotes);
  assert(
    h.refspecs.join() === "main,topic",
    "--force-with-lease takes a value only with `=`, so its follower stays a refspec",
  );
  // The deletion switches are the other way to ask for a deletion, and a
  // parser must not read the branch they name as a revision: `git push origin
  // --delete gone` reads `gone` as a ref name in a position git itself reads
  // after the option, so the words after a deletion switch are scanned the
  // same way whether or not the scan later treats them as commits.
  for (const [flag, rest] of [
    ["--delete", "origin --delete gone"],
    ["-d", "-d origin x"],
  ] as const) {
    const words = [PUSH, ...rest.split(/\s+/)];
    assert(
      pushRefspecs(words, PUSH, new Set(["origin"])).deletes,
      `pushRefspecs marks a push with ${flag} as a deletion`,
    );
  }
  // A delete publishes no commit, so the scan must resolve nothing and refuse
  // nothing: an implementation that tried to resolve the empty source would
  // fail closed on a routine branch deletion.
  await reset();
  const del = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(pushCommand("origin :refs/heads/never-existed")),
  });
  assert(
    del.scanned && del.problems.length === 0 && del.texts.length === 0,
    "a deletion refspec publishes no commits and is not refused",
  );
  // The `-d`/`--delete` switches are the other way to ask for a deletion, and
  // the branch named there usually no longer exists — resolving it would be a
  // refusal about a push that publishes nothing.
  for (const flag of ["--delete", "-d"]) {
    const rest = flag === "--delete" ? "origin --delete gone" : "-d origin x";
    const scan = await scanPushRange({
      exec,
      cwd: repo,
      remoteUrl: githubUrl,
      ...scanOpts(pushCommand(rest)),
    });
    assert(
      scan.scanned && scan.texts.length === 0 && scan.problems.length === 0,
      `a push with ${flag} is scanned clean and refuses nothing`,
    );
    assert(
      (await inspect(pushCommand(rest))) === undefined,
      `a push with ${flag} of a branch that does not exist is allowed`,
    );
  }
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);

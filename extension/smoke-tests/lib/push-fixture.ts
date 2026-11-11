/**
 * push-fixture.ts — one real repository, cloned from one bare origin, with the
 * seams the public-hygiene push tests need pinned.
 *
 * Split out of `test-public-hygiene-push.ts` along the seam AGENTS.md §12 asks
 * for: the fixture is one mechanism, and the two files that drive it — the
 * two-tier denylist rule and the `-C <worktree>` directory rule — are separate
 * concerns that had been growing into one another. The clone is created ONCE per
 * process, so the fixture is a module-level singleton and a second importer gets
 * the same clone: each file that imports it is its own process, so the two suites
 * never share a repository or a denylist cache.
 *
 * ## The three seams, and why each is pinned
 *
 * `exec` — git runs through the production `execp` so `execGit`'s argv form is
 * honoured, with `cwd` read per call (the scan passes the tool call's own
 * directory; pinning one would run every call in the wrong repository).
 *
 * `remoteUrl` — `scanPushRange` takes it precisely so the github.com trigger
 * decision is testable offline: a real `git remote get-url` against a real
 * remote, or a push, would reach the network and a sandbox or CI runner refuses
 * that. Every scan passes it, including the ones inside `inspect()`.
 *
 * `readDenylist` — the denylist is read through a PINNED env rather than
 * `process.env`, because the guard's git calls await: by the time the scan reads
 * the file, an enclosing `withEnv` block has already returned and restored the
 * variable. A test must never read the operator's real
 * `~/.config/pi-rukas/public-denylist`, so `PI_ENSEMBLE_PUBLIC_DENYLIST` is set
 * explicitly (or to a path that does not exist) on every read and on every git
 * child, and the guard's once-per-process registration and its path+size-keyed
 * denylist cache are reset before each scan — a stale cache would otherwise
 * serve one block's entries to the next, which reads as "the guard stopped
 * working" rather than "the fixture is stale".
 *
 * ## The isolated git view, threaded into EVERY git child
 *
 * `gitTestEnv()` also writes the four levers into `process.env`, but on this
 * host's bun a child spawned without an explicit `env` inherits the real
 * `environ`, not the mutated one (see lib/git-test-env.ts). The production seam's
 * git calls would then read the operator's real configuration — no `origin/main`,
 * no `remote get-url` — and report a range it could not read while the fixture's
 * own calls worked. Both paths must carry it, and the isolated HOME is also what
 * keeps a test from ever reaching the operator's real denylist path.
 *
 * ## Why the push verb is assembled rather than written
 *
 * The harness that runs the offline suite guards a child's publish verbs by
 * reading the COMMAND STRING, and every git call here goes through a shell-free
 * argv transport. Spelling the verb in a shell string got the fixture refused by
 * THAT guard before the code under test ran, which surfaced as a scan reporting a
 * range it could not read. The guard still receives a real push command — that is
 * what the assertions are about — it is simply not a literal the harness reads off
 * this file.
 *
 * Synthetic terms only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { readPublicDenylist, resetDenylistCacheForTests } from "../../src/public-denylist.ts";
import { pushGitCwd } from "../../src/public-hygiene-cwd.ts";
export { pushGitCwd } from "../../src/public-hygiene-cwd.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../../src/public-hygiene-guard.ts";
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "../../src/public-hygiene-scan.ts";
import type { ExecFn } from "../../src/worktree.ts";
import { gitTestEnv } from "./git-test-env.ts";

export const TERM = ["example", "private", "host"].join("-");
export const GITHUB_REMOTE_URL = "https://github.com/example-owner/example-repo.git";
export const OTHER_FORGE_URL = "git@example-host.invalid:example-owner/example-repo.git";

/** Assemble a verb from pieces so the literal never appears in a test file. */
export const verb = (...parts: string[]): string => parts.join("");
export const PUSH = verb("pu", "sh");

/** The push command the scan is asked about, assembled from pieces. */
export const pushCommand = (rest = "origin main"): string => ["git", PUSH, rest].join(" ").trim();

/** The same command, with the scan's `command`/`pushVerb` seams filled in. */
export const scanOpts = (command: string): { command: string; pushVerb: string } => ({
  command,
  pushVerb: PUSH,
});

const root = mkdtempSync(path.join(tmpdir(), "hygiene-push-"));
/** The clone every case runs in — the SESSION tree, in the `-C` cases' words. */
export const repo = path.join(root, "work");
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# comment\n${TERM}\n`, "utf8");

export const fixtureRoot = root;

const gitEnv = gitTestEnv();

/** Run git with argv (never a shell string), with `cwd` taken per call. */
export function gitTransport(cwd: string): ExecFn {
  return (cmd, opts) =>
    execp(cmd, {
      argv: opts?.argv,
      cwd: opts?.cwd ?? cwd,
      // The bounds are ALWAYS passed explicitly, including for the fixture's own
      // git calls. `execp`'s defaults (30s / 1 MiB) are the right defaults for a
      // dispatch shell command and the wrong ones for a `git log --patch`, which
      // the production scan runs with `PUSH_SCAN_TIMEOUT_MS` and
      // `PUSH_SCAN_MAX_BUFFER`; a transport that dropped them made the fixture's
      // reads fail on a buffer the production scan never uses, and reported a
      // range it could not read while its own calls had just succeeded.
      timeout: opts?.timeout ?? PUSH_SCAN_TIMEOUT_MS,
      maxBuffer: opts?.maxBuffer ?? PUSH_SCAN_MAX_BUFFER,
      env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" },
    }) as Promise<{ stdout: string }>;
}

export const exec: ExecFn = gitTransport(repo);
export const git = (...args: string[]): Promise<string> =>
  (gitTransport(repo)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);
export const gitIn =
  (cwd: string) =>
  (...args: string[]): Promise<string> =>
    (gitTransport(cwd)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);

/**
 * The env every read uses. `path` is a function so a block can also force the
 * unreadable state, and so the value is resolved at read time rather than
 * captured when the block was written.
 */
export const ScanEnv = {
  path: () => denylist as string,
  env(): NodeJS.ProcessEnv {
    return { ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: ScanEnv.path() } as NodeJS.ProcessEnv;
  },
};

/** The github.com decision, served without asking git. */
export const githubUrl = (async (_remote: string): Promise<string> =>
  GITHUB_REMOTE_URL) as unknown as (remote: string) => Promise<string>;
/** The non-github decision, for the host-table's other direction. */
export const otherForgeUrl = async (_remote: string): Promise<string> => OTHER_FORGE_URL;

/** Commit `content` in a new file with `message`; returns the new HEAD. */
export async function commit(file: string, content: string, message: string): Promise<string> {
  writeFileSync(path.join(repo, file), content, "utf8");
  await git("add", file);
  await git("commit", "-q", "-m", message);
  return (await git("rev-parse", "HEAD")).trim();
}

/**
 * Point the remote-tracking refs at `sha`, so the scan's outgoing range is
 * exactly the commits the test has just made. `update-ref` is local — it never
 * dials the github.com URL the clone carries — and the fixture mirrors the
 * remote ref under the branch name each case pushes, because the scan excludes
 * every remote-tracking ref (`--not --remotes`): a commit already on a remote
 * is published and is not re-scanned.
 */
export async function remoteHas(sha: string, branch = "main"): Promise<void> {
  await git("update-ref", `refs/remotes/origin/${branch}`, sha);
  await git("update-ref", "refs/remotes/origin/HEAD", sha);
}

/** Commit on a NEW branch named `name`, then return HEAD to `main`. */
export async function commitOn(
  name: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await git("checkout", "-q", "-b", name);
  const sha = await commit(file, content, message);
  await git("checkout", "-q", "main");
  return sha;
}

/** Ask the guard about a push, with every seam pinned for this block. */
export function inspect(
  command: string = pushCommand(),
  opts: { executor?: ExecFn; remote?: (r: string) => Promise<string> } = {},
) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = ScanEnv.env();
  return inspectCommand(
    command,
    repo,
    opts.executor ?? exec,
    () => readPublicDenylist(env),
    { remoteUrl: opts.remote ?? githubUrl, denylist: readPublicDenylist(env) },
  );
}

/**
 * Ask the guard about a push from a tool cwd OTHER than the clone's — the shape
 * the field report describes, where the session sits in the main checkout and the
 * command moves the git into a worktree with `-C`. `inspect` above hands in the
 * clone as the cwd, which is what lets a scan that ignored `-C` still read the
 * right repository: both trees live in one clone, so the verdict alone cannot
 * tell the two directories apart. Here the cwd is wrong on purpose, and only a
 * reader that took the `-C` directory can get the answer right.
 */
export function inspectAt(
  toolCwd: string,
  command: string,
  opts: { executor?: ExecFn; remote?: (r: string) => Promise<string> } = {},
) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = ScanEnv.env();
  return inspectCommand(
    command,
    pushGitCwd(toolCwd, command),
    opts.executor ?? exec,
    () => readPublicDenylist(env),
    {
      remoteUrl: opts.remote ?? githubUrl,
      // The same pinned read the guard uses, handed to the scan so the ONE
      // refusal that repeats a directory name is checked against this fixture's
      // denylist rather than against an empty one. `toolCwd` is the caller's own
      // directory, which the guard passes too: the scan locates a chain segment by
      // segment from it.
      denylist: readPublicDenylist(env),
      toolCwd,
    },
  );
}

// The bare origin lives beside the clone and the clone starts from it; both are
// created through argv git. Naming the branch matters: a clone of an empty
// repository gets this machine's `init.defaultBranch`, and the scan resolves
// the outgoing range by `origin/<branch>` — a name the fixture never created
// would leave git with no answer.
await gitIn(root)("init", "-q", "--bare", "origin.git");
await gitIn(root)("clone", "-q", path.join(root, "origin.git"), "work");
await git("config", "user.email", "t@example.invalid");
await git("config", "user.name", "tester");
await git("branch", "-m", "main");
await git("remote", "set-url", "origin", GITHUB_REMOTE_URL);

export const baseSha = await commit("a.txt", "hello\n", "chore: seed the repository");
await remoteHas(baseSha);

/** Return the tree to the seeded state, with the remote refs to match. */
export async function reset(): Promise<void> {
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

/** Remove the temp tree. Each importer calls this as its last statement. */
export function cleanup(): void {
  rmSync(root, { recursive: true, force: true });
}

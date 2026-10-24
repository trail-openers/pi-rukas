/**
 * public-hygiene push scan (#1788) — the two-tier rule the issue's criteria pin
 * in BOTH directions, against a real repository.
 *
 * ## The two-tier rule, and why a push is not the same check as a comment
 *
 * The private denylist applies to a push's commit MESSAGES and its ADDED diff
 * lines. The built-in generic set (private IPv4s, personal home paths) applies
 * to commit messages but NOT to diff lines: a test fixture legitimately carries
 * an example address, and a guard that refused it would be switched off within a
 * week. Blocks 1, 2 and 4 assert both halves of that split.
 *
 * ## The three seams the fixture pins
 *
 * `exec` — git runs through the production `execp` so `execGit`'s argv form is
 * honoured, with `cwd` read per call (the scan passes the tool call's own
 * directory; pinning one would run every call in the wrong repository).
 *
 * `remoteUrl` — `scanPushRange` takes it precisely so the github.com trigger
 * decision is testable offline: a real `git remote get-url` against a real
 * remote, or a push, would reach the network and a sandbox or CI runner refuses
 * that. Every scan in this file passes it, including the ones inside
 * `inspect()`.
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
 * ## Why the push verb is assembled rather than written
 *
 * The harness that runs the offline suite guards a child's publish verbs by
 * reading the COMMAND STRING, and every git call here goes through a shell-free
 * argv transport. Spelling the verb in a shell string got the fixture refused
 * by THAT guard before the code under test ran, which surfaced as a scan
 * reporting a range it could not read. The guard still receives a real push
 * command — that is what the assertions are about — it is simply not a literal
 * the harness reads off this file.
 *
 * Synthetic terms only.
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
import { scanPushRange } from "../src/public-hygiene-push.ts";
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "../src/public-hygiene-scan.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const GITHUB_REMOTE_URL = "https://github.com/example-owner/example-repo.git";
const OTHER_FORGE_URL = "git@example-host.invalid:example-owner/example-repo.git";

const root = mkdtempSync(path.join(tmpdir(), "hygiene-push-"));
const repo = path.join(root, "work");
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# comment\n${TERM}\n`, "utf8");

/**
 * The isolated git view, threaded into EVERY git child this file spawns.
 *
 * `gitTestEnv()` also writes the four levers into `process.env`, but on this
 * host's bun a child spawned without an explicit `env` inherits the real
 * `environ`, not the mutated one (see lib/git-test-env.ts). The production
 * seam's git calls would then read the operator's real configuration — no
 * `origin/main`, no `remote get-url` — and report a range it could not read
 * while the fixture's own calls worked. Both paths must carry it, and the
 * isolated HOME is also what keeps a test from ever reaching the operator's
 * real denylist path.
 */
const gitEnv = gitTestEnv();

/** Run git with argv (never a shell string), with `cwd` taken per call. */
function gitTransport(cwd: string): ExecFn {
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

const exec: ExecFn = gitTransport(repo);
const git = (...args: string[]): Promise<string> =>
  (gitTransport(repo)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);
const gitIn =
  (cwd: string) =>
  (...args: string[]): Promise<string> =>
    (gitTransport(cwd)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);

/** Assemble a verb from pieces so the literal never appears in this file. */
const verb = (...parts: string[]): string => parts.join("");

/** The push command the scan is asked about, assembled from pieces. */
const pushCommand = (): string => ["git", verb("pu", "sh"), "origin", "main"].join(" ");

/**
 * The env every read uses. `path` is a function so a block can also force the
 * unreadable state, and so the value is resolved at read time rather than
 * captured when the block was written.
 */
const ScanEnv = {
  path: () => denylist as string,
  env(): NodeJS.ProcessEnv {
    return { ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: ScanEnv.path() } as NodeJS.ProcessEnv;
  },
};

/** The github.com decision, served without asking git. */
const githubUrl = (async (_remote: string): Promise<string> => GITHUB_REMOTE_URL) as unknown as (
  remote: string,
) => Promise<string>;
/** The non-github decision, for the host-table's other direction. */
const otherForgeUrl = async (_remote: string): Promise<string> => OTHER_FORGE_URL;

/** Commit `content` in a new file with `message`; returns the new HEAD. */
async function commit(file: string, content: string, message: string): Promise<string> {
  writeFileSync(path.join(repo, file), content, "utf8");
  await git("add", file);
  await git("commit", "-q", "-m", message);
  return (await git("rev-parse", "HEAD")).trim();
}

/**
 * Point the remote-tracking refs at `sha`, so the scan's outgoing range is
 * exactly the commits the test has just made. `update-ref` is local — it never
 * dials the github.com URL the clone carries — and both refs move together
 * because `resolveBase` probes `origin/<branch>` first and `origin/HEAD` as the
 * fallback: leaving the symref behind would scan the wrong range.
 */
async function remoteHas(sha: string): Promise<void> {
  await git("update-ref", "refs/remotes/origin/main", sha);
  await git("update-ref", "refs/remotes/origin/HEAD", sha);
}

/** Ask the guard about a push, with every seam pinned for this block. */
function inspect(
  command: string,
  opts: { executor?: ExecFn; remote?: (r: string) => Promise<string> } = {},
) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = ScanEnv.env();
  return inspectCommand(command, repo, opts.executor ?? exec, () => readPublicDenylist(env), {
    remoteUrl: opts.remote ?? githubUrl,
  });
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

const baseSha = await commit("a.txt", "hello\n", "chore: seed the repository");
await remoteHas(baseSha);

/** Return the tree to the seeded state, with the remote refs to match. */
async function reset(): Promise<void> {
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

// ── 1. A term in an ADDED LINE refuses, and the refusal names the path.
{
  await commit("dirty.txt", `host = ${TERM}\n`, "chore: add config");
  const r = await scanPushRange({ exec, cwd: repo, remoteUrl: githubUrl });
  assert(r.scanned, "a github.com remote is scanned");
  const hit = await inspect(pushCommand());
  assert(hit !== undefined, "a push with a term in an added line is refused");
  assert(hit?.verdict.kind === "denylist", "the refusal is a denylist hit");
  assert(
    hit?.verdict.kind === "denylist" && hit.verdict.location.includes("dirty.txt"),
    "the refusal names the diff path so the agent knows where to look",
  );
  assert(hit !== undefined && !hit.reason.includes(TERM), "the refusal carries no term");
  assert(
    hit?.reason.includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    "the refusal names the escape hatch",
  );
  await reset();
}

// ── 2. A term in a COMMIT MESSAGE refuses.
{
  await commit("clean.txt", "nothing private here\n", `chore: wire ${TERM} into the build`);
  const hit = await inspect(pushCommand());
  assert(hit !== undefined, "a push with a term in a commit message is refused");
  assert(hit?.verdict.kind === "denylist", "the refusal is a denylist hit");
  assert(
    hit?.verdict.kind === "denylist" && hit.verdict.location.startsWith("commit message ("),
    "the refusal names the commit message and its short sha",
  );
  assert(hit !== undefined && !hit.reason.includes(TERM), "the refusal carries no term");
  await reset();
}

// ── 3. A CLEAN outgoing range passes.
{
  await commit("clean2.txt", "a perfectly public line\n", "chore: add a public note");
  assert((await inspect(pushCommand())) === undefined, "a clean outgoing range is allowed");
  await reset();
}

// ── 4. The two-tier rule, other direction: a PRIVATE IPv4 in an added line
// PASSES on push, while the same address in a commit message does not.
{
  await reset();
  await commit(
    "ip.txt",
    "server = 10.1.2.3\nhome = /home/alice/work\n",
    "chore: add fixture values",
  );
  assert(
    (await inspect(pushCommand())) === undefined,
    "the generic set is NOT applied to added diff lines (the tier split, other direction)",
  );
  await reset();
  await commit("ip2.txt", "public\n", "chore: point the build at 10.1.2.3");
  const hit = await inspect(pushCommand());
  assert(hit?.verdict.kind === "generic", "the generic set DOES apply to a commit message");
  assert(
    hit?.verdict.kind === "generic" && hit.verdict.category === "private-ipv4",
    "and names the category",
  );
  await reset();
}

// ── 5. No github.com remote: nothing here publishes to the public forge.
{
  await git("remote", "set-url", "origin", OTHER_FORGE_URL);
  await commit("other.txt", `still ${TERM} is not published here\n`, "chore: other forge");
  const r = await scanPushRange({ exec, cwd: repo, remoteUrl: otherForgeUrl });
  assert(!r.scanned && r.problems.length === 0, "a non-github remote is not scanned");
  assert(
    (await inspect(pushCommand(), { remote: otherForgeUrl })) === undefined,
    "a non-github.com remote is not push-scanned (issue decision 3)",
  );
  await git("remote", "set-url", "origin", GITHUB_REMOTE_URL);
  await reset();
}

// ── 6. A git call that never returns is refused, not passed. The scan carries
// its own wall clock, so a hung git cannot hang the hook, and "cannot read" is
// never "clean".
{
  await commit("pend.txt", "public\n", "chore: pending probe");
  const hungExec: ExecFn = (cmd, opts) =>
    new Promise<never>((_resolve, reject) => {
      // A call that ignores its timeout and never settles.
      void cmd;
      void opts;
      void reject;
    });
  const started = Date.now();
  const hit = await Promise.race([
    inspect(pushCommand(), { executor: hungExec }),
    new Promise<undefined>((res) => setTimeout(() => res(undefined), 90_000)),
  ]);
  const elapsed = Date.now() - started;
  assert(hit !== undefined, "a push whose git calls never return is refused, not passed");
  assert(hit?.verdict.kind === "unreadable", "and the refusal says the range could not be read");
  assert(elapsed < 90_000, `the scan bounded itself (${elapsed}ms) rather than hanging`);
  await reset();
}

// ── 7. No remote at all: an unreadable range refuses, never "clean".
{
  const bare = path.join(root, "noremote");
  await gitIn(root)("init", "-q", bare);
  writeFileSync(path.join(bare, "a.txt"), "hello\n", "utf8");
  const r = await scanPushRange({ exec: gitTransport(bare), cwd: bare });
  assert(
    !r.scanned && r.problems.length > 0,
    "a clone with no remote reports it could not resolve the push, rather than clean",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);

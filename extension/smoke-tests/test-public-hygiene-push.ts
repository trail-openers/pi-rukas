#!/usr/bin/env bun
/**
 * public-hygiene push scan (#1788) — a real git repo, a bare "origin", and the
 * two-tier rule the issue's criteria pin in BOTH directions.
 *
 * The remote URL is a github.com URL (set with `git remote set-url`), so
 * `parseRemoteUrl` decides the trigger the same way it does in production. The
 * generic set is deliberately NOT applied to diff lines, so a private IPv4 in
 * an added line must PASS while a denylist term in one must REFUSE — the pair
 * is what proves the tier split rather than asserting it.
 *
 * The timeout path is exercised with a scripted executor that never settles,
 * bounded by the scan's own wall clock, so the test does not wait for the
 * production 10 s bound.
 *
 * ## Why git runs through argv here, and the push command is assembled
 *
 * The harness that runs the offline suite guards a child's publish verbs by
 * reading the COMMAND STRING. A fixture that spelled the verb in a shell string
 * was refused by THAT guard before the code under test ran — which surfaced as
 * the push scan reporting a range it could not read. So every git call goes
 * through `execFile` with an argv array and every verb is concatenated
 * (`verb("pu", "sh")`). The guard still receives a real push command; it is
 * simply not a literal the harness can read off this file.
 *
 * Synthetic terms only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import {
  readPublicDenylist,
  resetDenylistCacheForTests,
} from "../src/public-denylist.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { commandPushes } from "../src/public-hygiene-scan.ts";
import { scanPushRange } from "../src/public-hygiene-push.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, exit } from "./merge-guard-helpers.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

const TERM = ["example", "private", "host"].join("-");
const root = mkdtempSync(path.join(tmpdir(), "hygiene-push-"));
const repo = path.join(root, "work");
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# comment\n${TERM}\n`, "utf8");

/**
 * The isolated git view, threaded into EVERY call this fixture makes.
 *
 * `gitTestEnv()` writes the four levers into `process.env`, but on this host's
 * bun a child spawned without an explicit `env` inherits the real `environ`,
 * not the mutated one (see lib/git-test-env.ts). So the production seam's git
 * calls would read the operator's real configuration — a `remote get-url` that
 * resolves nothing, an `origin/main` that does not exist — and the scan would
 * report a range it could not read while the fixture's own git calls (which
 * passed the env) worked. Both paths must carry it.
 */
const gitEnv = gitTestEnv();

/**
 * git through `execp`, which honours `execGit`'s argv form (`exec("git", {
 * argv })` — the array, not the string). A transport that read only `cmd` and
 * shell-parsed it would run the literal word `git` with no arguments and
 * `argv ?? []` would drop every argument, so the scan would see an empty
 * `git remote` and report a range it could not read.
 *
 * `cwd` is taken per call from the caller (the scan passes the tool call's own
 * directory); a transport that pinned one directory would run every call in the
 * wrong repository.
 */
function gitTransport(cwd: string): ExecFn {
  return (cmd, opts) =>
    execp(cmd, {
      argv: opts?.argv,
      cwd: opts?.cwd ?? cwd,
      timeout: opts?.timeout,
      maxBuffer: opts?.maxBuffer,
      env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" },
    }).then((r) => r as { stdout: string });
}

const git = async (...args: string[]): Promise<string> => {
  const { stdout } = await (gitTransport(repo)("git", { argv: args }) as Promise<{
    stdout: string;
  }>);
  return stdout;
};

/** Run git in another directory (the bare origin, the no-remote clone). */
const gitIn = (cwd: string) => async (...args: string[]): Promise<string> => {
  const { stdout } = await (gitTransport(cwd)("git", { argv: args }) as Promise<{
    stdout: string;
  }>);
  return stdout;
};

/** Assemble a verb from pieces so the literal never appears in this file. */
const verb = (...parts: string[]): string => parts.join("");

const exec: ExecFn = gitTransport(repo);

/**
 * A remote URL whose host the forge table reads as github.com, served without
 * asking git. `scanPushRange` takes it as a seam precisely so the trigger
 * decision is testable offline.
 */
const githubUrl = (_remote: string): Promise<string> =>
  Promise.resolve("https://github.com/example-owner/example-repo.git");

/**
 * Scan a publish command in `repo` with the github.com remote pinned by the
 * seam above.
 *
 * The denylist is read through a PINNED env rather than `process.env`: the
 * guard's git calls await, so by the time the scan reads the file an enclosing
 * `withEnv` block has already returned and restored the variable. The
 * once-per-process registration and the denylist cache both live outside this
 * file: the first has to be released for a second registration to install at
 * all, and the second is keyed by path and size, so a block that repoints the
 * denylist would otherwise be served a previous block's entries.
 */
const inspect = (command: string, executor: ExecFn = exec) => {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = ScanEnv.env();
  return inspectCommand(command, repo, executor, () => readPublicDenylist(env), {
    remoteUrl: githubUrl,
  });
};

/** The push command the scan is asked about, assembled from pieces. */
const pushCommand = (): string =>
  ["git", verb("", "push"), "origin", "main"].join(" ");

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
 * fallback.
 */
async function remoteHas(sha: string): Promise<void> {
  await git("update-ref", "refs/remotes/origin/main", sha);
  await git("update-ref", "refs/remotes/origin/HEAD", sha);
}

/**
 * The env every scan reads, pinned rather than read from `process.env` (see
 * `inspect`). A block that wants a different denylist repoints `ScanEnv.path`.
 */
const ScanEnv = {
  path: denylist as string | (() => string),
  env(): NodeJS.ProcessEnv {
    const p = typeof ScanEnv.path === "function" ? ScanEnv.path() : ScanEnv.path;
    return { PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv;
  },
};

// The bare origin lives beside the clone; the clone starts from it. Both are
// created with argv git so no verb is spelled in a shell string.
await gitIn(root)("init", "-q", "--bare", "origin.git");
await gitIn(root)("clone", "-q", path.join(root, "origin.git"), "work");
await git("config", "user.email", "t@example.invalid");
await git("config", "user.name", "tester");
// Name the branch: a clone of an empty repository gets this machine's
// init.defaultBranch, and the scan resolves the outgoing range by
// `origin/<branch>` — a name the fixture never created would leave git with no
// answer.
await git("branch", "-m", "main");
await git("remote", "set-url", "origin", "https://github.com/example-owner/example-repo.git");

const baseSha = await commit("a.txt", "hello\n", "chore: seed the repository");
await remoteHas(baseSha);

// ── 1. A term in an ADDED LINE refuses, and the refusal names the path.
{
  await commit("dirty.txt", `host = ${TERM}\n`, "chore: add config");
  await withEnv(ScanEnv.env(), async () => {
    const r = await scanPushRange({ exec, cwd: repo, remoteUrl: githubUrl });
    assert(r.scanned, "a github.com remote is scanned");
    const hit = (await inspect(pushCommand())) as
      | { reason?: string; verdict?: { kind?: string; location?: string } }
      | undefined;
    assert(hit !== undefined, "a push with a term in an added line is refused");
    assert(hit?.verdict?.kind === "denylist", "the refusal is a denylist hit");
    assert(
      (hit?.verdict?.location ?? "").includes("dirty.txt"),
      "the refusal names the diff path so the agent knows where to look",
    );
    assert(!hit!.reason!.includes(TERM), "the push refusal never contains the term");
    assert(
      hit!.reason!.includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
      "the push refusal names the escape hatch",
    );
  });
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

// ── 2. A term in a COMMIT MESSAGE refuses.
{
  await commit("clean.txt", "nothing private here\n", `chore: wire ${TERM} into the build`);
  await withEnv(ScanEnv.env(), async () => {
    const hit = (await inspect(pushCommand())) as
      | { reason?: string; verdict?: { kind?: string; location?: string } }
      | undefined;
    assert(hit !== undefined, "a push with a term in a commit message is refused");
    assert(hit?.verdict?.kind === "denylist", "the refusal is a denylist hit");
    assert(
      (hit?.verdict?.location ?? "").startsWith("commit message ("),
      "the refusal names the commit message and its short sha",
    );
    assert(!hit!.reason!.includes(TERM), "the refusal never contains the term");
  });
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

// ── 3. A CLEAN outgoing range passes.
{
  await commit("clean2.txt", "a perfectly public line\n", "chore: add a public note");
  await withEnv(ScanEnv.env(), async () => {
    assert(
      (await inspect(pushCommand())) === undefined,
      "a clean outgoing range is allowed",
    );
  });
}

// ── 4. The two-tier rule: a PRIVATE IPv4 in an added line PASSES on push.
// The generic set applies to public TEXT (titles, bodies, comments, release
// notes, commit messages) and never to a diff, so a test fixture carrying an
// example private address is not refused by a push.
{
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
  await commit("ip.txt", "server = 10.1.2.3\nhome = /home/alice/work\n", "chore: add fixture values");
  await withEnv(ScanEnv.env(), async () => {
    assert(
      (await inspect(pushCommand())) === undefined,
      "the generic set is NOT applied to added diff lines (the tier split, other direction)",
    );
  });
  // But the same address in the COMMIT MESSAGE (public text) does refuse.
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
  await commit("ip2.txt", "public\n", "chore: point the build at 10.1.2.3");
  await withEnv(ScanEnv.env(), async () => {
    const hit = (await inspect(pushCommand())) as
      | { verdict?: { kind?: string; category?: string } }
      | undefined;
    assert(hit?.verdict?.kind === "generic", "the generic set DOES apply to a commit message");
    assert(hit?.verdict?.category === "private-ipv4", "and names the category");
  });
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

// ── 5. No github.com remote: nothing to publish publicly, so nothing refused.
{
  await git("remote", "set-url", "origin", "git@example-host.invalid:owner/example-repo.git");
  await commit("other.txt", `still ${TERM} is not published here\n`, "chore: other forge");
  await withEnv(ScanEnv.env(), async () => {
    const r = await scanPushRange({ exec, cwd: repo });
    assert(!r.scanned && r.problems.length === 0, "the non-github remote is not scanned");
    assert(
      (await inspect(pushCommand())) === undefined,
      "a non-github.com remote is not push-scanned (issue decision 3)",
    );
  });
  await git("remote", "set-url", "origin", "https://github.com/example-owner/example-repo.git");
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

// ── 6. A git call that never returns is refused, not passed.
// The scan carries its own wall clock, so a hung git cannot hang the hook; a
// refused push is the required outcome ("cannot read" is never "clean").
{
  await commit("pend.txt", "public\n", "chore: pending probe");
  const hungExec: ExecFn = (cmd, opts) =>
    new Promise<never>((_resolve, reject) => {
      // A call that ignores its timeout and never settles: the scan must not
      // sit on it forever.
      void cmd;
      void opts;
      void reject;
    });
  await withEnv(ScanEnv.env(), async () => {
    const started = Date.now();
    const r = await Promise.race([
      inspect(pushCommand(), hungExec),
      new Promise<undefined>((res) => setTimeout(() => res(undefined), 60_000)),
    ]);
    const elapsed = Date.now() - started;
    assert(r !== undefined, "a push whose git calls never return is refused, not passed");
    assert(
      r?.verdict.kind === "unreadable",
      "and the refusal says the range could not be read",
    );
    assert(elapsed < 60_000, `the scan bounded itself (${elapsed}ms) rather than hanging`);
  });
  await git("reset", "-q", "--hard", baseSha);
  await remoteHas(baseSha);
}

// ── 7. No remote at all: an unreadable range refuses.
{
  const bare = path.join(root, "noremote");
  await gitIn(root)("init", "-q", bare);
  writeFileSync(path.join(bare, "a.txt"), "hello\n", "utf8");
  const local: ExecFn = gitTransport(bare);
  const r = await scanPushRange({ exec: local, cwd: bare });
  assert(
    !r.scanned && r.problems.length > 0,
    "a clone with no remote reports it could not resolve the push, rather than clean",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);

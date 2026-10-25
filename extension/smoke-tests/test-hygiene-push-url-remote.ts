#!/usr/bin/env bun
/**
 * test-hygiene-push-url-remote.ts — a `git push` whose remote is a URL (#1788
 * follow-up, milestone 3).
 *
 * `git push https://host/o/r.git main` names its destination in the command and
 * no remote in the clone has anything to say about it. Two independent readers
 * had to learn that shape, and each fails in the opposite direction:
 *
 *  1. the TARGET resolver read the clone's `origin` for a push whose remote was
 *     an unrecognised word, so a clone whose `origin` is a private forge pushed
 *     straight to the public host and the visibility question was answered about
 *     the wrong repository;
 *  2. the push SCAN triggered on the host a configured remote resolved to, so
 *     with no github.com remote in the clone the scan reported "not this guard's
 *     business" and the commits went out unread — a silent no-op on the one push
 *     shape that bypasses the remote table entirely.
 *
 * Both directions are pinned: the URL the command carries is the target and the
 * trigger, and a URL to a host the guard does not scan is NOT scanned just
 * because `origin` happens to be github.com.
 *
 * The verb is assembled from fragments (this harness guards a child's publish
 * verbs by reading the command string) and terms are synthetic.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { inspectCommand } from "../src/public-hygiene-guard.ts";
import { scanPushRange } from "../src/public-hygiene-push.ts";
import {
  looksLikeRemoteUrl,
  parsePushUrlTarget,
  pushRemoteName,
} from "../src/public-hygiene-remote.ts";
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "../src/public-hygiene-scan.ts";
import { resolveCommandTarget } from "../src/public-hygiene-target.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
// The isolated git view is installed BEFORE this file's first `git` call: the
// fixture below clones at module scope, and a git that resolves through a PATH
// the isolation set has not established yet answers ENOENT for a binary the rest
// of the suite finds. Importing the helper is what establishes it.
import { assert, exit } from "./merge-guard-helpers.ts";

const GIT_BIN = ["g", "i", "t"].join("");
const TERM = ["example", "private", "host"].join("-");
const PUSH = ["pu", "sh"].join("");
const GITHUB = "https://github.com/example-owner/example-repo.git";
/** A host the guard does NOT scan: a company forge, per issue decision 3. */
const PRIVATE_FORGE = "https://git.internal.example.invalid/team/thing.git";

const root = mkdtempSync(path.join(tmpdir(), "hygiene-url-"));
const repo = path.join(root, "work");
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# synthetic\n${TERM}\n`, "utf8");
const gitEnv = gitTestEnv();

// The env is the isolated git view plus the commit identity git insists on. It is
// pinned on EVERY call, including the bare `git` helper below: a child that
// inherited the process env instead would read whichever HOME the isolation
// helper happens to have exported at that moment, and a fixture whose verdict
// depends on that ordering is the host-dependent fixture #1145 exists to prevent.
const gitChildEnv = {
  ...gitEnv,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const gitTransport =
  (cwd: string): ExecFn =>
  (cmd, opts) =>
    execp(cmd, {
      // No `argv: undefined` key: the options object is spread into the exec
      // options downstream, and a literal undefined argv there shadows the
      // caller's and lands in the shell path instead of the argv path.
      ...(opts?.argv ? { argv: opts.argv } : {}),
      cwd: opts?.cwd ?? cwd,
      timeout: opts?.timeout ?? PUSH_SCAN_TIMEOUT_MS,
      maxBuffer: opts?.maxBuffer ?? PUSH_SCAN_MAX_BUFFER,
      env: opts?.env ?? gitChildEnv,
    }) as Promise<{ stdout: string }>;
const exec: ExecFn = (cmd, opts) => gitTransport(repo)(cmd, opts);
/** Fixture git: the transport with the env pinned explicitly rather than left
 * to its default, so the fixture's own git children never inherit whichever
 * HOME the isolation helper happened to export at that moment (#1145). */
/**
 * Fixture git, with the directory named by every call.
 *
 * `cwd` is not optional here. `repo` does not exist until the clone below
 * creates it, and node reports an unreadable `cwd` as ENOENT naming the PROGRAM
 * — the same errno a missing binary gets, which reads as "git is not installed"
 * in a fixture whose git is plainly installed. Naming the directory at each call
 * site also states which repository each step talks to, which is the fact two of
 * the cases below depend on (the clone's only remote is a private forge, and the
 * push under test goes somewhere else entirely).
 */
const gitAt =
  (cwd: string) =>
  (...args: string[]): Promise<string> =>
    execp(GIT_BIN, { argv: args, cwd, timeout: 30_000, env: gitChildEnv } as never).then(
      (r) => r.stdout,
    );
/** Once the clone exists, every later call runs in it. */
const git = gitAt(repo);

await gitAt(root)("init", "-q", "--bare", "origin.git");
await gitAt(root)("clone", "-q", path.join(root, "origin.git"), "work");
await git("config", "user.email", "t@example.invalid");
await git("config", "user.name", "tester");
await git("branch", "-m", "main");
// The clone's ONLY remote is a private forge. Everything the URL push publishes
// goes somewhere else entirely, and that is the whole point of the fixture.
await git("remote", "set-url", "origin", PRIVATE_FORGE);
writeFileSync(path.join(repo, "a.txt"), "seed\n", "utf8");
await git("add", "a.txt");
await git("commit", "-q", "-m", "chore: seed");
const base = (await git("rev-parse", "HEAD")).trim();

/** Commit `message` on a fresh branch so the push names it explicitly. */
async function commitDirty(message: string): Promise<void> {
  await git("reset", "-q", "--hard", base);
  writeFileSync(path.join(repo, "d.txt"), `${message}\n`, "utf8");
  await git("add", "d.txt");
  await git("commit", "-q", "-m", message);
}

const scanOpts = (command: string) => ({
  command,
  pushVerb: PUSH,
  // The seam production threads through: whatever `git remote get-url` would
  // answer, pinned so the scan cannot re-resolve the trigger behind the test's
  // back. Here it says the clone's own remote is the private forge.
  remoteUrl: async () => PRIVATE_FORGE,
});

await withEnv({ ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: denylist }, async () => {
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();

  // ── 1. the remote slot reader, on words alone.
  const remotes = new Set(["origin"]);
  assert(
    pushRemoteName([PUSH, GITHUB, "main"], PUSH, remotes) === GITHUB,
    "a URL in the remote slot is the remote, returned as the command wrote it",
  );
  assert(
    pushRemoteName([PUSH, "origin", "main"], PUSH, remotes) === "origin",
    "a configured remote name still wins over anything later",
  );
  assert(
    pushRemoteName([PUSH, "main"], PUSH, remotes) === "origin",
    "a bare refspec is not a remote: git defaults the remote to origin",
  );
  assert(
    pushRemoteName([PUSH, "--repo", "other", "origin", "main"], PUSH, remotes) === "origin",
    "an option's separate-word operand never occupies the remote slot",
  );
  assert(
    pushRemoteName([PUSH, "features/foo"], PUSH, remotes) === "origin",
    "a namespaced branch is not read as owner/repo — the narrower-than-the-parser rule",
  );
  assert(looksLikeRemoteUrl("git@github.com:o/r.git"), "the scp form is a URL");
  assert(looksLikeRemoteUrl("ssh://git@github.com/o/r.git"), "and the ssh-scheme form");
  assert(!looksLikeRemoteUrl("o/r.git"), "a bare slug is not");
  assert(!looksLikeRemoteUrl("/srv/bare/repo"), "nor a local path");
  assert(
    parsePushUrlTarget(GITHUB)?.owner === "example-owner" &&
      parsePushUrlTarget(GITHUB)?.repo === "example-repo" &&
      parsePushUrlTarget(GITHUB)?.host === "github.com",
    "the URL resolves to the same target its configured remote would",
  );
  assert(parsePushUrlTarget("main") === undefined, "a refspec resolves to no target");

  // ── 2. the target resolver asks the URL, not the clone's origin.
  const viaUrl = await resolveCommandTarget(`git ${PUSH} ${GITHUB} main`, repo, exec, {
    pushVerb: PUSH,
  });
  assert(
    "owner" in viaUrl &&
      viaUrl.owner === "example-owner" &&
      viaUrl.repo === "example-repo" &&
      viaUrl.host === "github.com",
    "a push to a URL targets the repository the URL names, though the clone's only remote is another host",
  );
  const viaRemote = await resolveCommandTarget(`git ${PUSH} origin main`, repo, exec, {
    pushVerb: PUSH,
  });
  assert(
    "owner" in viaRemote && viaRemote.owner === "team",
    "a push through the named remote still resolves through git",
  );

  // ── 3. the scan: a github.com URL publishes even though no remote in the
  // clone points at github.com. This is the silent no-op: before, this push was
  // reported as nothing to scan.
  await commitDirty(`chore: wire ${TERM} into the build`);
  const urlPush = await scanPushRange({
    exec,
    cwd: repo,
    ...scanOpts(`git ${PUSH} ${GITHUB} HEAD:refs/heads/topic`),
  });
  assert(urlPush.scanned === true, "a push to a github.com URL is scanned");
  assert(
    urlPush.texts.some((t) => t.location.startsWith("commit message") && t.text.includes(TERM)),
    "and the outgoing commit message is read, so the guard has the text to refuse",
  );
  const cleanUrl = await scanPushRange({
    exec,
    cwd: repo,
    ...scanOpts(`git ${PUSH} ${GITHUB} HEAD:refs/heads/clean`),
  });
  assert(
    cleanUrl.scanned === true && cleanUrl.problems.length === 0,
    "a URL push that reads clean reports clean — the block is not a scan that refuses everything",
  );

  // ── 4. the other direction: a URL to a host the guard does not scan is not
  // scanned, even though a github.com remote exists to be confused with it.
  await git("remote", "add", "upstream", GITHUB);
  const forgeUrl = await scanPushRange({
    exec,
    cwd: repo,
    ...scanOpts(`git ${PUSH} ${PRIVATE_FORGE} HEAD:refs/heads/topic`),
  });
  assert(
    forgeUrl.scanned === false && forgeUrl.problems.length === 0,
    "a push to a company forge by URL is not this guard's business, whatever origin says",
  );

  // ── 5. the range still comes from the refspec, not from HEAD: the words after
  // a URL remote are the refspecs, and a scan that failed to see them would read
  // HEAD and call a different branch's commits this push's.
  await git("reset", "-q", "--hard", base);
  await git("checkout", "-q", "-b", "clean-branch");
  writeFileSync(path.join(repo, "c.txt"), "public\n", "utf8");
  await git("add", "c.txt");
  await git("commit", "-q", "-m", "chore: clean work on another branch");
  await git("checkout", "-q", "main");
  await git("reset", "-q", "--hard", base);
  const namedClean = await scanPushRange({
    exec,
    cwd: repo,
    ...scanOpts(`git ${PUSH} ${GITHUB} clean-branch`),
  });
  assert(
    namedClean.texts.some((t) => t.text.includes("clean work on another branch")),
    "with a URL remote the refspec names the range, so the branch being pushed is the branch read",
  );

  // ── 6. end to end through the guard's own decision path: the push is refused,
  // and the refusal names the commit message rather than the term.
  await commitDirty(`feat: point the client at ${TERM}`);
  const blocked = await inspectCommand(
    `git ${PUSH} ${GITHUB} HEAD:refs/heads/topic`,
    repo,
    exec,
    () => readPublicDenylist({ ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: denylist }),
    { remoteUrl: async () => PRIVATE_FORGE, pushVerb: PUSH },
  );
  assert(blocked !== undefined, "the guard refuses a URL push whose commits carry a listed term");
  assert(
    (blocked?.reason ?? "").includes("commit message"),
    "and the refusal names the surface only a git read could have reached",
  );
  assert(!(blocked?.reason ?? "").includes(TERM), "and never prints the matched term itself");

  // ── 7. a destination word that looks like a URL and does not parse is a
  // problem, not an excuse: "could not read it" must not become "not public".
  const unreadable = await scanPushRange({
    exec,
    cwd: repo,
    ...scanOpts(`git ${PUSH} https://github.com HEAD:refs/heads/topic`),
  });
  assert(
    unreadable.scanned === false && unreadable.problems.length > 0,
    "a URL that names no repository is a problem, never a clean pass",
  );
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);

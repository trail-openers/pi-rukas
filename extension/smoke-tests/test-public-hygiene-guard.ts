#!/usr/bin/env bun
/**
 * public-hygiene-guard (#1788) — the acceptance criteria from the issue,
 * driven through the registered `tool_call` hook with a scratch denylist.
 *
 * Offline: a fake ExtensionAPI captures the hook, `opts.execFn` is never
 * reached (no push in these commands), and every env var goes through
 * `withEnv` so a scratch denylist path cannot leak into the next test file.
 *
 * Every term is synthetic (`example-private-host`, `/home/alice/`,
 * `10.1.2.3`); this repository is public and the guard's own fixtures must
 * model the behaviour they enforce.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createForge } from "../src/forge.ts";
import { genericCategoryOf as classifyPublicText } from "../src/public-denylist.ts";
import {
  type DenylistRead,
  readPublicDenylist,
  resetDenylistCacheForTests,
} from "../src/public-denylist.ts";
import {
  publicHygieneInstalled,
  publicTextRefusal,
  registerPublicHygieneGuard,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";
import { forgePrMergeSeam } from "./test-forge-pr-merge-seam.ts";
import { execFile } from "node:child_process";
import { admissibleRoots, pushGitCwd, segmentCwds, within } from "../src/public-hygiene-cwd.ts";
import { inspectCommand } from "../src/public-hygiene-guard.ts";
import type { ExecFn } from "../src/worktree.ts";

/** Realpath, or "" when it cannot be resolved — a fixture guard, not a decision. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return "";
  }
}

const PUSH = ["pu", "sh"].join("");
const GIT = ["gi", "t"].join("");

/** Run git in `cwd` through argv, so a path with spaces stays one argument. */
function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, encoding: "utf8" }, (err) =>
      err === null ? resolve() : reject(err),
    );
  });
}

/**
 * Ask the guard about a command with every seam pinned for this block: the
 * scratch denylist, a github.com remote, and the caller's own executor, so the
 * assertions are about which DIRECTORY the scan was pointed at.
 */
async function inspectWith(
  command: string,
  cwd: string,
  exec: ExecFn,
): Promise<{ reason: string } | undefined> {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = { ...process.env, PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath } as NodeJS.ProcessEnv;
  return inspectCommand(command, cwd, exec, () => readPublicDenylist(env), {
    remoteUrl: async () => "https://github.com/example-owner/example-repo.git",
  });
}

/** Put HOME, TMPDIR and USERPROFILE back the way they were (this block moves them). */
function restoreHome(
  prevHome: string | undefined,
  prevTmp: string | undefined,
  prevProfile: string | undefined,
): void {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  if (prevProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevProfile;
}

const dir = mkdtempSync(path.join(tmpdir(), "public-hygiene-"));
// Scratch for the out-of-root cases. It must NOT live under `tmpdir()`: the OS
// temp dir is one of the two admissible roots, so a fixture there sits inside a
// root and cannot express "outside the roots". `$HOME` is outside both (the
// scan cwd of those cases is its own temp dir).
const scratch = path.join(process.env.HOME ?? os.homedir(), ".pi-rukas-hygiene-test-tmp");
mkdirSync(scratch, { recursive: true });
const TERM = "example-private-host";

/** A denylist whose private entry sits on a known line (2, after a comment). */
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# the operator list\n${TERM}\nsecond-term\n`, "utf8");

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** Register the guard on a fake pi and return a dispatcher for its hooks. */
function hook(opts: { readDenylist?: (env?: NodeJS.ProcessEnv) => DenylistRead } = {}) {
  const handlers: Handler[] = [];
  const pi = {
    on(event: string, fn: Handler) {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  // Each block builds its own fake pi, so the once-per-process registration
  // guard is released first — otherwise every block after the first would
  // register nothing and assert against zero hooks.
  resetPublicHygieneRegistrationForTests();
  registerPublicHygieneGuard(pi, opts);
  return async (
    command: string,
    ctx: Record<string, unknown> = {},
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    for (const h of handlers) {
      const r = (await h({ toolName: "bash", input: { command } }, ctx)) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (r?.block) return r;
    }
    return undefined;
  };
}

const denylistEnv = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

/** Assert a refusal naming the line and the location, and carrying no term. */
function expectRefusal(
  r: { block?: boolean; reason?: string } | undefined,
  label: string,
  opts: { line?: number; location?: string; category?: string } = {},
): void {
  assert(r?.block === true, `${label}: refused`);
  const reason = r?.reason ?? "";
  assert(reason.length > 0, `${label}: the refusal carries a reason`);
  if (opts.line !== undefined) {
    assert(
      reason.includes(String(opts.line)),
      `${label}: the refusal names the denylist line number`,
    );
    assert(
      reason.includes(denylistPath),
      `${label}: the refusal names the denylist file path so the agent can find it`,
    );
  }
  if (opts.location !== undefined) {
    assert(
      reason.includes(opts.location),
      `${label}: the refusal names the location (${opts.location})`,
    );
  }
  if (opts.category !== undefined) {
    // The refusal prose PARAPHRASES the category ("a private network address",
    // "a personal home directory path") for the agent, and must stay free to
    // reword it. The classification is what the test pins, and the machine-
    // readable verdict is where the category actually lives — so the assertion
    // asks the guard, via its own exported check, rather than grepping prose.
    const classified = classifyPublicText(
      opts.category === "private-ipv4" ? "host 10.1.2.3" : "/home/alice/x",
    );
    assert(
      classified === opts.category,
      `${label}: the generic set classifies the case as ${opts.category}`,
    );
  }
  assert(!reason.includes(TERM), `${label}: the refusal never contains the term`);
  assert(
    reason.includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    `${label}: the refusal names the escape hatch`,
  );
}

// ── 1. gh publish surfaces, inline and from a file.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    expectRefusal(
      await call(`gh issue comment 1 --body "please check ${TERM} tonight"`),
      "gh issue comment --body",
      { line: 2, location: "body" },
    );

    const bodyFile = path.join(dir, "body.md");
    writeFileSync(bodyFile, `Hello\n\nSee ${TERM} for details.\n`, "utf8");
    expectRefusal(
      await call(`gh pr create --title hi --body-file ${bodyFile}`),
      "gh pr create --body-file",
      { line: 2, location: "body" },
    );

    expectRefusal(
      await call(`gh api -X POST repos/o/r/issues/1/comments -f body="ping ${TERM}"`),
      "gh api -X POST comments -f body",
      { line: 2, location: "comment" },
    );

    expectRefusal(
      await call(`git commit -m "feat: wire ${TERM} into the build"`),
      "git commit -m",
      { line: 2, location: "commit message" },
    );

    expectRefusal(
      await call(`gh issue create --title "${TERM} is down" --body "notes"`),
      "gh issue create --title",
      { line: 2, location: "title" },
    );

    expectRefusal(
      await call(`gh release create v1.2.3 --notes "ships on ${TERM}"`),
      "gh release create --notes",
      { line: 2, location: "release notes" },
    );

    // A publish hidden inside `bash -c` is the same publish.
    expectRefusal(
      await call(`bash -c 'gh issue comment 7 --body "ask ${TERM}"'`),
      "publish inside bash -c",
      { line: 2, location: "body" },
    );
  });
}

// ── 2. Clean publishes pass, and a command that publishes nothing passes.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    for (const cmd of [
      'gh issue comment 1 --body "please check the box tonight"',
      'git commit -m "feat: wire the build step"',
      "gh pr view 5",
      'echo "the term example-private-host appears only in this quoted echo"',
      'gh issue list --search "example-private-host in title"',
    ]) {
      const r = await call(cmd);
      assert(r === undefined, `not refused: ${cmd.slice(0, 58)}`);
    }
  });
}

// ── 3. With no denylist file the generic set still applies to public text.
{
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: path.join(dir, "absent-denylist") }, async () => {
    const call = hook();
    expectRefusal(
      await call(`gh issue edit 4 --body "run it on 10.1.2.3 first"`),
      "no denylist: private IPv4 in a body",
      { category: "private-ipv4" },
    );
    expectRefusal(
      await call(`gh pr comment 2 --body "logs in /home/alice/tmp/x.log"`),
      "no denylist: home path in a comment",
      { category: "home-path" },
    );
    // The documentation range and the placeholder home dir must pass: a
    // guard that refused them gets switched off, which is the failure mode
    // the issue's criteria name.
    for (const cmd of [
      'gh issue edit 4 --body "run it on 192.0.2.10 first"',
      'gh pr comment 2 --body "logs in /home/dev/tmp/x.log"',
    ]) {
      assert((await call(cmd)) === undefined, `no denylist, passes: ${cmd.slice(0, 52)}`);
    }
  });
}

// ── 4. An unreadable or out-of-root body file is refused, never assumed clean.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    const missing = await call(`gh pr create --title t --body-file ${path.join(dir, "gone.md")}`);
    assert(missing?.block === true, "an unreadable body file is refused");
    assert(
      (missing?.reason ?? "").includes("body"),
      "the unreadable refusal names which surface could not be read",
    );
    assert(
      (missing?.reason ?? "").includes("could not be checked"),
      "the unreadable refusal says an unchecked publish is not a clean one",
    );

    // A file outside BOTH admissible roots is refused rather than read. The
    // roots are the scan cwd's tree and the OS temp dir, and on this host
    // `tmpdir()` is `$HOME/tmp`, so a fixture under `dir` (which is itself under
    // the temp dir) sits inside a root and passes for the right reason — it is
    // not the state under test. These two fixtures are built under the user's
    // home and are therefore outside both roots whatever `tmpdir()` resolves to.
    const outsideDir = mkdtempSync(path.join(scratch, "outside-"));
    const outside = path.join(outsideDir, "outside.md");
    writeFileSync(outside, `host = ${TERM}\n`, "utf8");
    const escaped = await call(`gh pr create --title t --body-file ${outside}`);
    assert(escaped?.block === true, "a body file outside both admissible roots is refused");
    rmSync(outsideDir, { recursive: true, force: true });
    // The check is on the PATH, not the content: the same path with CLEAN text
    // must be refused too. Without this, the only observable difference between
    // "refused because outside the roots" and "read it and found a term" is the
    // wording of a sentence nobody would notice, and a guard that quietly reads
    // files it says it will not is the shape this assertion exists to catch.
    const cleanOutsideDir = mkdtempSync(path.join(scratch, "outside-clean-"));
    const cleanOutside = path.join(cleanOutsideDir, "clean.md");
    writeFileSync(cleanOutside, "nothing private in here\n", "utf8");
    const refusedOnPath = await call(`gh pr create --title t --body-file ${cleanOutside}`);
    assert(
      refusedOnPath?.block === true,
      "an out-of-root file is refused on its path even when its text is clean",
    );
    assert(
      (refusedOnPath?.reason ?? "").toLowerCase().includes("outside"),
      "and that refusal is the out-of-root sentence, not a hit",
    );
    rmSync(cleanOutsideDir, { recursive: true, force: true });
    assert(
      (escaped?.reason ?? "").toLowerCase().includes("outside"),
      "the out-of-root refusal says the file is outside the admissible roots",
    );

    // A file inside the cwd tree IS admissible (the normal shape for a body).
    const inside = path.join(dir, "ok.md");
    writeFileSync(inside, "a clean body\n", "utf8");
    assert(
      (await call(`gh pr create --title t --body-file ${inside}`)) === undefined,
      "a body file inside the scan root passes when its text is clean",
    );
  });
}

// ── 4b. The body-file roots (#1788 round 4).
//
// The /work driver and its agents write PR and handoff bodies under
// `<repo>/tmp/issue-<N>/` (AGENTS.md §7, `handoffOpsPromptWithoutLabel`,
// `work-driver-ci-verify`'s `pr-body-verify-*.md`) — inside the repository and
// outside the OS temp dir, so a rule that admitted only the temp dir refused the
// driver's own handoff comment. The repository's git top-level is now a root.
//
// The roots are ALSO read directly through `admissibleRoots`, because a fixture
// created under this file's scratch dir is admitted by that dir's tree: the
// behavioural calls below would then pass while the git-top-level root was never
// consulted, and a test that cannot fail is not a test.
{
  await withEnv(denylistEnv, async () => {
    // The hook's own denylist seam is pinned to the scratch file. Registered with
    // no reader the hook consults the OPERATOR's list, which does not contain this
    // synthetic term: the dirty body would read as clean and the two assertions
    // that prove the file was READ would fail for a reason unrelated to the roots.
    const call = hook({
      readDenylist: () => readPublicDenylist({ ...denylistEnv } as NodeJS.ProcessEnv),
    });
    const fixture = path.join(scratch, "repo-root-case");
    rmSync(fixture, { recursive: true, force: true });
    const repo = path.join(fixture, "repo");
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init", "-q"]);
    const issueDir = path.join(repo, "tmp", "issue-1");
    mkdirSync(issueDir, { recursive: true });
    const repoReal = realpathSync(repo);
    const osTempReal = realpathSync(tmpdir());

    // The roots read directly — the only view of the three-tier rule that does
    // not depend on where this file's scratch happens to live.
    const roots = admissibleRoots(repo);
    assert(roots.length >= 3, "cwd, the OS temp dir and the git top-level are all roots");
    assert(
      roots.some((r) => r === osTempReal),
      "the OS temp dir remains a root (the forge adapter writes its bodies there)",
    );
    assert(
      roots.some((r) => within(r, repoReal)),
      "the repository is among its own admissible roots (the git top-level rule)",
    );
    assert(
      roots.every((r) => !within(r, realpathSync("/etc"))),
      "no admissible root contains /etc, which is what refuses it without opening it",
    );
    assert(
      !within(osTempReal, repoReal),
      "the fixture repository is NOT under the OS temp dir, so only the git top-level can admit it",
    );

    // Dirty text under the repo's scratch dir: admitted AND read AND scanned.
    const dirty = path.join(issueDir, "body.md");
    writeFileSync(dirty, `host = ${TERM}\n`, "utf8");
    const refused = await call(`gh pr create --title t --body-file ${dirty}`, { cwd: repo });
    assert(
      refused?.block === true,
      "a body file under <repo>/tmp/issue-N with a private term is refused",
    );
    assert(
      (refused?.reason ?? "").includes("denylist line 2"),
      "and it is refused because the file was READ — the refusal names the denylist line",
    );
    assert(
      !(refused?.reason ?? "").toLowerCase().includes("outside"),
      "and not merely refused on its path",
    );

    // The same path with clean text is allowed: admission is about the root, not
    // about whether the file exists or what it says.
    const clean = path.join(issueDir, "clean.md");
    writeFileSync(clean, "a perfectly ordinary PR body\n", "utf8");
    const cleanProbe = await call(`gh pr create --title t --body-file ${clean}`, { cwd: repo });
    assert(
      cleanProbe === undefined,
      "a clean body file under the repository scratch dir is allowed",
    );

    // /etc/passwd remains refused and is NEVER OPENED: the out-of-root decision is
    // made on the path, before any read, so a dirty system file and a clean one
    // produce the same sentence. That wording is the only observable difference
    // between "refused without reading" and "read it, found nothing, allowed" — a
    // hit-shaped refusal here would mean the file had been opened.
    const passwd = await call("gh pr create --title t --body-file /etc/passwd", {
      cwd: repo,
    });
    assert(passwd?.block === true, "/etc/passwd is refused as a body file");
    assert(
      (passwd?.reason ?? "").toLowerCase().includes("outside"),
      "and the refusal is the out-of-root sentence, which is only reachable without opening it",
    );
    assert(
      (passwd?.reason ?? "").includes("repository"),
      "and it names the repository as one of the admissible roots it checked against",
    );
    rmSync(fixture, { recursive: true, force: true });
  });
}

// ── 4c. `git -C` is per SEGMENT: two pushes in two trees scan two trees.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    const work = path.join(dir, "chain");
    const scanned: string[] = [];
    const execSpy = ((cmd: string, o?: { argv?: string[] }) => {
      if (o?.argv) scanned.push(o.argv.join(" "));
      return Promise.resolve({ stdout: "" });
    }) as unknown as Parameters<typeof registerPublicHygieneGuard>[1]["execFn"];
    // `git -C one push … && git -C two push …` must resolve the FIRST push to
    // `one` and the SECOND to `two`. A single answer for the whole chain gives
    // `one/two`, a directory in neither tree: the guard either scans a range
    // nobody is publishing or refuses a readable command as unreadable.
    const both = pushGitCwd(
      work,
      `git -C one ${PUSH} origin main && git -C two ${PUSH} origin main`,
    );
    assert(
      both === path.join(work, "two"),
      "the last push of a two-push chain resolves to its own -C directory",
    );
    const first = segmentCwds(
      work,
      `git -C one ${PUSH} origin main && git -C two ${PUSH} origin main`,
    );
    assert(
      first.length === 2 &&
        first[0] === path.join(work, "one") &&
        first[1] === path.join(work, "two"),
      "each segment resolves its own -C: never one/two",
    );
    // A `cd` DOES carry, because that is what a shell does with it.
    assert(
      segmentCwds(work, `cd sub && git status && git ${PUSH} origin main`).every(
        (d) => d === path.join(work, "sub"),
      ),
      "a cd moves every later segment",
    );
    // And the -C of an earlier segment must not leak into a later bare push.
    const leak = segmentCwds(work, `git -C one ${PUSH} origin main && git ${PUSH} origin main`);
    assert(leak[1] === work, "a git -C does not move the segment that did not write it");
    // The push scan itself runs in the resolved directory: an unresolvable
    // directory is an unreadable range, which the guard refuses rather than
    // passing.
    const scannedIn = await inspectWith(
      `git -C one ${PUSH} origin main && git -C two ${PUSH} origin main`,
      work,
      execSpy,
    );
    assert(
      scannedIn !== undefined,
      "a chain whose pushes name missing trees is refused, not passed",
    );
    void call;
  });
}

// ── 5. A configured-but-unreadable denylist refuses (it is not "no denylist").
{
  const notAFile = path.join(dir, "not-a-file");
  mkdirSync(notAFile, { recursive: true });
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: notAFile }, async () => {
    const call = hook();
    const r = await call(`gh issue comment 1 --body "nothing private here at all"`);
    assert(r?.block === true, "an unreadable denylist refuses a publish");
    assert(
      (r?.reason ?? "").includes("could not be checked"),
      "the refusal says the private check could not run",
    );
  });
}

// ── 6. The escape hatch: exactly 0 disables; any other value leaves it on.
{
  await withEnv({ ...denylistEnv, PI_ENSEMBLE_PUBLIC_HYGIENE: "0" }, async () => {
    const call = hook();
    assert(
      (await call(`gh issue comment 1 --body "ask ${TERM}"`)) === undefined,
      "PI_ENSEMBLE_PUBLIC_HYGIENE=0 disables every check",
    );
    assert(
      (await call(`gh issue edit 1 --body "host 10.1.2.3"`)) === undefined,
      "the hatch disables the generic set too",
    );
  });
  await withEnv({ ...denylistEnv, PI_ENSEMBLE_PUBLIC_HYGIENE: "false" }, async () => {
    const call = hook();
    const r = await call(`gh issue comment 1 --body "ask ${TERM}"`);
    assert(r?.block === true, "a non-0 value is not an off switch (only 0 disables)");
  });
}

// ── 7. The pure text check the forge seam uses (driver-authored posts).
{
  await withEnv(denylistEnv, async () => {
    const r = publicTextRefusal("pull request body", `deployed on ${TERM} yesterday`);
    assert(typeof r === "string" && r.length > 0, "the forge seam check refuses a dirty body");
    assert(!(r ?? "").includes(TERM), "and its refusal carries no term");
    assert(
      publicTextRefusal("pull request body", "deployed on the staging box") === undefined,
      "a clean driver-authored body passes the check",
    );
    await withEnv({ PI_ENSEMBLE_PUBLIC_HYGIENE: "0" }, async () => {
      assert(
        publicTextRefusal("pull request body", `${TERM} again`) === undefined,
        "the hatch disables the forge seam check as well",
      );
    });
  });
}

// ── 7b. The same seam for a DRIVER-AUTHORED COMMIT MESSAGE (#1788, PM
// decision 8). The driver's forge writes are in-process execs, so the
// tool_call hook never sees them: `forge.ts`'s `checkPublicText` is what stops
// a commit-message string the driver composes itself (a squash-subject, a
// release note) from reaching the forge with a private term in it.
{
  await withEnv(denylistEnv, async () => {
    const execed: string[] = [];
    const det = {
      forge: "github",
      host: "github.com",
      url: "https://github.com/example-owner/example-repo.git",
      source: "remote",
    } as const;
    const forge = createForge(det as never, {
      execFn: (async (_cmd: string, _opts?: unknown) => {
        execed.push(_cmd);
        return { stdout: "{}", exitCode: 0 };
      }) as never,
      cwd: dir,
    });
    const dirty = `feat(x): wire ${TERM} into the build`;
    let thrown: unknown;
    try {
      await forge.issueCreate("release notes", `commit ${dirty} to the release`);
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== undefined, "a driver-authored commit message is refused at the forge seam");
    assert(
      (thrown as Error)?.name === "PublicHygieneError",
      "as the hygiene error the driver's error paths already recognise",
    );
    const message = String((thrown as Error)?.message ?? "");
    assert(message.length > 0 && !message.includes(TERM), "and its refusal carries no term");
    assert(
      execed.length === 0,
      "nothing was execed: the check runs before the forge command, not after the post",
    );
    // And the clean counterpart, so the block is not satisfied by a seam that
    // refuses everything. The assertion is on what reached the exec, not on the
    // call resolving: a fake forge whose stdout is not a created-issue URL
    // rejects for that reason AFTER the check passed, and conflating the two
    // would report a passing seam as a refusing one.
    execed.length = 0;
    await forge
      .issueCreate("release notes", "commit feat(x): wire the build")
      .catch(() => undefined);
    assert(
      execed.length === 1,
      "a clean driver-authored message reaches the exec — the seam did not refuse it",
    );
  });
}

// ── 7c. The same seam for a MERGE COMMIT SUBJECT (#1788 round 2). A squash
// merge publishes the subject as the commit message on main, so it is a public
// text surface like a title or a body — and the merge is the one forge write
// the cycle cannot undo. The check must run BEFORE `run`, so a refused subject
// merges nothing. The assertions live in `test-forge-pr-merge-seam.ts`, which
// also runs them as its own file so the offline loop discovers them.
{
  await withEnv(denylistEnv, async () => {
    await forgePrMergeSeam(TERM, dir, createForge);
  });
}

// ── 8. The hook is registered exactly once per process (double-registration).
{
  await withEnv(denylistEnv, async () => {
    const handlers: Handler[] = [];
    const pi = {
      on(event: string, fn: Handler) {
        if (event === "tool_call") handlers.push(fn);
      },
    } as unknown as ExtensionAPI;
    resetPublicHygieneRegistrationForTests();
    registerPublicHygieneGuard(pi);
    registerPublicHygieneGuard(pi);
    registerPublicHygieneGuard(pi);
    // One hook, so the guard's exec-heavy push scan runs once per tool_call;
    // a second registration would run it twice (the #926 companion no-op
    // exists for the same reason).
    assert(
      handlers.length === 1,
      `registering three times installs exactly one hook (got ${handlers.length})`,
    );
    assert(publicHygieneInstalled(), "the process-wide flag records the registration");
    // And the installed hook still refuses, so the guard is not inert.
    const r = (await handlers[0]?.(
      { toolName: "bash", input: { command: `gh issue comment 1 --body "ask ${TERM}"` } },
      {},
    )) as { block?: boolean } | undefined;
    assert(r?.block === true, "the single installed hook is live");
    resetPublicHygieneRegistrationForTests();
  });
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);

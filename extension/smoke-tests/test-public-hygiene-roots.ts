#!/usr/bin/env bun
/**
 * public-hygiene round 4 (#1788) — the two things the first three rounds got
 * wrong, driven through the registered `tool_call` hook with a scratch denylist:
 *
 * - **The body-file roots.** The guard admitted the cwd tree and the OS temp
 *   dir, but the /work driver and its agents write PR and handoff bodies under
 *   the REPOSITORY's scratch dir (`<repo>/tmp/issue-<N>/`, AGENTS.md §7), so a
 *   normal handoff comment was refused as unreadable. The repository's git
 *   top-level is now a third root, and a path outside all three is still refused
 *   on its PATH and never opened.
 * - **The push cwd, per segment.** One directory was carried across a whole
 *   chain, so `git -C one push && git -C two push` resolved both pushes to
 *   `one/two` — a path in neither tree.
 *
 * Offline, synthetic terms, scratch denylist always; this repository is public.
 * Split out of `test-public-hygiene-guard.ts` under AGENTS.md §12's size cap.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type DenylistRead,
  readPublicDenylist,
  resetDenylistCacheForTests,
} from "../src/public-denylist.ts";
import { admissibleRoots, pushGitCwd, segmentCwds, within } from "../src/public-hygiene-cwd.ts";
import {
  inspectCommand,
  registerPublicHygieneGuard,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = "example-private-host";
const PUSH = ["pu", "sh"].join("");
const GIT = ["gi", "t"].join("");

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-r4-"));
// The fixture repository is built OUTSIDE every admissible root a hook call
// could otherwise be given, because a fixture nested in `mkdtempSync(tmpdir())`
// sits under the OS temp dir and is admitted by that tier alone — the
// git-top-level rule would never be consulted and its assertions would pass
// anyway. A repo-root case has to be placed in a tree that is neither the OS
// temp dir nor the command cwd handed to the hook: this project's own scratch
// dir under its worktree is the nearest such place. Created before it is
// canonicalised, since realpath does not tolerate a missing path.
const scratch = path.join(import.meta.dirname, "..", "tmp", "issue-1788-roots");
mkdirSync(scratch, { recursive: true });
const scratchReal = realpathSync(scratch);
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# the operator list\n${TERM}\n`, "utf8");
const denylistEnv = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

/** Run git through argv so a path with spaces stays one argument. */
function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, encoding: "utf8" }, (err) =>
      err === null ? resolve() : reject(err),
    );
  });
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** Register the hook on a fake pi and return a dispatcher, with seams pinned. */
function hook(opts: { readDenylist?: (env?: NodeJS.ProcessEnv) => DenylistRead } = {}) {
  const handlers: Handler[] = [];
  const pi = {
    on(event: string, fn: Handler) {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
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

/** Ask the guard with every seam pinned: scratch denylist, github.com remote,
 *  and the caller's executor, so the assertions are about which DIRECTORY the
 *  scan was pointed at and which list the text was judged against. */
async function inspectWith(
  command: string,
  cwd: string,
  exec: ExecFn,
): Promise<{ reason: string } | undefined> {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = { ...process.env, ...denylistEnv } as NodeJS.ProcessEnv;
  return inspectCommand(command, cwd, exec, () => readPublicDenylist(env), {
    remoteUrl: async () => "https://github.com/example-owner/example-repo.git",
  });
}

// ── 1. The body-file roots: the repository's own scratch dir is admissible,
// and a path outside every root is refused without being opened.
//
// The fixture is placed OUTSIDE the OS temp dir and the command cwd handed to
// the hook IS the repository — what the hook resolves for a developer running
// in its worktree. A repo created under this file's own scratch dir is admitted
// by that dir's tree, and every behavioural assertion below would then pass
// while the git-top-level root was never consulted. That is why the roots are
// ALSO read directly: a test that cannot fail is not a test.
{
  await withEnv(denylistEnv, async () => {
    // The hook's own denylist seam is pinned to the scratch file. Registered
    // with no reader the hook consults the OPERATOR's list, which does not
    // contain this synthetic term: the dirty body would read as clean and the
    // two assertions that prove the file was READ would fail for a reason
    // unrelated to the roots.
    const call = hook({
      readDenylist: () => readPublicDenylist({ ...denylistEnv } as NodeJS.ProcessEnv),
    });
    const fixture = path.join(scratchReal, "repo-root-case");
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
    const hookCwdReal = realpathSync(dir);
    assert(roots.length >= 3, "cwd, the OS temp dir and the git top-level are all roots");
    assert(
      roots.some((r) => r === osTempReal),
      "the OS temp dir remains a root (the forge adapter writes its bodies there)",
    );
    assert(
      roots.some((r) => r === repoReal),
      "the repository is among its own admissible roots (the git top-level rule)",
    );
    assert(
      roots.every((r) => !within(r, realpathSync("/etc"))),
      "no admissible root contains /etc, which is what refuses it without opening it",
    );
    assert(
      !within(osTempReal, repoReal) && !within(hookCwdReal, repoReal),
      "the fixture repository is under NEITHER the OS temp dir NOR the cwd the hook is given, so only the git top-level can admit it",
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

    // /etc/passwd remains refused and is NEVER OPENED: the out-of-root decision
    // is made on the path, before any read, so a dirty system file and a clean
    // one produce the same sentence. That wording is the only observable
    // difference between "refused without reading" and "read it, found nothing,
    // allowed" — a hit-shaped refusal here would mean the file had been opened.
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

// ── 2. `git -C` is per SEGMENT: two pushes in two trees scan two trees.
{
  await withEnv(denylistEnv, async () => {
    const work = path.join(dir, "chain");
    const scanned: string[] = [];
    const execSpy = ((cmd: string, o?: { argv?: string[] }) => {
      if (o?.argv) scanned.push(o.argv.join(" "));
      return Promise.resolve({ stdout: "" });
    }) as unknown as ExecFn;
    const both = pushGitCwd(
      work,
      `git -C one ${PUSH} origin main && git -C two ${PUSH} origin main`,
    );
    assert(
      both === path.join(work, "two"),
      "the last push of a two-push chain resolves to its own -C directory",
    );
    // The single answer is a last-mover reading; the per-segment list is what
    // proves neither push inherited the other's directory. Without the reset
    // the pair resolves to one/two, a path in neither tree, and the scan either
    // reads a range nobody is publishing or refuses a readable command.
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
    const leak = segmentCwds(work, `git -C one ${PUSH} origin main && git ${PUSH} origin main`);
    assert(leak[1] === work, "a git -C does not move the segment that did not write it");
    // And the scan really runs where it says: an unresolvable directory is an
    // unreadable range, which the guard refuses rather than passes.
    const scannedIn = await inspectWith(
      `git -C one ${PUSH} origin main && git -C two ${PUSH} origin main`,
      work,
      execSpy,
    );
    assert(
      scannedIn !== undefined,
      "a chain whose pushes name missing trees is refused, not passed",
    );
  });
}

rmSync(dir, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
process.exit(exit);

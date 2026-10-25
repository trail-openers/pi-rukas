#!/usr/bin/env bun
/**
 * hygiene-push-slot-reader (#1820 lens round 1, M4) — the push destination is
 * read ONCE, fail-closed, and every shape that names one is matched.
 *
 * ## The defects this file pins
 *
 * - **The verb's position was recovered by `lastIndexOf`** (`git commit -C commit
 *   -m hello`): the operand equal to the verb moved the slice, git's own `-C
 *   <commit>` fell before it, and the reuse form read as a plain commit — a
 *   fail-OPEN introduced by this branch. The verb's index now comes from the
 *   walker that knows which globals consume a follower.
 * - **`git remote` failing returned `[]`**, which the refspec reader read as
 *   "no anchor", resolved HEAD, and reported the push clean. A transport failure
 *   is now a named problem.
 * - **The destination had two walkers** (`directPushTarget` and the target
 *   resolver), which drifted on the glued `--repo=<url>` spelling: the scan never
 *   triggered and the visibility question was answered from the clone's remote.
 * - **`github.com:owner/repo.git`** — a URL git resolves, with no `user@` — was
 *   not a URL to this guard, so a push to it was never scanned.
 *
 * ## What must NOT regress
 *
 * A refspec (`HEAD:refs/heads/x`, `features/foo`) is still not a destination; a
 * local path is still not one; a `+`-prefixed remote is still not stripped (git
 * rejects `+origin` as a remote name — verified against git 2.x — so stripping it
 * here would resolve a command git refuses); `--repo <name>` as a separate-word
 * operand still does not occupy the slot.
 *
 * Offline, synthetic hosts and terms only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRemoteUrl } from "../src/forge-detect.ts";
import { commitMessageReuse } from "../src/public-hygiene-commit-reuse.ts";
import {
  PUSH_VALUE_OPTIONS,
  looksLikeRemoteUrl,
  parsePushUrlTarget,
  pushOptionGluedValue,
  pushRemoteName,
} from "../src/public-hygiene-remote.ts";
import { pushRefspecs } from "../src/public-hygiene-refspecs.ts";
import { scanPushRange } from "../src/public-hygiene-push.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "push-slot-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# synthetic\n${TERM}\n`, "utf8");

const PUSH = "push";
const REMOTES = new Set(["origin"]);
const GITHUB_URL = "https://github.com/example-owner/example-repo.git";
const PRIVATE_FORGE = "https://git.internal.example/org/private-repo.git";

const argvOf = (command: string): string[] => command.split(" ");

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath }, async () => {
  resetVisibilityCacheForTests();

  // ── (a) the verb's position comes from the walker, not lastIndexOf ────────
  assert(
    commitMessageReuse(argvOf("git commit -C HEAD -m commit")) === true,
    "git commit -C HEAD -m commit is a reuse form (an operand equal to the verb does not move the slice)",
  );
  assert(
    commitMessageReuse(argvOf("git commit -C commit -m hello")) === true,
    "git commit -C commit -m hello is a reuse form — the adversarial repro: lastIndexOf used to land on the operand and read this as a plain commit",
  );
  assert(
    commitMessageReuse(argvOf("git commit -m x commit -C HEAD")) === true,
    "git commit -m x commit -C HEAD is a reuse form (the verb is the first, not the last, such word)",
  );
  assert(
    commitMessageReuse(argvOf("git -C /x/commit commit -m x")) === false,
    "git -C /x/commit commit -m x is NOT a reuse form (a path that ends in the verb is git's, not commit's)",
  );
  assert(
    commitMessageReuse(argvOf("git --work-tree /x commit -m x")) === false,
    "git --work-tree /x commit -m x is NOT a reuse form — the long globals consume their follower too",
  );
  assert(
    commitMessageReuse(argvOf("git --git-dir /x/.git commit -m x")) === false,
    "git --git-dir /x/.git commit -m x is NOT a reuse form",
  );
  assert(
    commitMessageReuse(argvOf("docker run img commit -C HEAD")) === true,
    "a command that is not git still fails closed",
  );
  assert(
    commitMessageReuse(argvOf("/usr/bin/git commit --squash=abc -m x")) === true,
    "a path-qualified git program is still git",
  );
  assert(
    commitMessageReuse(argvOf("./mygit commit -C HEAD")) === true,
    "a program whose BASENAME is not git is not read as a commit at all, so it fails closed",
  );

  // ── (d) scp-like URLs without a user are URLs ─────────────────────────────
  assert(
    looksLikeRemoteUrl("github.com:owner/repo.git"),
    "host:path with no user@ is a remote URL",
  );
  assert(
    JSON.stringify(parsePushUrlTarget("github.com:owner/repo.git")) ===
      JSON.stringify({ host: "github.com", owner: "owner", repo: "repo" }),
    "…and it parses to the same target as the user@ spelling",
  );
  assert(
    JSON.stringify(parsePushUrlTarget("git@github.com:o/r.git")) ===
      JSON.stringify(parsePushUrlTarget("github.com:o/r.git")),
    "both scp spellings resolve to the same target through the push reader",
  );
  assert(
    parseRemoteUrl("github.com:o/r.git") === undefined,
    "the forge detector's shared parser is UNWIDENED: the bare host:path form is a " +
      "push-slot concern, not a forge-detection claim about every clone's remote URL",
  );
  assert(!looksLikeRemoteUrl("HEAD:refs/heads/x"), "a refspec is not a URL");
  assert(!looksLikeRemoteUrl("features/foo"), "a bare branch name is not a URL");
  assert(!looksLikeRemoteUrl("/srv/bare/repo"), "a local path is not a URL");
  assert(
    pushRemoteName(["git", PUSH, "github.com:owner/repo.git", "main"], PUSH, REMOTES) ===
      "github.com:owner/repo.git",
    "…and it occupies the remote slot",
  );

  // ── PM item (2): the glued `--repo=<value>` spelling ──────────────────────
  assert(
    pushRemoteName(["git", PUSH, "--repo=https://github.com/o/r.git", "main"], PUSH, REMOTES) ===
      "https://github.com/o/r.git",
    "--repo=<url> is the destination, not an option to skip",
  );
  assert(
    pushRemoteName(["git", PUSH, "--repo=origin", "main"], PUSH, REMOTES) === "origin",
    "--repo=<configured remote> names that remote",
  );
  assert(
    pushRemoteName(["git", PUSH, "--repo", "other", "origin", "main"], PUSH, REMOTES) === "origin",
    "the separate-word --repo still swallows its operand",
  );
  assert(
    pushOptionGluedValue("--exec=/bin/receive-pack") === undefined,
    "a glued --exec= is an option value, never a destination",
  );
  for (const f of ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]) {
    assert(PUSH_VALUE_OPTIONS.has(f), `${f} is a value-taking push option`);
  }
  const gluedRefspecs = pushRefspecs(
    ["git", PUSH, "--repo=https://github.com/o/r.git", "feature/x"],
    PUSH,
    REMOTES,
  );
  assert(
    gluedRefspecs.refspecs.length === 1 && gluedRefspecs.refspecs[0] === "feature/x",
    `pushRefspecs does not read a glued option's value as the anchor (got ${JSON.stringify(gluedRefspecs.refspecs)})`,
  );
  const gluedOpt = pushRefspecs(["git", PUSH, "origin", "-o=ci.skip", "main"], PUSH, REMOTES);
  assert(
    gluedOpt.refspecs.length === 1 && gluedOpt.refspecs[0] === "main",
    `-o=<value> glued is one word and not a refspec (got ${JSON.stringify(gluedOpt.refspecs)})`,
  );

  // ── (e) a `+` prefix is NOT stripped from the remote slot ─────────────────
  // Verified against git 2.x: `git ls-remote +origin2` and `git ls-remote
  // +/path/to/bare` both fail with "does not appear to be a git repository", so
  // git rejects a `+`-prefixed remote rather than treating it as a force-prefixed
  // destination. Stripping it would make this reader resolve a command git
  // refuses, so the guard leaves it unmatched and fails closed instead.
  assert(
    pushRemoteName(["git", PUSH, "+origin", "main"], PUSH, REMOTES) === "origin",
    "a +-prefixed word is not adopted as the remote (git itself rejects it, so the reader must not invent it)",
  );
  assert(
    pushRemoteName(["git", PUSH, "+https://github.com/o/r.git", "main"], PUSH, REMOTES) ===
      "https://github.com/o/r.git" ||
      pushRemoteName(["git", PUSH, "+https://github.com/o/r.git", "main"], PUSH, REMOTES) ===
        "origin",
    "a +-prefixed URL is either the URL or the default — never a bare `+https:…` handed on as a name",
  );

  // ── (b) a `git remote` that fails is a problem, never a clean scan ────────
  const failingRemotes: ExecFn = async (cmd, opts) => {
    const argv = opts?.argv ?? [];
    if (argv[0] === "remote" && argv.length === 1) throw new Error("git: broken pipe");
    if (argv[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n` };
    if (argv[0] === "log") return { stdout: "" };
    return { stdout: "" };
  };
  const broken = await scanPushRange({
    exec: failingRemotes,
    cwd: dir,
    command: `git ${PUSH} origin main`,
    pushVerb: PUSH,
  });
  assert(
    broken.scanned === false &&
      broken.problems.some((p) => p.reason.includes("remotes could not be read")),
    `a push whose \`git remote\` fails reports a named problem, not a clean scan (got ${JSON.stringify(broken)})`,
  );

  // A push-to-URL is unaffected by an unreadable remote list: the command carries
  // its own destination.
  const urlPush = await scanPushRange({
    exec: failingRemotes,
    cwd: dir,
    command: `git ${PUSH} ${GITHUB_URL} main`,
    pushVerb: PUSH,
  });
  assert(
    !urlPush.problems.some((p) => p.reason.includes("remotes could not be read")),
    `a push-to-URL does not depend on the clone's remotes (got ${JSON.stringify(urlPush.problems)})`,
  );

  // ── the glued `--repo=<url>` push reaches the public-host decision ────────
  const glued = await scanPushRange({
    exec: failingRemotes,
    cwd: dir,
    command: `git ${PUSH} --repo=${GITHUB_URL} main`,
    pushVerb: PUSH,
  });
  assert(
    !glued.problems.some((p) => p.reason.includes("remotes could not be read")),
    `--repo=<github url> is treated as a push to the public host, so the clone's remotes are not consulted (got ${JSON.stringify(glued.problems)})`,
  );
  const gluedPrivate = await scanPushRange({
    exec: failingRemotes,
    cwd: dir,
    command: `git ${PUSH} --repo=${PRIVATE_FORGE} main`,
    pushVerb: PUSH,
  });
  assert(
    gluedPrivate.scanned === false && gluedPrivate.problems.length === 0,
    `a glued --repo= to a non-github host is not scanned (got ${JSON.stringify(gluedPrivate)})`,
  );

  // ── a `file://` push keeps its current behaviour: refused, not excused ───
  const fileProbe: ExecFn = async (_cmd, opts) => {
    const argv = opts?.argv ?? [];
    if (argv[0] === "remote" && argv.length === 1) return { stdout: "origin\n" };
    if (argv[0] === "remote" && argv[1] === "get-url") return { stdout: GITHUB_URL + "\n" };
    if (argv[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n` };
    if (argv[0] === "log") return { stdout: `${"b".repeat(40)}\t${TERM}\u001e\n` };
    if (argv[0] === "diff") return { stdout: "" };
    return { stdout: "" };
  };
  const filePush = await scanPushRange({
    exec: fileProbe,
    cwd: dir,
    command: `git ${PUSH} file:///srv/other/repo.git main`,
    pushVerb: PUSH,
  });
  assert(
    filePush.texts.length > 0 || filePush.problems.length > 0,
    `a file:// push is READ (its commits scanned or a problem named), never excused as "not the public forge" (got ${JSON.stringify(filePush)})`,
  );
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);

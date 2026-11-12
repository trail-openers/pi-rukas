#!/usr/bin/env bun
/**
 * #2181 — the merge-author allowlist read against REAL git.
 *
 * Every other arm of this gate drives a stubbed executor, and that is precisely how
 * the symlink hole survived review: the stub was told the type was `symlink`, while
 * real git answers `cat-file -t` with `blob` for a committed symlink, because in the
 * object database a symlink IS a blob. The type is in the tree entry's MODE, and only
 * `git ls-tree` prints it. So this file runs the reader at a real base commit, with no
 * stubbed exec anywhere — the shapes below are what git actually produces.
 *
 *   1. absent file          → the repository never opted in; the gate is not applied;
 *   2. present, allowlisted → allowed;
 *   3. empty after comments → refused;
 *   4. a committed symlink  → refused (the defect: the old probe said `blob`);
 *   5. a directory          → refused;
 *   6. an unresolvable base → refused, never read as absence.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MERGE_AUTHORS_FILE, readMergeAuthorAllowlist } from "../src/merge-author-allowlist.ts";
import { spawnSync } from "node:child_process";
import { gitTestEnv, trackedTempDir } from "./lib/git-test-env.ts";
import { execp } from "../src/exec.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The exec seam's production shape: `execp`, the same one every merge path uses. */
const exec = execp;

const ALLOWED_LOGIN = "alice";

/**
 * A real repository at a real base commit, whose `.pi/` holds whatever the case asks
 * for. `kind` is the on-disk shape; git is what turns it into a tree entry.
 */
function buildRepo(kind: "absent" | "file" | "empty" | "symlink" | "directory"): {
  root: string;
  baseSha: string;
} {
  const root = trackedTempDir("merge-author-realgit-");
  const git = (...args: string[]) => {
    const child = spawnSync("git", args, { cwd: root, env: gitTestEnv() });
    if (child.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${child.stderr?.toString().slice(0, 200) ?? ""}`);
    }
    return child.stdout.toString();
  };
  git("init", "-b", "main");
  git("config", "user.email", "gate@test.invalid");
  git("config", "user.name", "Merge author real-git test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  mkdirSync(join(root, ".pi"), { recursive: true });
  switch (kind) {
    case "file":
      writeFileSync(join(root, MERGE_AUTHORS_FILE), `# maintainers\n${ALLOWED_LOGIN}\n`);
      break;
    case "empty":
      writeFileSync(join(root, MERGE_AUTHORS_FILE), "# a comment and nothing else\n\n");
      break;
    case "symlink":
      // A committed symlink: the object is a blob, so `cat-file -t` says `blob`.
      writeFileSync(join(root, ".pi", "elsewhere.txt"), "randomm\njanit\n");
      symlinkSync("elsewhere.txt", join(root, MERGE_AUTHORS_FILE));
      break;
    case "directory":
      mkdirSync(join(root, MERGE_AUTHORS_FILE), { recursive: true });
      writeFileSync(join(root, MERGE_AUTHORS_FILE, "alice"), "alice\n");
      break;
    case "absent":
      break;
  }
  git("add", "-A");
  git("commit", "-m", "chore: base");
  return { root, baseSha: git("rev-parse", "HEAD").trim() };
}

/** The reader's verdict rendered for the assertion message. */
function said(read: Awaited<ReturnType<typeof readMergeAuthorAllowlist>>): string {
  return read.ok ? `ok (${read.logins.join(",")})` : `${read.reason}: ${read.detail ?? ""}`;
}

// ---------------------------------------------------------------- 1. absent → opt-out
{
  const { root, baseSha } = buildRepo("absent");
  const read = await readMergeAuthorAllowlist(exec, root, baseSha);
  assert(
    read.ok === false && read.reason === "absent",
    `absent gate file reports the repository never opted in (${said(read)})`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------- 2. present → allowlisted author
{
  const { root, baseSha } = buildRepo("file");
  const read = await readMergeAuthorAllowlist(exec, root, baseSha);
  assert(
    read.ok === true && read.set.has(ALLOWED_LOGIN),
    `a committed allowlist is read from real git (${said(read)})`,
  );
  assert(
    read.ok === true && read.set.has("bob") === false,
    "…and holds only the logins the file names",
  );
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------- 3. empty → refuse
{
  const { root, baseSha } = buildRepo("empty");
  const read = await readMergeAuthorAllowlist(exec, root, baseSha);
  assert(
    read.ok === false && read.reason === "empty",
    `a gate file that names nobody refuses (${said(read)})`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ----------------------------------------------------------- 4. committed symlink → refuse
{
  const { root, baseSha } = buildRepo("symlink");
  const read = await readMergeAuthorAllowlist(exec, root, baseSha);
  assert(
    read.ok === false && /symlink/i.test(read.detail ?? ""),
    `a committed symlink is refused, naming itself (${said(read)})`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. directory → refuse
{
  const { root, baseSha } = buildRepo("directory");
  const read = await readMergeAuthorAllowlist(exec, root, baseSha);
  assert(
    read.ok === false && read.reason === "not-a-blob",
    `a directory at the gate path refuses as a tree (${said(read)})`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------- 6. unresolvable base → refuse, not absent
{
  const { root, baseSha } = buildRepo("file");
  const gone = "0000000000000000000000000000000000000000";
  assert(gone.length === baseSha.length, "the bogus base is sha-shaped so the sha gate passes");
  const read = await readMergeAuthorAllowlist(exec, root, gone);
  assert(
    read.ok === false && read.reason !== "absent",
    `a base git cannot resolve refuses rather than reporting an opt-out (${said(read)})`,
  );
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

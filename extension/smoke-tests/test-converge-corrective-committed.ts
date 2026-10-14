/**
 * #1203 — a corrective round that COMMITS its work is not an empty
 * round. The post-corrective probe used to read `git status --porcelain`
 * alone, so a child that did what the developer prompt asks (commit) left a
 * clean tree, was logged "left no tree changes", and its verify re-run was
 * skipped. The probe now also compares HEAD against its pre-dispatch value.
 * Runs against a real repository.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { correctiveChange } from "../src/work-driver-converge-gate.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const repo = mkdtempSync(path.join(tmpdir(), "converge-corrective-"));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const ctx = { repoRoot: repo } as unknown as DriverContext;
try {
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "a.sh"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "seed");
  const before = git("rev-parse", "HEAD");

  assert(
    (await correctiveChange(ctx, repo, before)) === "unchanged",
    "clean tree, HEAD where it was → unchanged (the re-run may be skipped)",
  );

  writeFileSync(path.join(repo, "a.sh"), "two\n");
  assert(
    (await correctiveChange(ctx, repo, before)) === "changed",
    "uncommitted edit → changed",
  );

  git("commit", "-q", "-am", "corrective work");
  assert(git("status", "--porcelain") === "", "fixture: the tree is clean after the commit");
  assert(
    (await correctiveChange(ctx, repo, before)) === "changed",
    "committed work on a clean tree → changed (the gates re-run)",
  );

  git("commit", "-q", "--amend", "-m", "corrective work, amended");
  assert(
    (await correctiveChange(ctx, repo, before)) === "changed",
    "an amended commit still reads as changed",
  );

  assert(
    (await correctiveChange(ctx, repo, undefined)) === "unknown",
    "clean tree with an unreadable pre-dispatch HEAD → unknown (re-run, never skip)",
  );
  assert(
    (await correctiveChange(ctx, undefined, before)) === "unknown",
    "no probe directory → unknown",
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

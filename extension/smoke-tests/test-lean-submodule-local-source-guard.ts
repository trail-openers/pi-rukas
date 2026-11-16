#!/usr/bin/env bun
/**
 * lean/submodule-entries — `localSource` refuses every source that is not the operator's.
 *
 * The seeding's whole safety case rests on one function answering "where do these bytes live"
 * with a path inside the SUPERPROJECT. The suites that drive a whole run assert the positive —
 * the submodule arrived — and a positive survives any widening of this function, because a run
 * that seeded from the wrong place still ends with a populated directory. So each rule below is
 * tested against the source it exists to refuse, and each was confirmed to go RED when its own
 * guard is deleted: a case that cannot fail is not a rule.
 *
 * The three refusals, and what each one makes possible if the RULE behind it is missing. Each
 * rule is a pair of guards that back each other up, so deleting only one half stays green — the
 * cases below delete what the rule needs to hold, and each was confirmed RED when the whole rule
 * is removed and the partner guard cannot catch it. A single-deletion green is defence-in-depth,
 * not a dead guard; deleting both halves of any rule below must go red:
 *
 *   - the run's own tree as the superproject, or nested inside it as the source's parent: a
 *     submodule the run added on its own branch is filed under this tree's gitdir, invisible to
 *     `clean -fdx`, so the child's own unverified bytes would be reported as `seeded`;
 *   - a module store filed under the run's gitdir while the superproject is elsewhere: the same
 *     self-seed reached by way of a git dir rather than a path;
 *   - `..`, `.` and absolute segments in a submodule's registered path: `.gitmodules` is content
 *     of the base, so an entry named `../elsewhere` is a base asking the harness to read outside
 *     the superproject — the finished answer is held to containment AFTER resolution, because
 *     `path.join` preserves `..` and the segment filter alone left the one-level case open.
 *
 * `localSource` is pure and synchronous: it takes the superproject, the git dirs and the run tree
 * as arguments and answers with a path or nothing. Every case here therefore hands it the exact
 * shape a hostile base would produce and reads the answer, rather than driving git and inferring.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localSource } from "../src/lean/submodule-entries.ts";
import { trackedTempDir } from "./lib/git-test-env.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { gitEnv } from "./lib/lean-submodule-local-fixture.ts";

const { assert, failures } = makeAssert();

/** Make a directory, failing loudly — a fixture that half-built is worse than one that throws. */
function dir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Write `text` at `file`, making parents, and return the path. */
function file(file: string, text = "x\n"): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/**
 * A tree that looks like a module store: git's one requirement for calling a directory a
 * repository is `objects`.
 */
function storeAt(gitDir: string, sub: string): string {
  const store = path.join(gitDir, "modules", ...sub.split("/"));
  dir(path.join(store, "objects"));
  return store;
}

/** A real git dir, so a refusal cannot be blamed on a fixture that built nothing. */
function git(dirPath: string): void {
  const r = spawnSync("git", ["init", "-q", "-b", "main", dirPath], { env: gitEnv() });
  if (r.status !== 0) throw new Error(`git init ${dirPath}: ${(r.stderr ?? "").trim()}`);
}

// ── (a) the run's own tree is never the source, whichever way it is offered
{
  const root = trackedTempDir("local-source-run-");
  const superRoot = dir(path.join(root, "super"));
  git(superRoot);
  const wt = dir(path.join(superRoot, ".worktrees", "lean-7"));
  const sub = "vendor/lib";
  // A real source exists in both places, so a widening produces a WRONG ANSWER rather than a
  // missing one — the only kind of defect a positive-path suite cannot see.
  const superStore = storeAt(path.join(superRoot, ".git"), sub);
  const runStore = storeAt(path.join(wt, ".git"), sub);

  const dirs = [path.join(superRoot, ".git"), path.join(wt, ".git", "worktrees", "lean-7")];
  const got = localSource(superRoot, dirs, sub, { wt });
  assert(
    got === superStore,
    `(a) the source is the SUPERPROJECT's store, not the run's (got ${String(got)}, want ${superStore})`,
  );

  // Same run tree, offered as the superproject itself: the field bug was `--show-toplevel`
  // answering with the linked worktree, which makes the run tree the source it seeds from.
  const self = localSource(wt, [path.join(wt, ".git")], sub, { wt });
  assert(
    self === undefined,
    `(a) and a run tree asked to seed ITSELF gets no source at all (got ${String(self)})`,
  );

  // And as the source's PARENT: a superproject that resolves to a directory INSIDE the run tree
  // is a directory this run made, so it cannot be what the base's verify ran against. The tree
  // here is a real repository holding a real store — if it were merely absent, the assertion
  // below would pass without the containment rule ever firing.
  // Nested one level below the run tree's root, so the containment branch is the code that
  // decides the answer: were it deleted, the guard's earlier `runTree === super` test would
  // still be false here and only containment stands between this run and seeding from bytes
  // the run itself created.
  const nestedRoot = dir(path.join(wt, "a", "nest"));
  git(nestedRoot);
  const nestedStore = storeAt(path.join(nestedRoot, ".git"), sub);
  const asParent = localSource(nestedRoot, [path.join(nestedRoot, ".git")], sub, { wt });
  assert(
    asParent === undefined,
    `(a) and a superproject INSIDE the run tree is refused even when it really holds a store (got ${String(asParent)}, store really present: ${String(existsSync(nestedStore))})`,
  );
  assert(
    existsSync(runStore),
    "(a) the run's store really was there to be chosen — a refusal of nothing would pass too",
  );
}

// ── (b) a store filed under the run tree is skipped even when a legitimate superproject exists
{
  const root = trackedTempDir("local-source-dirs-");
  const superRoot = dir(path.join(root, "super"));
  git(superRoot);
  const wt = dir(path.join(root, "outside", "lean-9"));
  const sub = "vendor/lib";
  // Only the run tree holds the objects: the honest answer is "nothing", because the one copy
  // on this host is the run's own and cannot vouch for itself.
  const runStore = storeAt(path.join(wt, ".git"), sub);
  const got = localSource(superRoot, [path.join(wt, ".git")], sub, { wt });
  assert(
    got === undefined,
    `(b) a module store under the run's gitdir is not admitted as a source (got ${String(got)}, store really present: ${String(existsSync(runStore))})`,
  );
  // The same dirs, with the superproject's store present: the run's store must not win the race.
  const superStore = storeAt(path.join(superRoot, ".git"), sub);
  const both = localSource(superRoot, [path.join(wt, ".git"), path.join(superRoot, ".git")], sub, {
    wt,
  });
  assert(
    both === superStore,
    `(b) and the superproject's store wins when both exist (got ${String(both)}, want ${superStore})`,
  );
}

// ── (c) a submodule path cannot walk out of the superproject
{
  const root = trackedTempDir("local-source-traversal-");
  const superRoot = dir(path.join(root, "super"));
  git(superRoot);
  const wt = dir(path.join(superRoot, ".worktrees", "lean-11"));
  // The victim: a real store reachable only by escaping the superproject, holding a file the
  // superproject does not have. If a `..` segment were honoured, the seeding would name this.
  const outside = dir(path.join(root, "outside"));
  const escapee = storeAt(path.join(outside, ".git"), "etc");
  file(path.join(outside, "HEAD"), "ref: refs/heads/main\n");

  const dirs = [path.join(superRoot, ".git")];
  for (const [name, sub] of [
    ["parent-escaping", "../outside"],
    ["doubly parent-escaping", "../../outside"],
    ["absolute", "/etc"],
    ["dot", "."],
    ["empty", ""],
    ["slashes only", "///"],
  ] as const) {
    const got = localSource(superRoot, dirs, sub, { wt });
    assert(
      got === undefined || path.resolve(superRoot, sub).startsWith(superRoot + path.sep),
      `(c) a ${name} submodule path (${JSON.stringify(sub)}) is never answered with a path outside the superproject (got ${String(got)})`,
    );
  }
  // The specific escape the filter exists for, asserted against the artefact rather than a shape.
  const escaped = localSource(superRoot, dirs, "../outside", { wt });
  assert(
    escaped === undefined || !escaped.startsWith(outside),
    `(c) and no answer names the escapee store that really exists at ${escapee} (got ${String(escaped)})`,
  );
  assert(
    existsSync(path.join(escapee, "objects")),
    "(c) the escapee really is a store, so `undefined` is a refusal and not an absent target",
  );
}

// ── (c2) a git dir named OUTSIDE the superproject cannot smuggle a store in past containment
//
// The `..` filter never sees this: the registered path is a clean `vendor/lib`, and the escape
// comes from the CALLER handing `localSource` a git dir outside the superproject (a stray
// GIT_DIR, a probe that echoed a different tree). The module-store branch is the only way in, and
// its containment test is the sole guard — no other check rejects it — so this is the case that
// makes that guard load-bearing rather than decoration.
{
  const root = trackedTempDir("local-source-outside-dir-");
  const superRoot = dir(path.join(root, "super"));
  git(superRoot);
  const wt = dir(path.join(superRoot, ".worktrees", "lean-21"));
  const sub = "vendor/lib";
  // A store that lives under a git dir OUTSIDE the superproject; the checkout branch cannot be
  // blamed because the superproject holds no such path.
  const foreign = dir(path.join(root, "foreign"));
  const foreignStore = storeAt(foreign, sub);
  const got = localSource(superRoot, [foreign], sub, { wt });
  assert(
    got === undefined,
    `(c2) a store reached through a git dir outside the superproject is refused (got ${String(got)}, foreign store really present: ${String(existsSync(foreignStore))})`,
  );
  assert(
    existsSync(path.join(foreignStore, "objects")),
    "(c2) the foreign store really exists, so this is the containment guard refusing, not an absent target",
  );
}

// ── (d) the positive path still answers, so the refusals above are refusals and not silence
{
  const root = trackedTempDir("local-source-positive-");
  const superRoot = dir(path.join(root, "super"));
  git(superRoot);
  const sub = "vendor/lib";
  const store = storeAt(path.join(superRoot, ".git"), sub);
  const got = localSource(superRoot, [path.join(superRoot, ".git")], sub, {
    wt: path.join(superRoot, ".worktrees", "lean-13"),
  });
  assert(got === store, `(d) a legitimate superproject store is still found (got ${String(got)})`);
  // The checkout form, with no store anywhere: git's `HEAD`/`.git` is what marks it a repository.
  const checkout = dir(path.join(superRoot, "vendor", "other"));
  file(path.join(checkout, "HEAD"), "ref: refs/heads/main\n");
  const viaCheckout = localSource(superRoot, [path.join(superRoot, ".git")], "vendor/other", {
    wt: path.join(superRoot, ".worktrees", "lean-13"),
  });
  assert(
    viaCheckout === checkout,
    `(d) and a populated superproject checkout is found too (got ${String(viaCheckout)})`,
  );
}

process.exit(failures() === 0 ? 0 : 1);

#!/usr/bin/env bun
/**
 * #2200, the redirected-`TMPDIR` rows: a machine whose temp root sits under a THIRD tree —
 * neither `$HOME` nor `/` — that also holds the checkout. The shape an operator gets when they
 * park scratch at `~/scratch/machinetmp`, and the shape `#2200`'s own incident ran on, where a
 * redirected temp root lived under a scratch tree that held other runs too.
 *
 * The ancestor walk of `forbiddenWorkingDirectories` adds a temp root's PARENT for its whole
 * subtree, which is right for the tree the machine really keeps its scratch in (a child standing
 * there reaches a sibling run's temp dir with `rm -rf ..`) and wrong for any ancestor a redirected
 * `TMPDIR` brings with it: there the parent is an ordinary directory that legitimately holds
 * checkouts, and closing its subtree silently takes the `ops` carve-out — `rm -rf dist`,
 * `rm -rf node_modules` where the role stands — off every checkout under it. Failing closed is
 * the safe direction for the guard, so this is a usability regression rather than an escape, and
 * it is invisible to the rows that pin the carve-out through the file-pinned host: there the
 * temp root's parent IS `$HOME`, which the walk's two hard exemptions already cover.
 *
 * So `HOME`/`TMPDIR` here name a tree of their OWN rather than the pinned host's: under the host
 * the whole fixture sits beneath the home, and a refusal of `$HOME`-as-itself would decide these
 * rows before the walk got asked. Nothing here deletes anything — the rows call the judge.
 *
 * Run: cd extension && bun smoke-tests/test-write-fence-deletion-scratch-tmp-2200.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deletionRootsFrom,
  firstDeletionOutside,
} from "../src/write-fence-deletion.ts";
import {
  assert,
  exit,
} from "./lib/write-fence-deletion-harness.ts";
import { withDeletionHost } from "./lib/write-fence-deletion-fixture.ts";

// The rows build their trees OUTSIDE the machine's temp tree — `<repoRoot>/tmp/issue-<N>/`, the
// layout the dispatcher names for scratch, which no temp rule recognises. The reason is the walk
// itself: the process's own temp root is refused for its WHOLE subtree (a child standing in it
// reaches a sibling run's dir with `rm -rf ..`), so a scratch layout parked inside it would have
// that refusal decide every row here before the redirect under test got asked. `HOME` and `TMPDIR`
// are pinned for the file (the rule reads both off `process.env` behind a row's back — `os.homedir()`
// and the seed of the walk) and written out again per row, so a verdict is a function of the row's
// own env object alone.
const scratchParent = path.join(import.meta.dirname, "..", "..", "tmp", "issue-2200");
mkdirSync(scratchParent, { recursive: true });
const host = mkdtempSync(path.join(scratchParent, "scratchtmp-host-"));
process.on("exit", () => rmSync(host, { recursive: true, force: true }));
await withDeletionHost({ HOME: host, TMPDIR: path.join(host, "proctmp") }, async () => {
  mkdirSync(path.join(host, "proctmp"), { recursive: true });
  const scratchTree = path.join(host, "scratch");
  const machineTmp = path.join(scratchTree, "machinetmp");
  const seed = path.join(machineTmp, "pi-rukas-Q1"); // the per-child dir a spawn hands the walk
  const checkout = path.join(scratchTree, "projects", "repo");
  for (const dir of [machineTmp, seed, checkout]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(seed, "prompt.txt"), "x");
  writeFileSync(path.join(machineTmp, "other-run-payload"), "x");

  const HOST_ENV = { PI_ENSEMBLE_ROLE: "ops", HOME: host, TMPDIR: machineTmp };

  {
    // The finding's row, verbatim in shape: `TMPDIR=<scratch>/machinetmp`, cwd
    // `<scratch>/projects/repo`, seeded the way a spawn seeds it. The carve-out must stay OPEN.
    const roots = deletionRootsFrom(HOST_ENV, checkout, () => seed);
    assert(
      roots.allowed.length === 1 &&
        firstDeletionOutside("rm -rf dist", roots) === undefined &&
        firstDeletionOutside("rm -rf node_modules", roots) === undefined,
      `scratch-tmp: an ops checkout beside a redirected temp root keeps its carve-out (got ${JSON.stringify(roots.allowed)})`,
    );
    // …and the refusal that must NOT be bought back by keeping it open: the temp root's own
    // subtree, the tree holding it, and the parent the command reaches with `rm -rf ..`. Were the
    // walk simply dropped, the row above would stay green and these would go red.
    assert(
      firstDeletionOutside("rm -rf ..", roots) !== undefined &&
        firstDeletionOutside(`rm -rf ${machineTmp}/victim`, roots) !== undefined &&
        firstDeletionOutside(`rm -rf ${scratchTree}`, roots) !== undefined &&
        firstDeletionOutside(`rm -rf ${host}`, roots) !== undefined,
      "scratch-tmp: and that checkout still cannot delete the temp root, the tree holding it, or $HOME",
    );
  }
  {
    // The same redirect judged without the spawn's seed at all: the redirected root contributes
    // its own root and never an ancestor, so the carve-out does not depend on what the caller
    // happened to inject.
    const roots = deletionRootsFrom(HOST_ENV, checkout);
    assert(
      roots.allowed.length === 1 && firstDeletionOutside("rm -rf dist", roots) === undefined,
      "scratch-tmp: the carve-out holds with no per-child seed to climb from either",
    );
    assert(
      firstDeletionOutside(`rm -rf ${machineTmp}/other-run-payload`, roots) !== undefined,
      "scratch-tmp: and a delete of another run under that redirected root is still refused",
    );
  }
  {
    // The other direction, so the row above cannot be satisfied by exempting the whole scratch
    // tree: a cwd the dispatch parked INSIDE the redirected temp root is no one's working
    // directory — `rm -rf ..` there is the shared root itself.
    const insideTmp = deletionRootsFrom(HOST_ENV, path.join(machineTmp, "wt"));
    assert(
      insideTmp.allowed.length === 0 &&
        firstDeletionOutside("rm -rf dist", insideTmp) !== undefined,
      "scratch-tmp: a cwd inside the redirected temp root is refused fail-closed",
    );
  }
  {
    // A child who is not `ops` gets nothing from any of this: the redirected temp root is not a
    // root it may delete into, whatever the walk decided about its parent.
    const dev = deletionRootsFrom(
      {
        PI_ENSEMBLE_WRITE_ROOT: checkout,
        PI_ENSEMBLE_WRITE_REPO: host,
        PI_ENSEMBLE_WRITE_SCRATCH: path.join(host, "cycle-scratch"),
        PI_ENSEMBLE_CHILD_TMP: seed,
      },
      checkout,
    );
    assert(
      firstDeletionOutside(`rm -rf ${machineTmp}`, dev) !== undefined &&
        firstDeletionOutside(`rm -rf ${scratchTree}`, dev) !== undefined &&
        firstDeletionOutside(`rm -rf ${machineTmp}/other-run-payload`, dev) !== undefined,
      "scratch-tmp: a fenced child still cannot delete the redirected temp root or the tree holding it",
    );
    assert(
      firstDeletionOutside("rm -rf dist", dev) === undefined,
      "scratch-tmp: and that child still cleans its own worktree",
    );
  }
});

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #289 — the integration lock.
 *
 * `integrate()` mutates repoRoot's checkout, index and HEAD. Two concurrent
 * groups doing that corrupt each other silently rather than loudly:
 *
 *   - `checkout -B` carries a dirty index ACROSS branches, so B's applied-but-
 *     uncommitted slice moves onto A's branch and A's commit ships B's code
 *     under A's `Fixes #N`;
 *   - `git apply --index` contends on `index.lock` and surfaces as a phantom
 *     patch conflict, routing a healthy group to handoff;
 *   - the post-commit `git rev-parse HEAD` can read a SIBLING's commit, and
 *     the worktree `reset --hard` that follows then destroys this group's work.
 *
 * None of those are hypothetical: `/work` is fire-and-forget and `ctx.isIdle()`
 * reports idle immediately after launch, so two `/work` invocations already
 * race over repoRoot today.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureGitExclude } from "../src/work-driver-branch-mechanized.ts";
import { __resetIntegrationLock, withIntegrationLock } from "../src/work-driver-integrate.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-lock-"));
mkdirSync(path.join(root, ".git", "info"), { recursive: true });

try {
  // -------------------------------------------------- mutual exclusion

  {
    __resetIntegrationLock();
    const spans: Array<{ id: string; enter: number; exit: number }> = [];
    const body = async (id: string) => {
      const enter = Date.now();
      await sleep(60);
      spans.push({ id, enter, exit: Date.now() });
    };
    await Promise.all([
      withIntegrationLock(root, () => body("a")),
      withIntegrationLock(root, () => body("b")),
      withIntegrationLock(root, () => body("c")),
    ]);

    assert(spans.length === 3, "all three critical sections ran");
    const sorted = [...spans].sort((x, y) => x.enter - y.enter);
    const overlaps = sorted.some((s, i) => i > 0 && s.enter < (sorted[i - 1]?.exit ?? 0));
    assert(!overlaps, "no two critical sections overlapped — this is the whole point");
  }

  {
    // Anti-vacuity: the same harness MUST see overlap without the lock,
    // otherwise "no overlap" proves only that the tasks never raced.
    const spans: Array<{ enter: number; exit: number }> = [];
    const body = async () => {
      const enter = Date.now();
      await sleep(60);
      spans.push({ enter, exit: Date.now() });
    };
    await Promise.all([body(), body(), body()]);
    const sorted = [...spans].sort((x, y) => x.enter - y.enter);
    const overlaps = sorted.some((s, i) => i > 0 && s.enter < (sorted[i - 1]?.exit ?? 0));
    assert(overlaps, "the same three tasks DO overlap when unlocked (the test can detect overlap)");
  }

  // ---------------------------------------------- a throw releases the lock

  {
    __resetIntegrationLock();
    await withIntegrationLock(root, async () => {
      throw new Error("integration blew up");
    }).catch(() => undefined);

    let ran = false;
    await withIntegrationLock(root, async () => {
      ran = true;
    });
    assert(ran, "a throwing integration releases the lock for the next group");
    assert(
      !existsSync(path.join(root, ".git", "pi-ensemble-integration.lock")),
      "the lockfile is removed even when the critical section throws",
    );
  }

  {
    // The chain must not inherit a prior rejection — otherwise one failed
    // integration poisons every later one for the life of the process.
    __resetIntegrationLock();
    const results: string[] = [];
    const bad = withIntegrationLock(root, async () => {
      throw new Error("first fails");
    }).catch(() => results.push("bad"));
    const good = withIntegrationLock(root, async () => {
      results.push("good");
    });
    await Promise.all([bad, good]);
    assert(results.includes("good"), "a group queued behind a FAILING integration still runs");
  }

  // ------------------------------------------------------------ lockfile

  {
    __resetIntegrationLock();
    const lockFile = path.join(root, ".git", "pi-ensemble-integration.lock");
    let sawLock = false;
    await withIntegrationLock(root, async () => {
      sawLock = existsSync(lockFile);
    });
    assert(sawLock, "the lockfile exists while the critical section runs (cross-process backstop)");
    assert(!existsSync(lockFile), "the lockfile is removed on release");
  }

  {
    // A stale lockfile must be swept, not deadlocked on — a crashed Pi
    // process would otherwise block integration forever.
    __resetIntegrationLock();
    const lockFile = path.join(root, ".git", "pi-ensemble-integration.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now() - 60 * 60 * 1000 }));
    let ran = false;
    await withIntegrationLock(root, async () => {
      ran = true;
    });
    assert(ran, "an hour-old lockfile is swept rather than deadlocked on");
  }

  {
    // A corrupt lockfile must not deadlock either.
    __resetIntegrationLock();
    const lockFile = path.join(root, ".git", "pi-ensemble-integration.lock");
    writeFileSync(lockFile, "not json at all");
    let ran = false;
    await withIntegrationLock(root, async () => {
      ran = true;
    });
    assert(ran, "an unparseable lockfile is treated as stale, not as a deadlock");
  }

  // ------------------------------------------------- atomic git exclude

  {
    // The regression: two writers, one read-then-write each. Interleaved, the
    // overwrite clobbered whatever the other had just appended.
    const excludePath = path.join(root, ".git", "info", "exclude");
    writeFileSync(excludePath, "# existing\n*.log\n");
    await Promise.all([
      ensureGitExclude(root, ["/tmp/"]),
      ensureGitExclude(root, [".worktrees/"]),
      ensureGitExclude(root, ["/tmp/"]),
      ensureGitExclude(root, [".worktrees/"]),
    ]);
    const body = readFileSync(excludePath, "utf8");
    assert(/^\/tmp\/$/m.test(body), "concurrent writers: /tmp/ survived");
    assert(/^\.worktrees\/$/m.test(body), "concurrent writers: .worktrees/ survived");
    assert(/^\*\.log$/m.test(body), "the operator's own exclude lines were preserved");
    assert(
      (body.match(/^\/tmp\/$/gm) ?? []).length === 1,
      "no duplicate lines from repeated calls (idempotent)",
    );
  }

  {
    // Fresh clone with no .git/info directory at all.
    const bare = mkdtempSync(path.join(tmpdir(), "pi-ens-lock-bare-"));
    mkdirSync(path.join(bare, ".git"), { recursive: true });
    try {
      await ensureGitExclude(bare, ["/tmp/"]);
      assert(
        readFileSync(path.join(bare, ".git", "info", "exclude"), "utf8").includes("/tmp/"),
        "creates .git/info/exclude when it does not exist",
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

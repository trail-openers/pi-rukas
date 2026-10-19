#!/usr/bin/env bun
/**
 * #1676 backstop (part 2 of 2) — the discard pass's HARDENING and its ROLLBACK.
 *
 * The pass now runs `git commit`, `git checkout` and `git rm` in a worktree the
 * developer, a lens-fix or a dependency can write. Two properties follow, and each
 * is pinned here against real git rather than asserted in prose:
 *
 *   1. the hardened argv (`SAFE_CONFIG`, shared with the #406 protected-path reads)
 *      means a worktree-written `pre-commit` cannot abort the driver's revert
 *      commit — measured: an executable `.git/hooks/pre-commit` that exits 1 DOES
 *      abort an unhardened `git commit -- <path>`, and `core.hooksPath=/dev/null`
 *      makes the same commit land;
 *   2. when a revert commit fails for a reason the guard does not cover (a conflicted
 *      index), the pass restores the path to HEAD BEFORE reporting, so a failure
 *      never leaves a half-applied discard behind.
 *
 * Plus the two refusals the pass must make before it touches anything: a deferred
 * path that is itself a symlink, and an unreadable status stream (which must never
 * read as "there was no edit").
 *
 * Part 1 (the revert/remove/rename/directory cases the develop loop reads):
 * test-discard-protected-1676.ts. Shared fixtures: lib/discard-1676-fixtures.ts.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "../src/work-develop-git.ts";
import {
  FENCE,
  discardDeferredProtectedEdits,
  git,
  makeAssert,
  realExec,
  repoAtBase,
} from "./lib/discard-1676-fixtures.ts";

let exit = 0;
const assert = makeAssert(() => {
  exit = 1;
});

// 13a. The revert commit runs with the hardened config, so a worktree-written
// pre-commit hook CANNOT block it — the `-c core.hooksPath=/dev/null` pair the
// discard's argv carries is what makes the ordinary discard succeed here.
{
  const { dir, base } = repoAtBase("pd-hard-hook-");
  writeFileSync(path.join(dir, FENCE), "dev-edit\n");
  git(dir, "commit", "-q", "-am", "dev edit to the gate");
  const hook = path.join(dir, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 0,
    "a worktree-written pre-commit hook does not block the hardened revert commit",
  );
  assert(
    readFileSync(path.join(dir, FENCE), "utf8") === "base-gate\n" &&
      git(dir, "diff", "--name-only", base, "HEAD") === "",
    "with the hook neutralised the revert commit lands and the net diff is empty",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 13a-bis. The hook really is load-bearing: the SAME hook aborts an UNHARDENED
// commit. Without this half, 13a could be passing because git never runs hooks at
// all on this platform, and the guard would be protecting nothing.
{
  const { dir } = repoAtBase("pd-hard-hook-ctl-");
  writeFileSync(path.join(dir, FENCE), "dev-edit\n");
  git(dir, "commit", "-q", "-am", "dev edit to the gate");
  const hook = path.join(dir, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(path.join(dir, FENCE), "another-edit\n");
  let blocked = false;
  try {
    git(dir, "commit", "-m", "unguarded", "--", FENCE);
  } catch {
    blocked = true;
  }
  assert(
    blocked,
    "control: the same hook DOES abort an unhardened `git commit -- <path>` — the guard is load-bearing, not decorative",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 13b. A revert commit that fails for ANOTHER reason puts the path back to HEAD and
// fails: the branch keeps the developer's commit. This is the failure the recovery
// path exists for now that hooks are neutralised by the hardened argv.
//
// The injected failure is a conflicted index — `git commit -- <path>` refuses while
// the path is unmerged ("U" stage), which is deterministic and does not depend on
// the host's git identity, gpg, or hooks. The assertion that matters is not the
// failure itself but what follows it: the path is restored to HEAD before the
// failure is reported, never left half-applied.
{
  const { dir, base } = repoAtBase("pd-hard-rollback-");
  writeFileSync(path.join(dir, FENCE), "dev-edit\n");
  git(dir, "commit", "-q", "-am", "dev edit to the gate");
  git(dir, "checkout", "-q", "-b", "side", "HEAD~1");
  writeFileSync(path.join(dir, FENCE), "side-edit\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "side edit");
  git(dir, "checkout", "-q", "-");
  // --no-ff so the merge cannot fast-forward, and conflicting content on both sides.
  // The merge exiting non-zero IS the fixture succeeding, so its error is expected.
  writeFileSync(path.join(dir, FENCE), "main-edit\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main edit");
  try {
    git(dir, "merge", "--no-ff", "--no-commit", "side", "-m", "conflicting merge");
  } catch {
    // expected: a content conflict exits 1 and leaves the conflicted index behind.
  }
  const conflicted = git(dir, "status", "--porcelain", "--", FENCE);
  if (!conflicted.startsWith("UU")) {
    assert(false, `fixture did not produce a conflict on ${FENCE}: ${JSON.stringify(conflicted)}`);
  }
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("restored to HEAD"),
    "a failed revert commit (conflicted index) is a named failure that reports the restore",
  );
  assert(
    readFileSync(path.join(dir, FENCE), "utf8") === "main-edit\n",
    "after the failed revert the worktree file is back at HEAD's content",
  );
  assert(
    git(dir, "diff", "--name-only", base, "HEAD") === FENCE,
    "the developer's commit is still on the branch",
  );
  rmSync(dir, { recursive: true, force: true });
}

// 9a. A deferred path that is ITSELF a symlink is refused: `git checkout <base> -- p`
// would write through the link, replacing the file behind it, and `rm` would
// unlink the link rather than restore tracked content.
{
  const { dir, base } = repoAtBase("pd-hard-leaf-");
  const outside = mkdtempSync(path.join(tmpdir(), "pd-hard-leaf-out-"));
  writeFileSync(path.join(outside, "victim"), "keep\n");
  // The tracked file is replaced by a symlink on disk (developer did `ln -sf`).
  rmSync(path.join(dir, FENCE));
  symlinkSync(path.join(outside, "victim"), path.join(dir, FENCE));
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: realExec,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && failures[0]?.includes("is a symlink"),
    "a deferred path that is itself a symlink is refused, not written through",
  );
  assert(
    readFileSync(path.join(outside, "victim"), "utf8") === "keep\n",
    "the file behind a symlinked leaf is untouched",
  );
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// 9b. An unreadable status stream is a named failure, never "there was no edit".
// `worktreeStatus`/`parseStatus` reject a malformed `-z` record; the discard must
// halt rather than report the path clean (the silent pass this pass exists to remove).
{
  const { dir, base } = repoAtBase("pd-hard-status-");
  writeFileSync(path.join(dir, FENCE), "dev-edit\n");
  // An executor that answers the status read with a token git would never print
  // (no `XY ` prefix), and forwards everything else to real git.
  const brokenStatus = (async (cmd: string, opts: { argv?: string[]; cwd: string }) => {
    if (opts.argv?.includes("status")) {
      return { stdout: "not-a-status-record\0", stderr: "" };
    }
    return realExec(cmd, opts);
  }) as unknown as ExecFn;
  const failures: string[] = [];
  await discardDeferredProtectedEdits({
    execFn: brokenStatus,
    worktrees: { default: dir },
    baseFor: () => base,
    deferred: [FENCE],
    protectedGrant: [],
    failures,
    notes: [],
  });
  assert(
    failures.length === 1 && /status read failed|malformed status entry/.test(failures[0] ?? ""),
    "an unreadable status stream is a named failure, not a silent 'no edit'",
  );
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

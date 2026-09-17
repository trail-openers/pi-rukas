#!/usr/bin/env bun
/**
 * Smoke test for the /work driver — committed-work-aware lens-fix detection
 * (#749, AGENTS.md §12 file-size limit), ref-collision case.
 *
 * Companion of test-work-driver-lens-fix-committed.ts (cases 50/51/52),
 * which this file was split from to stay under the 500-line hard cap.
 *
 * Covers: Issue #749 —
 *   53. ref-collision: a tag named like the branch does not shadow it.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_FORGE = "none";
process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = "0";

// 53. Issue #749 — ref-namespace collision: a tag named like the branch
// shadows the branch in bare-name resolution; the driver must resolve it.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-ref-collision-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    const { countCommittedAhead, detectCommittedFix } = await import(
      "../src/work-driver-lens-fix-commit.ts"
    );
    const origin = path.join(dir, "origin.git");
    const root = path.join(dir, "root");
    const wt = path.join(dir, "wt");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(dir, "root", ".git", "info", "exclude"), "\n.pi/\n");
    await fs.writeFile(path.join(root, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/ref-collision", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/ref-collision", { cwd: root });
    await execp(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: root });
    // The fixer commits a fix, then a tag shadows the branch name.
    await fs.writeFile(path.join(wt, "feature.txt"), "fixed\n");
    await execp("git add feature.txt && git commit -q -m 'lens-fix'", {
      cwd: wt,
      shell: "/bin/bash",
    });
    await execp("git tag -f feature/ref-collision", { cwd: wt });
    // Sanity: the BARE name is tag-shadowed (the driver's old measurement shape).
    const { stdout: bareCount } = await execp("git rev-list --count feature/ref-collision..HEAD", {
      cwd: wt,
    });
    assert(
      Number.parseInt(bareCount.trim(), 10) === 0,
      "setup: the bare name is tag-shadowed (rev-list against it reports 0)",
    );
    const execFn = (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) =>
      new Promise<{ stdout: string; stderr?: string }>((resolve, reject) =>
        exec(cmd, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer }, (err, stdout, stderr) =>
          err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr }),
        ),
      );
    const count = await countCommittedAhead(execFn, wt, "feature/ref-collision");
    assert(
      count === 1,
      `the count is the TRUE committed count despite the tag shadow (got: ${count})`,
    );
    const fix = await detectCommittedFix(execFn, wt, "feature/ref-collision");
    assert(
      fix.status === "committed" && fix.count === 1 && fix.diffEmpty === false,
      `detectCommittedFix reports the fix as committed with content NOT on the branch (got: ${JSON.stringify(fix)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

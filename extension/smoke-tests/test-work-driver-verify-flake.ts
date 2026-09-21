#!/usr/bin/env bun
/**
 * #782 — the consolidated-verify flake retry.
 *
 * Tests runConsolidatedVerify directly with the retry option:
 * Case 1: first run fails, re-run passes → status: "passed", recovered: true,
 *         onRecover callback called.
 * Case 2: first run fails, re-run fails → status: "failed", retried: true,
 *         recovered: false.
 * Case 3: canRetry: false → no retry, single-run failure.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: NonNullable<Parameters<typeof runConsolidatedVerify>[0]> = async (cmd, o) => {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    e.stdout = e.stdout ?? "";
    e.stderr = e.stderr ?? (err as unknown as { stderr?: string }).stderr ?? "";
    throw e;
  }
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-flake-direct-"));

async function fixture(name: string) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = sha.trim();
  return { repo, baseSha, dir };
}

function commitIn(wt: string, msg: string) {
  return execFileP("git", ["add", "."], { cwd: wt }).then(() =>
    execFileP("git", ["commit", "-q", "-m", msg], { cwd: wt }),
  );
}

try {
  // --------------------------------------------------------------- case 1
  // First run fails (stateful flag), re-run passes → recovered.
  {
    const f = await fixture("recover");
    const wt = path.join(f.dir, "wt-a");
    await git(f.repo, ["worktree", "add", "--detach", wt, f.baseSha]);
    writeFileSync(path.join(wt, "change.txt"), "new\n");
    await commitIn(wt, "add change");

    // Stateful flag: first run creates the flag and fails, second run
    // sees the flag and passes. The flag is in the scratch tree's CWD.
    const verifyCmd = "sh -c 'test -f flake-flag.txt || { touch flake-flag.txt; exit 1; }'";
    let recovered = false;
    let recoveredTail: string | undefined;
    const result = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { a: wt },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
      retry: {
        canRetry: true,
        onRecover: (tail) => {
          recovered = true;
          recoveredTail = tail;
        },
      },
    });
    assert(result.status === "passed", `case 1: status is passed (got: ${result.status})`);
    if (result.status === "passed") {
      assert(result.recovered === true, "case 1: recovered is true");
    }
    assert(recovered, "case 1: onRecover callback was called");
    assert(recoveredTail !== undefined, "case 1: onRecover received the original failing tail");
  }

  // --------------------------------------------------------------- case 2
  // First run fails, re-run fails → not recovered, retried: true.
  {
    const f = await fixture("both-fail");
    const wt = path.join(f.dir, "wt-a");
    await git(f.repo, ["worktree", "add", "--detach", wt, f.baseSha]);
    writeFileSync(path.join(wt, "change.txt"), "new\n");
    await commitIn(wt, "add change");

    // Always fails: the verify cmd always exits 1.
    const verifyCmd = "sh -c 'exit 1'";
    const result = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { a: wt },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
      retry: {
        canRetry: true,
        onRecover: () => {
          assert(false, "case 2: onRecover should NOT be called");
        },
      },
    });
    assert(result.status === "failed", `case 2: status is failed (got: ${result.status})`);
    if (result.status === "failed") {
      assert(result.retried === true, "case 2: retried is true");
      assert(result.recovered === false, "case 2: recovered is false");
    }
  }

  // --------------------------------------------------------------- case 3
  // canRetry: false → no retry, single-run failure.
  {
    const f = await fixture("no-retry");
    const wt = path.join(f.dir, "wt-a");
    await git(f.repo, ["worktree", "add", "--detach", wt, f.baseSha]);
    writeFileSync(path.join(wt, "change.txt"), "new\n");
    await commitIn(wt, "add change");

    const verifyCmd = "sh -c 'exit 1'";
    const result = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { a: wt },
      scratchDir: path.join(f.dir, "scratch"),
      verifyCmd,
      timeoutMs: 30_000,
      retry: {
        canRetry: false,
        onRecover: () => {
          assert(false, "case 3: onRecover should NOT be called");
        },
      },
    });
    assert(result.status === "failed", `case 3: status is failed (got: ${result.status})`);
    if (result.status === "failed") {
      assert(
        result.retried === undefined || result.retried === false,
        "case 3: retried is false/undefined",
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

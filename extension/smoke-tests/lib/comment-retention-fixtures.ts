/**
 * Shared real-git fixtures for the comment-retention smoke tests (#948/#1040).
 * Not a test itself (no `test-` prefix, so the gate glob does not run it).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findLostComments } from "../../src/comment-retention.ts";
import type { ExecFn } from "../../src/worktree.ts";

export const execFileP = promisify(execFile);

/** Real shell exec, matching the driver's ExecFn contract. */
export const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/**
 * Scratch repo: `base` files committed first, then `head` applied in a second
 * commit (a `null` value deletes the file). Returns the repo dir.
 */
export async function repoWithFiles(
  base: Record<string, string>,
  head: Record<string, string | null>,
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-hunks-"));
  await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
  for (const [file, content] of Object.entries(base)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  await git(dir, ["add", "-A", "src"]);
  await git(dir, ["commit", "-q", "-m", "base"]);
  for (const [file, content] of Object.entries(head)) {
    if (content === null) unlinkSync(path.join(dir, file));
    else {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
  }
  await git(dir, ["add", "-A", "src"]);
  await git(dir, ["commit", "-q", "-m", "head"]);
  return dir;
}

/** Single-file convenience: `file` at base, rewritten to `head`. */
export async function repoWith(file: string, base: string, head: string): Promise<string> {
  return repoWithFiles({ [file]: base }, { [file]: head });
}

/** Build a scratch repo for `file`, run findLostComments HEAD~1...HEAD, clean up. */
export async function runRetention(file: string, base: string, head: string) {
  const dir = await repoWith(file, base, head);
  try {
    return await runRetentionIn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run findLostComments over HEAD~1...HEAD of an existing repo, under `src`. */
export async function runRetentionIn(dir: string) {
  const b = (await git(dir, ["rev-parse", "HEAD~1"])).stdout.trim();
  const h = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  return await findLostComments(realExec, dir, b, h, ["src"]);
}

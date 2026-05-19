import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Thin worktree helpers. P1: direct git CLI calls.
 * P2: replace with @randomm/pi-worktree once that package's programmatic API
 * is published — the plugin already implements the dirty-check / prune-order /
 * lock-detection guards we want.
 */

export interface WorktreeCreateOpts {
  name: string; // "task-A" → .worktrees/task-A
  branch?: string; // defaults to scratch/<name>
  fromRef?: string; // defaults to HEAD
}

export async function worktreeCreate(opts: WorktreeCreateOpts): Promise<string> {
  const path = `.worktrees/${opts.name}`;
  const branch = opts.branch ?? `scratch/${opts.name}`;
  const args = ["worktree", "add", path, "-b", branch];
  if (opts.fromRef) args.push(opts.fromRef);
  await execFileP("git", args);
  return path;
}

export async function worktreeList(): Promise<string> {
  const { stdout } = await execFileP("git", ["worktree", "list"]);
  return stdout;
}

export async function worktreeRemove(name: string, force = false): Promise<void> {
  const path = `.worktrees/${name}`;
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  await execFileP("git", args);
}

export async function diffInWorktree(name: string): Promise<string> {
  const path = `.worktrees/${name}`;
  const { stdout } = await execFileP("git", ["-C", path, "diff"]);
  return stdout;
}

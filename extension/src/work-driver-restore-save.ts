/**
 * work-driver-restore-save — #750 / #1258: capture repoRoot's discarded state
 * before a restore touches it, and say which of three things happened.
 *
 * Split from work-driver-restore.ts (500-line gate). The capture used to
 * return `undefined` both when there was nothing to save and when the save
 * FAILED, so its callers could not tell the two apart and reset the tree
 * either way — throwing away work that existed nowhere else. A failed save
 * is now its own result, and the restores in work-driver-restore.ts leave
 * the tree exactly as it is when they get one (see `saveFailedRestore`).
 */
import fs from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/** What capturing the discarded state did. */
export type SaveResult =
  /** The state was written to `path`. */
  | { kind: "saved"; path: string }
  /** The root had nothing staged, unstaged or listed by status. */
  | { kind: "nothing" }
  /** The capture could not be made; `error` names the git argv and its stderr. */
  | { kind: "failed"; error: string };

/**
 * Capture the root's staged/unstaged/unmerged state to a scratch file.
 * Never throws. A failure is returned, not swallowed: the caller must not
 * run anything destructive after it, since the tree is then the only copy.
 */
export async function preserveDiscardedState(
  execFn: ExecFn,
  repoRoot: string,
  scratchDir: string,
  label: string,
): Promise<SaveResult> {
  // The git read in flight, so a failure names the command that failed.
  let argv: string[] | undefined;
  const read = async (args: string[], maxBuffer: number): Promise<string> => {
    argv = args;
    return (await execFn("git", { cwd: repoRoot, maxBuffer, argv: args })).stdout;
  };
  try {
    const status = await read(["status", "--porcelain"], 1024 * 1024);
    const unstaged = await read(["diff"], 8 * 1024 * 1024);
    const staged = await read(["diff", "--cached"], 8 * 1024 * 1024);
    argv = undefined;
    if (!status.trim() && !unstaged.trim() && !staged.trim()) return { kind: "nothing" };
    fs.mkdirSync(scratchDir, { recursive: true });
    const file = path.join(
      scratchDir,
      `restored-state-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.diff`,
    );
    const body = `# #750 — repoRoot state discarded by a consolidation restore
# label: ${label}
# captured before the restore's reset and checkout

--- status (git status --porcelain) ---
${status}

--- unstaged (git diff) ---
${unstaged}

--- staged (git diff --cached) ---
${staged}
`;
    fs.writeFileSync(file, body, "utf8");
    trace(`work-driver: ${label} — discarded state preserved to ${file}`);
    return { kind: "saved", path: file };
  } catch (err) {
    // Name the argv and git's own stderr: a bare `Command failed: git` (example-owner/pi-rukas#32)
    // could not be told apart from an environment failure.
    const e = err as Error & { stderr?: string };
    const what = argv ? `\`git ${argv.join(" ")}\` failed: ` : "";
    const error = `${what}${(e.stderr?.trim() || e.message)?.slice(0, 160)}`;
    trace(`work-driver: ${label} — could not preserve discarded state: ${error}`);
    return { kind: "failed", error };
  }
}

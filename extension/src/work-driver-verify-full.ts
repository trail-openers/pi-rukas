/**
 * work-driver-verify-full — verify-full command discovery and execution.
 *
 * Issue #279 — adds a second verify tier that distinguishes \"the fast
 * suite passed\" from \"the suite that exercises real dependencies passed.\"
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Read the first non-empty, non-comment line from a config file. */
function readFirstConfigLine(content: string): string | undefined {
  return content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Resolve the verify-full command for the project.
 *
 * Issue #279 part A: reads `.pi/verify-cmd-full` ONLY — first non-empty,
 * non-comment line, verbatim. NO derivation fallback (an inferred \"full
 * suite\" recreates exactly the ambiguity this removes). Explicit escape
 * hatch: when the file is absent, the verify-full tier is skipped with a
 * visible `verify-full-status: skipped` event.
 *
 * Returns the command verbatim (caller must execute it in the correct cwd:
 * the group's primary worktree, never repoRoot, per #279 addendum).
 */
export async function verifyCmdFullFor(repoRoot: string): Promise<string | undefined> {
  const fullPath = path.join(repoRoot, ".pi", "verify-cmd-full");
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    const line = readFirstConfigLine(raw);
    return line;
  } catch {
    // No explicit file — verify-full tier skipped.
    return undefined;
  }
}

/**
 * Execute the verify-full command driver-side in the ci step.
 *
 * Returns status and timing for the `verify-full-status` event. Caller
 * must ensure cwd is the group's worktree (per #279 addendum), NOT repoRoot.
 */
export async function runVerifyFull(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
): Promise<{ outcome: "success" | "failure"; ms: number; output: string }> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFn(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1 MiB cap for evidence tail
    });
    const ms = Date.now() - startedAt;
    const output = (stdout || stderr || "").trim();
    return { outcome: "success", ms, output };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const output = ((err as Error).message || (err as { stderr?: string }).stderr || "").trim();
    return { outcome: "failure", ms, output };
  }
}

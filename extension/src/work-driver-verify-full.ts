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
 * #782 — a single bounded re-run for the verify-full flake. Opt-in via the
 * `retry` argument of `runVerifyFull`; the existing callers that run the
 * tier once (the offline test fixtures, pre-#782 callers) keep the pre-#782
 * shape by passing nothing.
 */
interface VerifyRun {
  ms: number;
  ok: boolean;
  output: string;
}

async function execVerifyOnce(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
): Promise<VerifyRun> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFn(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1 MiB cap for evidence tail
    });
    const ms = Date.now() - startedAt;
    const output = (stdout || stderr || "").trim();
    return { ms, ok: true, output };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const output = ((err as Error).message || (err as { stderr?: string }).stderr || "").trim();
    return { ms, ok: false, output };
  }
}

/**
 * Execute the verify-full command driver-side in the ci step.
 *
 * Returns status and timing for the `verify-full-status` event. Caller
 * must ensure cwd is the group's worktree (per #279 addendum), NOT repoRoot.
 *
 * #782 — when `retry` is true, on a failure the SAME command is re-run ONCE
 * in the SAME worktree before giving up. The first failure's output is
 * preserved as `firstRunOutput` so the caller can surface it on the
 * `verify-full-status` event alongside the re-run's outcome. The re-run is
 * bounded (exactly one) — a command that fails twice is a genuine failure and
 * must park. Callers that do not pass `retry` keep the pre-#782 single-run
 * shape (the offline test fixtures, and any pre-#782 caller).
 */
export async function runVerifyFull(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr?: string }>,
  opts?: { retry?: boolean },
): Promise<{
  outcome: "success" | "failure";
  ms: number;
  output: string;
  recovered?: boolean;
  firstRunOutput?: string;
}> {
  const first = await execVerifyOnce(cmd, cwd, timeoutMs, execFn);
  if (first.ok) return { outcome: "success", ms: first.ms, output: first.output };

  if (!opts?.retry) {
    return { outcome: "failure", ms: first.ms, output: first.output };
  }

  // #782 — single bounded re-run, same command, same worktree. No loop:
  // a command that fails twice is a genuine failure and must park.
  const second = await execVerifyOnce(cmd, cwd, timeoutMs, execFn);
  if (second.ok) {
    return {
      outcome: "success",
      ms: first.ms + second.ms,
      output: second.output,
      recovered: true,
      firstRunOutput: first.output,
    };
  }
  // Second run also failed — report the second run's output as the primary
  // evidence (it's what the caller's handoff tail should show), and preserve
  // the first run's output so the caller can surface both on the event.
  return {
    outcome: "failure",
    ms: first.ms + second.ms,
    output: second.output,
    firstRunOutput: first.output,
  };
}

/**
 * work-driver-verify-fast — #1324: the optional fast verify tier.
 *
 * `.pi/verify-cmd-fast` (first non-empty, non-comment line, like
 * `.pi/verify-cmd`) names a cheap check — typecheck, lint — that runs BEFORE
 * the full verify command wherever the driver runs it: each worktree, the
 * consolidated tree at develop and at commit-pr, and the baseline probe. A
 * fast failure short-circuits the full run, so a type error surfaces in
 * seconds instead of after the whole suite. Both tiers share the full run's
 * bound: the full run gets what the fast run left of it, so a timeout still
 * means "the gate did not finish inside PI_ENSEMBLE_VERIFY_TIMEOUT_MS".
 *
 * Absent the file, `withFastTier` returns the executor unchanged and the
 * develop prompt names the full command as before.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { readFirstConfigLine } from "./work-driver-verify-cmd.ts";

/** Ends the failure stream of a fast-tier run; the handoff quotes it. */
export const FAST_TIER_LABEL = "[verify-cmd-fast]";

/** The command a verify error came from: the fast tier's when it failed, else `fullCmd`. */
export function failedVerifyCmd(err: unknown, fullCmd: string): string {
  return (err as { fastTier?: string } | undefined)?.fastTier ?? fullCmd;
}

/** The fast tier's command, or undefined when `.pi/verify-cmd-fast` is absent or empty. */
export async function fastVerifyCmdFor(repoRoot: string): Promise<string | undefined> {
  try {
    return readFirstConfigLine(
      await fs.readFile(path.join(repoRoot, ".pi", "verify-cmd-fast"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

type Exec<O extends { timeout?: number }> = (
  cmd: string,
  opts?: O,
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Wrap `execFn` so a call that runs `fullCmd` runs `fastCmd` first in the
 * same cwd. Every other call (git, the smoke command) passes through. A fast
 * failure is rethrown with the fast run's own stream and `killed` flag, plus
 * a closing line naming the tier (and `fastTier` set, see `failedVerifyCmd`),
 * so the gate's existing failure handling
 * (timeout, missing deps, host exhaustion, tail extraction) applies as is.
 */
export function withFastTier<O extends { timeout?: number }>(
  execFn: Exec<O>,
  fullCmd: string,
  fastCmd: string | undefined,
): Exec<O> {
  if (!fastCmd) return execFn;
  return async (cmd, opts) => {
    if (cmd !== fullCmd) return execFn(cmd, opts);
    const started = Date.now();
    try {
      await execFn(fastCmd, opts);
    } catch (err) {
      const e = err as Error & { stderr?: string; fastTier?: string };
      e.fastTier = fastCmd;
      e.stderr = `${e.stderr ?? ""}\n${FAST_TIER_LABEL} the fast tier \`${fastCmd}\` failed, so the full verify \`${fullCmd}\` was not run`;
      trace(`work-driver: fast verify tier failed — full verify skipped: ${fastCmd.slice(0, 120)}`);
      throw e;
    }
    const bound = opts?.timeout;
    const timeout = bound === undefined ? undefined : Math.max(1, bound - (Date.now() - started));
    return execFn(cmd, { ...opts, timeout } as O);
  };
}

/**
 * The develop prompt's verify instruction. With a fast tier the developer
 * runs only that, and the full command is left to the driver — M children
 * each running the full suite at once is the contention #1324 removes.
 */
export function developVerifyLine(verifyCmd?: string, fastCmd?: string): string {
  if (verifyCmd && fastCmd) {
    return `Before committing, run the project's FAST verify tier — \`${fastCmd}\` — and make it pass in your worktree. Do NOT run the full verify command (\`${verifyCmd}\`) yourself: the driver runs the fast tier and then the full command on your worktree the moment you finish, and parallel workstreams each running the full suite only slow every gate down. Fix formatting or lint output by RUNNING the formatter/linter, never by hand-guessing.`;
  }
  return verifyCmd
    ? `Before committing, run the project's verify command — \`${verifyCmd}\` — and make it pass in your worktree; this is the exact command the verify gate will run, so the two cannot diverge. Run it when the change is complete, not after every edit: the driver runs it again on your worktree the moment you finish, so a re-run that only re-confirms a green result buys nothing. Fix formatting or lint output by RUNNING the formatter/linter, never by hand-guessing.`
    : "This project has no discoverable verify command, so there is no project-level check to run before committing — rely on the change being correct and complete.";
}

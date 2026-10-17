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
import { toolInactivityTimeoutMs } from "./spawn-support.ts";
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

/**
 * The wall-clock bound every suite command a developer runs carries, derived
 * from the tool-inactivity watchdog rather than frozen as a literal.
 *
 * Prompt-layer only — nothing in the harness parses or enforces it. Measured
 * on a `/work` fan-out: developers ran the whole offline suite in parallel
 * worktrees with no bound at all and one stuck ~20 minutes on a single suite
 * call, so the slowest child set the pace of every gate.
 *
 * A third of the watchdog is the shape that was always intended: the command
 * reports what hung instead of the child being killed for silence. Deriving
 * it keeps that true when an operator shrinks
 * `PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS` — a frozen 1200 told the developer
 * to wrap a command in a bound LONGER than the watchdog that would then take
 * it down, which is the opposite of a bound. The 1200 ceiling is the number
 * the derivation already gives at the 60-min default, and it keeps the prompt
 * sane at an enlarged watchdog rather than telling a child to let one suite
 * run for hours.
 *
 * The floor of 1 is load-bearing in a way the ceiling is not. The knob accepts
 * `0`, and a non-numeric value (`""`, `"abc"`) also reads as 0 — and coreutils
 * treats `timeout 0` as *no timeout at all*. So the very shape this bound
 * exists to prevent — a suite running until the watchdog takes the whole child
 * — is what a `timeout 0` in the prompt instructs the child to do. Same reason
 * `withFastTier` above floors its derived bound with `Math.max(1, ...)`.
 */
export function suiteTimeoutSeconds(): number {
  return Math.max(1, Math.min(1200, Math.floor(toolInactivityTimeoutMs() / 1000 / 3)));
}

/**
 * #1156 — the test-scope rule for the develop prompt, appended to the verify
 * line. It complements `developVerifyLine` rather than restating it: that
 * function already says which *project verify command* the developer runs
 * (#1324's fast tier), and this says what else the developer does NOT run —
 * the whole suite, which the driver's own verify runs once on the worktree
 * after the child finishes.
 *
 * Separate export so the rule is testable on its own: `developVerifyLine`
 * returns one of three strings and the rule applies to all three.
 *
 * `adHocOnly` is the #1324 fast-tier mode. There `developVerifyLine` already
 * forbids the developer running the project verify command at all, so this
 * rule must not read as licensing it: the binding then covers only the ad-hoc
 * test commands the child picks for itself, and says plainly that it is not
 * permission to run the full verify.
 */
export function developTestScopeLine(adHocOnly = false): string {
  const seconds = suiteTimeoutSeconds();
  // The macOS branch is a PROBE, not a claim about the platform. Whether a
  // `timeout` binary exists is a fact about the machine the child is sitting
  // on, and the child can look it up. Asserting "macOS ships none" instead
  // told a child on a machine that HAS one (coreutils via Homebrew, a Linux
  // container) to run its suites unbounded for no reason at all.
  const binding = adHocOnly
    ? "The bound below applies to the ad-hoc test commands you run for yourself — not to the project verify command, which the fast tier says you do NOT run; nothing here licenses running it."
    : `Wrap every suite or test command in \`timeout ${seconds}\` (e.g. \`timeout ${seconds} bun test extension/smoke-tests/test-foo.ts\`) so a single stuck test can never consume the dispatch.`;
  const probe = "`command -v timeout || command -v gtimeout`";
  const fallback =
    "Only where the probe prints nothing — run the command bare and keep it under the tool watchdog (`PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS`).";
  return `Scope your own testing: run the smoke tests for the files you changed, plus typecheck and lint. Do NOT run the full test suite — the driver runs the full suite once on your worktree after you finish, and several workstreams each running it whole in parallel only slow every gate down. ${binding} Probe for a timeout binary first: ${probe} (POSIX-specified; \`gtimeout\` is Homebrew coreutils' same tool). ${fallback}`;
}

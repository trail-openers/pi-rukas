/**
 * work-driver-verify-fast — #1324: the optional fast verify tier.
 *
 * `.pi/verify-cmd-fast` (first non-empty, non-comment line, like
 * `.pi/verify-cmd`) names a cheap check — typecheck, lint — that runs BEFORE
 * the full verify command wherever the driver runs it: each worktree, the
 * consolidated tree at develop and at commit-pr, and the baseline probe. A
 * fast failure short-circuits the full run, so a type error surfaces in
 * seconds instead of after the whole suite.
 *
 * #1509 — the two tiers NO LONGER SHARE one bound. Pre-#1509 the full run got
 * `Math.max(1, bound - fastElapsed)` from one `opts.timeout`, so one number
 * had to cover a 400 ms lint run and a 641-file suite, and a suite that
 * legitimately needs longer parked the cycle. Each tier now carries its own
 * bound (see `work-driver-verify-budget.ts`): the fast run gets the fast
 * tier's, the full run gets the suite tier's untouched, and the fast tier's
 * elapsed time subtracts from nothing. The clamp that remains is a guard
 * against a caller that passed no bound at all — a `timeout: 0` would reach
 * exec as "no bound", so a derived bound still floors at 1 ms.
 *
 * Tier selection stays on the `cmd !== fullCmd` identity it has always used,
 * BUT the bound no longer rides on that comparison: each exec is handed its
 * tier's number explicitly, so the hazard the #1509 spec names — a per-tier
 * bound keyed off the same string equality silently handing the fast tier the
 * full budget — cannot arise.
 *
 * Absent the file, `withFastTier` returns the executor unchanged and the
 * develop prompt names the full command as before.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { callBudgetFloorMs } from "./spawn-call-budget.ts";
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
 *
 * #1509 — `tierTimeouts` carries each tier's OWN bound, resolved by the caller
 * (which is the only place that knows the repoRoot to read a `.pi/*-timeout-ms`
 * file from). The fast exec gets `tierTimeouts.fast`; the full exec gets the
 * caller's `opts.timeout` untouched — that is already the suite tier's bound,
 * resolved by the same resolver. When the caller supplies no `tierTimeouts`
 * (a test, or a seam that has one bound for both), the pre-#1509 sharing is
 * preserved exactly: the full run gets what the fast run left.
 */
export interface VerifyTierTimeouts {
  /** The bound the fast tier's exec carries. */
  fast?: number;
}

export function withFastTier<O extends { timeout?: number }>(
  execFn: Exec<O>,
  fullCmd: string,
  fastCmd: string | undefined,
  tierTimeouts?: VerifyTierTimeouts,
): Exec<O> {
  if (!fastCmd) return execFn;
  return async (cmd, opts) => {
    if (cmd !== fullCmd) return execFn(cmd, opts);
    const started = Date.now();
    // A caller that resolved a fast-tier bound owns it outright: the fast tier
    // must never inherit the suite tier's number, and reading `opts.timeout`
    // as a fallback when it is absent would let a 10-minute `opts.timeout`
    // answer for a tier that has its own knob.
    const fastTimeout = tierTimeouts?.fast;
    try {
      await execFn(
        fastCmd,
        (fastTimeout === undefined ? opts : ({ ...opts, timeout: fastTimeout } as O)) as O,
      );
    } catch (err) {
      const e = err as Error & { stderr?: string; fastTier?: string };
      e.fastTier = fastCmd;
      e.stderr = `${e.stderr ?? ""}\n${FAST_TIER_LABEL} the fast tier \`${fastCmd}\` failed, so the full verify \`${fullCmd}\` was not run`;
      trace(`work-driver: fast verify tier failed — full verify skipped: ${fastCmd.slice(0, 120)}`);
      throw e;
    }
    if (tierTimeouts?.fast !== undefined) {
      // Per-tier bounds: the full run keeps the bound the caller resolved for
      // it. Subtracting the fast tier's elapsed time from a DIFFERENT bound is
      // what made a generous suite budget clamp toward 1 ms and fake an instant
      // timeout, so the subtraction is gone whenever the tiers are separated.
      return execFn(cmd, opts);
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
 * from the call budget's floor (`PI_ENSEMBLE_CALL_BUDGET_MS`, 20 min) rather
 * than frozen as a literal.
 *
 * Prompt-layer only — nothing in the harness parses it as an instruction.
 * Measured on a `/work` fan-out: developers ran the whole offline suite in
 * parallel worktrees with no bound at all and one stuck ~20 minutes on a
 * single suite call, so the slowest child set the pace of every gate.
 *
 * The call budget (#1465, spawn-call-budget.ts) gives a command with its own
 * `timeout N` a budget of N + 2 min, so the command reports what hung before
 * any watchdog acts. The floor is what an unwrapped command gets, so a bound
 * at the floor never asks for more than a bare call would have had. The 1200
 * ceiling is the number the default floor gives, and it keeps the prompt sane
 * at an enlarged floor rather than telling a child to let one suite run for
 * hours.
 *
 * The floor of 1 is load-bearing in a way the ceiling is not. The knob accepts
 * `0` — coreutils treats `timeout 0` as *no timeout at all* — so a `timeout 0`
 * in the prompt would instruct the child to run unbounded. Same reason
 * `withFastTier` above floors its derived bound with `Math.max(1, ...)`.
 * `callBudgetFloorMs` rejects what it cannot read (`""`, `"NaN"`, a negative,
 * an overflow to Infinity) to its default, so the result is always finite.
 */
export function suiteTimeoutSeconds(): number {
  return Math.max(1, Math.min(1200, Math.floor(callBudgetFloorMs() / 1000)));
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
    "Only where the probe prints nothing — run the command bare; it then gets the call budget (`PI_ENSEMBLE_CALL_BUDGET_MS`), and a call past it with no new output for 10 minutes is killed.";
  return `Scope your own testing: run the smoke tests for the files you changed, plus typecheck and lint. Do NOT run the full test suite — the driver runs the full suite once on your worktree after you finish, and several workstreams each running it whole in parallel only slow every gate down. ${binding} Probe for a timeout binary first: ${probe} (POSIX-specified; \`gtimeout\` is Homebrew coreutils' same tool). ${fallback}`;
}

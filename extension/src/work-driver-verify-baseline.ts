/**
 * work-driver-verify-baseline — the develop gate's baseline comparison.
 *
 * The develop gate proves a change builds by running the project's verify
 * command against the change. It never asked the prior question: does that
 * command pass WITHOUT the change? When it does not — a test unrelated to
 * the diff fails at the cycle's base commit, or the gate cannot finish inside
 * its bound on this host — every cycle parks as `verify-failed:develop` with
 * evidence that blames the diff, and an operator following the advice
 * inspects code that was never the problem.
 *
 * `probeBaselineVerify` runs the SAME command ONCE on a clean checkout of
 * the base sha: a temporary detached worktree, provisioned the way develop
 * worktrees are, bounded by the same timeout, removed afterwards. The caller
 * invokes it ONLY after the verify command has already failed — never on the
 * happy path, where it would double every cycle's gate cost.
 *
 * The probe can only ADD evidence. It never turns a failure into a pass: a
 * red baseline still parks (the gate cannot pass, so there is nothing to
 * merge), but the park says the gate is red at base. Anything the probe
 * cannot establish — the worktree could not be created, the base run failed
 * for want of dependencies — is `unknown` and reported as a note, never as
 * a red baseline: a wrong "the change is not implicated" is worse than none.
 */
import { trace } from "./trace.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  sharesAssertion,
} from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { VERIFY_TIMEOUT_LABEL } from "./work-driver-verify-develop-helpers.ts";
import { combinedExecFailureStream } from "./work-driver-verify-flake.ts";
import { looksLikeMissingDeps, provisionWorktree } from "./worktree-provision.ts";
import { type ExecFn, worktreePath } from "./worktree.ts";

/** Leads the failure string of a red baseline; the explain renderer keys on it. */
export const BASELINE_RED_MARKER = "[baseline-red]";

export type BaselineVerdict =
  | { status: "green" }
  /** `assertion` is null when nothing assertion-shaped could be extracted. */
  | { status: "red"; assertion: string | null; timedOut: boolean }
  | { status: "unknown"; reason: string };

export async function probeBaselineVerify(
  execFn: ExecFn,
  opts: { repoRoot: string; baseSha: string; issue: number; cmd: string; timeoutMs: number },
): Promise<BaselineVerdict> {
  const { repoRoot, baseSha, cmd, timeoutMs } = opts;
  // Deliberately NOT `issue-<N>-…`: the same-issue leftover scan reads that
  // prefix as a workstream's worktree, and a probe tree leaked by a killed
  // process must never park the next cycle as "dirty leftover work".
  const abs = worktreePath(repoRoot, `baseline-verify-${opts.issue}`);
  const remove = () =>
    execFn(`git worktree remove --force ${JSON.stringify(abs)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    }).catch(() => undefined);
  // A leaked probe tree holds nothing but a checkout of some base commit.
  await remove();
  try {
    await execFn(`git worktree add --detach ${JSON.stringify(abs)} ${JSON.stringify(baseSha)}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    return {
      status: "unknown",
      reason: `could not check out the base commit (${(err as Error).message?.slice(0, 160)})`,
    };
  }
  try {
    await provisionWorktree(execFn, repoRoot, abs);
    trace(`work-driver: baseline verify — running \`${cmd}\` at base ${baseSha.slice(0, 12)}`);
    try {
      await execFn(cmd, { cwd: abs, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return { status: "green" };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
      if (e.killed === true) return { status: "red", assertion: null, timedOut: true };
      const raw = combinedExecFailureStream(e);
      // A bare worktree fails every dependency-needing command; that says
      // nothing about the base commit.
      if (looksLikeMissingDeps(raw)) {
        return {
          status: "unknown",
          reason: "the base checkout failed for want of dependencies, not on the gate itself",
        };
      }
      const assertion = extractSpecificAssertion(extractAttributedTail(raw, 1500).tail);
      return {
        status: "red",
        assertion: assertion === NO_SPECIFIC_ASSERTION ? null : assertion.slice(0, 200),
        timedOut: false,
      };
    }
  } finally {
    await remove();
  }
}

/**
 * The failure string for a red baseline. Kept short: cap evidence keeps only
 * the last 800 chars of each failure (work-develop-cap-evidence.ts).
 * `changeFailure` is the text the change's own run failed with — the "same
 * assertion" claim is made only when the base assertion appears in it.
 */
export function baselineRedMessage(
  verdict: Extract<BaselineVerdict, { status: "red" }>,
  opts: { cmd: string; baseSha: string; timeoutMs: number; changeFailure: string },
): string {
  const where = `on a clean checkout of the cycle's base commit ${opts.baseSha.slice(0, 12)}, without this change`;
  if (verdict.timedOut) {
    return `${BASELINE_RED_MARKER} ${VERIFY_TIMEOUT_LABEL} verify command \`${opts.cmd}\` exceeded its ${Math.round(opts.timeoutMs / 60000)}-min timeout ${where} — the gate cannot finish inside its bound on this host whatever the diff contains. Raise PI_ENSEMBLE_VERIFY_TIMEOUT_MS or make the gate faster; the failures below do not implicate this change`;
  }
  const same =
    verdict.assertion !== null && sharesAssertion(opts.changeFailure, verdict.assertion)
      ? " — the SAME assertion the change's run failed on"
      : "";
  return `${BASELINE_RED_MARKER} verify command \`${opts.cmd}\` ALSO FAILS ${where} — assertion at base: ${verdict.assertion ?? NO_SPECIFIC_ASSERTION}${same}. The gate was red before this change was written, so no change can pass it; the failures below cannot be attributed to this diff until the base is green. Fix the gate at the base commit (or the host it runs on), then re-run`;
}

/** One failure of the change's own verify run, for the baseline comparison. */
export interface ChangeFailure {
  text: string;
  timedOut: boolean;
}

/**
 * #1349 — true only when the change's failures are demonstrably the base's:
 * every one shares the (extracted, non-null) base assertion, or the base and
 * every change run were killed at the bound. A base that is red some other
 * way says nothing about a failure the change added, so it never excuses one.
 */
export function baselineExplainsChange(
  verdict: Extract<BaselineVerdict, { status: "red" }>,
  changeFailures: readonly ChangeFailure[],
): boolean {
  if (changeFailures.length === 0) return false;
  if (verdict.timedOut) return changeFailures.every((f) => f.timedOut);
  const assertion = verdict.assertion;
  return (
    assertion !== null &&
    changeFailures.every((f) => !f.timedOut && sharesAssertion(f.text, assertion))
  );
}

/**
 * Runs the probe after the verify command has failed (moved out of
 * work-driver-verify-verify-cmd.ts for the 500-line cap). A red base leads
 * `failures` with its finding; anything else is a note. Returns whether the
 * base explains every change failure (`baselineExplainsChange`).
 */
export async function compareWithBaseline(
  execFn: ExecFn,
  opts: {
    repoRoot: string;
    baseSha: string;
    issue: number;
    cmd: string;
    timeoutMs: number;
    changeFailures: readonly ChangeFailure[];
    failures: string[];
    notes: string[];
  },
): Promise<boolean> {
  const { cmd, baseSha, timeoutMs } = opts;
  const verdict = await probeBaselineVerify(execFn, opts);
  if (verdict.status !== "red") {
    opts.notes.push(
      verdict.status === "green"
        ? `baseline verify passed — \`${cmd}\` exits 0 on a clean checkout of the base commit ${baseSha.slice(0, 12)}, so the gate was green before this change`
        : `baseline verify not established — ${verdict.reason}`,
    );
    return false;
  }
  const changeFailure = opts.changeFailures.map((f) => f.text).join("\n");
  opts.failures.unshift(baselineRedMessage(verdict, { cmd, baseSha, timeoutMs, changeFailure }));
  return baselineExplainsChange(verdict, opts.changeFailures);
}

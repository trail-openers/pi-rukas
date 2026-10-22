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
import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  sharesAssertion,
} from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { type BaseHealthVerdict, matchingVerdict } from "./work-driver-verify-base-health.ts";
import { TIER_KNOB, TIER_TIMEOUT_FILE, VERIFY_TIMEOUT_ENV } from "./work-driver-verify-budget.ts";
import { verifyHostEnv } from "./work-driver-verify-cmd.ts";
import { VERIFY_TIMEOUT_LABEL, boundText } from "./work-driver-verify-develop-helpers.ts";
import { combinedExecFailureStream } from "./work-driver-verify-flake.ts";
import { summaryCount } from "./work-driver-verify-names.ts";
import { looksLikeMissingDeps, provisionWorktree } from "./worktree-provision.ts";
import { type ExecFn, worktreePath } from "./worktree.ts";

/** Leads the failure string of a red baseline; the explain renderer keys on it. */
export const BASELINE_RED_MARKER = "[baseline-red]";

/**
 * The ONE naming rule for a baseline probe's throwaway worktree. Exported
 * because the attribution seam has to name the same tree the probe creates —
 * it hands that path to the name comparison as the root the base run's names
 * live under, and two spellings of one directory is how a comparison silently
 * stops matching anything.
 *
 * Deliberately NOT `issue-<N>-…`: the same-issue leftover scan reads that
 * prefix as a workstream's worktree, and a probe tree leaked by a killed
 * process must never park the next cycle as "dirty leftover work".
 */
export function baselineProbeWorktreePath(repoRoot: string, label: number | string): string {
  return worktreePath(repoRoot, `baseline-verify-${label}`);
}

export type BaselineVerdict =
  | { status: "green" }
  /**
   * #1404 fix round 3 — a red base is TWO arms, not one shape with optional
   * evidence. The single-shape version left `rawStream`, `probed` and
   * `exitCode` optional with permissive defaults, so the commit-pr seam's
   * guards (`verdict.probed !== true`, `(verdict.exitCode ?? 1) !== 0`) read
   * an ABSENT value as either "not probed, refuse" or "no exit code, assume
   * non-zero, allow" — and the second of those is the fail-open half. A
   * producer that forgot a field used to produce a verdict the guards could
   * still wave through; now it does not compile.
   *
   * `red` is the only arm that may excuse anything, and only with all three
   * pieces of evidence present: the stream it printed, whether that stream
   * reached the loop's own report half, and the child's exit code.
   *
   * `assertion` is null when nothing assertion-shaped could be extracted —
   * legitimately so, because the develop step compares one extracted assertion
   * and treats a red base as park-with-context either way.
   */
  | ({
      status: "red";
      /** The base run's combined stream — required, never defaulted to "". */
      rawStream: string;
      /** True when the stream carried the loop's own `FAILED: <n> test(s)` summary. */
      probed: boolean;
      /** The child's exit code; `null` when the executor did not report one. */
      exitCode: number | null;
      assertion: string | null;
    } & RedBaselineExtra)
  /**
   * The base run was killed at its bound. It judged nothing, so it has no
   * stream, no tally and no exit code to reason from — which is exactly why it
   * is its own arm rather than a `timedOut` flag on the red shape: the flags
   * that were optional were the ones a killed run could not supply.
   *
   * The develop step still reads this as "the gate cannot finish inside its
   * bound whatever the diff contains" (`baselineExplainsChange` / `baselineRedMessage`),
   * and the commit-pr seam refuses to excuse anything on it.
   */
  | ({ status: "red-timed-out"; assertion: null } & RedBaselineExtra)
  | { status: "unknown"; reason: string };

/**
 * The red verdicts, as one type. The develop step's helpers take either arm —
 * they reason about "the base was red" and the timeout is part of that answer,
 * not an exception to it — while the commit-pr seam's continue path takes only
 * the fully-evidenced `red` arm.
 */
/** #1765 — the reuse flag both red arms carry (see `compareWithBaseline`). */
interface RedBaselineExtra {
  /**
   * The colour came from the branch step's cached probe rather than a run this
   * seam made: still the base's colour, but no stream to evidence an excuse with,
   * so #1349's `baselineExplainsChange` is not owed it.
   */
  reused?: boolean;
}

export type RedBaselineVerdict =
  | Extract<BaselineVerdict, { status: "red" }>
  | Extract<BaselineVerdict, { status: "red-timed-out" }>;

/** True for either red arm. Lets callers test the status without duplicating it. */
export function isRedBaseline(verdict: BaselineVerdict): verdict is RedBaselineVerdict {
  return verdict.status === "red" || verdict.status === "red-timed-out";
}

/**
 * #1765 — the compact record the branch step's pre-develop probe kept, read
 * back as the verdict arm the post-failure comparison reasons over. A cycle
 * that probed its base before develop and then watched the same command fail
 * on the change holds its verdict already; re-running the suite in a second
 * throwaway tree proves nothing new. The arm is the unevidenced `red`: the
 * caller has refused this park already, so there is no excuse left to grant,
 * and `assertion: null` keeps `baselineExplainsChange` from excusing anything
 * on a stream this record never held. Only a RED is reused — a cached GREEN
 * cannot survive a develop failure and must re-probe.
 */
function reuseCachedVerdict(
  cached: BaseHealthVerdict,
  notes: string[],
  cmd: string,
  baseSha: string,
): BaselineVerdict {
  notes.push(
    `baseline verify reused the branch step's RED probe of base ${baseSha.slice(0, 12)} for \`${cmd}\` — no second suite run paid for`,
  );
  return {
    status: "red",
    assertion: null,
    rawStream: "",
    probed: false,
    exitCode: null,
  };
}

export async function probeBaselineVerify(
  execFn: ExecFn,
  opts: {
    repoRoot: string;
    baseSha: string;
    /**
     * The probe tree is `.worktrees/baseline-verify-<issue>`. A string lets a
     * caller name a distinct probe per seam — the develop step and the
     * commit-pr step of ONE issue must not share a tree, because one step's
     * teardown removes the other's checkout. Numbers stay the develop step's
     * shape and produce byte-identical tree names.
     */
    issue: number | string;
    cmd: string;
    timeoutMs: number;
    /**
     * #1404 — the env the base run executes with. The commit-pr seam uses it to
     * point `VERIFY_REPORT_FILE` at a file only the loop can write, so the
     * names it reads back are the loop's own verdict rather than a stream a
     * test may have printed. Absent → the ambient env, which produces no report
     * at all (the offline suite's and CI's shape).
     */
    env?: NodeJS.ProcessEnv;
  },
): Promise<BaselineVerdict> {
  const { repoRoot, baseSha, cmd, timeoutMs } = opts;
  // The probe's OWN git calls (`git worktree remove/add`) run before and after
  // the project command. They are the driver's calls, not the project's, so
  // they keep the one knob that decides where the driver reports (see
  // `verifyHostEnv`): scrubbing it would move a host-channel cycle's handoff
  // into the forge for the length of one probe. The project command below is
  // scrubbed on its own `env`.
  const hostEnv = verifyHostEnv();
  // Deliberately NOT `issue-<N>-…`: the same-issue leftover scan reads that
  // prefix as a workstream's worktree, and a probe tree leaked by a killed
  // process must never park the next cycle as "dirty leftover work".
  const abs = baselineProbeWorktreePath(repoRoot, opts.issue);
  const remove = () =>
    execFn(`git worktree remove --force ${JSON.stringify(abs)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
      env: hostEnv,
    }).catch(() => undefined);
  // A leaked probe tree holds nothing but a checkout of some base commit.
  await remove();
  try {
    await execFn(`git worktree add --detach ${JSON.stringify(abs)} ${JSON.stringify(baseSha)}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      env: hostEnv,
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
      await withVerifySlot(() =>
        execFn(cmd, {
          cwd: abs,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        }),
      );
      return { status: "green" };
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        /** `execFile` puts the child's exit code here on a non-zero exit. */
        code?: number;
      };
      if (e.killed === true) return { status: "red-timed-out", assertion: null };
      const raw = combinedExecFailureStream(e);
      // A bare worktree fails every dependency-needing command; that says
      // nothing about the base commit.
      if (looksLikeMissingDeps(raw)) {
        return {
          status: "unknown",
          reason: "the base checkout failed for want of dependencies, not on the gate itself",
        };
      }
      // #1765 — a stream the gate never printed is no evidence about the base
      // commit. When the executor captured nothing, `combinedExecFailureStream`
      // falls back to the Error's own message, which node always leads with
      // `Command failed: <cmd>` — so that fallback text, with nothing real
      // beneath it, is the harness speaking and not the gate. It used to reach
      // the red arm, where the pre-develop probe turns it straight into a
      // `verify-baseline-red` PARK (and the develop gate into its excuse): a
      // broken harness would park a cycle for a base that may be perfectly
      // green. `probeBaselineVerify` can only ADD evidence, so here there is
      // none: unknown, with the reason naming what came back.
      if (baseStreamIsHarnessOnly(raw, cmd)) {
        return {
          status: "unknown",
          reason: "the base run returned no output from the gate itself, only the executor error",
        };
      }
      // #1404 — the raw stream rides back on a red verdict. The develop step's
      // consumers read only the extracted assertion, so this was discarded;
      // the commit-pr seam's per-test attribution needs the whole stream
      // (`failingTestNames` parses its `FAILED:` markers, and the 1500-char
      // assertion window would elide all but the last of them).
      const assertion = extractSpecificAssertion(extractAttributedTail(raw, 1500).tail);
      return {
        status: "red",
        assertion: assertion === NO_SPECIFIC_ASSERTION ? null : assertion.slice(0, 200),
        rawStream: raw,
        // #1404 — the gate judged itself. The loop's own SUMMARY line
        // (`verify-report.sh`'s `FAILED: <n> test(s) — …`) is the positive
        // signal, and it is printed in BOTH modes — digest mode additionally
        // prints the `P:/F:` tally, normal mode does not, so the tally cannot
        // be the requirement without leaving every non-digest base run
        // unevidenced. A run that exited non-zero WITHOUT the summary never
        // reached the report half, so its failure is not evidence about the
        // base commit's tests.
        probed: summaryCount(raw) !== undefined,
        exitCode: typeof e.code === "number" ? e.code : null,
      };
    }
  } finally {
    await remove();
  }
}

/**
 * #1765 — is `raw` nothing but node's own `Command failed: <cmd>` echo? The
 * executor error's message starts with that line and `combinedExecFailureStream`
 * hands it back verbatim when the child produced no stdout and no stderr, so a
 * stream that reduces to it is the harness talking, not the project's gate. The
 * command is stripped in escaped and quoted forms too: node echoes the whole
 * invocation, and a shell-wrapped `sh -c 'sh gate.sh'` names it inside quotes.
 */
function baseStreamIsHarnessOnly(raw: string, cmd: string): boolean {
  let rest = raw.trim();
  if (!rest.startsWith("Command failed:")) return false;
  rest = rest.slice("Command failed:".length).trim();
  // The whole invocation is one line: whatever survives the echo is content the
  // gate itself printed, so anything left means the run did produce output.
  const endOfLine = rest.indexOf("\n");
  if (endOfLine !== -1) return false;
  return stripCmdEcho(rest, cmd).length === 0;
}

/** Remove every spelling of the invoked command from the executor's echo. */
function stripCmdEcho(rest: string, cmd: string): string {
  let out = rest;
  for (const form of [cmd, JSON.stringify(cmd), `'${cmd}'`, `"${cmd}"`]) {
    if (!form) continue;
    out = out.split(form).join("").trim();
  }
  return out;
}

/**
 * The failure string for a red baseline. Kept short: cap evidence keeps only
 * the last 800 chars of each failure (work-develop-cap-evidence.ts).
 * `changeFailure` is the text the change's own run failed with — the "same
 * assertion" claim is made only when the base assertion appears in it.
 */
export function baselineRedMessage(
  verdict: RedBaselineVerdict,
  opts: { cmd: string; baseSha: string; timeoutMs: number; changeFailure: string },
): string {
  const where = `on a clean checkout of the cycle's base commit ${opts.baseSha.slice(0, 12)}, without this change`;
  if (verdict.status === "red-timed-out") {
    // #1509 — the knob named here is the one that governs the tier the probe
    // ran (the suite tier: it re-runs `.pi/verify-cmd` at base), and the bound
    // is the caller's `timeoutMs` threaded in rather than re-read, so the text
    // can only ever describe the run that actually happened.
    return `${BASELINE_RED_MARKER} ${VERIFY_TIMEOUT_LABEL} verify command \`${opts.cmd}\` exceeded its ${boundText(opts.timeoutMs)} timeout ${where} — the gate cannot finish inside its bound on this host whatever the diff contains. Raise ${TIER_KNOB.suite} (or .pi/${TIER_TIMEOUT_FILE.suite}, or ${VERIFY_TIMEOUT_ENV} in the environment) or make the gate faster; the failures below do not implicate this change`;
  }
  const same =
    verdict.assertion !== null && sharesAssertion(opts.changeFailure, verdict.assertion)
      ? " — the SAME assertion the change's run failed on"
      : "";
  return `${BASELINE_RED_MARKER} verify command \`${opts.cmd}\` ALSO FAILS ${where} — assertion at base: ${verdict.assertion ?? NO_SPECIFIC_ASSERTION}${same}. The gate was red before this change was written, so no change can pass it; the failures below cannot be attributed to this diff until the base is green. Fix the gate at the base commit (or the host it runs on), then re-run`;
}

/** One failure of the change's own verify run, for the baseline comparison. */ export interface ChangeFailure {
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
  verdict: RedBaselineVerdict,
  changeFailures: readonly ChangeFailure[],
): boolean {
  if (changeFailures.length === 0) return false;
  if (verdict.status === "red-timed-out") return changeFailures.every((f) => f.timedOut);
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
    /** #1642 — the scrubbed env the project's base run executes with. */
    env?: NodeJS.ProcessEnv;
    changeFailures: readonly ChangeFailure[];
    failures: string[];
    notes: string[];
    /**
     * #1765 — the cycle's own base verdict, when the branch step's pre-develop
     * probe already established one for the SAME (baseSha, command, bound).
     * Reusing it is the whole cost argument for that probe: the post-failure
     * comparison pays for a second throwaway worktree and a second full suite
     * run for a verdict this cycle already holds. Absent, or for a different
     * key, the probe runs as it always did.
     */
    cachedVerdict?: BaseHealthVerdict | undefined;
  },
): Promise<RedBaselineVerdict | undefined> {
  const { cmd, baseSha, timeoutMs } = opts;
  const cached =
    opts.cachedVerdict?.status === "red"
      ? matchingVerdict(opts.cachedVerdict, { baseSha, command: cmd, tierBoundMs: timeoutMs })
      : undefined;
  const verdict: BaselineVerdict =
    cached === undefined
      ? await probeBaselineVerify(execFn, opts)
      : reuseCachedVerdict(cached, opts.notes, cmd, baseSha);
  if (!isRedBaseline(verdict)) {
    opts.notes.push(
      verdict.status === "green"
        ? `baseline verify passed — \`${cmd}\` exits 0 on a clean checkout of the base commit ${baseSha.slice(0, 12)}, so the gate was green before this change`
        : `baseline verify not established — ${verdict.reason}`,
    );
    return undefined;
  }
  const changeFailure = opts.changeFailures.map((f) => f.text).join("\n");
  opts.failures.unshift(baselineRedMessage(verdict, { cmd, baseSha, timeoutMs, changeFailure }));
  // #1765 — the verdict is RETURNED, not re-derived by the caller from the entry
  // this wrote: the `red-timed-out` arm leads its entry with `[verify-timeout]`,
  // so prose matching cannot tell a red base from a killed run. #1349's excuse is
  // `baselineExplainsChange(verdict, ...)`, which the caller now computes — and a
  // verdict reused from the branch step has no stream to excuse anything with.
  return cached === undefined ? verdict : { ...verdict, reused: true };
}

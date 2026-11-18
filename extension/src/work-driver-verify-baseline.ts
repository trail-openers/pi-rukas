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
import { CAP_EVIDENCE_PER_FAILURE_MAX } from "./work-develop-cap-evidence.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  sharesAssertion,
} from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import {
  BASELINE_STALE_BASE_MARKER,
  type BaseBehindDefaultBranch,
  CMD_FLOOR,
  probeBaseBehindDefault,
  staleBaseClosing,
  timedOutRedEntry,
} from "./work-driver-verify-baseline-stale.ts";
import { verifyHostEnv } from "./work-driver-verify-cmd.ts";
import { baseStreamIsHarnessOnly } from "./work-driver-verify-echo.ts";
import { panicCanExcuseChange } from "./work-driver-verify-failures.ts";
import { combinedExecFailureStream } from "./work-driver-verify-flake.ts";
import { summaryCount } from "./work-driver-verify-names.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import { looksLikeMissingDeps, provisionWorktree } from "./worktree-provision.ts";
import { type ExecFn, worktreePath } from "./worktree.ts";

/** Leads the failure string of a red baseline; the explain renderer keys on it. */
export const BASELINE_RED_MARKER = "[baseline-red]";

/**
 * #2341 — re-exported so every reader keeps importing the baseline-red failure
 * vocabulary from ONE module (`explain-verify` and both smoke families import
 * it from here); the predicate and the probe live in
 * `work-driver-verify-baseline-stale.ts`, the §12 split of this file.
 */
export { BASELINE_STALE_BASE_MARKER, type BaseBehindDefaultBranch };

/**
 * The cap-evidence bound a baseline-red failure string has to fit — the ONE
 * `CAP_EVIDENCE_PER_FAILURE_MAX` of `work-develop-cap-evidence.ts` that keeps
 * a failure's TAIL when no `FAILED:` marker anchors it (so a string that
 * overflows loses the `[baseline-red]` marker the cap routes on AND the
 * quoted command the #1765 attribution reads, which is the artefact the
 * operator actually reads). The renderer below budgets against it instead of
 * letting a long assertion push the message past it. #2341 fix wave (T1): the
 * number is IMPORTED, not restated — a third copy of it is a number that
 * drifts.
 */
const CAP_EVIDENCE_BOUND = CAP_EVIDENCE_PER_FAILURE_MAX;

/**
 * The narrowest assertion the renderer will show before it drops the middle
 * sentence to buy room. The sentence it drops ("The gate was red before this
 * change was written …") restates the lead clause ("ALSO FAILS … WITHOUT this
 * change") in prose the operator has already read; the assertion is the half
 * they act on. The two explain routes still carry the full advice.
 */
const MIN_ASSERTION_CHARS = 120;

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
  /**
   * #1826 — the second base run's colour, carried on a REUSED arm only. A fresh run
   * has no second run yet (the confirmation asks for it); a record the probe wrote
   * states it, and that statement IS the confirmation the reuse stands on. Read
   * with the same care as the stored field of the same name
   * (`workflow-state-schema-base-health.ts`).
   */
  secondRun?: "green" | "red" | "red-timed-out" | "unknown";
  /**
   * #2341 — the stale-base probe's answer, computed by `probeBaselineVerify`
   * only on a freshly red arm. Absent (a reused arm, or an arm rebuilt from a
   * cache record) means the probe did not ask, which renders as the plain
   * fix-the-base advice — the pre-#2341 text, never a claim either way.
   */
  staleBase?: BaseBehindDefaultBranch;
}

export type RedBaselineVerdict =
  | Extract<BaselineVerdict, { status: "red" }>
  | Extract<BaselineVerdict, { status: "red-timed-out" }>;

/** True for either red arm. Lets callers test the status without duplicating it. */
export function isRedBaseline(verdict: BaselineVerdict): verdict is RedBaselineVerdict {
  return verdict.status === "red" || verdict.status === "red-timed-out";
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
      // #2341 fix wave 6 — the whole stream rides in as the veto's second
      // question's text: the verdict the window elides is read from the stream.
      const assertion = extractSpecificAssertion(extractAttributedTail(raw, 1500).tail, raw);
      // #2341 — a red base may be red only because it predates commits already
      // on the default branch (nessie 1415: the base predated the fix for the
      // very check that was red, so the handoff told the operator to fix a
      // gate no change could pass). Ask the git fact HERE, where `execFn` and
      // `repoRoot` exist — `baselineRedMessage` only renders. The probe tree
      // is detached and may lack the remote refs, so the reads run against
      // the cycle's own checkout, on the driver's host env like its other
      // git calls. A `red-timed-out` arm never gets here: a killed run
      // judges nothing, including staleness.
      const staleBase = await probeBaseBehindDefault(execFn, {
        repoRoot,
        baseSha,
        env: hostEnv,
      });
      return {
        status: "red",
        // 400, not 200: the nessie 1415 panic pair is ~206 code points and the
        // AC1 clause the operator needs ("which is over the 100 ms bound")
        // sits at the END of it — a 200-code-point clip amputated exactly the
        // decisive text. This is the STORE bound; the width that reaches the
        // operator is bounded again at render time against the 800-char
        // cap-evidence window — see {@link CAP_EVIDENCE_BOUND}.
        assertion: assertion === NO_SPECIFIC_ASSERTION ? null : assertion.slice(0, 400),
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
        staleBase,
      };
    }
  } finally {
    await remove();
  }
}

/**
 * The failure string for a red baseline, composed to FIT the 800-char
 * cap-evidence bound (see {@link CAP_EVIDENCE_BOUND}) — `changeFailure` is the
 * text the change's own run failed with, and the "same assertion" claim is
 * made only when the base assertion appears in it. The stale-base probe that
 * decides the closing advice lives in `work-driver-verify-baseline-stale.ts`
 * (#2341) and is asked by `probeBaselineVerify`, on the freshly-red arm only.
 *
 * #2341 fix wave 4 (H3) — the bound is enforced on the PUBLISHED entry: the
 * two-run prose the publishers used to append after the return is passed in
 * as `runs` and budgeted inside it. A message composed to exactly the bound
 * and then extended published past the bound it claimed to enforce.
 */
export function baselineRedMessage(
  verdict: RedBaselineVerdict,
  opts: {
    cmd: string;
    baseSha: string;
    timeoutMs: number;
    changeFailure: string;
    /** The publishers' two-run prose, budgeted as part of the entry (#2341 H3). */
    runs?: string;
  },
): string {
  const where = `on a clean checkout of the cycle's base commit ${opts.baseSha.slice(0, 12)}, without this change`;
  const suffix = opts.runs === undefined || opts.runs === "" ? "" : ` — ${opts.runs}`;
  if (verdict.status === "red-timed-out") {
    // #1509 / #2341 fix wave 6 (ISSUES 1): rendered by the handoff-renderer
    // half of the §12 split, under the same budget discipline as the red arm
    // below — see {@link timedOutRedEntry}.
    return timedOutRedEntry(BASELINE_RED_MARKER, opts.cmd, opts.timeoutMs, where, suffix);
  }
  const same =
    verdict.assertion !== null && sharesAssertion(opts.changeFailure, verdict.assertion)
      ? " — the SAME assertion the change's run failed on"
      : "";
  const assertionText = verdict.assertion ?? NO_SPECIFIC_ASSERTION;
  // #2341 — the closing advice, three-way. A base that trails the default
  // branch cannot be advised "fix the gate at the base commit": no change on
  // that base could ever make it green (nessie 1415 made an operator chase an
  // OOM that did not exist and an unfixable base for 58 minutes). The probe
  // states the git fact — the divergence and the commits — and explicitly
  // withholds causation, which only a reproduction on the base can establish.
  // An `unknown` probe keeps the classic advice but SAYS it could not check, in
  // the module's FIXED VOCABULARY (never git's own error text, which can carry
  // local paths into a public handoff), so an unreadable git call never reads
  // as "mainline does not explain the red".
  const stale = verdict.staleBase;
  const behind = stale?.status === "behind" ? stale : undefined;
  let middle =
    behind === undefined
      ? "The gate was red before this change was written, so no change can pass it; the failures below cannot be attributed to this diff until the base is green. "
      : "";
  const unknownClause =
    stale?.status === "unknown"
      ? ` (default-branch staleness could not be established: ${stale.reason})`
      : "";
  // #2341 fix wave 5 (H3) — the closing has TWO arms, widest first: the second
  // thing the budget takes from (after the middle sentence, BEFORE the cmd or
  // the assertion). The compact arm drops the commit subjects and the
  // parenthetical; the divergence count and the re-run advice stay in both.
  const closings: [string, string] = behind
    ? [staleBaseClosing(behind), staleBaseClosing(behind, { subjects: false })]
    : [
        `Fix the gate at the base commit (or the host it runs on), then re-run${unknownClause}`,
        `Fix the gate at the base commit, then re-run${unknownClause}`,
      ];
  // #2341 round 1 — the BOUND IS ENFORCED, not asserted. The stored assertion
  // is bounded at 400 by the probe, but 400 was never the width that FITS: the
  // whole message has to live inside the 800-char cap-evidence window, whose
  // fallback (`extractAttributedTail` finding no marker in a single-line
  // failure) amputates the TAIL — so a 361-char assertion pushed the
  // `[baseline-red]` marker and the quoted command, the two parts the cap's
  // routing and the operator's diagnosis read, out of the evidence artefact.
  // So the room is bought in a FIXED ORDER (#2341 fix wave 5): the middle
  // sentence first (it restates the lead clause, and both explain routes still
  // carry the full advice), then the closing's width, then the one genuinely
  // unbounded part — the operator-authored cmd, clipped with its own marker to
  // a recognition floor (#2341 fix wave 4 H3) — and ONLY THEN the assertion's
  // tail. Buying from the cmd before the closing traded the actionable half
  // #1762 exists to deliver for boilerplate that printed the branch name thrice.
  const leadOf = (cmdText: string): string =>
    `${BASELINE_RED_MARKER} verify command \`${cmdText}\` ALSO FAILS ${where} — assertion at base: `;
  const frame = (mid: string, cmdText: string, close: string): number =>
    leadOf(cmdText).length + `${same}. ${mid}${close}${suffix}`.length;
  // The assertion CHARACTERS the entry would show at a frame (the clip's `\u2026`
  // costs one) — what the floor is a floor on.
  const room = (mid: string, cmdText: string, close: string): number => {
    const budget = CAP_EVIDENCE_BOUND - frame(mid, cmdText, close);
    if (budget <= 0) return 0;
    return Math.min(assertionText.length, assertionText.length <= budget ? budget : budget - 1);
  };
  let cmdText = opts.cmd;
  const wanted = Math.min(MIN_ASSERTION_CHARS, assertionText.length);
  if (room(middle, cmdText, closings[0]) < wanted) middle = "";
  const fitting = closings.find((candidate) => room(middle, cmdText, candidate) >= wanted);
  const closing = fitting ?? closings[1];
  const budget = CAP_EVIDENCE_BOUND - frame(middle, cmdText, closing);
  if (room(middle, cmdText, closing) < wanted) {
    // The clip buys room: `buy - 1` characters of frame (its own `\u2026` costs
    // one). The cmd is quoted WHOLE whenever the room allows — the clip is the
    // last buy, and #1765 routes the cap on the command named INSIDE the entry
    // (`baselineRedForCommand` compares that span: whole, or clipped with this
    // marker).
    const buy = Math.min(wanted + 2 - budget, Math.max(0, opts.cmd.length - CMD_FLOOR - 1));
    if (buy > 0) cmdText = `${opts.cmd.slice(0, opts.cmd.length - buy)}\u2026`;
  }
  const roomLeft = room(middle, cmdText, closing);
  const shown =
    roomLeft >= assertionText.length
      ? assertionText
      : roomLeft > 0
        ? `${assertionText.slice(0, roomLeft)}\u2026`
        : "";
  return `${leadOf(cmdText)}${shown}${same}. ${middle}${closing}${suffix}`;
}

/** One failure of the change's own verify run, for the baseline comparison. */ export interface ChangeFailure {
  text: string;
  timedOut: boolean;
}

/**
 * #1349 — true only when the change's failures are demonstrably the base's:
 * every one shares the (extracted, non-null) base assertion, or the base and
 * every change run were killed at the bound. A base red some other way says
 * nothing, and a Rust panic excuses only on {@link panicCanExcuseChange}'s
 * evidence — the base run's own per-test line naming that test as FAILED.
 */
export function baselineExplainsChange(
  verdict: RedBaselineVerdict,
  changeFailures: readonly ChangeFailure[],
): boolean {
  if (changeFailures.length === 0) return false;
  if (verdict.status === "red-timed-out") return changeFailures.every((f) => f.timedOut);
  const { assertion, rawStream } = verdict;
  if (assertion === null || !panicCanExcuseChange(rawStream, assertion)) return false;
  return changeFailures.every((f) => !f.timedOut && sharesAssertion(f.text, assertion));
}

/**
 * #1809 fix round — a verdict `compareWithBaseline` may reuse, and the one flag
 * that says WHICH channel it came from. A verdict read out of `pipelineState` or
 * the cache is a plain `BaseHealthVerdict` (no flag) and may only be reused when
 * it is GREEN; the verdict of the probe this gate pass awaited out of the
 * single-flight registry carries `fromInFlightProbe: true` and may be reused in
 * either colour. Keeping the rule in the type, rather than in a caller's filter,
 * is what makes "a RED is never cached across rounds" survive a cleanup of the
 * collected/consulted split.
 *
 * #1826 adds the second half of the rule on the READER's side: a RED reused this
 * way is the comparison's first run, never its confirmation. Only a record that
 * states `secondRun: "red"` may claim the cap without a second run of its own.
 */
export type ReusableVerdict = BaseHealthVerdict & { fromInFlightProbe?: true };

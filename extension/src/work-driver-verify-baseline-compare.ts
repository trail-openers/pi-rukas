/**
 * work-driver-verify-baseline-compare — #1826: the develop gate's post-failure
 * comparison against the base commit, and the two-run rule that decides whether
 * a red base may be claimed at all.
 *
 * Split out of `work-driver-verify-baseline.ts` for the AGENTS.md §12 line cap,
 * along the seam that already existed there: the probe (`probeBaselineVerify`,
 * the arms, the finding's prose) stayed, and what moved is the CALLER-side
 * judgement — read the cycle's own verdict back, run the base command, confirm a
 * red twice, and decide what the develop gate may claim.
 *
 * The rule this module owns, and why one run is not enough (#1826): ten of
 * twenty /work cycles on one repository parked as `verify-baseline-red` on a
 * single red run of the whole-command base probe, four inside one 40-minute
 * window, while a fifth cycle started inside that window ran the same check on
 * the same mainline, passed, and merged. A single run on a loaded host is not
 * evidence about an immutable commit. So a first red is confirmed by a second run
 * of the same command on a FRESH checkout of the same base commit
 * (`confirmRedBase`), and BOTH of the develop gate's claim channels — the #1765
 * cap claim (`onBaselineRedEstablished`) and #1349's excuse
 * (`baselineExplainsChange`, which the caller computes off the returned arm) —
 * require that confirmation, or a cached record that already states a confirmed
 * second run.
 *
 * Cost discipline, unchanged: this seam runs ONLY after the change's own verify
 * has failed, never on the happy path. A green first run pays for nothing else;
 * a reused arm (a colour this cycle's own probe already saw) is the comparison's
 * first run rather than a third one.
 */
import {
  type BaseRedConfirmationResult,
  baseRunsProse,
  confirmRedBase,
} from "./work-driver-verify-base-confirm.ts";
import {
  type BaselineVerdict,
  type ChangeFailure,
  type RedBaselineVerdict,
  type ReusableVerdict,
  baselineRedMessage,
  isRedBaseline,
  probeBaselineVerify,
} from "./work-driver-verify-baseline.ts";
import { boundText } from "./work-driver-verify-develop-helpers.ts";
import type { BaseHealthKey } from "./workflow-state-schema-base-health.ts";
import { matchingVerdict } from "./workflow-state-schema-base-health.ts";
import type { ExecFn } from "./worktree.ts";

/** The args every base run of this comparison needs, as one object. */
interface BaseRunOpts {
  repoRoot: string;
  baseSha: string;
  cmd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The rebuild of a cached red into the arm the comparison reasons over.
 *
 * A cached red is reused as the comparison's FIRST run — the colour is the base's
 * and it was this cycle's own probe that saw it, so the run is not paid for
 * twice — but it is never reused as a CONFIRMED red: the record carries a colour,
 * not a stream, and a colour with no second run behind it is exactly what #1826
 * stopped trusting. The confirming run then runs for real, and `reused` still
 * lands on the returned verdict so #1349's excuse stays unearned by an arm that
 * holds no evidence.
 */
function reuseCachedVerdict(
  cached: ReusableVerdict,
  inFlight: boolean,
  notes: string[],
  cmd: string,
  baseSha: string,
): RedBaselineVerdict {
  if (cached.secondRun !== "red") {
    // The record states no confirmed second run — a record an older build wrote,
    // or one whose confirmation came back green, unknown or killed. One run saw a
    // red; the confirming run below is what decides whether that is a claim.
    notes.push(
      `baseline verify: the cached RED for base ${baseSha.slice(0, 12)} \`${cmd}\` states no confirmed second base run, so it is re-confirmed before it may claim the cap (#1826)`,
    );
  }
  // Which CHANNEL the colour came from is an operator fact, read off the flag
  // `compareWithBaseline` computed it from — NOT off a field of the verdict, which
  // `matchingVerdict`'s reader rebuilds and therefore cannot carry. A red this gate
  // pass just collected from the background probe and a red the cycle recorded in an
  // earlier round are two different runs, and the note has to say which one the
  // operator is being asked to trust.
  notes.push(
    inFlight
      ? `baseline verify reused the background base probe's RED of base ${baseSha.slice(0, 12)} for \`${cmd}\` — no second suite run paid for`
      : `baseline verify reused the cycle's RED base verdict for base ${baseSha.slice(0, 12)} \`${cmd}\` — no second suite run paid for`,
  );
  // The in-state red arm is a COLOUR without a stream, exactly as the in-flight
  // one is: whoever recorded it holds the run's evidence, and this call does not.
  // It is a `BaseHealthVerdict`, so `timedOut` is the only arm signal it carries.
  return cached.timedOut === true
    ? { status: "red-timed-out", assertion: null }
    : { status: "red", assertion: null, rawStream: "", probed: false, exitCode: null };
}

/**
 * What the develop gate's post-failure comparison established, in the one shape
 * its two claim channels read.
 *
 * `established` is the two-run answer: true only when the base was red on BOTH
 * runs. A single red run returns `undefined` — no finding, no claim, and the
 * develop failure is attributed the way a green base attributes one.
 */
export interface BaselineComparison {
  /** The arm the base was red as, as #1765 returns it. */
  verdict: RedBaselineVerdict;
  /** Both claim channels may fire on this verdict. */
  established: boolean;
}

/**
 * Why a red first run was not confirmed, in the operator's words — the sentence
 * that replaces the park with a note, so the handoff can say what the two runs
 * actually did instead of repeating a colour one of them reached.
 */
function notConfirmedProse(
  result: BaseRedConfirmationResult,
  timeoutMs: number,
): { why: string; flaky: boolean } {
  if (result.confirmation === "names-disagree") {
    return { why: "the two base runs disagree about which test failed", flaky: true };
  }
  if (result.second === undefined) {
    return {
      why: `the base run was killed at its ${boundText(timeoutMs)} bound, so it judged nothing`,
      flaky: false,
    };
  }
  return {
    why: `the second base run was ${result.second.status}, so the base is not established red`,
    flaky: true,
  };
}

/**
 * Runs the comparison after the verify command has failed (moved out of
 * work-driver-verify-verify-cmd.ts for the 500-line cap; the two-run rule is
 * #1826). A confirmed red base leads `failures` with its finding — naming BOTH
 * base runs — and returns the arm the caller turns into its two claims; anything
 * else is a note.
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
    /** The cycle's own base verdict, when the cycle holds one (see `ReusableVerdict`). */
    cachedVerdict?: ReusableVerdict | undefined;
  },
): Promise<BaselineComparison | undefined> {
  const { cmd, baseSha, timeoutMs } = opts;
  const key: BaseHealthKey = { baseSha, command: cmd, tierBoundMs: timeoutMs };
  // A run already judged for exactly this key. An `unknown` judged nothing, so it
  // never skips the probe. A GREEN is reusable from either channel; a RED only from
  // this gate pass's own in-flight probe — an in-state red is a round's worth of
  // evidence that may be stale, and re-probing is the rule this makes unreusable.
  const reusable =
    opts.cachedVerdict !== undefined &&
    opts.cachedVerdict.status !== "unknown" &&
    (opts.cachedVerdict.status === "green" || opts.cachedVerdict.fromInFlightProbe === true);
  const cached = reusable ? matchingVerdict(opts.cachedVerdict, key) : undefined;
  if (cached?.status === "green") {
    opts.notes.push(
      `baseline verify reused the cycle's cached GREEN for \`${cmd}\` at base ${baseSha.slice(0, 12)} — no second suite run paid for`,
    );
    return undefined;
  }
  // Each base run gets its own throwaway tree: the develop step's own probe is
  // `baseline-verify-<issue>` and the confirming run is
  // `baseline-verify-<issue>-base2`, so neither inherits the other's checkout and
  // neither collides with the branch step's `baseline-verify-branch-*` trees.
  const run = (label: string, boundMs: number) =>
    probeBaselineVerify(execFn, { ...opts, issue: `${opts.issue}-${label}`, timeoutMs: boundMs });
  const reused =
    cached === undefined
      ? undefined
      : reuseCachedVerdict(
          cached,
          opts.cachedVerdict?.fromInFlightProbe === true,
          opts.notes,
          cmd,
          baseSha,
        );
  // The comparison's first base run. A reused arm is that run; everything else
  // pays for it.
  const first: BaselineVerdict = reused ?? (await run("base1", timeoutMs));
  if (!isRedBaseline(first)) {
    opts.notes.push(
      first.status === "green"
        ? `baseline verify passed — \`${cmd}\` exits 0 on a clean checkout of the base commit ${baseSha.slice(0, 12)}, so the gate was green before this change`
        : `baseline verify not established — ${first.reason}`,
    );
    return undefined;
  }
  // #1826 — one red run of the gate is not a red base. A first `red-timed-out`
  // triggers no second run and keeps today's routing: no baseline-red claim, and
  // the timeout's own evidence (the cap router already routes a killed run ahead
  // of the base claim, so it is still the actionable timeout it was).
  const confirmation = await confirmRedBase(first, run, timeoutMs);
  if (confirmation.confirmation !== "confirmed-red") {
    // Never a baseline-red claim on either channel, and the develop failure is
    // left exactly as the change's own run wrote it.
    const { why, flaky } = notConfirmedProse(confirmation, timeoutMs);
    opts.notes.push(
      `baseline verify not established — \`${cmd}\` failed once at base ${baseSha.slice(0, 12)} but the base is not confirmed red: ${why}. The failures below are attributed to the change as they would be on a green base (one red base run is not evidence, #1826)`,
    );
    if (flaky) {
      opts.notes.push(
        `baseline verify: the base is FLAKY — ${baseRunsProse(confirmation)}; no baseline-red claim raised`,
      );
    }
    return undefined;
  }
  const changeFailure = opts.changeFailures.map((f) => f.text).join("\n");
  const arm = confirmation.first as RedBaselineVerdict;
  const runs = baseRunsProse(confirmation);
  opts.failures.unshift(
    `${baselineRedMessage(arm, { cmd, baseSha, timeoutMs, changeFailure })}${runs === "" ? "" : ` — ${runs}`}`,
  );
  // #1765 — the verdict is RETURNED, not re-derived by the caller from the entry
  // this wrote: the `red-timed-out` arm leads its entry with `[verify-timeout]`,
  // so prose matching cannot tell a red base from a killed run. #1349's excuse is
  // `baselineExplainsChange(verdict, ...)`, which the caller now computes — and a
  // verdict reused from the branch step has no stream to excuse anything with.
  return {
    verdict: reused === undefined ? arm : { ...arm, reused: true },
    established: true,
  };
}

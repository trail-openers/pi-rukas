import {
  baseRunsProse,
  confirmingOutcomeProse,
  publishableEvidenceText,
} from "./work-driver-verify-base-confirm-prose.ts";
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
  BASE_CONFIRM_FIRST_LABEL,
  BASE_CONFIRM_SECOND_LABEL,
  type BaseRedConfirmationResult,
  baseRunInLabelledTree,
  baseRunTreePath,
  confirmRedBase,
  reusableRedRecord,
  reusedArmProbe,
} from "./work-driver-verify-base-confirm.ts";
import {
  type BaselineVerdict,
  type ChangeFailure,
  type RedBaselineVerdict,
  type ReusableVerdict,
  baselineProbeWorktreePath,
  baselineRedMessage,
  isRedBaseline,
  probeBaselineVerify,
} from "./work-driver-verify-baseline.ts";
import { boundText } from "./work-driver-verify-develop-helpers.ts";
import type { BaseHealthKey } from "./workflow-state-schema-base-health.ts";
import { matchingVerdict } from "./workflow-state-schema-base-health.ts";
import type { ExecFn } from "./worktree.ts";

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
      `baseline verify: the cached RED for base ${baseSha.slice(0, 12)} \`${publishableEvidenceText(cmd)}\` states no confirmed second base run, so it is re-confirmed before it may claim the cap (#1826)`,
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
      ? `baseline verify reused the background base probe's RED of base ${baseSha.slice(0, 12)} for \`${publishableEvidenceText(cmd)}\` — no second suite run paid for`
      : `baseline verify reused the cycle's RED base verdict for base ${baseSha.slice(0, 12)} \`${publishableEvidenceText(cmd)}\` — no second suite run paid for`,
  );
  // The in-state red arm is a COLOUR without a stream, exactly as the in-flight
  // one is: whoever recorded it holds the run's evidence, and this call does not.
  // It is a `BaseHealthVerdict`, so `timedOut` is the only arm signal it carries.
  // The arm is a COLOUR without a stream — whoever recorded it holds the run's
  // evidence, and this call does not — and `secondRun` rides on it because the
  // confirmation downstream reads the ARM, not the caller's record. Rebuilding the
  // colour alone was the defect: a probe's own confirmed red reached
  // `confirmRedBase` stating no second run, was refused for want of evidence it had
  // already paid for, and the cycle lost its `baseline-red` claim — while
  // `established`, read separately off the caller's record, still said true. The two
  // halves of one answer had to agree, and only the arm can carry both.
  return {
    ...(cached.timedOut === true
      ? { status: "red-timed-out", assertion: null }
      : { status: "red", assertion: null, rawStream: "", probed: false, exitCode: null }),
    ...(cached.secondRun === undefined ? {} : { secondRun: cached.secondRun }),
  };
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
 *
 * Every arm names the CONFIRMING run's own outcome, from
 * `confirmingOutcomeProse`: a pair whose second run came back green is never
 * described as "red", and a run that could not be read never borrows the
 * killed-at-its-bound sentence. `flaky` says whether the two runs disagreed about
 * the base (which is what makes the FLAKY note true), not whether a run failed.
 */
function notConfirmedProse(
  result: BaseRedConfirmationResult,
  timeoutMs: number,
): { why: string; flaky: boolean } {
  if (result.confirmation === "names-disagree") {
    return {
      why: "the two base runs named different failing tests",
      flaky: true,
    };
  }
  if (result.confirmingOutcome !== undefined) {
    // A second run that ran and told us nothing conclusive: killed at its bound or
    // unreadable. Each is named by the confirming run's own arm. The names-disagree
    // case is handled above, because there the pair disagreed and this function must
    // not overwrite that with a single run's colour.
    return { why: result.confirmingOutcome, flaky: confirmingRunWasFlaky(result) };
  }
  if (result.second === undefined && !result.ranSecond) {
    return {
      why: `the base run was killed at its ${boundText(timeoutMs)} bound, so it judged nothing`,
      flaky: false,
    };
  }
  return {
    why: `the second base run was ${result.second?.status ?? "not established"}, so the base is not established red`,
    flaky: true,
  };
}

/**
 * True when the confirming run DISAGREED with a red first run about the base —
 * which is the FLAKY shape — and false when it merely failed to judge (killed at
 * its bound, or a run that could not be read). A run that reached no verdict is not
 * evidence of a base that changes colour; calling it flaky would tell an operator to
 * chase a nondeterministic test when the actionable fact is the bound.
 */
function confirmingRunWasFlaky(result: BaseRedConfirmationResult): boolean {
  const outcome = result.confirmingOutcome ?? "";
  return outcome.includes("green") || outcome.includes("different failing tests");
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
  // A run already judged for exactly this key, read through the ONE reader
  // (`matchingVerdict`: shape checks, then key match). Its return type is the
  // stored record's — it rebuilds the object, so a caller's channel flag does not
  // survive it and nothing downstream may read one. What it DOES pass through,
  // because the record itself states it, is `secondRun`.
  const cached = opts.cachedVerdict ? matchingVerdict(opts.cachedVerdict, key) : undefined;
  // A GREEN reuses from either channel; a RED only from this gate pass's own
  // in-flight probe, and only when its RECORD states the confirming run; a killed
  // arm never. The predicate is exported from the module that owns the two-run rule
  // so the reuse gate and `confirmRedBase`'s reused arm cannot drift into two
  // answers about one record — and it is read off the reader's product above, not
  // the caller's argument, so a hand-built value that merely resembles a record
  // cannot widen it.
  const fromInFlightProbe = opts.cachedVerdict?.fromInFlightProbe === true;
  const reusable = reusableRedRecord(cached, fromInFlightProbe);
  if (reusable === "green") {
    opts.notes.push(
      `baseline verify reused the cycle's cached GREEN for \`${publishableEvidenceText(cmd)}\` at base ${baseSha.slice(0, 12)} — no second suite run paid for`,
    );
    return undefined;
  }
  // Each base run gets its own throwaway tree, through the helper BOTH base seams
  // share: the develop step's own probe is `baseline-verify-<issue>` and the
  // confirming run is `baseline-verify-<issue>-base2`, so neither inherits the
  // other's checkout and neither collides with the branch step's
  // `baseline-verify-branch-*` trees.
  const tree = (label: string) => baseRunTreePath(opts.repoRoot, opts.issue, label);
  const run = baseRunInLabelledTree(execFn, {
    repoRoot: opts.repoRoot,
    baseSha,
    cmd,
    issueLabel: opts.issue,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  // A KILLED arm is never reused — `reusableRedRecord` already refused it, and it
  // also refuses a red whose record states no confirming second run — so the only
  // arm that reaches this rebuild is one whose own record says it was watched twice.
  const reused =
    reusable !== "red" || cached === undefined
      ? undefined
      : reuseCachedVerdict(cached, fromInFlightProbe, opts.notes, cmd, baseSha);

  // A REUSED arm is the whole answer about its base, so the confirmation asks for
  // no second run at all — and `reused: true` is what says so to
  // `confirmRedBase`, which is where the short-circuit lives. Both halves matter:
  // the flag alone is not enough, because the arm the confirmation reads is this
  // one, and a plain arm reaching that seam pays for a suite run whose tree then
  // becomes the only root its name rule can anchor the pair in.
  if (reused !== undefined) {
    // The finding still leads `failures`: the reuse is the comparison's answer
    // about the base, and an operator reading the handoff must see the base's
    // command named there whichever way the colour arrived. Its evidence is the
    // arm's own (`reused` means no stream, so no assertion and no bound beyond
    // what the arm's status states), and the run line says plainly that a second
    // run was not paid for here.
    //
    // `confirmRedBase` is asked, and it answers from the arm: a reused red whose
    // record states `secondRun: "red"` is confirmed without a run, and every other
    // reused colour is refused, so no arm slips past the rule by arriving through
    // the cache. The injected probe is never called on that path — a reused verdict
    // runs no gate, and a probe that could run would defeat the reuse — so reaching
    // for it is the assertion that this seam pays nothing here.
    const confirmation = await confirmRedBase(
      { ...reused, reused: true },
      reusedArmProbe(),
      timeoutMs,
    );
    if (confirmation.confirmation !== "confirmed-red") {
      // A reuse the confirmation refuses is not a green base and not a red one: it
      // is a colour with no second run behind it, and the operator reading the
      // handoff has to be able to tell that apart from "the base is fine".
      opts.notes.push(
        `baseline verify: the cached RED for base ${baseSha.slice(0, 12)} \`${publishableEvidenceText(cmd)}\` was refused by the two-run rule (${confirmation.confirmation}) — no baseline-red claim`,
      );
      return undefined;
    }
    const changeFailure = opts.changeFailures.map((f) => f.text).join("\n");
    const runs = baseRunsProse(confirmation);
    opts.failures.unshift(
      `${baselineRedMessage(confirmation.first as RedBaselineVerdict, { cmd, baseSha, timeoutMs, changeFailure })}${runs === "" ? "" : ` — ${runs}`}`,
    );
    return {
      verdict: { ...reused, reused: true },
      // The claim is the RECORD's confirmation, read through the same predicate the
      // reuse gate used: `reusable === "red"` is exactly "an in-flight red whose
      // record states `secondRun: \"red\"`", so the note above and the claim below
      // cannot come from two different readings of one record.
      established: reusable === "red",
    };
  }
  // The comparison's first base run. A reused arm is that run; everything else
  // pays for it.
  //
  // The arm carries `secondRun` and `reused` forward, and both are load-bearing
  // rather than decorative:
  //
  //  - `reused` tells `confirmRedBase` not to pay for a second suite run whose
  //    answer the record already contains, and tells #1349's excuse rule that this
  //    colour has no stream to evidence an excuse with;
  //  - `secondRun` is the confirmation itself — the one field that says the probe
  //    watched BOTH runs and they agreed. Dropped on this projection, a confirmed
  //    reuse reached the confirmation looking like a single unconfirmed run, which
  //    cost a suite re-run and let the name rule (with no tree left to anchor in)
  //    answer "disagree" about a base the cycle had already established twice.
  //
  // `matchingVerdict` rebuilds the record from the stored fields, so neither is
  // carried by `cached` itself — the reader keeps only what a cache file may state.
  const first: BaselineVerdict = reused ?? (await run(BASE_CONFIRM_FIRST_LABEL, timeoutMs));
  if (!isRedBaseline(first)) {
    opts.notes.push(
      first.status === "green"
        ? `baseline verify passed — \`${publishableEvidenceText(cmd)}\` exits 0 on a clean checkout of the base commit ${baseSha.slice(0, 12)}, so the gate was green before this change`
        : `baseline verify not established — ${publishableEvidenceText(first.reason)}`,
    );
    return undefined;
  }
  // #1826 — one red run of the gate is not a red base. A first `red-timed-out`
  // triggers no second run (nothing judged is nothing to confirm) and keeps
  // today's EVIDENCE: the finding is written, because "the gate cannot finish on a
  // clean checkout of the base whatever the diff contains" is the operator's
  // actionable sentence for this shape and nothing else says it. What the killed
  // arm does NOT get is the CLAIM — `established` stays false, so neither the
  // #1765 cap claim nor #1349's excuse can be built on a run that reached no
  // verdict, and the cap router keeps routing the timeout ahead of the base.
  //
  // A REUSED arm arrives with no tree to anchor its names in: the throwaway
  // checkout that printed the stream has been removed, so the name rule ("do the
  // two runs name the same test?") has nothing to strip and would report every
  // pair as `unknown` — a disagreement the record never had. The record is the
  // confirmation: `secondRun: "red"` states that the probe watched both runs and
  // they agreed, and #1826's name rule is spent in producing it. Passing no roots
  // is what says so, and it makes an empty `commonNames` IMPOSSIBLE here — an
  // anchored comparison with a missing root can only ever answer "disagree", which
  // would throw away a confirmation this cycle already paid for (and the
  // no-name-anchoring path returns [] only for a stream that named nothing).
  const roots =
    reused === undefined
      ? {
          firstRoot: tree(BASE_CONFIRM_FIRST_LABEL),
          secondRoot: tree(BASE_CONFIRM_SECOND_LABEL),
        }
      : undefined;
  const confirmation = await confirmRedBase(first, run, timeoutMs, roots);
  if (confirmation.confirmation !== "confirmed-red") {
    // Never a baseline-red claim on either channel, and the develop failure is
    // left exactly as the change's own run wrote it.
    const { why, flaky } = notConfirmedProse(confirmation, timeoutMs);
    opts.notes.push(
      `baseline verify not established — \`${publishableEvidenceText(cmd)}\` failed once at base ${baseSha.slice(0, 12)} but the base is not confirmed red: ${publishableEvidenceText(why)}. The failures below are attributed to the change as they would be on a green base (one red base run is not evidence, #1826)`,
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

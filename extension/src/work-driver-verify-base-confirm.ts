import {
  commonNames,
  everyNameUnplaceable,
  named,
  namesOf,
} from "./work-driver-verify-base-confirm-names.ts";
import { confirmingOutcomeProse } from "./work-driver-verify-base-confirm-prose.ts";
/**
 * work-driver-verify-base-confirm — #1826: a base commit is red TWICE before a
 * cycle may park as `verify-baseline-red`.
 *
 * Why (#1826): one production repository, one day, ten of twenty /work cycles
 * parked as `verify-baseline-red` on a SINGLE red run of the whole-command base
 * probe — four of them inside one 40-minute window, while a fifth cycle started
 * inside that window ran the same check on the same mainline, passed it, and
 * merged. The park's evidence said "no specific assertion could be extracted",
 * so the red that failed ten cycles named no test at all. A single run of a
 * loaded host's gate is not evidence about an immutable commit: queueing behind
 * other cycles' verify slots, a per-test kill, or a dependency that settled late
 * all make one run lie.
 *
 * #1647's selected-verify path already refused this (`judge` in
 * `work-driver-verify-select-exec.ts` runs `probe` then `probe2` and requires
 * red on both). This module extends that discipline to the whole-command probe
 * every project uses. It is a behavioural model only: the selected-verify code
 * is neither changed nor reused, and this seam makes its own second
 * `probeBaselineVerify` call.
 *
 * The decision rule, in one table (first run → second run → answer):
 *
 *   red / red-timed-out     → no second run at all: today's routing is kept
 *   unknown / green         → no second run at all (not red)
 *   red + green             → not-confirmed  (a flaky base; never a park)
 *   red + unknown           → not-confirmed
 *   red + red-timed-out     → not-confirmed
 *   red + red, names on both, ≥1 common name → confirmed-red
 *   red + red, names on both, disjoint        → names-disagree
 *   red + red, names on exactly one           → names-disagree
 *   red + red, names on neither               → confirmed-red
 *   red + red, names neither run can place    → confirmed-red ("unplaceable-names")
 *
 * The name rule's arms are not decoration. `failingTestNames` returns `[]`
 * whenever the stream's `FAILED: <n> test(s)` summary disagrees with its
 * per-file markers — the normal outcome for a non-loop gate — so a rule that
 * required names would refuse every legitimate red base. Requiring nothing on
 * both would let two runs that failed DIFFERENT tests excuse each other, and
 * "one side named" is precisely that shape: one run saw which test broke, the
 * other saw nothing, and the disagreement is between the runs, not between the
 * base and the change.
 *
 * What this module never does: it never runs the gate itself (the caller injects
 * `probe`, which is `probeBaselineVerify` in production — so the second run's
 * cost, its bound, and its fresh tree are the caller's to pin), never treats a
 * killed or unreadable run as a confirming red, and never caches.
 */
import {
  type BaselineVerdict,
  baselineProbeWorktreePath,
  isRedBaseline,
  probeBaselineVerify,
} from "./work-driver-verify-baseline.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import type { ExecFn } from "./worktree.ts";

/** The label of the first base run of a confirmation — the probe's own tree. */
export const BASE_CONFIRM_FIRST_LABEL = "base1";
/**
 * The label of the confirming run. Distinct from the first on purpose: the
 * second run is a fresh `git worktree add` of the same base commit, because a
 * reused tree inherits whatever the first run's gate wrote into its own
 * checkout — which is a second source of flakiness, not a control.
 */
export const BASE_CONFIRM_SECOND_LABEL = "base2";

/**
 * The two trees a base run's names are anchored in.
 *
 * Each run prints its failures under ITS OWN absolute tree, and the two runs of
 * one confirmation are two different throwaway checkouts of one commit — so raw
 * string equality between their names is false for every test in the repo, and a
 * rule built on it would refuse every legitimate red base. This is the same
 * anchoring #1404's commit-pr attribution uses (`compareNames`): a name must sit
 * inside one of the trees this seam knows, and the paths RELATIVE to those roots
 * must be equal.
 */
export interface BaseConfirmRoots {
  /** The first run's throwaway tree. */
  firstRoot: string;
  /** The confirming run's throwaway tree. */
  secondRoot: string;
}

/** What the two base runs established, as the callers of this rule report it. */
export type BaseRedConfirmation = "confirmed-red" | "not-confirmed" | "names-disagree";

/**
 * The ONE reuse predicate (#1826 round 1): may a cached verdict stand in for a run
 * of the gate, and in which colour?
 *
 * The two develop-gate seams that answer this (`compareWithBaseline`'s reuse gate
 * and `confirmRedBase`'s reused arm) used to answer it twice, in two vocabularies,
 * and the two answers could drift — a record one seam reused and the other refused
 * is a colour that reaches a claim no run backs. One predicate, asked by both.
 *
 * The rules it encodes, and why each is drawn where it is:
 *
 * - **`unknown` never reuses.** A run that reached no verdict judged nothing, so it
 *   is not evidence about anything and must not skip the probe.
 * - **a GREEN reuses from either channel** (the cycle's own state or this gate
 *   pass's background probe). An immutable commit, judged by the same key.
 * - **a RED reuses only from this gate pass's own in-flight probe, and only when the
 *   RECORD states `secondRun: "red"`.** The record is read, not the caller's copy:
 *   `matchingVerdict` rebuilds the object from the fields a cache file may state,
 *   so a hand-built value that merely resembles a record cannot widen the rule.
 *   Anything else has been judged ONCE, which is precisely the evidence #1826
 *   refuses to act on — including an in-state red left by an earlier develop round,
 *   which is re-probed so one flaky red cannot speak for rounds it did not run in.
 * - **a KILLED red never reuses**, whatever colour its record carries. The bound it
 *   hit is the actionable diagnosis and a re-run on the same host re-derives nothing
 *   about it; and the arm the reuse rebuilds cannot state that it was killed
 *   (`ReusableVerdict` has no `timedOut`), so an arm that cannot name its own arm is
 *   one no evidence may be built from — the #1765 lens-round-1 defect, which read a
 *   killed gate's timeout as a plain red base.
 */
export function reusableRedRecord(
  cached: BaseHealthVerdict | undefined,
  /** True when this verdict is the colour THIS gate pass's background probe saw. */
  fromInFlightProbe: boolean,
): "green" | "red" | undefined {
  if (cached === undefined || cached.status === "unknown") return undefined;
  if (cached.timedOut === true) return undefined;
  if (cached.status === "green") return "green";
  return fromInFlightProbe && cached.secondRun === "red" ? "red" : undefined;
}

/**
 * What a confirming run that THREW establishes: nothing, and never a red. The arm
 * the caller keeps, the note it writes, and the reason the record carries all come
 * from this one value so a paid-for first red cannot collapse into "the base is
 * fine" and cannot gain a claim it never earned.
 */
export const CONFIRMING_RUN_UNREADABLE = "could not be read" as const;

/**
 * The probe a REUSED arm is confirmed with. It never runs: the record IS the
 * confirmation, so a reused arm short-circuits before the probe is reached, and the
 * function handed to that seam is written to be UNCALLABLE — a reuse that quietly
 * bought a suite run would be the cost rule this issue exists to enforce, lost.
 */
export function reusedArmProbe(): () => Promise<BaselineVerdict> {
  return () => Promise.reject(new Error("a reused verdict must not run the gate (#1826)"));
}

/**
 * The ONE "run the project's command once in a labelled throwaway tree" helper
 * (#1826 round 1, the simplicity lens). Both seams that probe the base build this
 * call — the branch step's background probe and the develop gate's post-failure
 * comparison — and each used to spell out its own `probeBaselineVerify` argument
 * list and its own tree name, which is how two seams drift apart on provisioning,
 * the scrubbed env, the bound, or the tree-naming rule while both still "work".
 *
 * `issueLabel` is the seam's own namespace (`branch-<issue>` for the background
 * probe, `<issue>` for the develop gate) and is load-bearing: two seams sharing one
 * throwaway checkout is how one step's teardown removes the other's tree mid-run.
 * `env` is the scrubbed env the project's command runs with; omitted, the ambient
 * env is used, exactly as `probeBaselineVerify` defaults it.
 */
export function baseRunInLabelledTree(
  exec: ExecFn,
  o: {
    repoRoot: string;
    baseSha: string;
    cmd: string;
    issueLabel: string | number;
    env?: NodeJS.ProcessEnv;
  },
): (label: string, boundMs: number) => Promise<BaselineVerdict> {
  return (label, boundMs) =>
    probeBaselineVerify(exec, {
      repoRoot: o.repoRoot,
      baseSha: o.baseSha,
      issue: `${o.issueLabel}-${label}`,
      // ↑ The caller passes the LABEL ALONE (`base1` / `base2`, i.e.
      // `BASE_CONFIRM_FIRST_LABEL`), never an already-prefixed name:
      // `probeBaselineVerify` adds its own `baseline-verify-` prefix and this helper
      // adds the seam's namespace. A caller that passed `…-base1` would build
      // `…-base1-base1`, and the tree the run actually executed in would not be the
      // tree the caller's `tree(label)` computes — so the name rule would anchor the
      // pair in a directory no run ever had, and every red base would come back
      // "names could not be placed".
      cmd: o.cmd,
      timeoutMs: boundMs,
      ...(o.env === undefined ? {} : { env: o.env }),
    });
}

/** The tree one labelled base run executes in — the root its names are anchored in. */
export function baseRunTreePath(
  repoRoot: string,
  issueLabel: string | number,
  label: string,
): string {
  return baselineProbeWorktreePath(repoRoot, `${issueLabel}-${label}`);
}

/**
 * Run the confirming probe and fold a fault into the arm #1826 gives an unreadable
 * run: `not-confirmed`, keeping the first run's arm. A probe that throws is the
 * executor's problem, not evidence about the base — but collapsing the first red
 * into `unknown` would throw away the one run this cycle paid for and re-ask a
 * question the gate already answered. So the outcome is a refusal to confirm, and
 * the note says the confirming run could not be read.
 */
export async function runConfirmingProbe(
  probe: () => Promise<BaselineVerdict>,
): Promise<{ second: BaselineVerdict } | { failed: true }> {
  try {
    return { second: await probe() };
  } catch {
    return { failed: true };
  }
}

/**
 * The two runs a confirmation judged, kept so the evidence can name both.
 * A REUSED arm stands in for its own confirming run: the record states that the
 * probe watched both, which is the whole confirmation, and no second stream
 * exists to show.
 */
export interface BaseRedConfirmationRuns {
  /** The run that asked the question: the probe's first run at the base. */
  first: BaselineVerdict;
  /** The confirming run — absent when the first run's arm decided alone. */
  second?: BaselineVerdict;
}

export interface BaseRedConfirmationResult extends BaseRedConfirmationRuns {
  confirmation: BaseRedConfirmation;
  /** True when a second run of the gate was paid for. */
  ranSecond: boolean;
  /** The first run's names, when its stream carried them (see the header). */
  firstNames?: readonly string[];
  /** The confirming run's names, when it ran and its stream carried them. */
  secondNames?: readonly string[];
  /** Names both red runs named — the overlap the confirmed-red arm requires. */
  commonNames?: readonly string[];
  /**
   * #1826 round 1 — what the CONFIRMING run actually reached, in the words the
   * record and the consultation note must use. Absent when no second run ran, and
   * never a colour the run did not reach: `"could not be read"` is what a probe that
   * threw establishes, and the sentence "the confirming run was red" is reserved for
   * a pair this seam actually watched fail twice.
   */
  confirmingOutcome?: string;
  /**
   * #1826 round 1 — the evidence sentence for the arms a name comparison cannot
   * answer: set when the two runs named failing tests that NO anchored comparison
   * could place, so the confirmation rests on two red runs and the operator is
   * told that rather than a name match that never happened.
   */
  namesUnplaceable?: true;
}

/**
 * The arms `decided` accepts. `unplaceable-names` is one of them and NOT a member
 * of `BaseRedConfirmation`: it confirms, and callers decide on `confirmation`, so
 * what they receive is `confirmed-red` carrying the structured flag that says the
 * claim rests on two red runs rather than on a name comparison nobody made.
 */
type DecidedConfirmation = BaseRedConfirmation | "unplaceable-names";

function decided(
  confirmation: DecidedConfirmation,
  runs: BaseRedConfirmationRuns,
  ranSecond: boolean,
  firstNames?: string[],
  secondNames?: string[],
  commonNames?: string[],
  confirmingOutcome?: string,
): BaseRedConfirmationResult {
  // `unplaceable-names` is an internal arm: it confirms, and callers decide on
  // `confirmation`, so what they receive is `confirmed-red` carrying the structured
  // flag that says the claim rests on two red runs rather than on a name comparison
  // nobody made.
  const unplaceable = confirmation === "unplaceable-names";
  return {
    confirmation: unplaceable ? "confirmed-red" : confirmation,
    first: runs.first,
    ...(runs.second === undefined ? {} : { second: runs.second }),
    ranSecond,
    ...(firstNames === undefined ? {} : { firstNames }),
    ...(secondNames === undefined ? {} : { secondNames }),
    ...(commonNames === undefined ? {} : { commonNames }),
    ...(confirmingOutcome === undefined ? {} : { confirmingOutcome }),
    ...(unplaceable ? { namesUnplaceable: true as const } : {}),
  };
}

/**
 * Judge a first red base run, running the gate a second time when (and only
 * when) the first run's arm leaves the question open.
 *
 * `probe` is the seam's whole cost: one run of the project's command on a fresh
 * checkout of `baseSha` under `label`, bounded by `timeoutMs`. The caller owns
 * all four — this module decides WHETHER a run is owed, never how it is paid for.
 */
export async function confirmRedBase(
  first: BaselineVerdict,
  /**
   * Run the project's command once, on a FRESH checkout of the base commit, under
   * `label`. The production caller passes a bound `probeBaselineVerify`; a test
   * injects the arm it wants to observe. `timeoutMs` is the first run's tier
   * bound, and the production caller hands it to the exec verbatim, so the second
   * run is bounded by the same wall clock as the first.
   */
  probe: (label: string, timeoutMs: number) => Promise<BaselineVerdict>,
  timeoutMs: number,
  /**
   * The two trees the runs execute in — required to compare their names. Omit
   * them (or pass empty strings) when a run's tree no longer exists, as for a
   * REUSED arm whose throwaway checkout was already removed: anchoring is then
   * impossible, and the caller is asserting that this arm's confirmation came
   * from its record rather than from a name comparison.
   */
  roots: BaseConfirmRoots = { firstRoot: "", secondRoot: "" },
): Promise<BaseRedConfirmationResult> {
  // A first `red-timed-out` is a red arm for TODAY's routing (the timeout
  // evidence, the timeout's cap precedence) but it judged nothing, so there is
  // no second run to reason about: it keeps its existing route untouched rather
  // than paying a full suite run to re-learn that the gate cannot finish.
  if (first.status === "red-timed-out") return decided("not-confirmed", { first }, false);
  // `green` and `unknown` are not red: nothing to confirm, and the PM decision
  // for a first `unknown` is explicit — a run that reached no verdict triggers
  // no second run. Both reach here only on the red branch of the callers, so an
  // answer here is a defensive one, never a route a cycle takes.
  if (!isRedBaseline(first)) return decided("not-confirmed", { first }, false);
  // A REUSED arm is ANSWERED FROM ITS RECORD rather than by re-running the gate.
  // `secondRun: "red"` is the one thing that may say the base failed twice: the
  // probe watched both runs when it wrote it, and the throwaway tree that printed
  // either stream is gone — so a second run here buys a full suite execution for an
  // answer the cycle already holds, and the name rule could not anchor the pair
  // anyway (a reused arm carries no stream, so its names are unplaceable and the
  // pair would come back "exactly one run named", discarding a confirmation this
  // cycle already paid for).
  //
  // A record stating any other colour, or nothing, has been judged ONCE, and #1826
  // does not act on once. That answer is returned, not left to the probe: the
  // caller's reuse branch injects a probe that REJECTS on purpose — reaching it is
  // the failure its assertion is made of, never a run to be quietly bought — so a
  // refusal that fell through would fault the comparison instead of reporting the
  // colour for what it is.
  if (first.reused === true) {
    return first.secondRun === "red"
      ? decided("confirmed-red", { first, second: first }, false)
      : decided("not-confirmed", { first }, false);
  }
  // A confirming run that THREW is not evidence about the base in either
  // direction: it is not a red (nothing was watched fail), and it is not a green
  // (the cycle paid for a first run that did fail). So the answer is a refusal to
  // confirm that KEEPS the first run's arm, and `ranSecond: true` records that the
  // second run was paid for. Folding the fault into `unknown` would discard the
  // paid-for first red; treating it as a red would be the #1765 defect in new
  // clothes.
  const ran = await runConfirmingProbe(() => probe(BASE_CONFIRM_SECOND_LABEL, timeoutMs));
  if ("failed" in ran) {
    return decided(
      "not-confirmed",
      { first },
      true,
      undefined,
      undefined,
      undefined,
      `the confirming run ${CONFIRMING_RUN_UNREADABLE}`,
    );
  }
  const second = ran.second;
  const firstNames = namesOf(first, roots.firstRoot);
  // A killed second run judged nothing, so it confirms nothing — even though
  // `red-timed-out` IS a red arm for today's other seams (a killed run still
  // means "the gate cannot finish"). Reading it as a confirming red is the
  // #1765 lens-round-1 shape this rule refuses to repeat, and it is why the
  // check below is on the arm rather than on `isRedBaseline`.
  if (second.status !== "red") {
    // Green, unknown or killed: the base is not established red, so the cycle
    // does not park as baseline-red and the develop failure is attributed the
    // way a green base attributes it.
    return decided(
      "not-confirmed",
      { first, second },
      true,
      firstNames,
      undefined,
      undefined,
      confirmingOutcomeProse({
        confirmation: "not-confirmed",
        first,
        second,
        ranSecond: true,
      }),
    );
  }
  const secondNames = namesOf(second, roots.secondRoot);
  if (!named(firstNames) && !named(secondNames)) {
    // Neither run named anything — the non-loop-gate case, and the reason the
    // rule is not "names must overlap": red twice is sufficient here.
    return decided("confirmed-red", { first, second }, true);
  }
  if (!named(firstNames) || !named(secondNames)) {
    // Exactly one run saw which test broke. That is a disagreement between the
    // runs about what they judged, so it is not baseline-red.
    return decided(
      "names-disagree",
      { first, second },
      true,
      firstNames,
      secondNames,
      undefined,
      "the two runs named different failing tests",
    );
  }
  // The `unplaceable-names` arm confirms exactly as "neither run named" does, and
  // is reported to the caller as that arm so no caller has to learn a fourth value
  // to decide whether a base may be claimed; the structured `namesUnplaceable` and
  // the prose below carry the distinction the operator reads. The `!named` guards
  // above narrow both lists, which is what makes them assignable here.
  if (firstNames === undefined || secondNames === undefined) {
    // Unreachable: the two guards above returned on either list being empty.
    return decided(
      "names-disagree",
      { first, second },
      true,
      firstNames,
      secondNames,
      undefined,
      "the two runs named different failing tests",
    );
  }
  const both: [readonly string[], readonly string[]] = [firstNames, secondNames];
  if (everyNameUnplaceable(both[0], both[1], roots)) {
    // Neither run's names could be placed in a tree — so the name rule has read
    // nothing, and "the runs disagree" would be a verdict on an absence of
    // evidence. Same arm as a stream that named nothing (red twice suffices), and
    // the caller's note names the difference.
    return decided("unplaceable-names", { first, second }, true, firstNames, secondNames);
  }
  const common = commonNames(both[0], both[1], roots);
  if (common.length === 0) {
    return decided(
      "names-disagree",
      { first, second },
      true,
      firstNames,
      secondNames,
      undefined,
      "the two runs named different failing tests",
    );
  }
  return decided("confirmed-red", { first, second }, true, firstNames, secondNames, common);
}

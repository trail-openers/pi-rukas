/**
 * lean/verify-red-attribution — what a RED says about WHICH gate broke.
 *
 * A red `verify` returns `reason`, one clipped sentence about the FIRST failure, and the
 * host document publishes two lists beside it: which tier went red and which criterion it
 * answers for. A step that returned only the sentence published nulls on every real red,
 * because the projection reads the record rather than parsing prose — so the step that ran
 * the checks has to write the two lists, and only it can: the tier's name exists in the
 * reason lines this step rendered, and the criterion exists in the frozen map this run's
 * `specify` recorded.
 *
 * The rule that keeps the record honest is that a name is read only out of text THIS step
 * wrote. `runTier`, `baselineRedReason` and `flakeReason` are its own renderers, so the
 * tiers it names are the tiers it ran; the criteria come from the contract's own
 * criterion→files rows matched against the failing check's own text. A project's output
 * quoted into a reason — a path it printed, a tier it guessed at — cannot put anything on
 * the record, because the reason is not evidence about itself.
 *
 * The record is omitted, not emptied, when neither half can be named: `red: { tiers: [],
 * criteria: [] }` would read as "the gate checked these and found none", which is a
 * different claim from the gate having nothing to say.
 */

import type { RedRecord } from "./state-outcome-gates.ts";
import {
  RED_CRITERIA_MAX,
  RED_CRITERIA_MAX_CHARS,
  RED_TIERS_MAX,
  RED_TIER_MAX_CHARS,
  clipNames,
} from "./state-outcome-gates.ts";
import type { Executed } from "./verify-steps.ts";

/** The tier names this step's own reason lines carry, each with its own shape. */
const TIER_REASON_PATTERNS = [
  // `runTier`: a project tier red at HEAD.
  /^verify\.([^ ]+) exited /,
  // `baselineRedReason`, whole and composed after the frozen contract's clause.
  /^baseline red: tier ([^ ]+) is red at the base commit /,
  // `flakeReason`, for the composed arms that carry a flake clause beside a real red.
  /^verify\.([^ ]+) was red on its first run /,
];

/**
 * The tier a project tier's own reason names, or `undefined` for a check that is not a tier.
 *
 * Every pattern above matches text THIS step wrote — `runTier`, `baselineRedReason` and
 * `flakeReason` are its own renderers — so the record can never name a tier the reason did
 * not, and a reason that quotes a project's output cannot put a tier on the record.
 */
function tierNameOf(reason: string): string | undefined {
  for (const pattern of TIER_REASON_PATTERNS) {
    const name = pattern.exec(reason)?.[1];
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * The tiers this step ran red.
 *
 * `armTier` is the tier the BASELINE arm settled: that tier is deliberately absent from
 * the executed results — the absence is what keeps its own reason from being overwritten
 * by the frozen contract's clause — so its name is carried in beside the arm's reason
 * rather than read back off a result that was withheld. A tier excused as a flake or over
 * the base contributes nothing: a name the gate let go would send a host to a check this
 * run does not stand on.
 */
function failedTierNames(ran: readonly Executed[], armTier: string | undefined): string[] {
  const names = ran
    .filter((one): one is { kind: "fail"; reason: string } => one.kind === "fail")
    .map((one) => tierNameOf(one.reason))
    .filter((name): name is string => name !== undefined);
  // A tier the arm composed into the reason is the SAME tier the executed results hold —
  // the withheld one is the baseline arm's, whose name the caller carries. Two entries for
  // one tier would tell a host two of the run's tiers failed.
  return [...new Set(armTier === undefined ? names : [...names, armTier])];
}

/**
 * The criteria the failing checks of this run's frozen contract answer for.
 *
 * `specify`/`challenge` recorded which test files each criterion owns, so a failing frozen
 * path maps back to the criterion it is the evidence for. A path nobody mapped — a file the
 * contract holds that no criterion claims — contributes nothing, because a criterion the
 * gate cannot point at is not one the gate can accuse.
 */
function failingCriteria(tests: Executed, testsOfRun: Record<string, string[]>): string[] {
  if (tests.kind !== "fail") return [];
  // The failing check's own text, not the step's composed reason: the composition can
  // carry a tier's tail, and a path quoted inside a test's own output is not evidence
  // about which criterion failed.
  const reason = tests.reason;
  const failing = Object.entries(testsOfRun)
    .filter(([, files]) => files.some((file) => reason.includes(file)))
    .map(([id]) => id);
  // A `command` criterion's failure reason NAMES its own id, at the front of the line the
  // step's renderer wrote it — `criterion AC2 (command tests/AC2-preserve.test.sh) failed: …`.
  // The anchor and the `failed:` tail are what keep the attribution to the step's own words:
  // `runTestFile` pastes the failing file's stdout and stderr into the detail, so a scan for
  // the bare prefix let a frozen test that echoes `criterion AC7 (command …)` add a criterion
  // this run never judged to the list a host triages on.
  const commands = [...reason.matchAll(/^criterion (AC\d+) \(command [^)]*\) failed: /gm)]
    .map((m) => m[1])
    .filter((id): id is string => id !== undefined);
  return [...new Set([...failing, ...commands])];
}

/**
 * The attribution a red gate records beside its reason, or nothing it cannot support.
 *
 * The writer clips at the record's own caps (see `state-outcome-gates.ts`), so the same
 * bounds the loader enforces are the bounds the step writes to.
 */
export function redAttribution(opts: {
  tests: Executed;
  tiers: readonly Executed[];
  armTier: string | undefined;
  testsOfRun: Record<string, string[]>;
}): RedRecord | undefined {
  const tiers = clipNames(
    failedTierNames(opts.tiers, opts.armTier),
    RED_TIERS_MAX,
    RED_TIER_MAX_CHARS,
  );
  const criteria = clipNames(
    failingCriteria(opts.tests, opts.testsOfRun),
    RED_CRITERIA_MAX,
    RED_CRITERIA_MAX_CHARS,
  );
  return tiers.length === 0 && criteria.length === 0 ? undefined : { tiers, criteria };
}

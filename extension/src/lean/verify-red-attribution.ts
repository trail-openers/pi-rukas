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
 * Two sources, and each is text this step owns. A failing frozen path is mapped back
 * through the contract's own criterion→files rows — and a path is only counted where it
 * stands at a TOKEN BOUNDARY of the check's text, so a test that merely MENTIONS another
 * criterion's path (a log line, a fixture list) contributes nothing: a runner names the
 * file it ran after a space, a `(`, a `,`, an `=` or at the line's front. The `commands` half reads the renderer's OWN composed
 * string, handed in beside the captured check, and nothing else — that line is composed
 * in `verify-commands.ts` and never by a project's toolchain, so a frozen test that
 * echoes the renderer's wording cannot put a criterion this run never judged on the list
 * a host triages on. The `command` renderer runs only AFTER the tiers, so a tier that
 * ended the run leaves `commandsReason` absent and this reads the contract alone.
 */
function failingCriteria(
  tests: Executed,
  testsOfRun: Record<string, string[]>,
  commands: readonly string[],
): string[] {
  if (tests.kind !== "fail") return [...new Set(commands)];
  // The failing check's own text, not the step's composed reason: the composition can
  // carry a tier's tail, and a path quoted inside a test's own output is not evidence
  // about which criterion failed.
  const failing = Object.entries(testsOfRun)
    .filter(([, files]) => files.some((file) => namesPath(tests.reason, file)))
    .map(([id]) => id);
  return [...new Set([...failing, ...commands])];
}

/**
 * Does this check's text NAME the path, as a path rather than as a word inside one?
 *
 * The old rule was `reason.includes(file)`, which accused a criterion whose file the test
 * only mentioned — a runner that prints its whole fixture list puts every criterion of
 * the contract in the list. A path counts where it stands at a token boundary: line start
 * or one of ` \t ( , =` before it (so the `sh` runner's `sh tests/x.test.sh`, pytest's
 * `FAILED tests/x.test.sh::case`, and a bare path at the front all match), and not
 * followed by another name character after it.
 */
function namesPath(text: string, file: string): boolean {
  return new RegExp(`(?:^|[\\s(,=])${escapeRegExp(file)}(?:$|[^\\w./-])`).test(text);
}

/** Escape a repo-relative path for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The criterion ids the step's OWN `command` renderer composed.
 *
 * `verify-commands.ts` writes `criterion AC2 (command tests/AC2-preserve.test.sh) failed:
 * …` itself and hands the string in beside the captured check, so an id found at the
 * front of THAT string is one this step judged. Scanning the captured stream instead let
 * a frozen test that echoes the renderer's wording add a criterion the run never judged —
 * a host triaging `gates.verify[].criteria` would go re-check a criterion that passed.
 */
export function commandCriterionIds(reason: string | undefined): string[] {
  if (reason === undefined) return [];
  return [...reason.matchAll(/^criterion (AC\d+) \(command [^)]*\) failed: /gm)]
    .map((m) => m[1])
    .filter((id): id is string => id !== undefined);
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
  /** The step's own composed `command`-criterion failure string, if one fired. */
  commandsReason?: string;
}): RedRecord | undefined {
  const tiers = clipNames(
    failedTierNames(opts.tiers, opts.armTier),
    RED_TIERS_MAX,
    RED_TIER_MAX_CHARS,
  );
  const criteria = clipNames(
    failingCriteria(opts.tests, opts.testsOfRun, commandCriterionIds(opts.commandsReason)),
    RED_CRITERIA_MAX,
    RED_CRITERIA_MAX_CHARS,
  );
  return tiers.length === 0 && criteria.length === 0 ? undefined : { tiers, criteria };
}

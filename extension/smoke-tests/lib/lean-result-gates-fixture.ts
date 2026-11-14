/**
 * lib/lean-result-gates-fixture — the logs and the drives the `gates` projection
 * cases share.
 *
 * Two builders, one purpose. `gatesLog` is a step log carrying EVERY gate record the
 * projection reads at once — frozen files per criterion, a red `verify` with its
 * tiers and criterion ids, a review that bought a fix wave, a handback that moved
 * origin — so one drive asserts the whole object instead of one field per fixture.
 * `gatesRun` drives records through the REAL engine and reads them back with
 * `loadRun`, which is the difference between asserting what a projection can print
 * and asserting what a run can record: a hand-written log can name a field the
 * loader would refuse, and a projection tested only against hand-written logs
 * cannot tell the two apart.
 *
 * `gates` is read from the durable record only, so every value a case asserts is a
 * value a handler wrote. A case that needs a value no handler writes is not a case —
 * it is a field the record does not carry.
 */

import type { LeanRun, Outcome, Step } from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";
import { driveRun } from "./lean-real-log-fixture.ts";
import { HEAD, URL, stepWith } from "./lean-result-fixture.ts";

/** The head the fix wave pushed — distinct from the one `verify` certified. */
export const FIX_HEAD = `${"b".repeat(39)}2`;

/** The head a rewind left standing, named by the handback's own record. */
export const UNSHIPPED = `${"c".repeat(39)}3`;

/**
 * A log built from the verdicts one case names, rather than from the option flags
 * `gatesLog` reads.
 *
 * `gatesLog` scripts a WHOLE run — the fields it fills are the ones its options can
 * ask for — and a case that needs a step whose shape no option spells (two gate
 * verdicts in sequence, a gate verdict no run would pair with the head the reporting
 * step names) would be asserting a fixture rather than a record. This takes the
 * outcomes verbatim and adds only the two steps every log must carry to be loaded at
 * all, so the ONLY thing a caller controls is what the gates and the reporting step
 * decided.
 */
export function gateSteps(steps: {
  verify: Outcome[];
  publish: Outcome;
  handback: Outcome;
  ci?: Outcome;
}): Step[] {
  let n = 0;
  const at = (state: Step["state"], outcome: Outcome): Step => ({
    key: `7:${state}:${String(n++)}`,
    state,
    startedAt: CLOCK + n,
    endedAt: CLOCK + n + 1,
    outcome,
  });
  return [
    at("ready", { kind: "ok" }),
    ...steps.verify.map((oc) => at("verify", oc)),
    at("publish", steps.publish),
    ...(steps.ci === undefined ? [] : [at("ci", steps.ci)]),
    at("handback", steps.handback),
  ];
}

/** The frozen contract as `specify` records it: path -> sha256 of the frozen bytes. */
export const FROZEN: Record<string, string> = {
  "tests/AC1-retry.test.sh": "a".repeat(64),
  "tests/AC2-backoff.test.sh": "b".repeat(64),
};

/** The same contract as the criterion record: criterion id -> the kept test files. */
export const TESTS: Record<string, string[]> = {
  AC1: ["tests/AC1-retry.test.sh"],
  AC2: ["tests/AC2-backoff.test.sh"],
};

/** One review round's counts — the four published severities and nothing else. */
export const ROUND_1 = { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 };
export const ROUND_2 = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 };

/** The one fix wave the step ran, with the full head it pushed. */
export const WAVES = [{ wave: "fix", head: FIX_HEAD }];

/** The record a `review` step writes when its own clock stopped it mid-wave. */
export const REVIEW_BOUND = {
  wave: "full" as const,
  unreviewedLanes: ["3 of 6 lenses unjudged"],
  reason: "review STEP stopped: minutes budget 20 exceeded (used 24)",
};

/** What a review that bought a fix wave and then cleared records. */
export function reviewOutcome(kind: "done" | "fixed" | "error", reason: string): Outcome {
  return {
    kind,
    reason,
    review: {
      rounds: [ROUND_1, ROUND_2].map((r) => ({ ...r })),
      waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
    },
  };
}

export interface GatesLogOpts {
  /** The frozen map on `specify`; OMITTED = the default contract, `null` = nothing froze. */
  frozen?: Record<string, string> | null;
  tests?: Record<string, string[]> | null;
  /** `null` = the log carries no `challenge` step; `budget` is the ceiling arm. */
  challenge?: "new-tests" | "none" | "budget" | null;
  /** `null` = no `verify` step at all. */
  // `undefined` is a VERDICT here, not an omission: every case whose gate is not the one
  // under test wants a green gate that goes on publishing. `null` is the omission an
  // assertion is about — a log that reached no gate at all.
  verify?: "green" | "red" | null;
  /** The red `verify`'s tier names and criterion ids; absent = it recorded none. */
  reds?: { tiers?: string[]; criteria?: string[] };
  /**
   * A run that hands back WITHOUT reaching publish — the arm that exists so a red gate
   * can be reported before any PR is opened. Only reachable under the attempt cap, so a
   * case that wants the shape without the cap's other effects asks for it here.
   */
  noPr?: boolean;
  /** The red `ci`'s tier names and criterion ids; `null`/absent = no `ci` step. */
  ci?: { tiers?: string[]; criteria?: string[] } | null;
  /** `null`/absent = the run never reached review. */
  review?: "done" | "fixed" | "error" | null;
  /** The handback's four head facts; absent = the step moved nothing. */
  heads?: {
    shippedHead?: string;
    shippedVerified?: boolean;
    unshippedHead?: string;
    unshippedReason?: string;
  };
  /** Whether a `publish` step is in the log at all (default: it is). */
  pr?: boolean;
  draft?: boolean;
  /** The head `publish` records; `null` = it recorded no head. */
  publishedHead?: string | null;
  posted?: boolean;
  /** The handback's own reason line; `null` = the record carries none. */
  handbackReason?: string | null;
}

/** The whole log one `gates` case drives, in the order the table walks it. */
export function gatesLog(opts: GatesLogOpts = {}): Step[] {
  return logThrough(opts, [
    "ready",
    "specify",
    "build",
    "challenge",
    "verify",
    "publish",
    "review",
    "ci",
    "handback",
  ]);
}

/** The states to emit, in the order the walk visits them, skipping the absent ones. */
function logThrough(opts: GatesLogOpts, order: Step["state"][]): Step[] {
  let n = 0;
  const at = (s: Step): Step => ({
    ...s,
    key: `7:${s.state}:${String(n++)}`,
    startedAt: CLOCK + n,
    endedAt: CLOCK + n + 1,
  });
  const steps: Step[] = [] as Step[];
  const push = (s: Step | undefined): void => {
    if (s !== undefined) steps.push(at(s));
  };
  for (const state of order) push(one(opts, state));
  return steps;
}

/** The one entry this log's options ask for at `state`, or `undefined` for none. */
function one(opts: GatesLogOpts, state: Step["state"]): Step | undefined {
  switch (state) {
    case "ready":
      return stepWith("ready", { kind: "ok" });
    case "specify":
      return stepWith("specify", {
        kind: "ok",
        ...(() => {
          // OMITTED means the default contract, not "nothing": every gate event is
          // present unless a case asked for the arm where it is missing, so a `null` a
          // case asserts is the absence it requested and not an artifact of a sparse log.
          if (opts.frozen === null && opts.tests === null) return {};
          const f = opts.frozen ?? FROZEN;
          const t = opts.tests ?? TESTS;
          if (f === null || t === null) return {};
          return { frozen: f, tests: t };
        })(),
      });
    case "build":
      return stepWith("build", { kind: "ok" });
    case "challenge":
      if (opts.challenge === null || opts.challenge === undefined) return undefined;
      return opts.challenge === "budget"
        ? stepWith("challenge", { kind: "budget", limit: "turns", value: 3, used: 3 })
        : stepWith("challenge", { kind: opts.challenge });
    case "verify":
      if (opts.verify === null) return undefined;
      return opts.verify === "red"
        ? stepWith("verify", {
            kind: "red",
            reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
            // A red that recorded NO attribution is a distinct case: the projection
            // publishes `tiers: null` for it, which a fixture that always filled the
            // field would never exercise.
            ...(opts.reds === undefined
              ? {}
              : {
                  red: {
                    tiers: opts.reds.tiers ?? [],
                    criteria: opts.reds.criteria ?? [],
                  },
                }),
          })
        : stepWith("verify", { kind: "green", verifiedHead: HEAD });
    case "publish": {
      if (opts.pr === false || opts.noPr === true) return undefined;
      const head = opts.publishedHead === null ? undefined : (opts.publishedHead ?? HEAD);
      return stepWith("publish", {
        kind: "ok",
        prUrl: URL,
        ...(opts.draft === undefined ? {} : { draft: opts.draft }),
        // The head is what the gate's green is matched against for EQUALITY, so a case
        // that names a published head gets the one it named and nothing else — an
        // appended default would leave a newest publish claiming a different commit and
        // `prState` would refuse `ready` for a reason the case never asked about.
        ...(head === undefined ? {} : { publishedHead: head }),
      });
    }
    case "ci":
      // A green CI is what every case whose gate is not CI's own needs to reach `land`;
      // `null` is the omission an assertion is about, and a red CI is the case's verdict.
      if (opts.ci === null) return undefined;
      if (opts.ci === undefined)
        return stepWith("ci", { kind: "green", reason: "required checks clean" });
      return stepWith("ci", {
        kind: "red",
        reason: "required checks red at the verified head",
        ...(opts.ci.tiers === undefined
          ? {}
          : { red: { tiers: opts.ci.tiers, criteria: opts.ci.criteria ?? [] } }),
      });
    case "review":
      if (opts.review === null) return undefined;
      return stepWith(
        "review",
        reviewOutcome(
          opts.review ?? "done",
          opts.review === "error"
            ? "the review step stopped at its own clock"
            : "adversarial and six-lens review clean",
        ),
      );
    case "handback":
      return stepWith("handback", {
        kind: "done",
        ...(opts.handbackReason === null
          ? {}
          : { reason: opts.handbackReason ?? "handback comment posted" }),
        posted: opts.posted !== false,
        ...(opts.heads ?? {}),
      });
    default:
      return undefined;
  }
}

/** The newest step of one state by LOG POSITION — decided or not. */
export function stepOf(run: LeanRun, state: Step["state"]): Step | undefined {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    if (run.steps[i]?.state === state) return run.steps[i];
  }
  return undefined;
}

/** The newest outcome of one state, or `undefined` when its newest step has none. */
export function outcomeOf(run: LeanRun, state: Step["state"]): Outcome | undefined {
  return stepOf(run, state)?.outcome;
}

/** The projected `gates` object, or `{}` when the document carries none. */
export function gatesOf(issue: Record<string, unknown> | undefined): Record<string, unknown> {
  return (issue?.gates ?? {}) as Record<string, unknown>;
}

/** One entry of the projected `gates.verify` list, by the state that wrote it. */
export function verifyEntry(
  issue: Record<string, unknown> | undefined,
  state: "verify" | "ci",
): Record<string, unknown> | undefined {
  const list = (issue?.gates as Record<string, unknown> | undefined)?.verify;
  if (!Array.isArray(list)) return undefined;
  return list.find((e) => (e as Record<string, unknown>).state === state) as
    | Record<string, unknown>
    | undefined;
}

/**
 * The step keys rewritten to the engine's own rule, `<issue>:<state>:<attempt>`.
 *
 * The verb fixture's `7:` keys suit the issue the verb projects; a run the ENGINE drives
 * is judged by the fold in `resume.ts`, which refuses a log whose keys are not the nth
 * entry for their state — so a driven fixture that kept the verb's keys would be refused
 * for a reason that has nothing to do with what the case is about.
 */
function rekeyed(log: Step[], issue: number): Step[] {
  const seen: Partial<Record<Step["state"], number>> = {};
  return log.map((s) => {
    const n = seen[s.state] ?? 0;
    seen[s.state] = n + 1;
    return { ...s, key: `${issue}:${s.state}:${String(n)}` };
  });
}

/**
 * How many times this run's walk visits `publish` — the walk the table in
 * `src/lean/machine.ts` prescribes, read off the verdicts this log carries. One per green
 * gate; a CI fix round or a review that pushed a fix wave earns another re-verification,
 * and a red CI after its single fix round ends the run at the reporting step instead. A
 * plan short of one leaves the run at `publish + error` and the log holds no reporting step.
 */
function publishVisits(opts: GatesLogOpts, extras: GatesRunExtras): number {
  if (opts.noPr === true) return 0;
  let gates = 1 + (opts.verify === "red" ? (extras.verifyGreenAfterRed === true ? 1 : 0) : 0);
  if (opts.review === "fixed") gates += 1;
  if (opts.ci !== undefined) gates += extras.ciRedTwice === true ? 0 : 1;
  return gates;
}

/**
 * How many build rounds this run's walk takes — the cap is three and the table bills one
 * on every edge into `build`, so a plan short of one leaves the run at `build + error`.
 */
function buildRounds(opts: GatesLogOpts, extras: GatesRunExtras): number {
  if (opts.challenge === "budget") return 1;
  let rounds = 1;
  if (opts.verify === "red" && extras.verifyGreenAfterRed !== true) rounds += 1;
  if (opts.ci !== undefined) rounds += 1;
  if (opts.ci !== undefined && extras.ciRedTwice === true) rounds += 1;
  if (opts.review === "fixed") rounds += 1;
  return Math.min(3, rounds);
}

/** What `gatesRun` may ask the engine to repeat, and why the repeat is legal. */
export interface GatesRunExtras {
  /** A red `verify` followed by a green one: the table sends a red back through
   *  `build` and a green to `publish`, which is how a run carries its first red gate
   *  AND reaches `review`. */
  verifyGreenAfterRed?: boolean;
  /** A red `ci` twice: the table gives a red CI exactly one fix round, so the second
   *  red is the one that ends the run — and the log must hold both gate entries. */
  ciRedTwice?: boolean;
}

/**
 * Records driven through the real engine and read back by `loadRun`, so the
 * projection reads what a handler wrote and a validator accepted.
 */
export async function gatesRun(
  dir: string,
  issue: number,
  opts: GatesLogOpts = {},
  extras: GatesRunExtras = {},
): Promise<{ run: LeanRun; code: number }> {
  const log = rekeyed(gatesLog(opts), issue);
  const of = <S extends Step["state"]>(state: S): Outcome[] =>
    log.filter((s) => s.state === state).map((s) => s.outcome as Outcome);

  // What the HANDLERS return, in call order, per state. The log is the record the case
  // asserts on; this is the script that makes the engine write it, so the two are not the
  // same list and the plan below is spelled per verdict rather than read off the log.
  const plan: Record<string, Outcome[]> = {
    ready: [{ kind: "ok" }],
    // The contract the case asked for, frozen — including on the arm whose LOG must show
    // no contract at all, which is what the log's `frozen: null` option is for.
    specify:
      opts.frozen === null && opts.tests === null
        ? [{ kind: "ok" }]
        : [{ kind: "ok", frozen: opts.frozen ?? FROZEN, tests: opts.tests ?? TESTS }],
    // A `challenge: budget` run never reaches build again: the table routes the ceiling
    // to handback, so a second round would be queued and never spent.
    // Every edge into `build` bills a round and the cap is three, so the plan carries one
    // `ok` per round this run's verdicts walk into: a red verify costs one, a red CI costs
    // one, a `fixed` review's re-verification costs none but the round after it may.
    build: Array.from({ length: buildRounds(opts, extras) }, () => ({ kind: "ok" })),
    challenge:
      of("challenge").length > 0
        ? of("challenge")
        : opts.challenge === "budget"
          ? [{ kind: "budget", limit: "turns", value: 3, used: 3 }]
          : [{ kind: "none" }],
    // A `fixed` review routes back through `verify` (that is the whole difference between
    // its two kinds), so a run that reviews needs one more gate verdict than one that
    // does not — and the re-verification's head is the fix wave's, which is the fact the
    // handback's head fields are about.
    verify: [
      ...(opts.noPr === true
        ? [
            {
              kind: "red",
              reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
              ...(opts.reds?.tiers === undefined
                ? {}
                : { red: { tiers: opts.reds.tiers, criteria: opts.reds.criteria ?? [] } }),
            },
          ]
        : []),
      ...(of("verify").length > 0 ? of("verify") : [{ kind: "green", verifiedHead: HEAD }]),
      // A `fixed` review routes back through the gate, and what the gate certifies then
      // is the fix wave's head. One green per visit the table makes: review's
      // re-verification, and one more after a CI fix round.
      ...(opts.noPr === true || opts.review !== "fixed"
        ? []
        : [{ kind: "green", verifiedHead: HEAD }]),
      ...(opts.noPr === true || extras.ciRedTwice !== true || opts.ci === undefined
        ? []
        : [{ kind: "green", verifiedHead: HEAD }]),
    ],
    // A second `publish` is what a CI fix round's re-verification does, and a red CI after
    // the fix round is what ends the run — so a case that carries CI reds needs one
    // publish per visit the table makes.
    publish: Array.from(
      { length: of("publish").length > 0 ? of("publish").length : publishVisits(opts, extras) },
      () =>
        (of("publish")[0] ?? {
          kind: "ok",
          prUrl: URL,
          ...(opts.draft === undefined ? {} : { draft: opts.draft }),
        }) as Outcome,
    ),
    // A run that publishes is reviewed (that is the table's whole point), so the review
    // step is scripted with its clean verdict unless the case named its own.
    review:
      of("review").length > 0
        ? of("review")
        : [
            {
              kind: opts.review === "fixed" ? "fixed" : "done",
              reason: "adversarial and six-lens review clean",
              ...(opts.review === "fixed"
                ? {
                    review: {
                      rounds: [ROUND_1, ROUND_2].map((r) => ({ ...r })),
                      waves: WAVES.map((w) => ({ wave: w.wave, head: w.head })),
                    },
                  }
                : {}),
            },
          ],
    // `ci` runs after `review`, and the table gives a red CI exactly one fix round, so a
    // run that carries two CI reds is a run that reviewed, fixed, and failed the pipeline
    // twice — which is also why `verify` needs a green for each post-fix visit below.
    ci:
      extras.ciRedTwice === true && of("ci").length > 0
        ? [of("ci")[0] as Outcome, of("ci")[0] as Outcome]
        : of("ci").length > 0
          ? of("ci")
          : [{ kind: "green", reason: "required checks clean" }],
    // The reporting step runs AFTER the table has already decided the run is over — the
    // engine routes a run that never reached publish into it so the comment, the rewind
    // and the head fields still run. So its verdict is never in the log a case asks for:
    // the engine's own handler writes it, and this plan only has to keep it silent about
    // heads the step never read.
    handback:
      of("handback").length > 0
        ? of("handback")
        : [{ kind: "done", posted: opts.posted !== false }],
  };
  if (extras.verifyGreenAfterRed === true && opts.verify === "red")
    plan.verify = [{ kind: "red", reason: "frozen tests failing" }, ...plan.verify];
  const driven = await driveRun(dir, issue, plan as never);
  return { run: driven.run, code: driven.run.result?.code ?? 10 };
}

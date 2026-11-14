/**
 * lib/lean-gates-engine-drive — one `gates` case driven by the REAL engine.
 *
 * The projection cases ask two different questions of a record. Most read a
 * hand-written `Step[]` and ask what the projection prints for it. These ask the
 * engine's own handlers to WRITE the record, then read it back with `loadRun`, so
 * every value a projection prints is one a handler wrote and the loader accepted —
 * which is the only way a case can tell "the projection prints this" apart from
 * "the test author typed this".
 *
 * The plan below is spelled per VERDICT, not read off a log: the table in
 * `src/lean/machine.ts` decides how many times a walk visits each state, and the
 * script has to hold one outcome per visit or the run ends at the step that ran
 * out of script and the case asserts on a log no real run produced.
 */

import type { Outcome, Step } from "../../src/lean/state.ts";
import { driveRun } from "./lean-real-log-fixture.ts";
import type { DrivenRun } from "./lean-real-log-fixture.ts";
import { HEAD, URL } from "./lean-result-fixture.ts";

/** What one engine-driven `gates` run is asked to do. */
export interface EngineGatesRun {
  /** The challenger's verdict, and with it whether a second build round is earned. */
  challenge?: "new-tests" | "none" | "budget";
  /** The gate's verdicts, in the order the walk meets them. */
  verify?: ("green" | "red")[];
  /** The red gate's attribution, on every red in `verify`. */
  reds?: { tiers?: string[]; criteria?: string[] };
  /** The pipeline's verdicts, in the order the walk meets them. */
  ci?: ("green" | "red")[];
  /** The red pipeline's attribution. */
  ciReds?: { tiers?: string[]; criteria?: string[] };
  /** The review's verdicts, and the record each one writes. */
  review?: ("done" | "fixed")[];
  /** The contract `specify` froze; absent = its step recorded none, which the projection
   *  publishes as two nulls rather than an empty object. */
  frozen?: Record<string, string>;
  tests?: Record<string, string[]>;
  /** What the review step records as what it judged, on every round. */
  record?: { rounds: Record<string, number>[]; waves: { wave: string; head: string }[] };
  /** The head each green gate certifies. */
  verifiedHead?: string;
  /** The head `publish` says it shipped. */
  publishedHead?: string;
  /** The handback's own four head facts, verbatim on the reporting step. */
  heads?: Record<string, unknown>;
  /** Whether the reporting step says its comment reached the forge. */
  posted?: boolean;
  /** Whether `land` merges or refuses; `refused` is the arm that hands back. */
  land?: "merged" | "refused";
}

/** How many times a walk that took these verdicts visits `build` — cap is three. */
function buildRounds(r: EngineGatesRun): number {
  if (r.challenge === "budget") return 1;
  let rounds = 1;
  // The challenger's new tests buy the one extra build the table bills on the way back
  // into it, whether or not the case also named a gate red.
  if (r.challenge === "new-tests") rounds += 1;
  for (const v of r.verify ?? []) if (v === "red") rounds += 1;
  for (const v of r.ci ?? []) if (v === "red") rounds += 1;
  return Math.min(3, rounds);
}

/** The plan one `EngineGatesRun` asks for, per verdict rather than per log entry. */
export function engineGatesPlan(r: EngineGatesRun): Record<string, Outcome[]> {
  const verify = r.verify ?? ["green"];
  const review = r.review ?? ["done"];
  const ci = r.ci ?? [];
  const greens = verify.filter((v) => v === "green").length;
  // One publish per green gate the walk cleared: the table goes `verify + green →
  // publish`, so a script shorter than the gate count leaves the run at `publish + error`
  // and a case would be asserting about a record no handler wrote.
  const publishes = greens;
  // One gate verdict per visit the table makes, on top of the ones the case named. A
  // `fixed` review and each red CI's fix round send the walk back through the gate, so
  // the list a case names is its VERDICTS and this count is the visits those verdicts
  // cost: short by one and the run ends at `verify + error`, whose `error` kind is a
  // DECIDED verdict the fold walks straight over, so the log keeps growing with entries
  // that say only "the handler threw".
  // Every entry carries its own verdict; the last one is what a later visit of the same
  // state spends, and `ci` has no re-entry of its own to run short of.
  const ciLast = ci[ci.length - 1] === "red" ? "red" : "green";
  const reentries = (review.includes("fixed") ? 1 : 0) + ci.filter((v) => v === "red").length;
  const gateVisits = verify.length + reentries;
  const red =
    r.reds === undefined
      ? {}
      : { red: { tiers: r.reds.tiers ?? [], criteria: r.reds.criteria ?? [] } };
  const ciRed =
    r.ciReds === undefined
      ? {}
      : { red: { tiers: r.ciReds.tiers ?? [], criteria: r.ciReds.criteria ?? [] } };
  return {
    ready: [{ kind: "ok" }],
    specify:
      r.frozen === undefined || r.tests === undefined
        ? [{ kind: "ok" }]
        : [{ kind: "ok", frozen: r.frozen, tests: r.tests }],
    build: Array.from({ length: buildRounds(r) }, () => ({ kind: "ok" })),
    challenge:
      r.challenge === "budget"
        ? [{ kind: "budget", limit: "turns", value: 3, used: 3 }]
        : [{ kind: r.challenge ?? "none" }],
    verify: Array.from({ length: gateVisits }, (_, i) =>
      (verify[Math.min(i, verify.length - 1)] ?? "green") === "green"
        ? { kind: "green", verifiedHead: r.verifiedHead ?? HEAD }
        : {
            kind: "red",
            reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
            ...red,
          },
    ),
    publish: Array.from({ length: publishes + reentries }, () => ({
      kind: "ok",
      prUrl: URL,
      ...(r.publishedHead === undefined ? {} : { publishedHead: r.publishedHead }),
    })),
    // One review entry per VISIT the table makes, not per verdict the case named: the
    // engine ends a run whose scripted step ran out of verdicts at `review + error`, and a
    // case would then be asserting about a record no review ever wrote. A `fixed` first
    // round is re-reviewed before the step may answer, so the visits are the verdicts.
    // "The engine wrote this" covers the WALK, not the review's own record: the queue here
    // scripts the `review` OUTCOME (see `reviewEntry`), so the counts and the wave head on
    // it are the case's, not the step's. The writer behind them — `noteRound`/`noteWave` in
    // `src/lean/review.ts` — is driven by the real handler in
    // `test-lean-review-gate-record.ts`, and only that file can say a run can record them.
    review: Array.from({ length: Math.max(review.length, reviewVisits(publishes)) }, (_, i) =>
      reviewEntry(review[i] ?? "done", r.record),
    ),
    ci: Array.from({ length: Math.max(ci.length, review.length > 0 ? 1 : 0) }, (_, i) => {
      const v = ci[Math.min(i, ci.length - 1)] ?? ciLast;
      return v === "green"
        ? { kind: "green", reason: "required checks clean" }
        : { kind: "red", reason: "required checks red at the verified head", ...ciRed };
    }),
    // A `refused` land hands the run back, so the walk reaches the reporting step too;
    // a merged one never does. Queued per VISIT for the same reason `review`'s is.
    land:
      r.land === "refused"
        ? [
            { kind: "refused", reason: "the merge guard held: a row is open against this head" },
            { kind: "refused", reason: "the merge guard held: a row is open against this head" },
          ]
        : [{ kind: "merged" }],
    handback:
      r.land === "refused"
        ? [
            // The rule fires, so the step answers WITH heads: the head origin holds
            // after the rewind and the gate's verdict about it. A `kind: "done"` alone
            // is the record of a handback the rule never touched, which is a different
            // fact and not the one these cases are about.
            {
              kind: "done",
              reason: "handback comment posted",
              posted: r.posted !== false,
              ...(r.heads ?? {}),
            },
            {
              kind: "done",
              reason: "handback comment posted",
              posted: r.posted !== false,
              ...(r.heads ?? {}),
            },
          ]
        : [
            {
              kind: "done",
              reason: "handback comment posted",
              posted: r.posted !== false,
              ...(r.heads ?? {}),
            },
          ],
    decline: [{ kind: "done" }],
  };
}

/**
 * How many times this walk visits `review`: the table sends the FIRST `publish + ok` to
 * the six lenses and every later one to `ci`, because `review` sets `reviewDone` and a
 * re-verification is `ci`'s job. So one, whenever the run published at all.
 */
function reviewVisits(publishes: number): number {
  return publishes > 0 ? 1 : 0;
}

/** One `review` verdict with the record the step writes beside it. */
function reviewEntry(kind: "done" | "fixed", record: EngineGatesRun["record"]): Outcome {
  return {
    kind,
    reason: `adversarial and six-lens review ${kind === "fixed" ? "bought one fix wave" : "clean"}`,
    ...(kind !== "fixed" || record === undefined
      ? {}
      : {
          review: {
            rounds: record.rounds.map((x) => ({ ...x })),
            waves: record.waves.map((w) => ({ wave: w.wave, head: w.head })),
          },
        }),
  };
}

/** Drive it, and hand back the run the engine left on disk. */
export async function driveEngineGates(
  dir: string,
  issue: number,
  r: EngineGatesRun,
): Promise<DrivenRun> {
  return driveRun(dir, issue, engineGatesPlan(r) as never);
}

/** The steps a driven run wrote, for a case that wants to name them. */
export function drivenSteps(run: { steps: Step[] }): Step[] {
  return run.steps;
}

/**
 * lean/machine — the whole transition table, in one pure function.
 *
 * `next(run, outcome)` is the only place a run decides where it goes. No clock, no I/O, no randomness: the
 * same pair always returns the same answer, which is what lets the step log be the record of a run. Every
 * (state, kind) pair a handler may return is listed here; `test-lean-machine.ts` enumerates them and fails on
 * any pair the table misses.
 *
 * Loop guards, all counters in the run so a resumed run sees the same caps: `buildAttempts` caps build rounds
 * DISPATCHED (billed on entering `build`, never leaving); `challengeDone` and `reviewDone` make each step run
 * at most once; `ciFixUsed` gives a red CI one fix round; `repairsSpent` gives a proven-wrong oracle one
 * repair, billed on entering it.
 */
import { type LeanRun, type LeanState, type Outcome, newestDecided } from "./state.ts";
import { type Transition, to, viaBuild } from "./transitions.ts";

/** Outcome kinds per state. The handler for a state may return only these; the pair enumeration in
 * `test-lean-machine.ts` asserts each entry equals the registry's set. */
export const OUTCOME_KINDS = {
  // `infra` is `ready`'s only route to `handback` that is not the author's fault:
  // in `derive` intake mode the contract comes from a model call, and a call that
  // died, timed out or came back unparsable is a retryable handback — not a
  // comment on the issue telling someone their ticket is unready. `setup` is the repository's
  // fault (`ready-setup.ts`): it ends the run without a reporting step, so nothing is posted.
  ready: ["ok", "fail", "infra", "setup"],
  // `red-test-gap` is specify's own child failing to prove a criterion red: the run's failure, so a
  // handback, where `no-red-test` is a refused spec.
  specify: ["ok", "no-red-test", "red-test-gap", "budget"],
  // `blocked` is the child's own "these frozen tests cannot all pass together", honoured only after the
  // driver re-ran the named tests itself. It is not `exhausted`: the route must never reach `publish`.
  build: ["ok", "exhausted", "budget", "blocked"],
  // Repair's verdicts: `repaired` rebuilds against the corrected contract, `refused` against the same one
  // with the red marker standing. Both spend the round.
  repair: ["repaired", "refused"],
  challenge: ["new-tests", "none", "budget", "skipped"],
  verify: ["green", "red"],
  publish: ["ok"],
  // Two kinds; the difference is whether the step moved the head. `done` pushed nothing, so `ci` runs;
  // `fixed` integrated commits that `integrate` PUSHES, so a `fixed` run goes back through `verify`. Both
  // set `reviewDone`, which the re-verification arm needs.
  review: ["done", "fixed"],
  ci: ["green", "red"],
  land: ["merged", "refused"],
  handback: ["done"],
  // The report of a refusal — a step, not a verdict. Both kinds land on terminal `not-ready` (exit 11).
  decline: ["done", "report-failed"],
} as const satisfies Partial<Record<LeanState, readonly string[]>>;

export type OutcomeKind<S extends keyof typeof OUTCOME_KINDS> = (typeof OUTCOME_KINDS)[S][number];

/** The states a run can be driven through: exactly the states with a handler. */
export const HANDLER_STATES = Object.keys(OUTCOME_KINDS) as (keyof typeof OUTCOME_KINDS)[];

/** What a run exits with. Chosen so a shell can branch on it without parsing. */
export const EXIT_CODES: Readonly<Record<string, number>> = Object.freeze({
  landed: 0,
  "handed-back": 10,
  "not-ready": 11,
});

/** The exit code for a terminal state. Throws on a non-terminal one. */
export function exitCodeFor(state: LeanState): number {
  const code = EXIT_CODES[state];
  if (code === undefined) throw new Error(`exitCodeFor: ${state} is not terminal`);
  return code;
}

/** How many build rounds a run gets before it ships a draft instead. */
export const MAX_BUILD_ATTEMPTS = 3;

/** The `decline` kind that says the comment did not reach the forge. */
export const REPORT_FAILED_KIND = "report-failed";

/** A step's own budget ended the child: a verdict, not a crash. */
const BUDGET_KIND = "budget";

/**
 * Does this blocked verdict earn a repair round? Both facts are read off the RUN, not the environment or the
 * working tree, so a resume cannot answer differently: the switch stamped at creation, and the spent counter.
 * The table stays a pure function of `(run, outcome)`, which is what lets the log be the record of a run.
 */
export function repairRoundDue(run: LeanRun): boolean {
  return run.oracleRepair === true && run.counters.repairsSpent < 1;
}

/** Is this pair in the table? `next()` throws on a pair it does not have, so ask first. */
export function hasTransition(state: LeanState, kind: string): boolean {
  const kinds = (OUTCOME_KINDS as Partial<Record<LeanState, readonly string[]>>)[state];
  return kinds?.includes(kind) ?? false;
}

/** The kinds a state's handler may return. Empty for terminal states. */
export function outcomeKindsFor(state: LeanState): readonly string[] {
  return (OUTCOME_KINDS as Partial<Record<LeanState, readonly string[]>>)[state] ?? [];
}

/**
 * The table. One branch per state, one case per legal kind. `run` is read, never mutated; a terminal state
 * has no case at all, and `next()` refusing one is a bug in a caller.
 */
export function next(run: LeanRun, outcome: Outcome): Transition {
  const c = run.counters;
  switch (run.state) {
    case "ready":
      switch (outcome.kind) {
        case "ok":
          return to(run, "specify");
        case "fail":
          // The verdict is `not-ready`; `decline` is how the run says it.
          return to(run, "decline");
        case "infra":
          // A derivation could not be completed. The issue is not at fault, so the
          // run says so on the operator's channel instead of on the ticket.
          return to(run, "handback");
        case "setup":
          // The repository cannot run lean: straight to `handed-back` (exit 10), no comment on an issue that
          // is not at fault, and a host falls back on `failure.kind: "setup"`.
          return to(run, "handed-back");
      }
      break;

    case "specify":
      switch (outcome.kind) {
        case "ok":
          // The contract holds, so the run earns its builder — and this edge DISPATCHES it, so this is where
          // build's first round is billed.
          return viaBuild(run, "build");
        case BUDGET_KIND:
          // Out of budget before the contract was written.
          return to(run, "handback");
        case "no-red-test":
          // A spec with no falsifiable test is not buildable from.
          return to(run, "decline");
        case "red-test-gap":
          // The run could not write a falsifiable test; the spec was not refused.
          return to(run, "handback");
      }
      break;

    case "build":
      switch (outcome.kind) {
        case "ok":
          // The cap-spending round came back clean, so the gate decides the run. The check sits on this
          // edge too because a run can ARRIVE with the cap already spent.
          if (c.buildAttempts >= MAX_BUILD_ATTEMPTS) return to(run, "verify");
          // The first build ever earns a challenge round; this edge bills nothing.
          return to(run, c.challengeDone ? "verify" : "challenge");
        case BUDGET_KIND:
          // The ceiling cut work short, it did not judge it.
          if (c.buildAttempts >= MAX_BUILD_ATTEMPTS) return to(run, "verify");
          return to(run, c.challengeDone ? "verify" : "challenge");
        case "blocked":
          // With the switch on and the run's one round unspent, that is a question for the adversary who
          // wrote the tests, not the end of the run. Otherwise the release's route, and never through
          // `exhausted`: publishing over tests the driver proved unsatisfiable is how a contract lands broken.
          if (repairRoundDue(run)) return viaBuild(run, "repair");
          return to(run, "handback");
        case "exhausted":
          // The publish arm is the GREEN arm and nothing else: the gate decides whether a head may ship, so
          // an exhausted round reaches `publish` only when the newest DECIDED `verify` said green — the one
          // reader `publish` itself consults, so the two cannot disagree. Every other case (none, or not
          // green) hands back through the biller: the round stays spent and the marker keeps it from `land`.
          if (newestDecided(run.steps, "verify")?.outcome?.kind === "green")
            return viaBuild(run, "publish", true);
          return viaBuild(run, "handback", true);
      }
      break;

    case "repair":
      switch (outcome.kind) {
        case "repaired":
          // The corrected oracle is the contract now, so the builder rebuilds against it with no red marker.
          // This edge DISPATCHES the round, so it bills the attempt.
          return viaBuild(run, "build");
        case "refused":
          // Nothing was corrected, so this round ships as a draft if the builder still cannot meet the
          // contract, with nothing later clearing the marker: a run must not land over a proven-bad oracle.
          return viaBuild(run, "build", true);
      }
      break;

    case "challenge":
      switch (outcome.kind) {
        case "new-tests":
          // New tests mean new red. One more build, and only one: the flag is charged on the branch that
          // re-enters build, so the build it earns cannot offer a second round.
          if (!c.challengeDone && c.buildAttempts < MAX_BUILD_ATTEMPTS)
            return viaBuild(run, "build", undefined, { challengeDone: true });
          return to(run, "verify", { challengeDone: true });
        case BUDGET_KIND:
        case "none":
        case "skipped":
          // A stop ends the optional round rather than the run; `skipped` bought no child, so it
          // owes no worktree reset either.
          return to(run, "verify", { challengeDone: true });
      }
      break;

    case "verify":
      switch (outcome.kind) {
        case "green":
          // Green is the only verdict that clears the red marker.
          return to(run, "publish", { draft: false });
        case "red":
          // A red verify AFTER the CI fix round ends the cycle: run and gate disagreed twice.
          if (c.ciFixUsed) return to(run, "handback");
          // The cap is not an escape hatch out of a red verdict. It only decides WHETHER to try again.
          if (c.buildAttempts < MAX_BUILD_ATTEMPTS)
            return viaBuild(run, "build", undefined, { draft: true });
          return to(run, "handback");
      }
      break;

    case "publish":
      // Publish is reached twice on two routes: `review + fixed` re-verifies and re-publishes the
      // head the review's own integrate pushed, and a CI fix round publishes a fixer's newer head,
      // whose re-verification is `ci`'s job.
      if (outcome.kind === "ok") return to(run, c.reviewDone ? "ci" : "review");
      break;

    case "review":
      if (outcome.kind === "done") return to(run, "ci", { reviewDone: true });
      if (outcome.kind === "fixed") return to(run, "verify", { reviewDone: true });
      break;

    case "ci":
      switch (outcome.kind) {
        case "green":
          // The only edge into `land`. The other half of the claim — the log's newest `verify` must be
          // green — is not expressible here; `apply()` refuses the arrival when the record says otherwise.
          return to(run, "land");
        case "red":
          // One fix round: a second red is a disagreement a third round will not settle.
          if (!c.ciFixUsed) return viaBuild(run, "build", undefined, { ciFixUsed: true });
          return to(run, "handback");
      }
      break;

    case "land":
      // `land` is entered by exactly one edge, which is a property of the table rather than an arrival flag.
      switch (outcome.kind) {
        case "merged":
          return to(run, "landed");
        case "refused":
          return to(run, "handback");
      }
      break;

    case "handback":
      if (outcome.kind === "done") return to(run, "handed-back");
      break;

    case "decline":
      // Neither kind may route to `handback`: that would relabel a refusal to build (11) as a driver
      // fault (10).
      if (outcome.kind === "done" || outcome.kind === REPORT_FAILED_KIND)
        return to(run, "not-ready");
      break;

    // Terminal: the run has ended, so nothing routes on its outcome.
    case "landed":
    case "handed-back":
    case "not-ready":
      break;
  }
  throw new UnlistedOutcome(run.state, outcome.kind);
}

/** An outcome kind its state does not declare. A handler bug, not a run failure. */
export class UnlistedOutcome extends Error {
  override readonly name = "UnlistedOutcome";
  constructor(
    readonly state: LeanState,
    readonly kind: string,
  ) {
    super(`no transition for ${state} + ${JSON.stringify(kind)}`);
  }
}

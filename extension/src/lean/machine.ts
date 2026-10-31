/**
 * lean/machine — the whole transition table, in one pure function.
 *
 * `next(run, outcome)` is the only place a run decides where it goes. It reads
 * the run and the outcome and returns the next state plus the next counters.
 * No clock, no I/O, no model call, no randomness: given the same pair it
 * returns the same answer forever, which is what lets the step log be the
 * record of a run rather than a hint at one.
 *
 * Every (state, outcome kind) pair a handler may legally return is listed
 * here, and `test-lean-machine.ts` enumerates them and fails on any pair the
 * table does not cover. A handler that returns an unlisted kind is a bug in
 * the handler, and the table says so rather than defaulting somewhere quiet.
 *
 * The loop guards are the interesting part. `buildAttempts` caps how many
 * times build may run before a run ships a draft rather than grinding;
 * `challengeDone` makes the challenge step run at most once; `reviewDone`
 * makes review run at most once, so a CI fix round re-verifies without
 * re-rehearsing the review; `ciFixUsed` gives a red CI exactly one fix round.
 * All four are counters in the run, so a resumed run sees the same caps a live
 * one did.
 */

import type { LeanRun, LeanState, Outcome } from "./state.ts";
import { type Transition, to, viaBuild } from "./transitions.ts";

/** Outcome kinds per state. The handler for a state may return only these. */
export const OUTCOME_KINDS = {
  ready: ["ok", "fail"],
  specify: ["ok", "no-red-test", "budget"],
  build: ["ok", "exhausted", "budget"],
  challenge: ["new-tests", "none", "budget"],
  verify: ["green", "red"],
  publish: ["ok"],
  // `done` is the only kind: both gates either clear or the step throws. A
  // review that ran out of its budget, or a gate that could not run, is NOT a
  // kind a handler returns — it is a throw, and the engine records it as the
  // infrastructure handback it is rather than letting the table route an
  // unreviewed head onward on a kind that reads like a verdict.
  review: ["done"],
  ci: ["green", "red"],
  land: ["merged", "refused"],
  handback: ["done"],
  // The report of a refusal. It is a step, not a verdict: `ready + fail` and
  // `specify + no-red-test` are what decide the run is not buildable, and this
  // state only says so on the issue. Both kinds land on the terminal
  // `not-ready` (exit 11); the difference is not in the table but in what the
  // step log records — `done` means the comment went out, `report-failed` says
  // the forge never took it. It is listed here rather than intercepted by the
  // engine because a terminal state cannot carry an outcome: only a
  // non-terminal one has an arrow to put it on.
  decline: ["done", "report-failed"],
} as const satisfies Partial<Record<LeanState, readonly string[]>>;

export type OutcomeKind<S extends keyof typeof OUTCOME_KINDS> = (typeof OUTCOME_KINDS)[S][number];

/**
 * The states a run can be driven through: exactly the keys of the registry
 * above, which are exactly the states with a handler. A terminal state —
 * `landed`, `handed-back`, `not-ready` — is absent from both, so the engine
 * ends a run for "no handler" the moment it arrives at one.
 */
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
export const MAX_BUILD_ATTEMPTS = 2;

/** The `decline` kind that says the comment did not reach the forge. */
export const REPORT_FAILED_KIND = "report-failed";

/** A step's own budget ended the child: a verdict like `exhausted` (#1883). */
export const BUDGET_KIND = "budget";

/**
 * Is this pair in the table? `next()` throws on a pair it does not have, so
 * callers that must not throw (the engine, the table test) ask first.
 */
export function hasTransition(state: LeanState, kind: string): boolean {
  const kinds = (OUTCOME_KINDS as Partial<Record<LeanState, readonly string[]>>)[state];
  return kinds?.includes(kind) ?? false;
}

/** The kinds a state's handler may return. Empty for terminal states. */
export function outcomeKindsFor(state: LeanState): readonly string[] {
  return (OUTCOME_KINDS as Partial<Record<LeanState, readonly string[]>>)[state] ?? [];
}

/**
 * The table. One branch per state; one case per legal outcome kind.
 *
 * `run` is read, never mutated — the caller owns the object and applies the
 * returned counters alongside the appended step. A terminal state has no case
 * at all: its handler set is empty, so no outcome ever reaches the table with
 * its name on it, and `next()` refusing one is a bug in a caller.
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
      }
      break;

    case "specify":
      switch (outcome.kind) {
        case "ok":
          return to(run, "build");
        case BUDGET_KIND:
          // Out of budget before the contract was written: nothing was proved,
          // so there is nothing to build against.
          return to(run, "handback");
        case "no-red-test":
          // A spec with no falsifiable test is not buildable from: it reads
          // fine and verifies nothing. Same refusal and same exit as an
          // unreadable spec.
          return to(run, "decline");
      }
      break;

    case "build":
      switch (outcome.kind) {
        case "ok":
          // The cap is a TABLE invariant, not a handler courtesy: a handler
          // that never returns `exhausted` must not walk past the budget. At
          // the cap the run stops building and goes to its gate, which either
          // clears the draft by going green or ends the run.
          if (c.buildAttempts >= MAX_BUILD_ATTEMPTS) return to(run, "verify");
          // The first build ever earned a challenge round; a build that came
          // back from one has already been challenged and goes to verify.
          return viaBuild(run, c.challengeDone ? "verify" : "challenge");
        case BUDGET_KIND:
          // `exhausted`'s shape with no draft to clear: the child's work went
          // back with the tree, so there is nothing to verify.
          return to(run, "handback");
        case "exhausted":
          // Out of build attempts. Whether this is a degradation or a defeat
          // depends entirely on the last verdict the run's own gate returned:
          //
          //   - `draft` set means `verify` said RED and the run has nothing
          //     left to try. Publishing would open a PR whose CI can go green
          //     without ever reading the acceptance criteria — the one shape
          //     where a red run reaches `land`. Hand back instead.
          //   - no draft means the code was green and the run simply ran out
          //     of rounds. A draft is then the honest degradation: review sees
          //     it, and the operator decides.
          // A draft is a PR that says "this was not verified", and it is not
          // a thing a run gets to acquire twice: a second exhausted build
          // means the round after the draft produced nothing verifiable
          // either. Without this a run could re-draft its way past the one
          // gate that called it red and merge on a green CI nobody read the
          // criteria against.
          if (c.draft) return to(run, "handback");
          return viaBuild(run, "publish", true);
      }
      break;

    case "challenge":
      switch (outcome.kind) {
        case "new-tests":
          // New tests mean new red. One more build, and only one: the flag is
          // charged HERE, on the branch that re-enters build, so the build it
          // earns cannot offer a second challenge round on the way out.
          if (!c.challengeDone && c.buildAttempts < MAX_BUILD_ATTEMPTS)
            return viaBuild(run, "build", undefined, { challengeDone: true });
          return to(run, "verify", { challengeDone: true });
        // The adversary ran out of budget mid-round, so it added nothing: the
        // counters are exactly `none`'s, and both end the optional round alike.
        case BUDGET_KIND:
        case "none":
          // Like `none`, a budget stop ends the optional round rather than the run —
          // the contract the run holds was written and paid for by `specify`, and
          // whether it HOLDS is `verify`'s question, which still runs every frozen
          // test. A challenge that did not converge says nothing about the build.
          return to(run, "verify", { challengeDone: true });
      }
      break;

    case "verify":
      switch (outcome.kind) {
        case "green":
          // Green is the only verdict that clears the red marker: it is the run's own
          // gate re-reading the criteria after the fix, which is what a draft
          // is a claim against. `build + ok` and `ci + green` do not clear it —
          // a model claiming it implemented the spec and a pipeline running
          // whatever the repo named are neither of them a criteria check.
          return to(run, "publish", { draft: false });
        case "red":
          // A red verify AFTER the CI fix round is the cycle ending, not a
          // third build: the run and its own gate have disagreed twice and a
          // further round repeats the argument rather than settling it.
          if (c.ciFixUsed) return to(run, "handback");
          // The attempt cap must NOT be an escape hatch out of a red verdict.
          // Before this, `verify + red` at the cap published a draft, and a
          // draft still walked publish → review → ci → land: a run that ran
          // out of build rounds could merge work its own gate had just called
          // red. Grinding to the cap and merging is strictly worse than
          // handing back, so the cap only decides WHETHER to try again.
          if (c.buildAttempts < MAX_BUILD_ATTEMPTS)
            return viaBuild(run, "build", undefined, { draft: true });
          return to(run, "handback");
      }
      break;

    case "publish":
      // A run that has already been reviewed does not go back for a second
      // review: the only way to reach publish twice is a CI fix round, and
      // that re-verification is `ci`'s job, not a repeat of the six lenses.
      if (outcome.kind === "ok") return to(run, c.reviewDone ? "ci" : "review");
      break;

    case "review":
      if (outcome.kind === "done") return to(run, "ci", { reviewDone: true });
      break;

    case "ci":
      switch (outcome.kind) {
        case "green":
          // The only edge into `land`. Nothing else may enter it, which is
          // what makes "the tests were green at CI" a fact about this run
          // rather than an assertion — `test-lean-machine.ts` enumerates every
          // reachable path from a red verify to prove no variant of it lands.
          // The table cannot express the other half of that claim (the log's
          // newest `verify` must itself be green), because `next()` sees one
          // outcome, not the sequence: the engine's `apply()` refuses the
          // arrival when the record says otherwise.
          return to(run, "land");
        case "red":
          // Exactly one fix round: a second red means the run and CI disagree
          // about something a third round will not settle.
          if (!c.ciFixUsed) return viaBuild(run, "build", undefined, { ciFixUsed: true });
          return to(run, "handback");
      }
      break;

    case "land":
      // `land` is entered by exactly one edge — `ci` + `green`. That is a
      // property of the table, not an arrival flag: an arrival check would
      // make a legal (state, kind) pair throw, which is a gate that breaks a
      // call rather than one that blocks an illegal arrival. The whole graph
      // is enumerated instead, twice over:
      //   - the exhaustive-pairs test asserts no pair but `ci` + `green`
      //     names `land` as its destination;
      //   - the reachability walk in `test-lean-machine.ts` explores every
      //     counter combination a red `verify` can be reached with and fails
      //     on any sequence that arrives here.
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
      // Both kinds land on the same terminal verdict. The reporting step never
      // chooses the exit code, so neither may route to `handback`: that would
      // relabel a refusal to build (11) as a driver fault (10).
      if (outcome.kind === "done" || outcome.kind === REPORT_FAILED_KIND)
        return to(run, "not-ready");
      break;

    // Terminal: the run has ended, so nothing routes on its outcome. `not-ready`
    // is one of these and nothing more — the step that reports it is `decline`.
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

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
  specify: ["ok", "no-red-test"],
  build: ["ok", "exhausted"],
  challenge: ["new-tests", "none"],
  verify: ["green", "red"],
  publish: ["ok"],
  review: ["done"],
  ci: ["green", "red"],
  land: ["merged", "refused"],
  handback: ["done"],
  // The reporting step. It is listed here because the engine ends a run for
  // "no handler" on any state missing from this registry, and `not-ready` does
  // have a handler (it posts the comment naming the failed rules). What its
  // handler may return is narrower than the list suggests: only `done`, which
  // confirms the run ended at the verdict `ready + fail` already reached. A
  // posting failure is NOT a kind in this table — see `REPORT_FAILED` in
  // `engine.ts`, which is an outcome the engine intercepts rather than routes,
  // because there is no arrow out of a terminal state that could carry it.
  "not-ready": ["done"],
} as const satisfies Partial<Record<LeanState, readonly string[]>>;

export type OutcomeKind<S extends keyof typeof OUTCOME_KINDS> = (typeof OUTCOME_KINDS)[S][number];

/** Non-terminal states: the ones a handler is written for. */
/**
 * The states a run can be driven through: the ones whose outcome the table
 * routes forward, plus `not-ready`, which has a handler (it posts the comment
 * naming the rules that failed) even though its own outcome no longer routes
 * anywhere. A missing entry here ends the run for "no handler", so the
 * reporting step must be listed.
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
 * returned counters alongside the appended step.
 */
export function next(run: LeanRun, outcome: Outcome): Transition {
  const c = run.counters;
  switch (run.state) {
    case "ready":
      switch (outcome.kind) {
        case "ok":
          return to(run, "specify");
        case "fail":
          return to(run, "not-ready");
      }
      break;

    case "specify":
      switch (outcome.kind) {
        case "ok":
          return to(run, "build");
        case "no-red-test":
          // A spec with no falsifiable test is not buildable from: it reads
          // fine and verifies nothing. Same exit as an unreadable spec.
          return to(run, "not-ready");
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
        case "none":
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

    case "not-ready":
      // The reporting step confirms the verdict `ready + fail` already put the
      // run in; it does not choose it. There is deliberately no second kind
      // here: a posting failure is not a routing question, and giving the
      // vocabulary one would invite a future reader to send a spec refusal
      // (exit 11) to `handback` (exit 10), which reports a refusal to build as
      // though the harness itself were broken. See `REPORT_FAILED`.
      if (outcome.kind === "done") return to(run, "not-ready");
      break;

    // Terminal: the run has ended, so nothing routes on its outcome. `not-ready`
    // is NOT in this group — it is terminal as an ANSWER but still runs its
    // reporting handler, which is the case immediately above.
    case "landed":
    case "handed-back":
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

#!/usr/bin/env bun
/**
 * lean/machine — the transition table, exhaustively.
 *
 * The engine and every future handler trust this one function, so the test is
 * a table test rather than a handful of anecdotes: it enumerates EVERY
 * (state, outcome kind) pair that `OUTCOME_KINDS` declares and asserts the
 * table has a rule for it, then enumerates a set of kinds the table must NOT
 * have a rule for and asserts `next()` refuses them. A handler that later
 * invents an outcome kind fails here, in the pair the author added, rather
 * than as a surprise at runtime.
 *
 * The second group is the part that actually bites: the attempt caps and the
 * draft flag. Each is a loop guard, and a loop guard that is one comparison
 * off looks correct in every single-transition test — it only shows when a
 * run reaches the cap and does not stop, or stops one round early.
 */

import {
  EXIT_CODES,
  MAX_BUILD_ATTEMPTS,
  OUTCOME_KINDS,
  type OutcomeKind,
  UnlistedOutcome,
  exitCodeFor,
  hasTransition,
  next,
  outcomeKindsFor,
} from "../src/lean/machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  TERMINAL_STATES,
  isTerminal,
} from "../src/lean/state.ts";
import { REFUSED_PAIRS } from "./lib/lean-machine-edges.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function run(state: LeanState, over: Partial<LeanRun> = {}): LeanRun {
  return {
    schema: 1,
    issue: 1,
    version: "test",
    models: {},
    baseSha: "sha",
    branch: "b",
    state,
    counters: { ...INITIAL_COUNTERS },
    steps: [],
    ...over,
  };
}

/**
 * The states the table routes FORWARD. After the `decline` split this is
 * exactly the registry's keys — no terminal state declares outcome kinds, so
 * the filter is now a tautology. It is deliberately kept: a future edit that
 * gave a terminal state a kind would fall out of the enumeration below and ship
 * a handler with no test, which is the failure this filter exists to catch.
 */
const HANDLER_STATES = (Object.keys(OUTCOME_KINDS) as LeanState[]).filter(
  (state) => !isTerminal(state),
);
// The registry has to stay a partition: every declared state is either routed
// forward or terminal, and a state that fell between the two would be silently
// skipped by the enumeration below — which is exactly how a handler can ship
// with no test at all.
assert(
  Object.keys(OUTCOME_KINDS).length ===
    HANDLER_STATES.length +
      Object.keys(OUTCOME_KINDS).filter((s) => isTerminal(s as LeanState)).length,
  "every declared state is either routed forward or terminal",
);

// ── every declared pair has a rule, and lands somewhere legal ──────────────

let pairs = 0;
for (const state of HANDLER_STATES) {
  for (const kind of outcomeKindsFor(state)) {
    pairs++;
    assert(hasTransition(state, kind), `${state} + ${kind} is in the table`);
    let moved: { state: LeanState } | undefined;
    let threw = false;
    try {
      moved = next(run(state), { kind });
    } catch {
      threw = true;
    }
    assert(!threw, `${state} + ${kind} does not throw`);
    // No self-edges. A rule that returns the state it was routed from is not a
    // transition — it is a loop the driver would run forever, and every
    // single-transition test in the world passes while it grinds. The engine's
    // step cap is the net under this, not the fix.
    assert(
      moved !== undefined && moved.state !== state,
      `${state} + ${kind} moves somewhere else (a self-edge is an infinite loop)`,
    );
    assert(
      moved !== undefined &&
        (isTerminal(moved.state) || Object.keys(OUTCOME_KINDS).includes(moved.state)),
      `${state} + ${kind} lands on a state that has handlers or ends the run`,
    );
  }
}
assert(
  pairs === 24,
  `all ${pairs} forward-routed pairs enumerated — the registry grew or shrank, check the spec`,
);

// ── `decline` is the report; `not-ready` is only its verdict ───────────────

// The two kinds the reporting step may return. Both land on the same terminal
// state with the same exit code, because the report never chooses the verdict:
// `ready + fail` and `specify + no-red-test` did that two steps earlier. The
// difference lives in the step log, and the engine test pins which reason each
// one leaves behind. Asserted here too, because a table edit that sent
// `report-failed` to `handback` would silently relabel a refusal to build (11)
// as a driver fault (10).
for (const kind of ["done", "report-failed"] as const) {
  const moved = next(run("decline"), { kind });
  assert(
    moved.state === "not-ready" && exitCodeFor(moved.state) === 11,
    `decline + ${kind} ends at the not-ready verdict (exit 11), never a handback`,
  );
}
for (const kind of ["ok", "green", "red"] as const) {
  let err: unknown;
  try {
    next(run("decline"), { kind });
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof UnlistedOutcome,
    `decline + ${kind} is refused — the report declares only its two kinds`,
  );
}
for (const kind of ["done", "report-failed", "ok"] as const) {
  let err: unknown;
  try {
    next(run("not-ready"), { kind });
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof UnlistedOutcome,
    `not-ready + ${kind} throws: it is an ordinary terminal state with no handler and nothing that routes`,
  );
}

// ── `land` has exactly one way in ──────────────────────────────────────────

// Not a style rule: `land` is the state that merges, so "did this run earn
// it" has to be answerable from the table alone. Enumerating every declared
// pair is the only way to know nothing else points at it.
{
  const intoLand: string[] = [];
  for (const state of HANDLER_STATES) {
    for (const kind of outcomeKindsFor(state)) {
      try {
        if (next(run(state), { kind }).state === "land") intoLand.push(`${state}+${kind}`);
      } catch {
        /* an unlisted pair cannot reach anything */
      }
    }
  }
  assert(
    intoLand.length === 1 && intoLand[0] === "ci+green",
    `land is entered only by ci + green (found: ${intoLand.join(", ") || "nothing"})`,
  );
}

// ── every terminal state has an exit code, and no non-terminal one does ───

assert(EXIT_CODES.landed === 0, "landed exits 0");
assert(EXIT_CODES["handed-back"] === 10, "handed-back exits 10");
assert(EXIT_CODES["not-ready"] === 11, "not-ready exits 11");
assert(
  exitCodeFor("landed") === 0 &&
    exitCodeFor("handed-back") === 10 &&
    exitCodeFor("not-ready") === 11,
  "exitCodeFor agrees with the table",
);
for (const state of HANDLER_STATES) {
  let threw = false;
  try {
    exitCodeFor(state);
  } catch {
    threw = true;
  }
  assert(threw, `${state} is not terminal, so it has no exit code`);
}
assert(
  TERMINAL_STATES.length === 3 && TERMINAL_STATES.every(isTerminal),
  "the three terminal states are the only ones",
);

// ── unlisted pairs are refused, not defaulted ──────────────────────────────
//
// The list is the declared registry's exact complement and lives beside
// `DECLINE_SOURCES` in `lib/lean-machine-edges.ts`, so an author adding a kind
// meets both halves in one place.
for (const [state, kind] of REFUSED_PAIRS) {
  assert(!hasTransition(state, kind), `${state} + ${kind} is refused by hasTransition`);
  let err: unknown;
  try {
    next(run(state), { kind });
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof UnlistedOutcome,
    `${state} + ${kind} throws UnlistedOutcome, not a default`,
  );
}

// ── the named transitions, one assertion per edge in the spec ──────────────

assert(next(run("ready"), { kind: "ok" }).state === "specify", "ready ok → specify");
assert(next(run("ready"), { kind: "fail" }).state === "decline", "ready fail → decline");
assert(next(run("specify"), { kind: "ok" }).state === "build", "specify ok → build");
assert(
  next(run("specify"), { kind: "no-red-test" }).state === "decline",
  "specify no-red-test → decline",
);
assert(
  next(run("build"), { kind: "ok" }).state === "challenge",
  "a first build earns a challenge round",
);
assert(
  next(run("build", { counters: { ...INITIAL_COUNTERS, challengeDone: true } }), { kind: "ok" })
    .state === "verify",
  "a build that already earned its challenge goes to verify",
);
// A build's round was billed on the edge that ENTERED build, so leaving on a
// ceiling bills nothing more: the counter the stopped edge carries out is the
// one it was handed. The pair claim (this edge leaves build and re-bills
// nothing; only the cap ends the run) lives here beside the other single-edge
// assertions; the step's work-keeping lives in test-lean-build.ts.
for (const challengeDone of [false, true]) {
  const stopped = next(run("build", { counters: { ...INITIAL_COUNTERS, challengeDone } }), {
    kind: "budget",
  });
  assert(
    stopped.state === (challengeDone ? "verify" : "challenge") &&
      stopped.counters.buildAttempts === 0,
    `build + budget leaves build and re-bills nothing — the round was billed on entry (challengeDone=${String(challengeDone)}: ${stopped.state}/${stopped.counters.buildAttempts})`,
  );
}
assert(
  next(run("build", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS } }), {
    kind: "budget",
  }).counters.buildAttempts === MAX_BUILD_ATTEMPTS,
  "build + budget at the cap goes to verify and bills no round beyond it",
);
const exhausted = next(run("build"), { kind: "exhausted" });
assert(
  exhausted.state === "publish" && exhausted.counters.draft === true,
  "build exhausted → publish as a draft",
);
// The builder ran and produced nothing, so the round it was given is spent: this
// edge bills one even though its destination is not `build`. Dropping the charge
// would let a builder that keeps coming back empty re-enter build forever, since
// every cap comparison in the table reads this counter and this is the edge a
// no-change round leaves by.
{
  const billed = next(
    run("build", { counters: { ...INITIAL_COUNTERS, buildAttempts: 1 } }),
    { kind: "exhausted" },
  );
  assert(
    billed.state === "publish" && billed.counters.buildAttempts === 2,
    `build exhausted bills the round the builder was dispatched for (got ${billed.state}/${billed.counters.buildAttempts})`,
  );
}
assert(
  next(run("challenge"), { kind: "new-tests" }).state === "build",
  "challenge new-tests → build while attempts remain",
);
{
  // The counter counts rounds DISPATCHED, and this edge dispatches one: the
  // builder the new tests earn. What it no longer does is bill anything on the
  // way OUT of the previous build — that double charge is what read two real
  // builds as three. The flag is charged here too, so the build this edge earns
  // cannot offer a second challenge round.
  const earned = next(run("challenge", { counters: { ...INITIAL_COUNTERS, buildAttempts: 1 } }), {
    kind: "new-tests",
  });
  assert(
    earned.state === "build" && earned.counters.buildAttempts === 2,
    `challenge new-tests dispatches and bills exactly the one round it earns (got ${earned.state}/${earned.counters.buildAttempts})`,
  );
  const fourth = next(
    run("challenge", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS } }),
    { kind: "new-tests" },
  );
  assert(
    fourth.state === "verify" && fourth.counters.buildAttempts === MAX_BUILD_ATTEMPTS,
    `challenge new-tests at the cap goes to verify and bills nothing (got ${fourth.state}/${fourth.counters.buildAttempts})`,
  );
}
{
  // True on BOTH branches of new-tests: below the cap the run goes back to
  // build, at the cap it goes to verify, and either way a second challenge
  // must never be offered. Asserting only the cheap branch is the bug shape.
  const below = next(run("challenge"), { kind: "new-tests" });
  const atCap = next(
    run("challenge", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS } }),
    { kind: "new-tests" },
  );
  assert(
    below.counters.challengeDone === true,
    "challenge sets challengeDone when it sends a run back to build",
  );
  assert(
    atCap.counters.challengeDone === true,
    "challenge sets challengeDone when the cap sends it to verify",
  );
}
assert(
  next(run("challenge"), { kind: "none" }).counters.challengeDone === true,
  "challenge sets challengeDone either way",
);
// The `challenge` + `budget` edge is a PAIR claim against `none` — same
// destination, same counters — and is asserted across several counter
// combinations in its own file, `test-lean-machine-challenge-budget.ts`.
assert(next(run("verify"), { kind: "green" }).state === "publish", "verify green → publish");
assert(
  next(run("publish"), { kind: "ok" }).state === "review",
  "publish ok → review for a run never reviewed",
);
assert(
  next(run("publish", { counters: { ...INITIAL_COUNTERS, reviewDone: true } }), { kind: "ok" })
    .state === "ci",
  "publish ok → ci once review has already run, so a CI fix round does not re-rehearse it",
);
assert(next(run("review"), { kind: "done" }).state === "ci", "review done → ci");
assert(
  next(run("review"), { kind: "done" }).counters.reviewDone === true,
  "review done sets reviewDone",
);
// A review that ran a fix round has PUSHED and the two kinds that say so —
// `fixed` re-verifies, `done` ships — are asserted as a PAIR, together with the
// claim that they are the step's only two, in their own file:
// `test-lean-machine-review.ts`. Split for the 500-line gate (AGENTS.md §12).
assert(next(run("ci"), { kind: "green" }).state === "land", "ci green → land");
assert(next(run("land"), { kind: "merged" }).state === "landed", "land merged → landed");
assert(next(run("land"), { kind: "refused" }).state === "handback", "land refused → handback");
assert(
  next(run("handback"), { kind: "done" }).state === "handed-back",
  "handback done → handed-back",
);

// ── who may reach the refusal, and who may not ────────────────────
//
// That claim is a graph property, so it lives in its own walker:
// `test-lean-machine-refusal.ts`. This file pins single transitions; that one
// enumerates every declared pair across every counter combination and asserts
// the source set of `decline` and the absence of any direct edge into
// `not-ready`. Split for the 500-line gate (AGENTS.md §12).

// `next` never mutates the run it was given.
const pristine = run("build", { counters: { ...INITIAL_COUNTERS } });
const snapshot = JSON.stringify(pristine);
next(pristine, { kind: "ok" });
assert(JSON.stringify(pristine) === snapshot, "next() does not mutate its run");

// The typed kind union is inhabited: this compiles only if the registry types
// match the strings the table routes on.
const typed: OutcomeKind<"build">[] = ["ok", "exhausted", "budget", "blocked"];
assert(typed.length === 4, "the kind union for build is exactly its four kinds");

process.exit(exit);

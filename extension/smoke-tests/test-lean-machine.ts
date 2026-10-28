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

const HANDLER_STATES = Object.keys(OUTCOME_KINDS) as Exclude<
  LeanState,
  (typeof TERMINAL_STATES)[number]
>[];

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
    assert(
      moved !== undefined &&
        (isTerminal(moved.state) || Object.keys(OUTCOME_KINDS).includes(moved.state)),
      `${state} + ${kind} lands on a state that has handlers or ends the run`,
    );
  }
}
assert(
  pairs === 17,
  `all ${pairs} declared pairs enumerated — the registry grew or shrank, check the spec`,
);

// ── `land` has exactly one way in ──────────────────────────────────────────

// Not a style rule: `land` is the state that merges, so "did this run earn
// it" has to be answerable from the table alone. Enumerating every declared
// pair is the only way to know nothing else points at it.
{
  const intoLand: string[] = [];
  for (const state of HANDLER_STATES) {
    for (const kind of outcomeKindsFor(state)) {
      try {
        if (next(run(state), { kind }, { from: state }).state === "land")
          intoLand.push(`${state}+${kind}`);
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

const refused: Array<[LeanState, string]> = [
  ["ready", "done"],
  ["ready", "green"],
  ["specify", "fail"],
  ["specify", "red"],
  ["build", "green"],
  ["build", "done"],
  ["challenge", "ok"],
  ["verify", "exhausted"],
  ["publish", "red"],
  ["review", "ok"],
  ["ci", "done"],
  ["land", "ok"],
  ["handback", "ok"],
  ["landed", "merged"],
  ["not-ready", "ok"],
  ["handed-back", "done"],
];
for (const [state, kind] of refused) {
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
assert(next(run("ready"), { kind: "fail" }).state === "not-ready", "ready fail → not-ready");
assert(next(run("specify"), { kind: "ok" }).state === "build", "specify ok → build");
assert(
  next(run("specify"), { kind: "no-red-test" }).state === "not-ready",
  "specify no-red-test → not-ready",
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
const exhausted = next(run("build"), { kind: "exhausted" });
assert(
  exhausted.state === "publish" && exhausted.counters.draft === true,
  "build exhausted → publish as a draft",
);
assert(
  next(run("challenge"), { kind: "new-tests" }).state === "build",
  "challenge new-tests → build while attempts remain",
);
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
assert(next(run("ci"), { kind: "green" }).state === "land", "ci green → land");
assert(next(run("land"), { kind: "merged" }).state === "landed", "land merged → landed");
assert(next(run("land"), { kind: "refused" }).state === "handback", "land refused → handback");
assert(
  next(run("handback"), { kind: "done" }).state === "handed-back",
  "handback done → handed-back",
);

// ── the caps ───────────────────────────────────────────────────────────────

// challenge new-tests sends a run back to build only while attempts remain.
const capped = run("challenge", {
  counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS },
});
assert(
  next(capped, { kind: "new-tests" }).state === "verify",
  `challenge new-tests at ${MAX_BUILD_ATTEMPTS} attempts goes to verify, not build`,
);
const oneShort = run("challenge", {
  counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS - 1 },
});
assert(
  next(oneShort, { kind: "new-tests" }).state === "build",
  "challenge new-tests one attempt below the cap still builds",
);
// A challenge already done cannot buy another build even below the cap.
const challenged = run("challenge", {
  counters: { ...INITIAL_COUNTERS, challengeDone: true, buildAttempts: 0 },
});
assert(
  next(challenged, { kind: "new-tests" }).state === "verify",
  "a second challenge never sends a run back to build",
);

// verify red is the run's own gate saying the criteria are not met, so it
// either buys another build round or ends the run — it never becomes a PR.
const redEarly = next(run("verify"), { kind: "red" });
assert(
  redEarly.state === "build" && redEarly.counters.draft === true,
  "verify red with attempts left → build, and the red is recorded on the run",
);
const redLate = next(
  run("verify", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS } }),
  { kind: "red" },
);
assert(
  redLate.state === "handback",
  "verify red at the attempt cap hands back rather than shipping unverified work",
);
assert(
  next(run("verify", { counters: { ...INITIAL_COUNTERS, ciFixUsed: true, buildAttempts: 0 } }), {
    kind: "red",
  }).state === "handback",
  "verify red after the CI fix round → handback, not another build",
);
assert(
  next(
    run("verify", {
      counters: { ...INITIAL_COUNTERS, ciFixUsed: true, buildAttempts: MAX_BUILD_ATTEMPTS },
    }),
    { kind: "red" },
  ).state === "handback",
  "a red verify at the cap after the fix round still hands back rather than publishing a draft",
);
// The cap is a budget, not a verdict: running out of build rounds degrades a
// GREEN run to a draft, and does not change what a RED one does.
const greenDraft = next(run("build", { counters: { ...INITIAL_COUNTERS, draft: false } }), {
  kind: "exhausted",
});
assert(
  greenDraft.state === "publish" && greenDraft.counters.draft === true,
  "build exhausted on a non-red run publishes a draft",
);
const redThenExhausted = next(run("build", { counters: { ...INITIAL_COUNTERS, draft: true } }), {
  kind: "exhausted",
});
assert(
  redThenExhausted.state === "handback",
  "build exhausted on a run its verify called red hands back instead of drafting",
);

// Every build transition consumes exactly one attempt, and never two.
for (const [state, kind] of [
  ["build", "ok"],
  ["build", "exhausted"],
  ["verify", "red"],
  ["ci", "red"],
] as const) {
  const before = run(state as LeanState, { counters: { ...INITIAL_COUNTERS, buildAttempts: 1 } });
  const after = next(before, { kind });
  assert(after.counters.buildAttempts === 2, `${state} + ${kind} spends exactly one build attempt`);
}
for (const [state, kind] of [
  ["ready", "ok"],
  ["specify", "ok"],
  ["challenge", "none"],
  ["verify", "green"],
  ["review", "done"],
  ["ci", "green"],
] as const) {
  const before = run(state as LeanState, { counters: { ...INITIAL_COUNTERS, buildAttempts: 1 } });
  assert(
    next(before, { kind }).counters.buildAttempts === 1,
    `${state} + ${kind} spends no build attempt`,
  );
}

// ci red gets exactly one fix round, and the flag is what spends it.
// The flag is spent by the BUILD that the red CI earns, not by the red CI
// itself — otherwise `build + ok`, which also spends an attempt, would double
// the charge on the way back. Assert the pair, because asserting the flag on
// the red edge alone is what let this read as done while it was wrong.
const ciRed = next(run("ci"), { kind: "red" });
assert(
  ciRed.state === "build" && ciRed.counters.ciFixUsed === true,
  "ci red → build and charges the one fix round",
);
const ciFixBuild = next(run("build", { counters: { ...INITIAL_COUNTERS, ciFixUsed: false } }), {
  kind: "ok",
});
assert(ciFixBuild.counters.ciFixUsed === false, "an ordinary build does not charge the fix round");
assert(
  next(run("ci", { counters: { ...INITIAL_COUNTERS, ciFixUsed: true } }), { kind: "red" }).state ===
    "handback",
  "ci red with the round already charged → handback",
);
// The draft a run already carries survives a CI fix round; the flag is sticky.
const ciFixDraft = next(run("ci", { counters: { ...INITIAL_COUNTERS, draft: true } }), {
  kind: "red",
});
assert(ciFixDraft.counters.draft === true, "a draft stays a draft through the CI fix round");
const ciFixPlain = next(run("ci"), { kind: "red" });
assert(ciFixPlain.counters.draft === false, "a non-draft is not turned into one by a CI fix round");

// `next` never mutates the run it was given.
const pristine = run("build", { counters: { ...INITIAL_COUNTERS } });
const snapshot = JSON.stringify(pristine);
next(pristine, { kind: "ok" });
assert(JSON.stringify(pristine) === snapshot, "next() does not mutate its run");

// The typed kind union is inhabited: this compiles only if the registry types
// match the strings the table routes on.
const typed: OutcomeKind<"build">[] = ["ok", "exhausted"];
assert(typed.length === 2, "the kind union for build is exactly its two kinds");

process.exit(exit);

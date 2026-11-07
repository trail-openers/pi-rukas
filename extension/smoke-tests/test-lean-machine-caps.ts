#!/usr/bin/env bun
/**
 * lean/machine — the attempt caps, and the two build exits that the caps do NOT
 * govern.
 *
 * Split from `test-lean-machine.ts` for the 500-line gate (AGENTS.md §12),
 * along the seam that file already draws: that one pins single transitions
 * one edge at a time, this one owns the LOOP GUARDS — the assertions that are
 * only true of a counter, and so only catch anything by driving a run to the
 * cap and one step past it.
 *
 * `build + blocked` is grouped here rather than with the single edges because
 * its whole claim is about the counters: the route must not charge a build
 * attempt (a run does not earn a round by reporting a conflict) and must not
 * set the draft marker (a draft is what a run SHIPS when it merely ran out of
 * rounds, and shipping one over a contract the run's own builder proved
 * unsatisfiable opens a PR whose CI can go green without anyone satisfying the
 * tests). Both halves are counter claims, so both belong where the counters are
 * tested — and both are asserted at 0, 1 and the cap, since an edge that is
 * right at one counter value and wrong at another is exactly the bug shape this
 * file exists for.
 */

import {
  HANDLER_STATES,
  MAX_BUILD_ATTEMPTS,
  next,
  outcomeKindsFor,
} from "../src/lean/machine.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState } from "../src/lean/state.ts";

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

/**
 * The four pairs whose destination is `build`: the first entry from `specify`,
 * and the three re-entries an adversary's new tests, a red gate or a red
 * pipeline buy. Each dispatches a builder, so each must bill exactly one round —
 * an edge that entered build free would let a run re-enter the builder past the
 * cap, since every cap comparison in the table reads this counter.
 */
const DISPATCHING_PAIRS = [
  "specify + ok",
  "challenge + new-tests",
  "verify + red",
  "ci + red",
];

// The dispatch cap binds on the TABLE, not only on what a handler chooses to
// return. A dispatched round is billed by the edge that ENTERED build, so the cap
// is read where it can still decide: the edges that BUY a round
// (`challenge + new-tests`, `verify + red` — the walk below pins those) and on
// BOTH exits from build, which buy nothing and so owe the run no further round.
{
  // The cap binds on the TABLE, not on what a handler chooses to return, and it
  // is read on every build exit: a run that sits at build with its three rounds
  // already dispatched (a pre-fix record, or a hand-written one) has no round
  // left to buy, so both exits go to the gate and neither writes a counter past
  // the cap. Leaving that check off `build + ok` let `viaBuild` write 4, 5, 6 and
  // let the fold derive a number no drive could have saved.
  for (const challengeDone of [false, true]) {
    for (const kind of ["ok", "budget"] as const) {
      const atCap = next(
        run("build", {
          counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS, challengeDone },
        }),
        { kind },
      );
      assert(
        atCap.state === "verify" && atCap.counters.buildAttempts === MAX_BUILD_ATTEMPTS,
        `build + ${kind} at the cap goes to its gate and bills no round beyond it (challengeDone=${String(challengeDone)}: ${atCap.state}/${atCap.counters.buildAttempts})`,
      );
    }
  }
  // One round below the cap the same exits still earn their consequence, billed
  // for the round that really ran: the challenge, or the gate.
  const oneBelow = next(
    run("build", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS - 1 } }),
    { kind: "ok" },
  );
  assert(
    oneBelow.state === "challenge" && oneBelow.counters.buildAttempts === MAX_BUILD_ATTEMPTS - 1,
    `build + ok one round below the cap still earns its challenge round and bills nothing for it (got ${oneBelow.state}/${oneBelow.counters.buildAttempts})`,
  );
}
// Every edge whose destination is `build` consumes exactly one attempt, and
// never two: the counter is a dispatch budget and those edges are the dispatch.
// The two exits that LEAVE build (`ok`, `budget`) are in the second loop — under
// entry-billing they carry the counter out unchanged.
for (const [state, kind] of [
  // The first dispatch, bought by the contract holding; and the three re-entries
  // a challenge's tests, a red gate or a red pipeline buy.
  ["specify", "ok"],
  ["challenge", "new-tests"],
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
  ["build", "ok"],
  ["build", "budget"],
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

{
  // The counter's whole contract, as a canary rather than a list: a pair may
  // bill a round if and only if it DISPATCHES one, and the table's two ways in
  // are the edges whose destination is `build` — the re-entry an adversary or a
  // gate buys — and the first entry from `specify`. The two directions a future
  // edit breaks it are the two this refuses: an edge that bills on the way OUT
  // of build (the bug #2081 removes, hiding behind a destination that is not
  // `build`), and an edge that enters build without billing (which would let a
  // run re-enter the builder past the cap, since every cap comparison reads this
  // counter). Enumerated over the pairs the registry declares, so an edge added
  // to the table is priced automatically; `build + exhausted` is the one biller
  // whose destination is not `build` because the run ships as a draft and builds
  // no further child.
  const billed: string[] = [];
  const unpriced: string[] = [];
  for (const state of HANDLER_STATES) {
    for (const kind of outcomeKindsFor(state)) {
      const before = run(state, { counters: { ...INITIAL_COUNTERS, buildAttempts: 1 } });
      let moved: ReturnType<typeof next>;
      try {
        moved = next(before, { kind });
      } catch {
        continue; // An unlisted pair is the sibling file's claim, not this one.
      }
      const pair = `${state} + ${kind}`;
      const spent = moved.counters.buildAttempts - before.counters.buildAttempts;
      // A pair named below only dispatches when it actually arrives at `build`:
      // `specify + ok` at the cap goes to the gate instead, and dispatches
      // nothing to bill. `build + exhausted` is the biller that dispatches no
      // child — it reports the round that already ran and ships it as a draft.
      const dispatches = DISPATCHING_PAIRS.includes(pair) && moved.state === "build";
      const bills = dispatches || pair === "build + exhausted";
      if (spent !== (bills ? 1 : 0)) (bills ? unpriced : billed).push(pair);
    }
  }
  assert(
    billed.length === 0,
    `no pair bills a build attempt it did not dispatch (offenders: ${billed.join(", ") || "none"})`,
  );
  assert(
    unpriced.length === 0,
    `every pair that dispatches a build bills exactly one round (offenders: ${unpriced.join(", ") || "none"})`,
  );
}

// ci red gets exactly one fix round, and the flag is what spends it.
// The flag is spent by the BUILD that the red CI earns, not by the red CI
// itself — otherwise `build + ok`, which also spends an attempt, would double
// the charge on the way back. Assert the pair, because asserting the flag on
// the red edge alone is what let this read as done while it was wrong.
{
  const ciRed = next(run("ci"), { kind: "red" });
  assert(
    ciRed.state === "build" && ciRed.counters.ciFixUsed === true,
    "ci red → build and charges the one fix round",
  );
  const ciFixBuild = next(
    run("build", { counters: { ...INITIAL_COUNTERS, ciFixUsed: false } }),
    { kind: "ok" },
  );
  assert(
    ciFixBuild.counters.ciFixUsed === false,
    "an ordinary build does not charge the fix round",
  );
  // The draft a run already carries survives a CI fix round; the flag is sticky.
  const ciFixDraft = next(run("ci", { counters: { ...INITIAL_COUNTERS, draft: true } }), {
    kind: "red",
  });
  assert(ciFixDraft.counters.draft === true, "a draft stays a draft through the CI fix round");
  const ciFixPlain = next(run("ci"), { kind: "red" });
  assert(
    ciFixPlain.counters.draft === false,
    "a non-draft is not turned into one by a CI fix round",
  );
}
assert(
  next(run("ci", { counters: { ...INITIAL_COUNTERS, ciFixUsed: true } }), { kind: "red" }).state ===
    "handback",
  "ci red with the round already charged → handback",
);

{
  // #1984: a blocked build must NEVER take the route `exhausted` takes. A draft
  // is a PR the run ships when it merely ran out of rounds; shipping one over a
  // contract the run's own builder proved unsatisfiable opens a PR whose CI can
  // go green without anyone satisfying the tests. And the edge charges no build
  // attempt — the run did not earn a round by reporting a conflict.
  for (const buildAttempts of [0, 1, MAX_BUILD_ATTEMPTS - 1, MAX_BUILD_ATTEMPTS]) {
    const blocked = next(run("build", { counters: { ...INITIAL_COUNTERS, buildAttempts } }), {
      kind: "blocked",
    });
    assert(
      blocked.state === "handback",
      `build blocked → handback at ${buildAttempts} attempt(s) (got ${blocked.state})`,
    );
    assert(
      blocked.counters.buildAttempts === buildAttempts,
      `build blocked charges no build attempt (got ${blocked.counters.buildAttempts})`,
    );
    assert(blocked.counters.draft === false, "build blocked does not set the draft marker");
  }
}

{
  // The field sequence the cap used to break, driven through the real `next()`
  // one engine entry at a time. `buildAttempts` counts rounds DISPATCHED: the
  // edge that ENTERS build bills one, and an edge LEAVING build bills nothing.
  // The chain is the field case exactly: the first build earns the challenge,
  // the challenge's NEW TESTS earn the second build, and the red that follows
  // earns the third — the round the old cap had already spent on the challenge,
  // which handed the whole run back after two real builds with no PR and a
  // two-line fix outstanding. Each edge below is correct read on its own; only
  // the chain shows the challenge must not spend a dispatch it never bought.
  const walk: string[] = [];
  let seq: LeanRun = run("build");
  for (const kind of ["ok", "new-tests", "ok", "red"] as const) {
    // The engine stops asking once a run is terminal, so the walk does too.
    if (seq.state === "handback") break;
    const moved = next(seq, { kind });
    walk.push(`${moved.state}/${String(moved.counters.buildAttempts)}`);
    seq = { ...seq, state: moved.state, counters: moved.counters };
  }
  // Two dispatches spent by the time the red comes in — the first build, and the
  // one the challenge's new tests earned — so the red still finds a round under
  // the cap and takes it: `build/3`, the third build the old arithmetic refused.
  assert(
    walk.join(" → ") === "challenge/0 → build/1 → verify/1 → build/2",
    `the field walk reaches its THIRD build: the challenge's round is no longer spent on the way out of build (got ${walk.join(" → ")})`,
  );
  // The red the third round exists to answer rides with it: `viaBuild` passes the
  // marker through rather than clearing it, so a run cannot out-grind its own gate.
  assert(
    seq.state === "build" &&
      seq.counters.buildAttempts === 2 &&
      seq.counters.challengeDone === true &&
      seq.counters.draft === true,
    `the run is dispatched into its THIRD build with its red still outstanding, not handed back (${seq.state} at ${String(seq.counters.buildAttempts)}, challenged ${String(seq.counters.challengeDone)}, draft ${String(seq.counters.draft)})`,
  );
  // The other field symptom, same walk up to the second build: a build the
  // child's OWN ceiling stopped leaves build without billing the round again,
  // so the run stands at the gate with two rounds spent and the third still
  // unwon. `build + budget` at the cap is where the counter, not the ceiling,
  // ends the run.
  const stopped: string[] = [];
  let stop: LeanRun = run("build");
  for (const kind of ["ok", "new-tests", "budget"] as const) {
    const moved = next(stop, { kind });
    stopped.push(`${moved.state}/${String(moved.counters.buildAttempts)}`);
    stop = { ...stop, state: moved.state, counters: moved.counters };
  }
  assert(
    stopped.join(" → ") === "challenge/0 → build/1 → verify/1",
    `a ceiling-stopped build leaves build billing nothing, so its gate still has the third round to win (got ${stopped.join(" → ")})`,
  );
  assert(
    next(stop, { kind: "red" }).state === "build",
    "and from that gate the red still earns the third build",
  );
  // The load-bearing half: the round the challenge used to spend no longer
  // exhausts the red-verify retry. One attempt below the cap — where the walk
  // above stood before it earned its third build — a red still buys build three,
  // red marker and all.
  const thirdRound = next(
    run("verify", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS - 1 } }),
    { kind: "red" },
  );
  assert(
    thirdRound.state === "build" &&
      thirdRound.counters.buildAttempts === MAX_BUILD_ATTEMPTS &&
      thirdRound.counters.draft === true,
    `a red verify one attempt below the cap earns the third build round, red marker and all (got ${thirdRound.state} at ${String(thirdRound.counters.buildAttempts)}, draft ${String(thirdRound.counters.draft)})`,
  );
  assert(
    next(
      { ...run("verify"), counters: { ...thirdRound.counters }, state: "verify" },
      { kind: "red" },
    ).state === "handback",
    "a red verify at the third round's cap hands back rather than a fourth build",
  );
}

process.exit(exit);

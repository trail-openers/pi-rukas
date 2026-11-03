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

import { MAX_BUILD_ATTEMPTS, next } from "../src/lean/machine.ts";
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

// The build cap binds on the TABLE, not only on what a handler chooses to
// return: `build + ok` at the cap must stop building. Without this edge a
// handler that never returned `exhausted` walked verify:red → build:ok →
// verify → publish → ci:green → land forever, and MAX_BUILD_ATTEMPTS was
// advisory.
for (const challengeDone of [false, true]) {
  const atCap = next(
    run("build", {
      counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS, challengeDone },
    }),
    { kind: "ok" },
  );
  assert(
    atCap.state === "verify" && atCap.counters.buildAttempts === MAX_BUILD_ATTEMPTS,
    `build + ok at the cap goes to verify and spends nothing (challengeDone=${challengeDone})`,
  );
}
{
  const oneBelow = next(
    run("build", { counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS - 1 } }),
    { kind: "ok" },
  );
  assert(
    oneBelow.state === "challenge" && oneBelow.counters.buildAttempts === MAX_BUILD_ATTEMPTS,
    "build + ok one attempt below the cap still earns its challenge round",
  );
}

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
  for (const buildAttempts of [0, 1, MAX_BUILD_ATTEMPTS]) {
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

process.exit(exit);

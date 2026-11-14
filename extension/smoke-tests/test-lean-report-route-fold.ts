/**
 * lean/resume — the fold's ONE exemption admits exactly the deadline's route into the
 * report, and nothing else (#2264).
 *
 * `foldLog` normally refuses a step whose entry belongs to a state the walk never stood
 * in. It has exactly one exemption, `isReportRoute`: the entry a deadline-routed run's
 * report writes while the walk still stands at the gate the clock refused. That exemption
 * is what makes a routed record openable at all — `verifiedPosition` runs before the
 * routing's switch is read, so a fold refusal there closes the documented answer to "this
 * issue timed out, run it again" for good, with no env value to recover it.
 *
 * A refusal is only worth something if the code that raises it can be seen failing, so
 * each case here was observed RED with `isReportRoute` replaced by `return true`: the
 * log's own shape cannot vouch for itself, and only the predicate says whether a
 * `handback` entry is the route or an invention. Which is the whole point of the third
 * condition in that predicate — the newest DECIDED work step must be a `fixed` review with
 * no decided `verify` behind it — and the reason the checks below are paired with a clean
 * control that must keep resuming: a predicate that merely always refused would pass them
 * too.
 *
 *   (a) a `handback` entry behind a CLEAN `review:done` → `ci:green`, the log ending on
 *       that entry: REFUSED. The gate certified the head, so there is no unverified head
 *       and no route — this is a smuggled report visit;
 *   (b) a SECOND `handback` entry: REFUSED. The routing enters the report once, so a
 *       second is a fabrication;
 *   (c) a `decline` entry where the routed report's belongs: REFUSED. The routing writes
 *       `handback` and no other state.
 *
 * Every log is a REAL drive's log with one entry appended or one entry's state changed,
 * never an array typed from the table (lib/lean-real-log-fixture.ts): a hand-written log
 * has twice in this repo been refused by the fold for a defect the case was not about.
 */

import { runLean } from "../src/lean/engine.ts";
import { handbackHeads } from "../src/lean/handback-heads.ts";
import type { LeanRun, LeanState, Outcome, Step } from "../src/lean/state.ts";
import { INITIAL_COUNTERS } from "../src/lean/state.ts";
import {
  FIXTURE_BASE_SHA,
  makeAssert,
  scripted,
  tempDir,
  ticking,
} from "./lib/lean-engine-fixtures.ts";
import { driveRun, foldOf, writeForged } from "./lib/lean-real-log-fixture.ts";
import { fixedReviewLog } from "./lib/lean-verified-handback-fixture.ts";

const { assert, failures } = makeAssert();

/**
 * Drive a forged record and report whether the LOAD refused it, with the refusal's message,
 * or `undefined` when the file opened and the run drove.
 *
 * The refusal is read off the throw rather than off a handler-call count because the fold
 * raises it from `loadRun`/`verifiedPosition`, before any handler is reachable — which is
 * the very property that makes these refusals permanent, and is what is under test.
 */
async function loadVerdict(
  dir: string,
  issue: number,
): Promise<{ refused: boolean; message: string }> {
  const { handlers } = scripted({ handback: [{ kind: "done" }] });
  try {
    await runLean({ repoRoot: dir, issue, handlers, now: ticking().now });
    return { refused: false, message: "loaded and drove without refusing" };
  } catch (err) {
    return { refused: true, message: String((err as Error)?.message ?? err) };
  }
}

/** The engine's own key for the nth visit to a state. */
const key = (issue: number, state: LeanState, n: number): string => `${issue}:${state}:${n}`;

/**
 * The log of a run the clock stopped over an uncertified head: the driven `fixed`-review
 * walk, and the routed report entry. `fixedReviewLog` DRIVES that walk with the real engine
 * and cuts it at the review, so every row before the appended one is a row `next()` routed
 * and the newest DECIDED work step really is a `fixed` review with no decided `verify` after
 * it — the premise the exemption admits. The appended row is the deadline's own move: the
 * routing writes that visit and the verdict is never on it, because the run ends with it.
 *
 * The undecided re-verification the clock refused is deliberately NOT in the log. A drive
 * cannot be made to hold it: the engine writes a step ahead and then its handler throws on a
 * dry queue, and the engine records that as an `error` verdict, so the blank entry the clock
 * leaves is a shape only the routing produces — and the fold refuses a blank entry anywhere
 * but the log's newest position (`resume.ts`), so a fold-derived snapshot cannot be built
 * with one beside a report entry. The rule that needs it, `handback-heads`, reads a blank
 * entry as "the gate was entered and never answered", which is the same verdict it reaches
 * for a review the gate never spoke for at all: `applies` either way, which is asserted.
 *
 * `last` is the state of the routed entry — `handback` for the legitimate shape, `decline`
 * for forgery (c).
 */
async function routedLog(
  issue: number,
  last: LeanState,
): Promise<{ steps: Step[]; snapshot: { state: LeanState; counters: LeanRun["counters"] } }> {
  const driven = await fixedReviewDriven(issue);
  // The entry the routing writes is the log's NEWEST, and the record the engine persisted at
  // that instant is the save that carried it: `runHandbackReport` attaches the verdict and the
  // terminal stamp afterwards, in one write that ends the run. So the routed record is this
  // entry blank and last, with the snapshot the save took — the fold's answer for the log up
  // to and including it.
  const steps: Step[] = [
    ...driven,
    { key: key(issue, last, 0), state: last, startedAt: driven.length },
  ];
  if (last !== "handback")
    return { steps, snapshot: { state: last, counters: foldPos(issue, driven).counters } };
  // The snapshot the engine held while the routed report ran: `settle` saved the review's
  // verdict with `state` still `review` (the move is applied in the save AFTER it), so the
  // record beside a routed log is the fold's position for the log WITHOUT the route — the
  // one-step lag `verifiedPosition` admits, which is the shape this run really persisted.
  // The snapshot the engine persisted while the routed report ran: `settle` saved the review's
  // verdict and only the save inside `apply()` moved `state`, so the durable file at the
  // report's boundary still says `review`. That is `foldPos` over the log WITHOUT the report
  // entry — the same value, stated where the fold's own answer is asked for.
  // `handback`, not `foldPos`: the fold's answer for the log WITHOUT the routed entry is
  // `review` (the review's own verdict was saved before `apply()` moved the state, and the
  // route is the move it never got to persist), so a fold-derived snapshot would be one step
  // BEHIND the file the routing writes. The routed record's snapshot is the state the routing
  // took it into — which is what the drive's own `endRun` writes beside that entry.
  return { steps, snapshot: { state: "handback", counters: foldPos(issue, driven).counters } };
}

/** The same driven walk, and one report entry appended to it as the routing leaves it. */
async function fixedReviewDriven(issue: number): Promise<Step[]> {
  return (await fixedReviewLog()).map((s) => ({
    ...s,
    key: s.key.replace(/^\d+:/, `${String(issue)}:`),
  }));
}

/**
 * The snapshot beside a routed log: the fold's own answer for that log, asked rather than
 * typed. A hand-carried counter is a second claim about the table's billing, and this repo's
 * fixture history says a guessed one ends up refusing an honest file.
 */
function foldPos(
  issue: number,
  steps: Step[],
): { state: LeanState; counters: LeanRun["counters"] } {
  return foldOf({
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: "lean/fold-case",
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps,
  });
}

/** The record beside a routed log, addressed to `issue`. */
function routedSeed(
  issue: number,
  steps: Step[],
  snapshot: { state: LeanState; counters: LeanRun["counters"] },
): LeanRun {
  return {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: `feature/issue-${String(issue)}`,
    steps,
    state: snapshot.state,
    counters: snapshot.counters,
  };
}

/** The report entry the routing writes: the state the walk never stood in, no verdict. */
function routeEntry(issue: number): Step {
  return { key: key(issue, "handback", 0), state: "handback", startedAt: 1 };
}

// ── (a) a `handback` entry behind a CLEAN review → ci:green is not a route ─────
// The log is a real drive's (`driveRun` ran the table to `landed`), whose newest decided
// WORK step is `ci:green` behind a `review:done`. Appending a report entry there is a
// smuggled visit: the gate certified the head, so the routing predicate that let the
// legitimate one through does not speak for this one.
{
  const issue = 2261;
  const { dir, cleanup } = tempDir();
  try {
    const driven = await fixedReviewDriven(issue);
    // The record the routing leaves, with the ONE fact that makes it a forgery changed: the
    // newest DECIDED work step behind the report entry is a `review:done` that went on to
    // `ci:green`, so the gate spoke for the head and no uncertified head is being reported.
    // The log is cut at the first `review`, answered `done`, and then walked through CI and
    // the merge with the keys the engine's own attempt rule gives those visits.
    const clean = driven.slice(0, driven.findIndex((s) => s.state === "review") + 1);
    clean[clean.length - 1] = { ...(clean[clean.length - 1] as Step), outcome: { kind: "done" } };
    const visits = (state: LeanState): number => clean.filter((x) => x.state === state).length;
    const steps: Step[] = [
      ...clean,
      {
        key: key(issue, "ci", visits("ci")),
        state: "ci",
        startedAt: 90,
        endedAt: 91,
        outcome: { kind: "green" },
      },
      {
        key: key(issue, "land", 0),
        state: "land",
        startedAt: 92,
        endedAt: 93,
        outcome: { kind: "merged" },
      },
      {
        key: key(issue, "handback", 0),
        state: "handback",
        startedAt: 94,
        endedAt: 95,
        outcome: { kind: "done" },
      },
    ];
    writeForged(
      dir,
      routedSeed(issue, steps, {
        // `handed-back`, not `handback`: the report entry carries its verdict, so the fold
        // runs past it and the walk ends where the table leaves a merged run. A snapshot of
        // `handback` would be refused by the snapshot rule alone, and the case would pass
        // with the route check disabled.
        state: "handed-back",
        counters: foldPos(issue, steps.slice(0, -1)).counters,
      }),
    );
    const verdict = await loadVerdict(dir, issue);
    assert(
      verdict.refused && /belongs to handback but the walk stands at/.test(verdict.message),
      `(a) a report entry behind a clean review:done → ci:green is refused by the ROUTE check, not only by the snapshot beside it (${JSON.stringify(verdict)})`,
    );
  } finally {
    cleanup();
  }
}

// ── (b) the route is admitted once, and a second report entry is refused ───────
// The two arms are the same walk: the CI-fix prefix, a `fixed` second review, the gate the
// clock refused. With ONE report entry the fold admits the route — which is what makes the
// second arm's refusal the predicate's doing rather than a blanket refusal — and with a
// second, the exemption is withheld.
{
  const ADMITTED = 2262;
  const DOUBLED = 2263;
  const a = tempDir();
  const b = tempDir();
  try {
    const admittedLog = await routedLog(ADMITTED, "handback");
    writeForged(a.dir, routedSeed(ADMITTED, admittedLog.steps, admittedLog.snapshot));
    const ok = await loadVerdict(a.dir, ADMITTED);
    assert(
      !ok.refused,
      `(b) control: the routed record the engine really writes is ADMITTED by the fold (${JSON.stringify(ok)})`,
    );
    // The premise itself, checked by the same rule the routing keys on: a log this fold
    // admits is one the head rule says is standing over unverified bytes. Were it not, the
    // control would be admitting a shape the routing never produces.
    const steps = admittedLog.steps;
    assert(
      handbackHeads(steps).applies,
      "(b) control: and the head rule agrees the log stands over an uncertified head",
    );

    // The walk the exemption admits, with a SECOND report entry appended to the record it
    // left: the routing enters the report ONCE, so a second is invented, and `seen` is what
    // withholds the exemption. The first entry keeps the verdict the routing gave it — the
    // forgery adds one entry to an admitted record, and nothing else — because the fold stops
    // folding at the first entry it finds with no verdict, and a blank first entry would be
    // refused for that reason alone, which is not what this case is about.
    const { steps: admitted } = await routedLog(DOUBLED, "handback");
    const second: Step[] = [
      ...admitted.slice(0, -1),
      {
        ...(admitted[admitted.length - 1] as Step),
        endedAt: admitted.length,
        outcome: { kind: "done" },
      },
      { key: key(DOUBLED, "handback", 1), state: "handback", startedAt: admitted.length + 1 },
    ];
    writeForged(
      b.dir,
      routedSeed(DOUBLED, second, {
        state: "handed-back",
        counters: foldPos(DOUBLED, admitted).counters,
      }),
    );
    const refused = await loadVerdict(b.dir, DOUBLED);
    assert(
      refused.refused && /belongs to handback but the walk stands at/.test(refused.message),
      `(b) a SECOND report entry behind the same premise is refused (${JSON.stringify(refused)})`,
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
}

// ── (c) the routed entry's state is `handback`, not `decline` ──────────────────
{
  const issue = 2264;
  const { dir, cleanup } = tempDir();
  try {
    const declined = await routedLog(issue, "decline");
    writeForged(dir, routedSeed(issue, declined.steps, declined.snapshot));
    const verdict = await loadVerdict(dir, issue);
    assert(
      verdict.refused && /belongs to decline but the walk stands at/.test(verdict.message),
      `(c) a decline entry in the routed report's place is refused (${JSON.stringify(verdict)})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());

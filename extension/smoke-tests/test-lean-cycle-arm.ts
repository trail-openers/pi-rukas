#!/usr/bin/env bun
/**
 * lean: the cycle arm a /work host hands the engine (#1920 item 2) — the arm's
 * INPUTS, what it STOPS, and what it must never touch.
 *
 * Split from `test-lean-deadline-host-channel.ts` at AGENTS.md §12's line cap
 * along the seam the cases already had: this file is the CLOCK (what becomes an
 * arm, what an arm stops, what survives a resume); the other file is the
 * CHANNEL (who receives the report, and what text they are handed). Both drive
 * the real `driveLoop` through `runLean` with handlers that only record what
 * they were asked to do, so a step that ran when it should not have shows up as
 * a recorded call rather than hiding behind a stub — and both share
 * `lib/lean-host-contract-fixture.ts`, because a rig that drifts between the two
 * turns a real stop into an assertion about the rig.
 *
 *   (a) the verb's `--timeout` is parsed, refused when malformed, and threaded
 *       into the engine as a VALUE — the environment is never written;
 *   (b) one contract, one reader: the flag, `PI_ENSEMBLE_CYCLE_BUDGET_MS` and
 *       `PI_ENSEMBLE_CYCLE_DEADLINE` resolve through the same rules `work` uses,
 *       including the epoch-in-seconds refusal;
 *   (c) a run the clock caught ends `handed-back` at 10 with no step run at all,
 *       its reason naming the clock, and the arm on the record;
 *   (d) an arm outside the handoff allowance stops nothing;
 *   (e) the reporting steps are exempt — a run standing in `handback` past its
 *       allowance still writes its report;
 *   (f)/(f′) a resume keeps the arm its FIRST round persisted, whatever the env
 *       says now, and a run with no deadline input is unaffected by any of this.
 */

import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { MINUTE_MS, leanDeadline } from "../src/lean/deadline.ts";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import { INITIAL_COUNTERS, type LeanRun, loadRun } from "../src/lean/state.ts";
import { flagBudgetMs } from "../src/work-driver-deadline.ts";
import { handoffDispatchTimeoutMs } from "../src/work-driver-handoff.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import {
  DAY,
  WALK,
  cleanScratch,
  crossing,
  recording,
  scratch,
  verbRun,
  wellFormedHandback,
  withEnv,
} from "./lib/lean-host-contract-fixture.ts";

const { assert, state } = makeAssert();

/** The clock `crossing` starts from — `Date.now()` when the fixture was built. */
function startOf(clock: { past: number }): number {
  // The fixture's two positions are `start` and `start + budget - 60s` with the
  // budget fixed at 240 minutes, so the early position is recoverable without
  // the fixture having to publish it.
  return clock.past - (240 * 60_000 - 60_000);
}

// ───────────────────────────── (a) the verb's `--timeout` reaches the engine
{
  const r = await verbRun(["7", "--timeout", "5"], wellFormedHandback());
  assert(r.code === 10, `(a) --timeout is accepted and the run ran (exit ${String(r.code)})`);
  assert(
    r.mode?.timeoutMs === 5 * MINUTE_MS,
    `(a) the flag arrives as minutes × 60 000 (got ${String(r.mode?.timeoutMs)})`,
  );
  assert(r.violations.length === 0, `(a) output contract (${r.violations.join("; ")})`);
}
{
  const r = await verbRun(["7"], wellFormedHandback());
  assert(
    r.code === 10 && r.mode?.timeoutMs === undefined,
    `(a) no flag, no arm: the run ran with timeoutMs absent (exit ${String(r.code)}, got ${String(r.mode?.timeoutMs)})`,
  );
}
{
  // The flag's destination, not just its parse. It is threaded as a VALUE into
  // the engine's `budgetMs` and resolved by the shared reader — the environment
  // is the host's input and is NEVER written, because a process that armed
  // `PI_ENSEMBLE_CYCLE_BUDGET_MS` from a flag gave every later run in the same
  // process that deadline, and left the parent with a clock it could not read
  // back. So this asserts BOTH halves: the engine received the arm, and the env
  // it did not.
  // The sentinel must be a key the run could clobber and the reader does NOT
  // read. A numeric `PI_ENSEMBLE_CYCLE_BUDGET_MS` cannot serve: the host's
  // exported budget OUTRANKS the caller's flag, so a numeric sentinel becomes the
  // arm and this case would assert a 5-minute deadline on a run armed with `1`.
  // `""` is the reader's own "no env input" spelling (`resolveCycleDeadline`
  // treats both absent and empty as unset), so the flag stays the arm WHILE the
  // key still exists: `withEnv({})` deletes it, and an assertion against
  // `undefined` then compares undefined to undefined — true whether or not the
  // run wrote the environment.
  await withEnv({ PI_ENSEMBLE_CYCLE_BUDGET_MS: "" }, async () => {
    const before = process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
    assert(
      before === "",
      `(a) the sentinel is present before the run (got ${JSON.stringify(before)})`,
    );
    const r = await verbRun(["7", "--timeout", "5"], wellFormedHandback());
    // The arm is a DURATION resolved to an epoch, so its absolute value is the
    // instant the engine asked; what must be exact is the duration the reader was
    // given. `startOf` is that instant recovered from the arm and the flag.
    assert(
      r.code === 10 &&
        r.engine?.budgetMs !== undefined &&
        Math.abs(r.engine.budgetMs - Date.now()) < 60_000,
      `(a) --timeout reaches the engine as a 5-minute arm the shared reader resolves (arm ${String(r.engine?.budgetMs)}, now ${String(Date.now())})`,
    );
    assert(
      process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === before,
      `(a) and the run wrote no deadline into the environment (env got ${String(process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS)}, was ${String(before)})`,
    );
  });
}
// The parser's own refusal (a flag is no value) and the verb's numeric check are
// two different refusals of the same flag; both are argv refusals at 40.
for (const [bad, expectRan] of [
  [["0"], false],
  [["-3"], false],
  [["abc"], false],
] as [string[], boolean][]) {
  const r = await verbRun(["7", ...bad], wellFormedHandback());
  assert(
    r.code === 40 && !r.ran,
    `(a) \`--timeout ${bad.join(" ")}\` refused at argv, engine untouched (exit ${String(r.code)}, ran=${String(r.ran)})`,
  );
}
{
  // A value that is another flag is NOT a missing value: `parseFlags` refuses it
  // with its own words before the verb's numeric check sees it, and the refusal
  // is still an argv refusal.
  const r = await verbRun(["7", "--timeout", "--json"], wellFormedHandback());
  assert(
    r.code === 40 && !r.ran,
    `(a) --timeout followed by another flag refused at argv (exit ${String(r.code)}, ran=${String(r.ran)})`,
  );
}

// ───────────────── (b) one contract, one reader: what arms a lean run's clock
// The three inputs are weighed by the SAME `resolveCycleDeadline` `work` reads,
// in the order the host expects: an absolute deadline it exported beats a budget
// it exported, and either beats the caller's `--timeout`. A run that weighed them
// differently would park a cycle its host had armed, or keep working past one.
await withEnv({}, async () => {
  const start = 1_700_000_000_000;
  const flag = flagBudgetMs(3 * MINUTE_MS);
  assert(
    leanDeadline(undefined, start, flag) === start + 3 * MINUTE_MS,
    "(b) the flag alone becomes an epoch resolved once, the same input `work` reads",
  );
  assert(
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === undefined &&
      process.env.PI_ENSEMBLE_CYCLE_DEADLINE === undefined,
    "(b) and resolving it wrote nothing to the environment",
  );
  await withEnv({ PI_ENSEMBLE_CYCLE_BUDGET_MS: String(99 * MINUTE_MS) }, async () => {
    assert(
      leanDeadline(undefined, start, flag) === start + 99 * MINUTE_MS,
      "(b) a budget the caller exported itself outranks the flag",
    );
    await withEnv(
      {
        PI_ENSEMBLE_CYCLE_BUDGET_MS: String(99 * MINUTE_MS),
        PI_ENSEMBLE_CYCLE_DEADLINE: "1700000200000",
      },
      async () => {
        assert(
          leanDeadline(undefined, start, flag) === 1700000200000,
          "(b) and an explicit absolute deadline outranks both",
        );
      },
    );
  });
  assert(
    leanDeadline(undefined, start) === undefined,
    "(b) a run with no flag and no env input has no clock at all",
  );
  // The arm a first boundary resolved is the arm every later one keeps, while a
  // duration is still set — the rule that stops a budget restarting its own clock.
  assert(
    leanDeadline(start + MINUTE_MS, start, flag) === start + MINUTE_MS,
    "(b) and a persisted arm survives the flag rather than re-resolving from now",
  );
  // `EPOCH_MS_FLOOR`: an epoch in SECONDS is an operator typo, not a deadline, and
  // obeying it would stop every step at once.
  await withEnv({ PI_ENSEMBLE_CYCLE_DEADLINE: "1700000200" }, async () => {
    assert(
      leanDeadline(undefined, start, flag) === undefined,
      "(b) an epoch in seconds is read as no deadline, not as a deadline in 1970",
    );
  });
});

// ── (c) the clock stops step work; the run reports instead of being killed
await withEnv({ PI_ENSEMBLE_CYCLE_DEADLINE: String(Date.now() - MINUTE_MS) }, async () => {
  const repo = scratch("past");
  const calls: string[] = [];
  const r = await runLean({
    repoRoot: repo,
    issue: 401,
    handlers: recording(calls, WALK),
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  assert(
    r.code === 10 && r.state === "handed-back",
    `(c) a run that starts past its deadline ends handed-back at 10 (got ${r.state}/${String(r.code)})`,
  );
  assert(calls.length === 0, `(c) no step ran at all (ran: ${calls.join(",")})`);
  assert(
    String(r.run.result?.reason).includes("cycle deadline"),
    `(c) the reason names the clock that stopped it (got ${String(r.run.result?.reason)})`,
  );
  assert(
    r.run.deadlineMs === Number(process.env.PI_ENSEMBLE_CYCLE_DEADLINE),
    `(c) the arm is persisted on the record a host reads (got ${String(r.run.deadlineMs)})`,
  );
  assert(
    loadRun(repo, 401)?.deadlineMs === r.run.deadlineMs,
    "(c) and the durable file carries it, not just the returned run",
  );
  const projected = leanIssueResult(r.run, r.code) as unknown as Record<string, unknown>;
  assert(
    projected.status === "handoff",
    `(c) the document is the handoff document a host can act on (got ${String(projected.status)})`,
  );
});

// ── (d) a deadline beyond the handoff allowance is not a stop: the run works
await withEnv({ PI_ENSEMBLE_CYCLE_DEADLINE: String(Date.now() + DAY) }, async () => {
  const repo = scratch("future");
  const calls: string[] = [];
  const r = await runLean({
    repoRoot: repo,
    issue: 402,
    handlers: recording(calls, WALK),
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  assert(
    calls.length >= 9 && r.state === "landed",
    `(d) a deadline far away stops nothing (ran ${calls.length} steps, state ${r.state})`,
  );
  assert(
    r.run.deadlineMs === Number(process.env.PI_ENSEMBLE_CYCLE_DEADLINE),
    "(d) and the arm is still recorded while the run works",
  );
});

// ── (e) the clock never stops the report: `handback` runs with a past deadline
await withEnv({ PI_ENSEMBLE_CYCLE_BUDGET_MS: String(240 * MINUTE_MS) }, async () => {
  const repo0 = scratch("handback-past");
  const calls: string[] = [];
  // The clock crosses at the LAST GATE, not at the report. The boundary that
  // reads a red verdict is the one the stop test governs (it decides whether the
  // run may start another step), so a crossing there means the run ENTERS
  // `handback` already past the allowance and the stop test it is judged by sees
  // `past` — which is the boundary the exemption exists for. Crossing at
  // `handback` itself would put the first `past` read AFTER that stop test, where
  // the case passes identically with or without the rule it advertises.
  const clock = crossing({ at: "verify", repoRoot: repo0, issue: 403, times: 1 });
  // The run's gate already said red twice, so the table's own rule hands the
  // third verdict to the step that tells the operator. The clock must not take
  // that one away.
  const r = await runLean({
    repoRoot: repo0,
    issue: 403,
    handlers: recording(calls, {
      ...WALK,
      verify: [
        { kind: "red", reason: "acceptance test x is red" },
        { kind: "red", reason: "acceptance test x is red" },
      ],
    }),
    seed: { version: "0.0.0-test", baseSha: "" },
    now: clock.now,
  });
  assert(
    calls.includes("handback"),
    `(e) the reporting step ran despite the past deadline (ran: ${calls.join(",")})`,
  );
  assert(
    r.state === "handed-back" && r.code === 10,
    `(e) and the run ended its normal way (got ${r.state}/${String(r.code)})`,
  );
  // The claim is worth only what the crossing is worth. `crossed()` is set when
  // the clock is found PAST at the SECOND read of a boundary — the read the stop
  // test itself takes — so a run that reached its report while still in
  // allowance, or a fixture that never moved, is distinguishable from the case
  // this one exists for. Without it `calls.includes("handback")` reads the same
  // whether the exemption held or the deadline simply had not arrived.
  const stamps = r.run.steps.map((s2) => [s2.state, s2.startedAt, s2.endedAt ?? null]);
  assert(
    clock.crossed(),
    `(e) the stop test of some boundary saw the clock past the allowance (stamps ${JSON.stringify(stamps)})`,
  );
  const report = r.run.steps.filter((s2) => s2.state === "handback").pop();
  assert(
    report !== undefined && report.endedAt === clock.past,
    `(e) the report was written PAST the deadline, so the exemption did the work (stamps ${JSON.stringify(stamps)})`,
  );
  assert(
    r.run.steps.some((s2) => s2.state !== "handback" && s2.startedAt !== clock.past),
    `(e) and the work before it ran inside the allowance — the clock crossed on the way, not before (stamps ${JSON.stringify(stamps)})`,
  );
  // `arm - start` is the budget and `arm - past` the allowance, so the two
  // positions really straddle the line this case is about.
  const arm = r.run.deadlineMs as number;
  assert(
    arm - startOf(clock) > handoffDispatchTimeoutMs() &&
      arm - clock.past <= handoffDispatchTimeoutMs(),
    `(e) the two clock positions straddle the allowance (arm-start=${String(arm - startOf(clock))}, arm-past=${String(arm - clock.past)}, allowance=${String(handoffDispatchTimeoutMs())})`,
  );
});

// ── (f) a resume keeps its clock; no arm at all, no behaviour change
await withEnv({ PI_ENSEMBLE_CYCLE_DEADLINE: String(Date.now() + DAY) }, async () => {
  const repo = scratch("resume");
  const first = await runLean({
    repoRoot: repo,
    issue: 404,
    handlers: recording([], WALK),
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  const armed = first.run.deadlineMs;
  assert(first.state === "landed", `(f) the first round ran to its end (got ${first.state})`);
  assert(armed !== undefined, "(f) the first round resolved an arm to keep");
  // A DIFFERENT arm for the second drive: if the engine re-read the env the
  // resumed run's clock would be this one, not the arm the first round persisted.
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(Date.now() + 2 * DAY);
  const calls: string[] = [];
  const again = await runLean({
    repoRoot: repo,
    issue: 404,
    handlers: recording(calls, WALK),
    now: () => Date.now(),
  });
  assert(
    again.run.deadlineMs === armed,
    `(f) a resume keeps the clock its first round resolved, not a fresh env read (got ${String(again.run.deadlineMs)} vs ${String(armed)})`,
  );
  assert(
    again.state === "landed" && again.code === 0,
    `(f) and the finished record replays unchanged (${again.state}/${String(again.code)})`,
  );
  // A2 — the arm is a field of the DURABLE record. This asserts the two halves
  // a test can actually reach: the resume reads its clock from the FILE (delete
  // the `drive.save(run)` inside the deadline branch of `driveLoop` and (f′)
  // fails, because a half-finished run's next load finds no arm and re-resolves
  // one from the halved budget), and the bytes on disk say the same thing the
  // record's own validator accepted. What no assertion here can prove is that the
  // FIRST boundary's write reaches the file: `startStep`'s write-ahead spreads the
  // in-memory run over the file a moment later, and an ES-module export cannot be
  // reassigned from a test to observe the window between the two, so a mutant that
  // drops only that one save is masked by the next one. It is masked harmlessly —
  // the field still lands before any handler runs, and (f′) is the assertion that
  // a resumed run is governed by what the file holds.
  const onDisk = loadRun(repo, 404);
  assert(
    onDisk?.deadlineMs === armed,
    `(f) the file the next boundary reads holds the arm (got ${String(onDisk?.deadlineMs)} vs ${String(armed)})`,
  );
});

// ── (f′) two `runLean` calls with a DIFFERENT env budget between them: the
// second drive must keep the first round's clock. `readCycleDeadline`'s rule is
// that the persisted arm wins while a budget is set, so a host that re-exports
// `PI_ENSEMBLE_CYCLE_BUDGET_MS` between boundaries — a wrapper that recomputes it
// from wall-clock start, a second unit in the same container — cannot hand a
// half-finished run a fresh allowance and never park. A crash between the two
// calls is the shape this reproduces, so the first drive is stopped mid-walk.
await withEnv({ PI_ENSEMBLE_CYCLE_BUDGET_MS: String(240 * MINUTE_MS) }, async () => {
  const repo = scratch("resume-budget");
  const firstCalls: string[] = [];
  const first = await runLean({
    repoRoot: repo,
    issue: 406,
    // `build` throws on its SECOND visit: the engine records the error outcome and
    // ends the run handed-back, which is the mid-run death a resume picks up. The
    // arm was already resolved and saved at the first boundary, before any handler
    // ran.
    handlers: {
      ...recording(firstCalls, { ...WALK, build: [] }),
      // `build` is NOT taken from `WALK`: with the walk's own handler the run
      // reaches `landed`, and this case would assert a mid-run death on a run that
      // finished. Overriding it here is what kills the run on the step the arm was
      // already persisted for — `driveLoop` resolves and saves the arm at the
      // boundary BEFORE the handler runs, so the record carries the clock this
      // resume must keep even though the walk never finished. The push makes "the
      // run died IN `build`" an observation rather than an inference: `build` is
      // the last state recorded, and nothing after it ever ran.
      build: async () => {
        firstCalls.push("build");
        throw new Error("simulated crash mid-build");
      },
    },
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  const armed = first.run.deadlineMs;
  assert(armed !== undefined, "(f′) the first round resolved an arm from the budget");
  // The run died mid-walk. An errored step ENDS the run, so a `result` is written
  // either way — the facts that say the first drive never finished are WHERE it
  // stopped and HOW FAR the walk got: a run that died in `build` sits at
  // `handed-back` with the gate never run, where the walk's own answer is
  // `landed`. The second call is therefore a genuine resume of a record whose
  // clock the first round set.
  assert(
    first.state === "handed-back" &&
      firstCalls.join(",") === "ready,specify,build" &&
      !firstCalls.includes("verify"),
    `(f′) the first round died IN \`build\` and never reached the gate, so the second call is a real resume (state ${first.state}, steps ${JSON.stringify(firstCalls)})`,
  );
  // The budget is now HALF of what the first call saw. A re-resolution would
  // produce an arm roughly `240 - 120` minutes LATER than the persisted one.
  process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS = String(120 * MINUTE_MS);
  const again = await runLean({
    repoRoot: repo,
    issue: 406,
    handlers: recording([], WALK),
  });
  assert(
    again.run.deadlineMs === armed,
    `(f′) the resume kept the arm its first round persisted, not the halved budget it was handed (got ${String(again.run.deadlineMs)} vs ${String(armed)})`,
  );
  assert(
    loadRun(repo, 406)?.deadlineMs === armed,
    `(f′) and the durable record says the same (got ${String(loadRun(repo, 406)?.deadlineMs)})`,
  );
});
await withEnv({}, async () => {
  const repo = scratch("no-deadline");
  const calls: string[] = [];
  const r = await runLean({
    repoRoot: repo,
    issue: 405,
    handlers: recording(calls, WALK),
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  assert(
    r.run.deadlineMs === undefined && calls.length >= 9,
    `(f) with no deadline input nothing changed: no arm, ${calls.length} steps ran`,
  );
  assert(
    loadRun(repo, 405)?.deadlineMs === undefined,
    "(f) and nothing was written to the record that was not asked for",
  );
});

cleanScratch();
process.exit(state.exit);

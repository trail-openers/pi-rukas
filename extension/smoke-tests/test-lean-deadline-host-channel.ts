#!/usr/bin/env bun
/**
 * lean: the host contract a /work host drives the engine with (#1920 items 2, 3, 6).
 *
 * The lean engine answered to none of the deadline contract: `--timeout` was
 * refused at argv (exit 40) and `PI_ENSEMBLE_CYCLE_DEADLINE` was ignored, so a
 * host supervising both engines enforced the wall clock for one of them and
 * trusted the other to end on its own. And `PI_ENSEMBLE_HANDOFF_CHANNEL=host`
 * changed nothing: both reporting steps posted their comment anyway and the
 * result said `channel: "forge"`, so a host that posts the report itself got a
 * second copy on the issue — and could not see the text it was meant to post.
 *
 *   (a) `--timeout 5` is accepted by the verb and reaches the engine as 5
 *       minutes; a nonsense value is refused at argv with 40, not run;
 *   (b) `armCycleBudget` writes the same input `work` reads, and yields to a
 *       deadline or budget the caller exported itself — one reader
 *       (`readCycleDeadline`) decides for both engines, so the two cannot
 *       disagree about what one environment means;
 *   (c) a run that starts with its deadline inside the handoff allowance ends
 *       `handed-back` WITHOUT running another step, its reason names the
 *       `cycle deadline` (the word `headless/exit-code.ts` pairs with exit 10,
 *       the exit `work` returns for the same stop), and the resolved arm is on
 *       the record — the host's only way to tell a deadline stop from a plain
 *       handback, since both end in the same state;
 *   (d) a deadline beyond the handoff allowance is NOT a stop: the run works, and
 *       the arm is still recorded;
 *   (e) the reporting steps are never stopped by the clock — a run standing in
 *       `handback` with a deadline it cannot beat still writes its report;
 *   (f) a resumed run keeps the arm its first round resolved rather than re-reading
 *       the env, and a run with no deadline input is unaffected by any of this;
 *   (g) on the host channel the real `handback` handler posts nothing, records the
 *       not-posted pair on its own step, and the projected result says
 *       `channel: "host"` with the body the host is meant to deliver and
 *       `labelSkipped: "host-channel"`;
 *   (h) the same for `decline`, and the run still ends `not-ready` at 11 — the spec
 *       refused it whatever channel the reason travels on;
 *   (i) on the FORGE channel nothing changed: the post happens, the step claims
 *       `posted: true`, and the projected handoff keeps `channel: "forge"` with no
 *       host-channel label claim;
 *
 * `failure.cause` — the third piece of the contract — is its own file,
 * `test-lean-failure-cause.ts`: it is a property of the PROJECTION, not of the
 * engine these cases drive.
 *
 * Cases (c)–(f) drive the REAL `driveLoop` through `runLean` with handlers that
 * only record what they were asked to do, so a step that ran when it should not
 * have shows up as a recorded call rather than hiding behind a stub. Cases (g)–(i)
 * drive the production wiring (`phase1Handlers`) and project it with the result
 * module the verb uses.
 */

import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { MINUTE_MS, leanDeadline } from "../src/lean/deadline.ts";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import { setLeanCommentPoster } from "../src/lean/io.ts";
import { INITIAL_COUNTERS, type LeanRun, type Step, loadRun } from "../src/lean/state.ts";
import { flagBudgetMs } from "../src/work-driver-deadline.ts";
import { HOST_CHANNEL_MARK, handoffChannel } from "../src/work-driver-handoff-channel.ts";
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
import { CHILDREN, URL, driveLean, leanLog, stepWith } from "./lib/lean-result-fixture.ts";

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
  await withEnv({}, async () => {
    const before = process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
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
    // `build` throws on its SECOND visit: the engine records the error outcome
    // and ends the run without a `result`, which is exactly the mid-run death a
    // resume picks up. The arm was already resolved and saved at the first
    // boundary, before any handler ran.
    handlers: {
      ...recording(firstCalls, WALK),
      build: async () => {
        if (firstCalls.filter((c) => c === "build").length >= 1)
          throw new Error("simulated crash mid-build");
        return { kind: "ok" };
      },
    },
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  const armed = first.run.deadlineMs;
  assert(armed !== undefined, "(f′) the first round resolved an arm from the budget");
  assert(
    first.result === undefined,
    `(f′) and the run died mid-walk, so the second call is a real resume (result ${JSON.stringify(first.result)})`,
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

// ── (g)+(i) the real handback handler, on each channel
// The budget is the host's `--timeout` made concrete (what `armCycleBudget`
// writes; item (b) pins that function itself), and the clock crosses AT the
// report — so the reporting step runs only because it is exempt, and the
// assertions below prove the crossing happened rather than assuming it.
for (const channel of ["host", "forge"] as const) {
  await withEnv(
    {
      PI_ENSEMBLE_HANDOFF_CHANNEL: channel,
      PI_ENSEMBLE_CYCLE_BUDGET_MS: String(240 * MINUTE_MS),
    },
    async () => {
      assert(
        handoffChannel() === channel,
        `(${channel === "host" ? "g" : "i"}) the channel reader agrees it is ${channel}`,
      );
      const repo = scratch(`handback-${channel}`);
      // The one production wiring for the STEPS THE CASE IS ABOUT: the run is
      // scripted down to the gate, which is scripted red, and the table then routes
      // it to `handback` — whose handler is the real one `runWorkLean` builds, post
      // seam and all. The states before it are answered from the log rather than
      // run, so no case here depends on a forge, a worktree or a model.
      const wired = phase1Handlers(repo, 410);
      const clock = crossing({ at: "verify", repoRoot: repo, issue: 410, times: 1 });
      const driven = await runLean({
        repoRoot: repo,
        issue: 410,
        // The production wiring for every step, with the earlier steps answered
        // by script so the drive actually ARRIVES at `handback`: what is under
        // test is the wiring of the reporting step, not the gate that routed to it.
        handlers: {
          ...wired,
          ...recording([], {
            ready: [{ kind: "ok" }],
            specify: [{ kind: "ok" }],
            build: [{ kind: "ok" }, { kind: "ok" }],
            challenge: [{ kind: "none" }],
            verify: [
              { kind: "red", reason: "acceptance test x is red" },
              { kind: "red", reason: "acceptance test x is red" },
              { kind: "red", reason: "acceptance test x is red" },
            ],
          }),
        },
        seed: { version: "0.0.0-test", baseSha: "" },
        // Every WORKING step starts inside the allowance, and the clock has gone by
        // the time the run stands in `handback` — so the step that appears below ran
        // only because the reporting states are exempt (pinned by the `startedAt`
        // assertion in the host branch).
        now: clock.now,
      });
      const handback = driven.run.steps.filter((s) => s.state === "handback").pop();
      assert(
        handback !== undefined,
        `(g/i) the wired run reached its report (state ${driven.state}, reason ${String(driven.run.result?.reason)})`,
      );
      const projected = leanIssueResult(driven.run, driven.code) as unknown as Record<
        string,
        unknown
      >;
      const handoff = projected.handoff as Record<string, unknown> | undefined;
      if (channel === "host") {
        assert(
          handback?.outcome?.posted === false,
          `(g) the host channel posts nothing, and the step says so (got ${JSON.stringify(handback?.outcome?.posted)})`,
        );
        // The CHANNEL the projection reads is the step's TYPED claim, written once
        // by the handler in `lean/command.ts`. A `posted: false` alone is not the
        // answer — a forge post the forge refused carries that too — so the two
        // fields are asserted together on a step that went through the real wiring:
        // a run that posted nothing and recorded no channel would be read as a
        // failed forge post and publish no body the host still has to deliver.
        assert(
          handback?.outcome?.channel === "host",
          `(g) the step records the channel it reported on (got ${JSON.stringify(handback?.outcome?.channel)})`,
        );
        // L5 — the body the host posts is the RUN'S REPORT: the `report` the step
        // built, not the sentence `handbackOutcome` wrote about its own post. The
        // reason keeps saying what the step did; the report is what the host prints.
        assert(
          String(handback?.outcome?.reason) === "handback comment posted",
          `(g) the step still records what it did (got ${JSON.stringify(String(handback?.outcome?.reason))})`,
        );
        assert(
          typeof handback?.outcome?.report === "string" &&
            handback.outcome.report.includes("acceptance test x is red") &&
            handback.outcome.report.includes("Frozen acceptance tests"),
          `(g) and records the comment it built, in full (got ${JSON.stringify(String(handback?.outcome?.report).slice(0, 70))})`,
        );
        assert(
          handoff?.bodyError === undefined &&
            typeof handoff?.body === "string" &&
            handoff.body.includes("acceptance test x is red") &&
            !handoff.body.includes("comment posted"),
          `(g) the published body IS that report, not a delivery note (got ${JSON.stringify(String(handoff?.body).slice(0, 90))})`,
        );
        assert(
          handback?.endedAt === clock.past && clock.crossed(),
          `(g) the report ran PAST the deadline, so this is the exempt-boundary case (endedAt ${String(handback?.endedAt)} vs past ${String(clock.past)}, crossed=${String(clock.crossed())})`,
        );
        assert(
          handoff?.channel === "host",
          `(g) the projected handoff is addressed to the host (got ${JSON.stringify(handoff?.channel)})`,
        );
        assert(
          typeof handoff?.body === "string" && handoff.body.includes("pi-rukas:handoff issue=410"),
          `(g) and carries the marker the host's own post must carry (got ${JSON.stringify(String(handoff?.body).slice(0, 60))})`,
        );
        assert(
          handoff?.labelSkipped === "host-channel" && handoff?.labelApplied === false,
          `(g) a false label is the contract, not an outage (got ${JSON.stringify([handoff?.labelApplied, handoff?.labelSkipped])})`,
        );
        assert(
          handoff?.bodyError === undefined,
          `(g) and it is not the forge's "published nothing" pair (got ${JSON.stringify(handoff?.bodyError)})`,
        );
      } else {
        // The forge channel has no forge to post to in a test run, so the honest
        // expectation is the OTHER half of the rule: the host-channel stamp is
        // absent and the contract's own not-delivered pair is present — which is
        // what a forge post that failed also gets, and what a host-channel run
        // must NOT get (asserted above). The "posted" half is pinned by the
        // projection's own forge cases and by `handbackOutcome`'s tests.
        assert(
          handback?.outcome?.posted === false &&
            String(handback?.outcome?.reason).includes("NOT posted"),
          `(i) the forge path still posts through the real seam and records the failure honestly (got ${JSON.stringify([handback?.outcome?.posted, handback?.outcome?.reason])})`,
        );
        assert(
          handoff?.channel === "forge" && handoff?.bodyError === "not-recorded",
          `(i) and the projection keeps the forge's not-delivered pair (got ${JSON.stringify([handoff?.channel, handoff?.bodyError])})`,
        );
        assert(
          handoff?.labelSkipped === undefined,
          `(i) no host-channel label claim leaks onto the forge path (got ${JSON.stringify(handoff?.labelSkipped)})`,
        );
      }
    },
  );
}

// ── (g′) "the host channel posts nothing" is FALSIFIABLE, not a vibe. The
// recording post seam (`setLeanCommentPoster`) is the only witness: in a temp repo
// there is no forge, so `posted: false` from the host contract and `posted: false`
// from a forge post that failed look IDENTICAL on the record. With the seam, the
// two are two different counts — and the forge arm of the loop above would go
// green on a host channel that posted, if the count were not pinned at 0.
for (const [channel, want] of [
  ["host", 0],
  ["forge", 1],
] as const) {
  await withEnv({ PI_ENSEMBLE_HANDOFF_CHANNEL: channel }, async () => {
    const repo = scratch(`post-count-${channel}`);
    const posted: string[] = [];
    const undo = setLeanCommentPoster(async (_issue, body) => {
      posted.push(body);
    });
    try {
      // The HANDOFF leg: the real wired `handback` handler, one red gate away
      // from its report.
      const driven = await runLean({
        repoRoot: repo,
        issue: 412,
        handlers: {
          ...phase1Handlers(repo, 412),
          ...recording([], {
            ready: [{ kind: "ok" }],
            specify: [{ kind: "ok" }],
            build: [{ kind: "ok" }, { kind: "ok" }],
            challenge: [{ kind: "none" }],
            verify: [
              { kind: "red", reason: "acceptance test x is red" },
              { kind: "red", reason: "acceptance test x is red" },
              { kind: "red", reason: "acceptance test x is red" },
            ],
          }),
        },
        seed: { version: "0.0.0-test", baseSha: "" },
      });
      assert(
        driven.state === "handed-back",
        `(g′) the ${channel} handback run finished (got ${driven.state})`,
      );
      assert(
        posted.length === want,
        `(g′) the ${channel} channel's handback posted ${String(want)} comments (got ${String(posted.length)}: ${JSON.stringify(posted.map((p) => p.slice(0, 40)))})`,
      );
      // The DECLINE leg, same seam, same counting — the refusal comment is the
      // other half of the contract and the other step that decides to post.
      const repo2 = scratch(`post-count-decline-${channel}`);
      posted.length = 0;
      const refused = await runLean({
        repoRoot: repo2,
        issue: 413,
        handlers: {
          ...phase1Handlers(repo2, 413),
          ready: async () => ({
            kind: "fail",
            failedRules: ["issue body has no pi-spec v1 block"],
          }),
        },
        seed: { version: "0.0.0-test", baseSha: "" },
      });
      assert(
        refused.state === "not-ready",
        `(g′) the ${channel} decline run finished (got ${refused.state})`,
      );
      assert(
        posted.length === want,
        `(g′) the ${channel} channel's decline posted ${String(want)} comments (got ${String(posted.length)}: ${JSON.stringify(posted.map((p) => p.slice(0, 40)))})`,
      );
      // And the body the forge DID take is the refusal — the same report the host
      // is handed on the other channel, so one channel is not a degraded version
      // of the other.
      if (want === 1) {
        assert(
          posted[0] !== undefined && posted[0].includes("pi-spec v1"),
          `(g′) the forge took the refusal's text (got ${JSON.stringify(String(posted[0]).slice(0, 60))})`,
        );
      }
    } finally {
      undo();
    }
  });
}

// ── (h) the host channel does not soften a refusal: decline still ends at 11
await withEnv({ PI_ENSEMBLE_HANDOFF_CHANNEL: "host" }, async () => {
  const repo = scratch("host-decline");
  const r = await runLean({
    repoRoot: repo,
    issue: 411,
    handlers: {
      ...phase1Handlers(repo, 411),
      ready: async () => ({
        kind: "fail",
        failedRules: ["issue body has no pi-spec v1 block"],
      }),
    },
    seed: { version: "0.0.0-test", baseSha: "" },
  });
  assert(
    r.state === "not-ready" && r.code === 11,
    `(h) the host channel leaves the verdict and the exit alone (got ${r.state}/${String(r.code)})`,
  );
  const decline = r.run.steps.filter((s) => s.state === "decline").pop();
  assert(
    decline?.outcome?.kind === "done" && decline.outcome.posted === false,
    `(h) the decline step ran and claimed nothing posted (got ${JSON.stringify(decline?.outcome)})`,
  );
  // The CHANNEL is the step's typed claim, not prose the projection has to
  // recognise: the reason is the REPORT (L5), and a reader of the comment must
  // learn what the spec refused, not that the harness skipped a post.
  assert(
    decline?.outcome?.channel === "host",
    `(h) the step records the channel it reported on (got ${JSON.stringify(decline?.outcome?.channel)})`,
  );
  assert(
    String(decline?.outcome?.reason).includes("pi-spec v1") &&
      !String(decline?.outcome?.reason).includes(HOST_CHANNEL_MARK),
    `(h) and its reason is the refusal itself, not a note about the delivery (got ${String(decline?.outcome?.reason)})`,
  );
  const handoff = (leanIssueResult(r.run, r.code) as unknown as Record<string, unknown>).handoff as
    | Record<string, unknown>
    | undefined;
  assert(
    handoff?.channel === "host" && typeof handoff?.body === "string",
    `(h) the refusal's text reaches the host rather than the forge (got ${JSON.stringify([handoff?.channel, typeof handoff?.body])})`,
  );
  assert(
    String(handoff?.body).includes("pi-spec v1"),
    `(h) and it is the run's own reason (got ${JSON.stringify(String(handoff?.body).slice(0, 80))})`,
  );
});

// ── (k) #1593 for lean, assessed and NOT built. `work` puts its cycle under
// `withCycleClock` so a child already running when the caller's deadline arrived is
// bounded by what the deadline leaves (`clampToCycleDeadline` in the spawn layer).
// `lean/engine.ts` needs no equivalent and adding one is refused here rather than
// left for someone to guess at: `driveLoop` re-reads `run.deadlineMs` through
// `leanDeadline` at EVERY boundary, so a lean run cannot stand in a step with a
// stale or missing arm the way a `work` cycle can — which is why no
// `noteCycleDeadline` call appears in this file, and why one would be a second
// clock for one run rather than a fix. What the arm does govern here is asserted
// above: the stop test at the boundary ((c)–(e)) and the record's own field ((c),
// (f), (f′)).

// ── (j) a non-terminal state is REFUSED, not projected. `leanStatus` has three
// arms because the verb's `wellFormed` gate admits only the three states
// `EXIT_CODES` names; a fourth would be a status no run can produce, and a status
// is what a host switches on. The old tail returned `running`/`interrupted` for
// that impossible case, so a bug upstream showed up as a plausible wrong document.
{
  const armed = 1_700_000_000_000;
  for (const state of ["ready", "build", "verify"] as const) {
    let thrown: unknown;
    try {
      leanIssueResult({ ...fakeRunState(), state } as LeanRun, 10);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && /not a terminal lean state/.test(thrown.message),
      `(j) projecting a run still at ${state} refuses rather than inventing a status (got ${String(thrown)})`,
    );
  }
  // And the three legal states still project, so the refusal is not a blanket
  // throw that would take the real documents down with it.
  for (const [state, code, want] of [
    ["landed", 0, "merged"],
    ["handed-back", 10, "handoff"],
    ["not-ready", 11, "aborted"],
  ] as const) {
    const projected = leanIssueResult(
      { ...fakeRunState(), state, deadlineMs: armed } as LeanRun,
      code,
    ) as unknown as Record<string, unknown>;
    assert(
      projected.status === want,
      `(j) ${state} still projects as ${want} (got ${String(projected.status)})`,
    );
  }
}

/** A minimal record whose only job is to reach `leanStatus`'s three arms. */
function fakeRunState(): LeanRun {
  return {
    schema: 1,
    issue: 420,
    version: "0.0.0-test",
    models: {},
    baseSha: "",
    branch: "",
    state: "handed-back",
    counters: { ...INITIAL_COUNTERS },
    steps: [],
    result: { code: 10, reason: "test" },
  };
}

cleanScratch();
process.exit(state.exit);

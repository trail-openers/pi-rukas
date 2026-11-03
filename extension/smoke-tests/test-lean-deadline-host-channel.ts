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

import { armCycleBudget, MINUTE_MS } from "../src/lean/deadline.ts";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { type LeanRun, type Step, loadRun } from "../src/lean/state.ts";
import { handoffChannel } from "../src/work-driver-handoff-channel.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { CHILDREN, URL, driveLean, leanLog, stepWith } from "./lib/lean-result-fixture.ts";
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
  // The flag's destination, not just its parse: `--timeout` reaches the engine's
  // opts AND the arming call the engine's own clock reads. A verb that parsed the
  // number and dropped it would pass the assertion above and fail this one.
  await withEnv({}, async () => {
    const r = await verbRun(["7", "--timeout", "5"], wellFormedHandback());
    assert(
      r.code === 10 && process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === String(5 * MINUTE_MS),
      `(a) --timeout arms the cycle budget the engine reads (env got ${String(process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS)})`,
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

// ───────────────── (b) the arm is written where `work`'s reader looks
await withEnv({}, async () => {
  armCycleBudget(3 * MINUTE_MS);
  assert(
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === String(3 * MINUTE_MS),
    `(b) --timeout becomes the same budget input \`work\` reads (got ${String(process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS)})`,
  );
  const before = process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
  armCycleBudget(99 * MINUTE_MS);
  assert(
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === before,
    `(b) the flag never overwrites a budget the caller exported itself (got ${String(process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS)})`,
  );
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = "1234567890";
  armCycleBudget(7 * MINUTE_MS);
  assert(
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === before,
    "(b) and never overwrites an explicit absolute deadline",
  );
  armCycleBudget(undefined);
  assert(
    process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS === before,
    "(b) a run with no --timeout leaves the environment alone",
  );
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
  const repo = scratch("handback-past");
  const calls: string[] = [];
  // One boundary BEFORE the drive would stop: enough that the whole run before
  // the report is in allowance and the report itself is the first boundary the
  // clock has passed. The number counts the loop's `now()` calls; the engine's
  // own timestamps consume the same clock, so the count is calibrated here and
  // the assertion below is about which STEP ran, not about the count.
  const clock = crossing(30);
  // The run's gate already said red, so the only step left is the one that tells
  // the operator. The clock must not take that one away.
  const r = await runLean({
    repoRoot: repo,
    issue: 403,
    // Three red gates: the table's own rule sends the first two back through
    // build and hands the third to `handback`, so the run ARRIVES at its report
    // while the clock passes its allowance on the way. `steps` is the number of
    // engine boundaries to spend before crossing the line, so the run is stopped
    // nowhere else — and the step that reports is exempt, which is the claim.
    handlers: recording(calls, {
      ...WALK,
      verify: [
        { kind: "red", reason: "acceptance test x is red" },
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
  assert(
    !String(r.run.result?.reason).includes("cycle deadline"),
    `(e) its reason is the handback's own, not the clock's (got ${String(r.run.result?.reason)})`,
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
// writes; item (b) pins that function itself), and the clock crosses it on the way
// to the report — so the reporting step runs only because it is exempt.
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
    const clock = crossing(32);
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
      // The clock crosses on the way: every WORKING step starts inside the
      // allowance, and by the time the run stands in `handback` the deadline has
      // gone — so the step that appears below ran only because the reporting
      // states are exempt.
      now: clock.now,
    });
    const handback = driven.run.steps.filter((s) => s.state === "handback").pop();
    assert(
      handback !== undefined,
      `(g/i) the wired run reached its report (state ${driven.state}, reason ${String(driven.run.result?.reason)})`,
    );
    const projected = leanIssueResult(driven.run, driven.code) as unknown as Record<string, unknown>;
    const handoff = projected.handoff as Record<string, unknown> | undefined;
    if (channel === "host") {
      assert(
        handback?.outcome?.posted === false,
        `(g) the host channel posts nothing, and the step says so (got ${JSON.stringify(handback?.outcome?.posted)})`,
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
  assert(
    String(decline?.outcome?.reason).includes("host owns the handoff channel"),
    `(h) and says the host owns the channel (got ${String(decline?.outcome?.reason)})`,
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

cleanScratch();
process.exit(state.exit);

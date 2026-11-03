#!/usr/bin/env bun
/**
 * lean: the handoff CHANNEL a /work host drives the engine with (#1920 items 3,
 * 6) — who receives the run's report, and what text they are handed.
 *
 * Split from `test-lean-deadline-host-channel.ts` at AGENTS.md §12's line cap
 * along the seam the cases already had: this file is the CHANNEL (the reporting
 * step's own record, and the projection that reads it); the other file is the
 * CLOCK (what becomes an arm and what it stops). Both share
 * `lib/lean-host-contract-fixture.ts` for the same reason as above.
 *
 *   (g)/(i) the real `handback` handler on each channel: the host channel posts
 *       NOTHING and says so on its own step, and the projected result says
 *       `channel: "host"` with the run's REPORT as the body the host is meant to
 *       deliver; the forge channel still posts and keeps `channel: "forge"`;
 *   (g′) falsifiability: a recording post seam counts the calls, so "posts
 *       nothing" is a count of zero and not a vibe;
 *   (h) the host channel does not soften a refusal: `decline` still ends
 *       `not-ready` at 11, with the refusal's own text reaching the host;
 *   (k) why lean has no `noteCycleDeadline` call, settled with evidence rather
 *       than left to guess;
 *   (j) a non-terminal state is REFUSED by the projection, never projected as an
 *       invented status.
 */

import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { runLean } from "../src/lean/engine.ts";
import { setLeanCommentPoster } from "../src/lean/io.ts";
import { INITIAL_COUNTERS, type Step, loadRun } from "../src/lean/state.ts";
import { HOST_CHANNEL_MARK, handoffChannel } from "../src/work-driver-handoff-channel.ts";
import { handoffDispatchTimeoutMs } from "../src/work-driver-handoff.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import {
  WALK,
  cleanScratch,
  crossing,
  recording,
  scratch,
  withEnv,
} from "./lib/lean-host-contract-fixture.ts";
import { CHILDREN, URL, driveLean, leanLog, stepWith } from "./lib/lean-result-fixture.ts";

const { assert, state } = makeAssert();

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

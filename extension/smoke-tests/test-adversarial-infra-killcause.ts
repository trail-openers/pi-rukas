/**
 * #1243 — `infraFailureResult` is the producer of the adversarial loop's
 * infra-failure result, and it was dropping `killCause`. Downstream, the
 * fan-out's in-step retry asks the taxonomy for a wait; with no structured kill
 * the taxonomy falls through every `self-killed:*` branch and lands on the
 * `dispatch-failed-provider` default — `provider-severed` — which
 * `providerRetryWaitMs` multiplies by the provider floor (60 s default). A
 * watchdog kill, which waiting cannot fix, bought the minutes ladder.
 *
 * The regression is a dropped field, so a test can pass by asserting a value
 * that survives the drop. Two things keep it honest:
 *
 *  1. The assertions go through the REAL `infraFailureResult`, never through a
 *     hand-built `DispatchResult` that sets the field itself.
 *  2. The driver leg asserts the wait that comes out of the real ladder, with
 *     the provider floor set 10 000× the linear rung — so a leg that slept the
 *     provider ladder can never be mistaken for one that slept the linear one,
 *     and reverting the producer change (drop the field again) turns the fast
 *     leg slow: a mutation the test observes, not a behaviour it assumes.
 *
 * Offline: no spawn, no real sleep.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import {
  type InfraCtx,
  infraFailureResult,
  runPhaseWithInfraRetry,
} from "../src/adversarial-retry.ts";
import type { DispatchResult, ExtensionAPI } from "../src/types.ts";
import { capKillOutcomeFields } from "../src/work-driver-adversarial-fanout-capkill.ts";
import { __setSleepFn } from "../src/work-driver-step-router.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The two ladders must be DISCRIMINABLE at zero cost. The linear rung is 1 ms;
// the provider rung is 10 000 ms (its 60 s default rescaled), so the
// distributions cannot be confused — and because `jitteredMs` draws
// uniform(0, baseMs), the provider floor is applied only as a FLOOR, so a
// provider wait can land anywhere in [floor, floor + max(base, 1000)). That is
// why the legs below assert on the DISTRIBUTION of many recorded waits and never
// on a single one: a lone draw cannot sit above the bound and a lone draw near
// the bound says nothing about which ladder produced it.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "1";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "1";
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = "10000";
process.env.PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS = "12000";

const PROVIDER_MESSAGE = "Request timed out.";

/**
 * The provider-class child. Its `errorStop.message` must be IDENTICAL across the
 * dispatches of one leg (the synthesis quotes it, and the step's terminal
 * classification is what parks the cycle); the CHILD's own text varies per
 * dispatch so the inner ladder's #79 repeat detector (`providerRepeats`, whose
 * `>= 2` parks the step before any in-step ladder runs) never fires on one
 * child — the single-provider-failure shape that earns the minutes-floor wait.
 */
const PROVIDER_CHILD: Partial<DispatchResult> = {
  errorStop: { reason: "error", message: PROVIDER_MESSAGE },
};

function childOf(overrides: Partial<DispatchResult>): DispatchResult {
  return {
    role: "adversarial-developer",
    ok: false,
    text: "",
    toolUses: [],
    ms: 10,
    exitCode: 1,
    transcriptPath: "/tmp/child.json",
    ...overrides,
  } as DispatchResult;
}

function infraCtx(): InfraCtx {
  return {
    start: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    lastTranscript: "/tmp/stub.json",
    lastModel: "stub",
    toRoundRecords: () => [],
  };
}

// ── 1. The producer re-emits the cause, for both of its consumers.
{
  for (const cause of [
    "inactivity",
    "timeout",
    "tool-inactivity",
    "abort",
    "plan-timeout",
  ] as const) {
    const r = childOf({ killCause: cause, killBudgetMs: 2000 });
    const synthesized = infraFailureResult(1, "review", r, classifyDispatchOutcome(r), infraCtx());
    assert(
      synthesized.killCause === cause,
      `infraFailureResult re-emits the watchdog killCause '${cause}' (got ${JSON.stringify(synthesized.killCause)})`,
    );
    // The ladder reads it; PARKING still must not. A watchdog kill must not
    // become a fixed-literal cap (#543's contract, which widening must not move).
    assert(
      capKillOutcomeFields(synthesized).killCause === undefined,
      `a '${cause}' kill stays out of the cap-kill projection (got ${JSON.stringify(capKillOutcomeFields(synthesized).killCause)})`,
    );
  }

  // The two cap kills still travel, with their evidence, unchanged.
  const looped = childOf({ killCause: "loop", loopEvidence: { tool: "bash", count: 4 } });
  assert(
    infraFailureResult(1, "review", looped, classifyDispatchOutcome(looped), infraCtx())
      .killCause === "loop",
    "infraFailureResult still re-emits a loop cap kill",
  );
  const budget = childOf({ killCause: "token-budget", tokenBudget: { budget: 10, used: 11 } });
  const budgetSynth = infraFailureResult(
    1,
    "fix",
    budget,
    classifyDispatchOutcome(budget),
    infraCtx(),
  );
  assert(
    capKillOutcomeFields(budgetSynth).killCause === "token-budget",
    `a token-budget kill keeps its cap identity through the synthesis (got ${JSON.stringify(capKillOutcomeFields(budgetSynth))})`,
  );

  // Nothing else invents a cause: a child that died of its own death has none.
  const crashed = childOf({});
  assert(
    infraFailureResult(1, "review", crashed, classifyDispatchOutcome(crashed), infraCtx())
      .killCause === undefined,
    "a crash-shaped child gets no killCause from the synthesis (no fabricated cause)",
  );
}

// ── 2. The driver leg: a watchdog kill takes the FAST ladder, a provider stop
// the floor — both observed on the ONE injectable sleep seam the fan-out's
// in-step retry now uses (#1243 MEDIUM 3: that wait went through its own
// `abortableSleep`, invisible to the router's seam, so no test could see it and
// no abort could cut it short).
//
// The chain from the child's result to the ladder is the real one: the fan-out
// calls `ctx.adversarialLoopFn`, whose implementation here is the REAL
// `runPhaseWithInfraRetry` feeding the REAL `infraFailureResult` — the producer
// whose dropped field this bug was.
async function waitsFor(child: () => DispatchResult, issue: number): Promise<number[]> {
  const dir = mkdtempSync(path.join(tmpdir(), `adv-infra-${issue}-`));
  const slept: number[] = [];
  const restore = __setSleepFn(async (ms) => {
    slept.push(ms);
  });
  try {
    // A real git tree holding one COMMITTED change, so `fetchDiff` is non-empty
    // and the fan-out does not short-circuit the review as "empty diff" and
    // retry nothing at all — the vacuous shape an earlier draft of this test
    // had, which made every ladder assertion below read an empty list.
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git(["init", "-q", "."]);
    // `baseSha` is the commit the reviewer diffs AGAINST, so the content lands
    // in a commit AFTER it — `git diff <baseSha>..HEAD` is then non-empty.
    git(["commit", "-q", "--allow-empty", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    git(["add", "a.ts"]);
    git(["commit", "-q", "-m", "the change under review"]);

    let s: WorkState = initialState(issue, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        baseSha,
        worktrees: { default: dir },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: `feature/issue-${issue}`,
      },
    };
    await writeState(dir, s);

    let seen = 0;
    const ctx = {
      host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async (n: number) => ({
        stdout: `title:\tmock #${n}\nstate:\tOPEN\n\nmock body for issue #${n}`,
      }),
      // commit-pr would otherwise run THIS repo's `bun run test` — the whole
      // offline suite — inside a synthetic git tree: minutes of unrelated work
      // per leg, and a gate this test has no business re-proving.
      verifyExecFn: async () => ({ stdout: "", stderr: "", code: 0 }),
      adversarialLoopFn: async () => {
        const r = await runPhaseWithInfraRetry("adversarial-developer", "round1-review", "p", dir, {
          runPhase: async () => {
            // ONE dispatch per phase, always failing. The child's text varies so
            // the inner ladder's #79 repeat detector never stamps
            // `providerRepeats` — without it the step takes the in-step ladder
            // instead of parking — while every synthesis quotes the SAME
            // provider message from `child()`. The inner ladder's own
            // inter-attempt waits are stubbed below, so the only provider wait
            // left in the run is the fan-out's in-step ladder: the site #1243
            // MEDIUM 3 moved onto the observable seam.
            const c = child();
            if (c.errorStop)
              c.errorStop = { reason: "error", message: `${PROVIDER_MESSAGE} #${seen++}` };
            return c;
          },
          accumulate: () => {},
          // One attempt per phase here: the ladder BETWEEN attempts is what is
          // under test, and a retry whose child dies of the same provider error
          // short-circuits (#79), which would leave the fan-out's own in-step
          // wait with nothing to observe.
          sleep: async () => {},
          signal: new AbortController().signal,
        });
        const synth = infraFailureResult(1, "review", r, classifyDispatchOutcome(r), infraCtx());
        // The synthesis quotes the CHILD verbatim, so a per-dispatch child text
        // would make the step's terminal classification see a different fault
        // each time. Re-stamp the provider message to the leg's single
        // canonical one: the child varies (no `providerRepeats`, so the step
        // takes the ladder rather than parking), the ENDPOINT fault does not.
        return synth.errorStop
          ? { ...synth, errorStop: { ...synth.errorStop, message: PROVIDER_MESSAGE } }
          : synth;
      },
      dispatchFn: async (_pi: unknown, spec: { role: string }) => {
        if (spec.role === "ops")
          return childOf({ role: "ops", ok: true, text: "Posted.", exitCode: 0 });
        throw new Error(`unexpected dispatch: ${spec.role}`);
      },
    } as unknown as Parameters<typeof runWorkDriver>[0];

    await runWorkDriver(ctx);
    return slept;
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The ladder constants are read from the environment at call time, so the
  // leg sets them itself: the offline suite's `smoke-tests/lib/*.ts` harness
  // (and any earlier module in the process) may have zeroed them, and a floor
  // of 0 makes the two ladders indistinguishable — which would turn the control
  // leg below into a silent no-op instead of a control.
  const LADDER_ENV = {
    PI_ENSEMBLE_TRANSIENT_RETRY: "1",
    PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS: "1",
    PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS: "10000",
    PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS: "30000",
  } as const;
  for (const [k, v] of Object.entries(LADDER_ENV)) process.env[k] = v;
  // `jitteredMs` draws `uniform(0, baseMs)` with the provider floor as a LOWER
  // bound, so a single cycle's waits are a random sample and the inner loop has
  // ladder sites of its own. Rather than assert on a distribution, stub the
  // draw to its midpoint: every wait becomes exactly the value
  // `providerRetryWaitMs` / `transientRetryBackoffMs` produced, so each leg
  // asserts on the ladder's NUMBER, not on luck.
  const realRandom = Math.random;
  Math.random = () => 0.5;
  let watchdog: number[] = [];
  let provider: number[] = [];
  try {
    watchdog = await waitsFor(() => childOf({ killCause: "inactivity", killBudgetMs: 2000 }), 1244);
    provider = await waitsFor(() => childOf(PROVIDER_CHILD), 1245);
  } finally {
    Math.random = realRandom;
  }
  // The waits the provider ladder produced: a provider-class wait is at least
  // the floor, so anything below it came from a linear site (the inner loop's
  // own backoff, or the step router's linear rung on the watchdog leg).
  const providerLadder = provider.filter((ms) => ms >= 10000);

  // The legs are only meaningful if the cycle actually retried — a cycle that
  // parked without a single wait would make BOTH assertions below pass vacuously
  // (an empty `every` is true, and the ladder filter would be empty too). The
  // counts are therefore asserted before the values are.
  assert(
    watchdog.length > 0 && provider.length > 0 && providerLadder.length > 0,
    `both legs retried (watchdog ${watchdog.length} waits, provider ${provider.length} waits, ${providerLadder.length} at the floor)`,
  );

  // Mutation signal: with the field dropped by `infraFailureResult`, EVERY wait
  // below sits above the provider floor — the bug this file exists for.
  assert(
    watchdog.length > 0 && watchdog.every((ms) => ms < 1000),
    `#1243: an inactivity kill takes the LINEAR ladder end to end — every one of ${watchdog.length} recorded waits is sub-second (got ${JSON.stringify(watchdog)})`,
  );
  // Control: a provider stop on the same path does get the floor, so the
  // assertion above is the cause's answer and not an always-fast predicate.
  assert(
    providerLadder.length > 0 && providerLadder.every((ms) => ms >= 10000 && ms <= 31000),
    `control: a provider error-stop gets the minutes floor on its ${providerLadder.length} ladder wait(s) (got ${JSON.stringify(providerLadder)})`,
  );
}

process.exit(exit);

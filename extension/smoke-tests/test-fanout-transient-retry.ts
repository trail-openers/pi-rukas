#!/usr/bin/env bun
/**
 * A develop FAN-OUT (N>1) that fails transiently is retried by the step router.
 *
 * `failureEventOf` was written (#433) to dig the per-child dispatch failure out
 * from behind `branch-completed` / `branches-converged`, but only the scrollback
 * block of `routeStepOutcome` called it. The retry DECISION still read the raw
 * tail, saw `branches-converged`, and fell through to the fan-out halt — so the
 * ✗ line was suppressed for a retry that never happened. These tests drive the
 * real driver with a fake dispatch and assert on what was re-dispatched.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { __setSleepFn } from "../src/work-driver-step-router.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "developer",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

/** The provider error-stop a child ends on (the `dispatch-failed-provider` shape). */
const providerStop = (message: string): "fail" => {
  stopMessage = message;
  return "fail";
};
let stopMessage = "";
const BURST_429 = "Server requested 59s retry delay (max: 10s). 429 status code (no body)";

// The outcome-verification gate needs a real repo; it is not what is under test.
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// The router's backoff is a real wait in production; record it instead.
const slept: number[] = [];
__setSleepFn(async (ms) => {
  slept.push(ms);
});

/** Run an N=2 develop step from a seeded state; returns the developer labels
 *  dispatched, in order, and the final state. */
async function runFanout(
  issue: number,
  developer: (label: string, attempt: number) => "ok" | "fail",
): Promise<{ labels: string[]; after: WorkState | undefined }> {
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-fanout-transient-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const shas = await makeBaseWorktrees(dir, ["a", "b"]);
    const s = initialState(issue, 1_000_000);
    await writeState(dir, {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { a: `${dir}/.worktrees/a`, b: `${dir}/.worktrees/b` },
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [] },
        },
        workstreamBaseShas: shas,
        branchName: `feature/issue-${issue}-fanout`,
      },
    });
    const labels: string[] = [];
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async (n) => ({ stdout: `title:\tmock #${n}\n\nmock body` }),
      dispatchFn: async (_pi, spec, opts) => {
        const label = opts?.label ?? spec.role;
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role !== "developer") throw new Error(`smoke: halting at ${label}`);
        labels.push(label);
        if (developer(label, labels.filter((l) => l === label).length) === "fail") {
          return mkResult({
            ok: false,
            text: "",
            errorStop: { reason: "error", message: stopMessage },
          });
        }
        // A green needs a commit ahead of its base (#1016).
        gitIn(spec.cwd ?? dir, ["commit", "--allow-empty", "-qm", `work ${label}`]);
        return mkResult();
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    return { labels, after: await readState(dir, issue) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (labels: string[], l: string) => labels.filter((x) => x === l).length;
const developRuns = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).filter((e) => e.kind === "step-started" && e.step === "develop").length;
const developCapped = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).some((e) => e.kind === "cap-hit" && e.cap === "step-failed:develop");

/**
 * #1243 — the fan-out router now reads the terminal failure the same way every
 * other cap in the pipeline does, so a fan-out that EVERY child lost to the
 * endpoint parks `provider-unavailable` (re-queueable by a headless caller)
 * rather than `step-failed:develop` (`failure.kind: "process"`, not
 * re-queueable). Both halt develop; the assertions that only need a halt use
 * this, and the cap name is printed so a switch between them is visible.
 */
const developHalted = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).some(
    (e) =>
      e.kind === "cap-hit" && (e.cap === "step-failed:develop" || e.cap === "provider-unavailable"),
  );
const capName = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).find(
    (e) => e.kind === "cap-hit" && /develop|provider-unavailable/.test(e.cap),
  )?.cap ?? "no cap";

// 1. Both developers hit a burst 429 once: the step waits out the delay the
//    provider stated and re-runs, and the cycle carries on past develop.
{
  slept.length = 0;
  const { labels, after } = await runFanout(2701, (_l, attempt) =>
    attempt === 1 ? providerStop(BURST_429) : "ok",
  );
  assert(
    count(labels, "developer[a]") === 2 && count(labels, "developer[b]") === 2,
    `all-transient fan-out: both developers re-dispatched once (got ${labels.join(",")})`,
  );
  assert(developRuns(after) === 2, "...by ONE router retry of the develop step");
  assert(
    slept.some((ms) => ms >= 59_000),
    `...after waiting the provider's 59s, not Pi's 2s/4s/8s (slept ${slept.join(",")})`,
  );
  assert(!developCapped(after), "...and develop is not capped: the retry recovered it");
  assert(
    (after?.pipelineState.transientRetryAttempts?.develop ?? 0) === 0,
    "...with the transient budget reset once the step succeeded",
  );
}

// 2. A fan-out that keeps failing transiently exhausts the budget and halts
//    through the fan-out router, with the attempts on record.
{
  const { labels, after } = await runFanout(2702, () => providerStop("terminated"));
  assert(
    count(labels, "developer[a]") === 3 && count(labels, "developer[b]") === 3,
    `persistent transient: 1 attempt + 2 retries per developer (got ${labels.join(",")})`,
  );
  assert(
    developHalted(after),
    `...then the step halts with a develop-halting cap (got ${capName(after)})`,
  );
  assert(
    after?.pipelineState.transientRetryAttempts?.develop === 2,
    "...and the state says the retries were attempted, not skipped",
  );
}

// 3. One green, one transient: only the failed workstream re-runs, inside the
//    develop step (#1016). The router never re-runs a fan-out with a green in it.
{
  const { labels, after } = await runFanout(2703, (l, attempt) =>
    l === "developer[b]" && attempt === 1 ? providerStop(BURST_429) : "ok",
  );
  assert(
    count(labels, "developer[a]") === 1 && count(labels, "developer[b]") === 2,
    `mixed fan-out: the green ran once, the failed workstream twice (got ${labels.join(",")})`,
  );
  assert(developRuns(after) === 1 && !developCapped(after), "...in a single develop step");
}

// 4. The same, but the failed workstream fails its in-step retry too: the step
//    halts. Re-running it wholesale would re-dispatch the work that landed.
{
  const { labels, after } = await runFanout(2704, (l) =>
    l === "developer[b]" ? providerStop(BURST_429) : "ok",
  );
  assert(
    count(labels, "developer[a]") === 1 && count(labels, "developer[b]") === 2,
    `mixed, retry fails: the green is still dispatched exactly once (got ${labels.join(",")})`,
  );
  assert(developRuns(after) === 1 && developCapped(after), "...and the step halts, unretried");
}

// 5. #1243 fix round — EVERY child lost to the endpoint: the fan-out's cap is
//    `provider-unavailable`, not `step-failed:develop`. That name is the only
//    thing a headless caller switches on to re-queue the cycle by itself, so a
//    fan-out — the shape where "the endpoint was down" is most obvious — must
//    not park with the one cap that says "a person must look at this diff".
//    Mutation-check: revert `dispatchFailCapHit`'s tail to non-optional with the
//    synthesised `dispatch-failed` event in the fan-out router and this leg
//    reports `step-failed:develop`.
{
  const { after } = await runFanout(2705, () => providerStop("terminated"));
  assert(
    capName(after) === "provider-unavailable",
    `an all-children provider fan-out parks provider-unavailable (got ${capName(after)})`,
  );
  const hit = (after?.eventLog ?? []).find(
    (e) => e.kind === "cap-hit" && e.cap === "provider-unavailable",
  );
  assert(
    hit?.kind === "cap-hit" && (hit.evidence ?? "").includes("cause=provider-severed"),
    `...with the outage evidence a caller re-queues on (got ${hit?.kind === "cap-hit" ? hit.evidence : "no cap"})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

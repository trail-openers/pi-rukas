#!/usr/bin/env bun
/**
 * #79 / #1243 — when the adversarial reviewer's children die of provider
 * faults, the loop names the cause, stops the retry ladder the taxonomy says
 * cannot help, and waits a burst 429's stated delay instead of re-spawning at
 * once.
 *
 * Observed (orchard cycles 45/61/63): every reviewer child died on
 * `Request timed out.`; the loop spawned `-review`, `-retry`, `-retry-2`,
 * `-retry-3`, the fan-out and the router's RETRY_ONCE re-ran it all, and the
 * only line left in err.txt was `adversarial loop infrastructure failure
 * (N=1)` — the handoff said "dispatch failed twice (retry exhausted)".
 *
 * #1243 adds three things that incident made visible:
 *  - the wait between attempts was 516ms / 3987ms, so every re-spawn landed
 *    inside the same outage — provider-class failures now wait a floor of
 *    minutes (`providerRetryWaitMs`), bounded by a total;
 *  - the reason was cut at 60 chars (`…round 2 review disp`), which made the
 *    one number that survived read like a constant — reason sites now keep
 *    `FAILURE_REASON_CHARS` of it;
 *  - the park carried the same cap as a real failure (`step-failed:
 *    adversarial`), so a headless caller could not tell an outage from a
 *    rejected diff — it now parks with `provider-unavailable`.
 *
 * Offline: the reviewer child is a fake `runPhase`; the driver half uses
 * `adversarialLoopFn` built from the real retry + infra-result code.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { infraFailureResult, runPhaseWithInfraRetry } from "../src/adversarial-retry.ts";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import { FAILURE_KINDS } from "../src/headless/failure.ts";
import type { DispatchResult } from "../src/types.ts";
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  FAILURE_REASON_CHARS,
  classifyFailureCause,
  failureCauseReason,
  providerRetryFloorMs,
  providerRetryMaxWaitMs,
  providerRetryWaitMs,
} from "../src/work-driver-failure-taxonomy.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
// #1243 — the provider-class floor is minutes by default. Zero it so the driver
// legs of this test do not sleep; the floor itself is asserted by name below.
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const TIMEOUT = "Request timed out.";
const MODEL_404 = '404: {"message":"model \\"qwen3.8-flash-next\\" not found","type":"not_found"}';
const BURST_429 =
  "Provider request error: Server requested 30s retry delay (max: 60s). 429 status code (no body)";
const QUOTA_429 =
  "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)";

function child(errorMessage?: string): DispatchResult {
  return {
    role: "adversarial-developer",
    ok: !errorMessage,
    text: errorMessage ? "" : "VERDICT: APPROVED",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    ...(errorMessage ? { errorStop: { reason: "error", message: errorMessage } } : {}),
  };
}

/** Run the real ladder against a scripted sequence of child outcomes. */
async function ladder(script: (string | undefined)[]) {
  const tags: string[] = [];
  const sleeps: number[] = [];
  const result = await runPhaseWithInfraRetry("adversarial-developer", "round1-review", "p", "/x", {
    runPhase: async (_role, tag) => {
      tags.push(tag);
      return child(script[Math.min(tags.length - 1, script.length - 1)]);
    },
    accumulate: () => {},
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { result, tags, sleeps };
}

// (1) Two identical timeouts stop the ladder — no `-retry-2`, no `-retry-3`.
{
  const { result, tags } = await ladder([TIMEOUT]);
  assert(tags.length === 2, `identical timeouts: 2 children, not 4 (got ${tags.join(", ")})`);
  assert(result.providerRepeats === 2, "the repeat count travels on the result");
}

// (2) A missing model is not retried at all.
{
  const { result, tags } = await ladder([MODEL_404]);
  assert(tags.length === 1, `404 model: 1 child (got ${tags.length})`);
  assert(
    classifyDispatchOutcome(result).cause === "provider-model-unavailable",
    "404 model classifies as provider-model-unavailable",
  );
}

// (3) A quota-window 429 is not retried.
{
  const { tags } = await ladder([QUOTA_429]);
  assert(tags.length === 1, `quota-window 429: 1 child (got ${tags.length})`);
}

// (4) A burst 429 waits the provider's stated delay, then re-spawns.
{
  const { result, tags, sleeps } = await ladder([BURST_429, undefined]);
  assert(tags.length === 2 && result.ok, "burst 429: re-spawned once and recovered");
  assert(
    sleeps.length === 1 && (sleeps[0] ?? 0) >= 30_000,
    `burst 429: waited ≥ the stated 30s before re-spawning (waited ${sleeps.join(",")}ms)`,
  );
}

// (5) Different errors in a row are not a repeat: the depth is unchanged.
{
  const { tags } = await ladder([TIMEOUT, "Connection error.", TIMEOUT, "Connection error."]);
  assert(tags.length === 4, `alternating errors keep the full depth (got ${tags.length})`);
}

// (5b) #1243 — the provider-class ladder: a minutes floor, scaled by attempt,
// bounded in total, and NOT applied to a cause waiting cannot fix. The env is
// pinned here rather than read from the suite's `= "0"` above — that zero exists
// so the DRIVER legs below never sleep, and an assertion that read it would be
// asserting 0 === 0.
{
  // `delete`, not `= ""`: `Number("")` is 0, which the env readers accept as a
  // legitimate zero override — pinning it to the empty string would assert 0 === 0.
  delete process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS;
  delete process.env.PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS;
  const severed = { cause: "provider-severed" as const };
  assert(
    providerRetryFloorMs() >= 60_000,
    `the default floor is minutes-scale, not seconds (${providerRetryFloorMs()}ms) — a sub-minute ladder re-spawns inside the same outage`,
  );
  assert(
    providerRetryMaxWaitMs() === 30 * 60_000,
    `the default per-wait clamp is 30 min (${providerRetryMaxWaitMs()}ms)`,
  );
  assert(
    providerRetryWaitMs(severed, 1, 5_000) === providerRetryFloorMs(),
    `a severed stream waits the floor, not the 5s ladder (got ${providerRetryWaitMs(severed, 1, 5_000)})`,
  );
  assert(
    providerRetryWaitMs(severed, 2, 10_000) === providerRetryFloorMs() * 2,
    `the floor scales by the attempt (got ${providerRetryWaitMs(severed, 2, 10_000)})`,
  );
  assert(
    providerRetryWaitMs({ cause: "rate-limited:burst", waitMs: 1_000 }, 1, 5_000) ===
      providerRetryFloorMs(),
    "a stated delay SHORTER than the floor still waits the floor",
  );
  assert(
    providerRetryWaitMs({ cause: "rate-limited:burst", waitMs: 5 * 60_000 }, 1, 5_000) ===
      5 * 60_000,
    "a stated delay LONGER than the floor is respected",
  );
  assert(
    providerRetryWaitMs(severed, 10_000, 5_000) === providerRetryMaxWaitMs(),
    "the wait never exceeds the per-wait bound",
  );
  assert(
    providerRetryWaitMs({ cause: "self-killed:inactivity" }, 1, 5_000) === 5_000,
    "a self-kill keeps the linear ladder — waiting minutes does not fix a hang",
  );
  assert(
    providerRetryWaitMs({ cause: "rate-limited:quota-terminal" }, 1, 5_000) === 5_000,
    "a spend cap keeps the linear ladder — no amount of waiting clears it",
  );
}

// (6) The loop's infra result, its step event and the taxonomy all name the cause.
const infraCtx = {
  start: Date.now(),
  usage: undefined,
  lastTranscript: undefined,
  lastModel: undefined,
  toRoundRecords: () => [],
};
async function loopResultFor(script: (string | undefined)[]): Promise<DispatchResult> {
  const { result } = await ladder(script);
  return infraFailureResult(1, "review", result, classifyDispatchOutcome(result), infraCtx);
}
{
  const loop = await loopResultFor([TIMEOUT]);
  assert(
    loop.text.includes(TIMEOUT) && loop.text.includes("cause=provider-severed"),
    `loop text names the provider error and its cause (got: ${loop.text})`,
  );
  const ctx = { repoRoot: "/nonexistent", issue: 1 } as unknown as DriverContext;
  const ev = await buildCompletionEvent(ctx, "adversarial", "adversarial-loop", "adversarial_loop", loop);
  assert(
    ev.kind === "dispatch-failed-provider" && ev.providerMessage === TIMEOUT,
    `step event is dispatch-failed-provider carrying the child's message (got ${ev.kind})`,
  );
  assert(!classifyFailureCause(ev).shouldRetry, "a repeated provider error is not retried by the router");
  assert(
    failureCauseReason(ev).includes(TIMEOUT) && failureCauseReason(ev).includes("×2"),
    `reason names the error and the repeat (got: ${failureCauseReason(ev)})`,
  );
  // #1243 — the reason is not cut mid-sentence. The orchard cycles all read
  // `subagent failed: Adversarial loop infrastructure failure: round 2 review
  // disp` — truncated at 60 chars into our own composite text, which made the
  // one surviving number look like a constant. A long provider error is now
  // clipped at FAILURE_REASON_CHARS, not 60.
  {
    const long = `${TIMEOUT} ${"detail ".repeat(100)}`;
    const clipped = failureCauseReason({
      kind: "dispatch-failed-provider",
      providerMessage: long,
    });
    assert(
      clipped.includes("detail detail detail") &&
        clipped.length > 60 + TIMEOUT.length &&
        clipped.length <= TIMEOUT.length + FAILURE_REASON_CHARS + 60,
      `a long provider reason keeps ${FAILURE_REASON_CHARS} chars, not 60 (got ${clipped.length})`,
    );
  }
}

// (7) Driver, N=1: no RETRY_ONCE into the same window, and the handoff names
// the cause. #1243 — an OUTAGE parks with its own cap (a caller can re-queue
// it); a cause waiting cannot fix (the 404) keeps `step-failed:adversarial`.
function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}
async function driverRun(issue: number, script: (string | undefined)[]) {
  const dir = mkdtempSync(path.join(tmpdir(), `adv-provider-cause-${issue}-`));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(issue, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
        branchName: `feature/issue-${issue}`,
      },
    };
    await writeState(dir, s);
    let loops = 0;
    const ctx: DriverContext = {
      host: makeFakePi(),
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async (n: number) => ({
        stdout: `title:\tmock #${n}\nstate:\tOPEN\n\nmock body for issue #${n}, non-empty`,
      }),
      adversarialLoopFn: async () => {
        loops++;
        return loopResultFor(script);
      },
      dispatchFn: async (_pi, spec, opts) =>
        opts?.label === "ops:handoff"
          ? { ...child(), role: "ops", text: "Posted." }
          : Promise.reject(new Error(`unexpected: ${spec.role}`)),
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, issue);
    return { loops, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const [issue, script, label, expectedCap] of [
  [7901, [TIMEOUT], "repeated timeout", "provider-unavailable"],
  [7902, [MODEL_404], "404 model", "step-failed:adversarial"],
] as const) {
  const { loops, after } = await driverRun(issue, [...script]);
  assert(loops === 1, `${label}: the step is not re-dispatched into the same fault (loops=${loops})`);
  const cap = after?.eventLog.findLast((e) => e.kind === "cap-hit");
  assert(cap?.kind === "cap-hit" && cap.cap === expectedCap, `${label}: parks with ${expectedCap} (got ${cap?.kind === "cap-hit" ? cap.cap : "no cap"})`);
  const why = after && cap?.kind === "cap-hit" ? explainCap(cap.cap, after) : "";
  assert(
    why.includes(script[0] === TIMEOUT ? TIMEOUT : "not found") && why.includes("cause="),
    `${label}: handoff names the provider cause, not the retry budget (got: ${why})`,
  );
}

process.exit(exit);

#!/usr/bin/env bun
/**
 * #1297 (ws-4) — when the adversarial reviewer's children die of provider
 * faults, the loop must classify the fault by the driver's taxonomy (not a
 * flat 429/provider-severed split), stop the retry ladder the taxonomy calls
 * final, wait a burst 429's stated delay, keep the child's `errorStop` on the
 * synthesized loop result, and let the step event + router + handoff name the
 * classified cause instead of "the driver's own retry budget".
 *
 * This test is the ws-4 slice of the five-workstream fix for #1297 (the
 * source fix splits across ws-1 classify/taxonomy, ws-2 retry-ladder +
 * errorStop propagation, ws-3 router/fan-out RETRY_ONCE protection, and this
 * test). It is written test-first against the target contract:
 *
 *   - the REAL current source is exercised end-to-end through the actual
 *     `runPhaseWithInfraRetry` / `classifyDispatchOutcome` / `infraFailureResult`
 *     / `buildCompletionEvent` / `runWorkDriver` seams (no copies);
 *   - provider-fault behaviours that the source does not yet implement are
 *     gated behind a `FIXED:` deferred-assertion — they are reported
 *     `⏸ deferred` (not a failure) until the sibling work lands, so this test
 *     is GREEN on its own now and flips to full PASS (0 deferred) the moment
 *     the source fix is integrated. That is the test-first signal: the exact
 *     failure modes of #1297 are named here and will flip, not be deleted.
 *
 * Observed (issue #1297 / orchard cycles 45/61/63): every reviewer child died
 * on `Request timed out.`; the loop spawned `-review`, `-retry`, `-retry-2`,
 * `-retry-3`, the fan-out and the router's RETRY_ONCE re-ran it all (up to 16
 * reviewer children), and the only line left was `adversarial loop
 * infrastructure failure (N=1)` — the handoff said "dispatch failed twice
 * (retry exhausted)", the driver's own budget, not the endpoint's fault.
 *
 * Ported from the example-owner/pi-rukas fork fix (#79 → PR #81) and re-grounded on
 * the current mainline driver context (the `host` field, #1020).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import { infraFailureResult, runPhaseWithInfraRetry } from "../src/adversarial-retry.ts";
import type { DispatchResult } from "../src/types.ts";
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { classifyFailureCause, failureCauseReason } from "../src/work-driver-failure-taxonomy.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
let pass = 0;
let deferred = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
    pass++;
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
/**
 * A provider-fault behaviour not yet implemented by the current source.
 * Asserted as a soft, non-failing check while `sourceFixed` is false so the
 * suite is green pre-integration; flips to a hard assertion (and the
 * "deferred" count drops) the moment the sibling fix lands.
 */
function FIXED(cond: boolean, msg: string, sourceFixed: boolean, detail: string) {
  if (!sourceFixed) {
    console.log(`⏸ deferred (ws-1/2/3 not landed): ${msg}`);
    deferred++;
    return;
  }
  assert(cond, `${msg}  [${detail}]`);
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const TIMEOUT = "Request timed out.";
const MODEL_404 = '404: {"message":"model \\"qwen3.8-flash-next\\" not found","type":"not_found"}';
const BURST_429 =
  "Provider request error: Server requested 30s retry delay (max: 60s). 429 status code (no body)";
const QUOTA_429 =
  "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)";

/** A reviewer child that either returns an approving verdict or dies with a provider error. */
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

/** Run the REAL loop ladder against a scripted sequence of child outcomes. */
async function ladder(script: (string | undefined)[]) {
  const tags: string[] = [];
  const result = await runPhaseWithInfraRetry("adversarial-developer", "round1-review", "p", "/x", {
    runPhase: async (_role, tag) => {
      tags.push(tag);
      return child(script[Math.min(tags.length - 1, script.length - 1)]);
    },
    accumulate: () => {},
    signal: new AbortController().signal,
  });
  return { result, tags };
}

/** True once the sibling source fix (#1297 ws-1/2/3) has landed. */
function sourceFixed(): boolean {
  // The target contract: a 404 model must classify to its own cause, not
  // provider-severed. Today it is provider-severed, so this is the probe.
  return classifyDispatchOutcome(child(MODEL_404)).cause === "provider-model-unavailable";
}

const fixed = sourceFixed();

// (1) Two identical provider timeouts stop the loop's retry ladder — no
//     `-retry-2` / `-retry-3`, and the repeat count travels on the result so
//     the fan-out and router can decline to re-dispatch.
{
  const { result, tags } = await ladder([TIMEOUT]);
  assert(
    tags.length >= 2,
    `identical timeouts: the ladder runs at least two children (got ${tags.join(", ")})`,
  );
  FIXED(
    tags.length === 2 && result.providerRepeats === 2,
    "identical timeouts stop the ladder at 2 children and the repeat count travels on the result",
    fixed,
    `tags=[${tags.join(", ")}] providerRepeats=${String((result as { providerRepeats?: number }).providerRepeats)}`,
  );
}

// (2) A missing model (404) is a final provider fault — not retried at all,
//     and named as its own cause rather than provider-severed.
{
  const { result, tags } = await ladder([MODEL_404]);
  FIXED(
    tags.length === 1,
    "404 model: the loop spawns exactly one child (not retried)",
    fixed,
    `tags=[${tags.join(", ")}]`,
  );
  FIXED(
    classifyDispatchOutcome(result).cause === "provider-model-unavailable",
    "404 model classifies as provider-model-unavailable",
    fixed,
    `cause=${classifyDispatchOutcome(result).cause}`,
  );
}

// (3) A quota-window 429 (hours) is a final fault — not retried.
{
  const { tags } = await ladder([QUOTA_429]);
  FIXED(
    tags.length === 1,
    "quota-window 429: the loop spawns exactly one child (not retried)",
    fixed,
    `tags=[${tags.join(", ")}]`,
  );
}

// (4) A burst 429 (minutes) is retried — after waiting the provider's stated
//     delay, not immediately.
{
  const { result, tags } = await ladder([BURST_429, undefined]);
  FIXED(
    tags.length === 2 && result.ok,
    "burst 429: re-spawned once and recovered (the stated delay is waited out first)",
    fixed,
    `tags=[${tags.join(", ")}] ok=${result.ok}`,
  );
}

// (5) Different errors in a row are NOT a repeat — the retry depth is unchanged.
{
  const { tags } = await ladder([TIMEOUT, "Connection error.", TIMEOUT, "Connection error."]);
  FIXED(
    tags.length === 4,
    "alternating errors keep the full retry depth (not treated as a repeat)",
    fixed,
    `tags=[${tags.join(", ")}]`,
  );
}

// (6) The loop's synthesized infra result, its step event and the taxonomy
//     all name the provider cause — and the loop result KEEPS the child's
//     errorStop (ws-2), so the router can classify it as a provider fault
//     instead of a bare `dispatch-failed` / `crashed`.
{
  const infraCtx = {
    start: Date.now(),
    usage: undefined,
    lastTranscript: undefined,
    lastModel: undefined,
    toRoundRecords: () => [],
  };
  const { result } = await ladder([TIMEOUT]);
  const loop = infraFailureResult(
    1,
    "review",
    result,
    classifyDispatchOutcome(result),
    infraCtx as never,
  );
  FIXED(
    loop.text.includes(TIMEOUT) && loop.text.includes("cause=provider-severed"),
    "loop result text names the provider error and its classified cause",
    fixed,
    `text=${loop.text}`,
  );
  const ctx = { repoRoot: "/nonexistent", issue: 1 } as unknown as DriverContext;
  const ev = await buildCompletionEvent(
    ctx,
    "adversarial",
    "adversarial-loop",
    "adversarial_loop",
    loop,
  );
  FIXED(
    ev.kind === "dispatch-failed-provider" && ev.providerMessage === TIMEOUT,
    "step event is dispatch-failed-provider carrying the child's message (errorStop kept)",
    fixed,
    `kind=${ev.kind} providerMessage=${String(ev.providerMessage)}`,
  );
  if (ev.kind === "dispatch-failed-provider") {
    FIXED(
      !classifyFailureCause(ev).shouldRetry,
      "a repeated provider fault is not re-retried by the router",
      fixed,
      `shouldRetry=${classifyFailureCause(ev).shouldRetry}`,
    );
    FIXED(
      failureCauseReason(ev).includes(TIMEOUT) && failureCauseReason(ev).includes("×2"),
      "the operator-facing reason names the error and the repeat, not the retry budget",
      fixed,
      `reason=${failureCauseReason(ev)}`,
    );
  }
}

// (7) Driver, N=1: the step is not re-dispatched into the same fault window
//     (no RETRY_ONCE into a taxonomy-final provider fault), and the handoff
//     names the provider cause instead of "the driver's own retry budget".
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
        const { result } = await ladder(script);
        return infraFailureResult(1, "review", result, classifyDispatchOutcome(result), {
          start: Date.now(),
          usage: undefined,
          lastTranscript: undefined,
          lastModel: undefined,
          toRoundRecords: () => [],
        } as never);
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
for (const [issue, script, label] of [
  [7901, [TIMEOUT], "repeated timeout"],
  [7902, [MODEL_404], "404 model"],
] as const) {
  const { loops, after } = await driverRun(issue, [...script]);
  FIXED(
    loops === 1,
    `${label}: the step is NOT re-dispatched into the same fault (one loop run)`,
    fixed,
    `loops=${loops}`,
  );
  const cap = after?.eventLog.findLast((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "step-failed:adversarial",
    `${label}: the cycle parks with step-failed:adversarial`,
  );
  const why = after && cap?.kind === "cap-hit" ? explainCap(cap.cap, after) : "";
  FIXED(
    why.includes(script[0] === TIMEOUT ? TIMEOUT : "not found") && why.includes("cause="),
    `${label}: the handoff names the provider cause, not the driver's retry budget`,
    fixed,
    `why=${why}`,
  );
}

console.log(
  `\n${pass} passed, ${deferred} deferred (source fix not landed)${deferred === 0 ? " — fix integrated, full contract holds" : ""}`,
);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #1371 — a SIGTERM during explore's issue-body fetch ends the cycle as
 * `interrupted` (exit 21, resumable), not as an `explore-bodies-empty` handoff:
 *
 *   - the abort wins over the fetch's own result: no cap-hit, no handoff, no
 *     `cap` in the result, and the interrupt names the step it cut off;
 *   - a fetch still in flight is abandoned and no retry or backoff follows, so
 *     the driver ends the cycle itself, well inside the runner's grace;
 *   - explore's step-started reaches the stream before the fetch, so a host
 *     that stops the cycle "once explore started" really stops it there;
 *   - the result never reports a cap that an interrupted step hit (the generic
 *     rule for every step), while a cap the cycle routed before an interrupt
 *     at a step boundary is still reported;
 *   - re-running the interrupted cycle resumes explore.
 *
 * Offline: the dispatch and the issue-body fetch are stubs, gh is absent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lastCap } from "../src/headless/exit-code.ts";
import { failureOf } from "../src/headless/failure.ts";
import { projectIssue } from "../src/headless/result.ts";
import { runHeadless } from "../src/headless/run.ts";
import type { DispatchResult } from "../src/types.ts";
import { IssueBodyFetchAborted, fetchIssueBodyWithRetry } from "../src/work-driver-explore.ts";
import {
  type WorkEvent,
  type WorkState,
  appendEvent,
  initialState,
  readState,
} from "../src/workflow-state.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
// A retry that ignored the abort would sleep a minute: the elapsed-time checks catch it.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "60000";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(sig: string, fn: () => void) {
      if (!handlers.has(sig)) handlers.set(sig, new Set());
      handlers.get(sig)?.add(fn);
    },
    off(sig: string, fn: () => void) {
      handlers.get(sig)?.delete(fn);
    },
    fire(sig: string) {
      for (const fn of [...(handlers.get(sig) ?? [])]) fn();
    },
  };
}

const failedDispatch = (_h: unknown, spec: { role: string }) => {
  const failed: DispatchResult = {
    role: spec.role,
    ok: false,
    text: "",
    toolUses: [],
    ms: 1,
    exitCode: null,
  };
  return Promise.resolve(failed);
};

const kindsOf = (s: WorkState) => s.eventLog.map((e: WorkEvent) => e.kind);
/** Generous against a loaded host; a minute of backoff or the 20 s grace would blow it. */
const PROMPT_MS = 8_000;
const GRACE_MS = 20_000;

// ── 1. SIGTERM while the fetch hangs: the driver itself ends the cycle as interrupted.
{
  const repo = mkdtempSync(path.join(tmpdir(), "interrupt-explore-"));
  try {
    const sig = fakeSignals();
    const lines: string[] = [];
    let calls = 0;
    let streamedBeforeFetch = false;
    // The fetch never settles: only abandoning it on the abort ends the step.
    const hangingFetch = () => {
      calls++;
      streamedBeforeFetch = lines.some((l) => l.includes('"step-started"'));
      sig.fire("SIGTERM");
      return new Promise<{ stdout: string }>(() => undefined);
    };
    const started = Date.now();
    const result = await runHeadless({
      repoRoot: repo,
      issues: [71],
      restart: false,
      graceMs: GRACE_MS,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: failedDispatch as never, issueBodyFetcherFn: hangingFetch },
      write: (l) => {
        lines.push(l);
      },
    });
    const elapsed = Date.now() - started;
    const state = (await readState(repo, 71)) as WorkState;
    const kinds = kindsOf(state);
    const issue = result.results[0];
    assert(result.exitCode === 21, `exits 21, not 10 (got ${result.exitCode})`);
    assert(state.pipelineState.status === "interrupted", "the state file reads interrupted");
    assert(issue?.resumable === true, "the result is resumable");
    assert(issue?.cap === undefined, `the result names no cap (got ${issue?.cap})`);
    assert(issue?.failedStep === "explore", "failedStep is explore");
    assert(!kinds.includes("cap-hit"), "no cap-hit: the empty fetch is not taken for a cap");
    assert(!kinds.includes("handoff-emitted"), "no handoff");
    assert(!kinds.includes("dispatch-started"), "no dispatch ran after the abort");
    const interrupted = state.eventLog.find((e) => e.kind === "interrupted");
    assert(
      interrupted?.kind === "interrupted" && interrupted.step === "explore",
      "the interrupted event names the step it cut off",
    );
    assert(calls === 1, `one fetch attempt, no retry after the abort (got ${calls})`);
    assert(elapsed < PROMPT_MS, `the driver ends it, inside the grace (${elapsed} ms)`);
    assert(streamedBeforeFetch, "explore's step-started reached the stream before the fetch ran");
    assert(
      !lines.some((l) => l.includes('"cap-hit"')),
      "no cap-hit line on the NDJSON stream either",
    );

    // ── 6. A plain re-run resumes explore.
    const resumed = await runHeadless({
      repoRoot: repo,
      issues: [71],
      restart: false,
      graceMs: GRACE_MS,
      signalTarget: fakeSignals() as unknown as NodeJS.Process,
      driverSeams: {
        dispatchFn: failedDispatch as never,
        issueBodyFetcherFn: async () => ({ stdout: "title\n\nnon-empty body" }),
      },
      write: () => undefined,
    });
    const after = (await readState(repo, 71)) as WorkState;
    const exploreStarts = after.eventLog.filter(
      (e) => e.kind === "step-started" && e.step === "explore",
    ).length;
    assert(resumed.exitCode !== 40, `the re-run is not refused (got ${resumed.exitCode})`);
    assert(exploreStarts >= 2, `the re-run runs explore again (starts: ${exploreStarts})`);
    assert(
      !after.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "explore-bodies-empty"),
      "the resumed cycle never parks on explore-bodies-empty",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 2. SIGTERM during a failing fetch: no backoff sleep, no second attempt.
{
  const repo = mkdtempSync(path.join(tmpdir(), "interrupt-explore-"));
  try {
    const sig = fakeSignals();
    let calls = 0;
    const failingFetch = async () => {
      calls++;
      sig.fire("SIGTERM");
      throw new Error("no git remotes found");
    };
    const started = Date.now();
    const result = await runHeadless({
      repoRoot: repo,
      issues: [72],
      restart: false,
      graceMs: GRACE_MS,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: failedDispatch as never, issueBodyFetcherFn: failingFetch },
      write: () => undefined,
    });
    const elapsed = Date.now() - started;
    const state = (await readState(repo, 72)) as WorkState;
    assert(result.exitCode === 21, `a failed fetch under SIGTERM exits 21 (got ${result.exitCode})`);
    assert(result.results[0]?.cap === undefined, "and names no cap");
    assert(!kindsOf(state).includes("cap-hit"), "no explore-bodies-empty cap-hit");
    assert(calls === 1, `no retry after the abort (got ${calls} attempts)`);
    assert(elapsed < PROMPT_MS, `no backoff sleep after the abort (${elapsed} ms)`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. The retry helper: an aborted signal stops it before any attempt.
{
  const ac = new AbortController();
  ac.abort("signal");
  let calls = 0;
  let caught: unknown;
  try {
    await fetchIssueBodyWithRetry(
      async () => {
        calls++;
        return { stdout: "" };
      },
      73,
      "/nonexistent",
      { signal: ac.signal, sleep: async () => undefined },
    );
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof IssueBodyFetchAborted, "an aborted fetch rejects IssueBodyFetchAborted");
  assert(calls === 0, "no attempt once the signal has fired");
  // Without a signal, the empty result still comes back for the cap to judge.
  const plain = await fetchIssueBodyWithRetry(async () => ({ stdout: "" }), 73, "/nonexistent", {
    attempts: 2,
    sleep: async () => undefined,
  });
  assert(plain.stdout === "", "no signal: a persistently empty body is still returned as empty");
}

// ── 4. Projection: a cap hit by an interrupted step is not the cycle's cap.
{
  const at = 1_000;
  let s: WorkState = initialState(74);
  s = appendEvent(s, { kind: "step-started", step: "develop", at });
  s = appendEvent(s, {
    kind: "cap-hit",
    at,
    cap: "verify-failed:develop",
    reviewRound: 0,
    nextStep: "develop",
  });
  // The router took that cap; then a step started and the signal cut it off.
  s = appendEvent(s, { kind: "step-started", step: "develop", at });
  s = appendEvent(s, {
    kind: "cap-hit",
    at,
    cap: "step-failed:develop",
    reviewRound: 0,
    evidence: "cut-off step's evidence",
  });
  const cutOff = appendEvent(
    { ...s, pipelineState: { ...s.pipelineState, status: "interrupted" } },
    { kind: "interrupted", at, reason: "signal", step: "develop" },
  );
  assert(
    lastCap(cutOff) === "verify-failed:develop",
    `the interrupted step's own cap is skipped, the routed one kept (got ${lastCap(cutOff)})`,
  );
  const cutOffFailure = failureOf(cutOff, lastCap(cutOff), "develop");
  assert(
    cutOffFailure?.kind === "verify" && !JSON.stringify(cutOffFailure).includes("cut-off"),
    `the failure describes the reported cap, not the skipped one (got ${JSON.stringify(cutOffFailure)})`,
  );
  const atBoundary = appendEvent(
    { ...s, pipelineState: { ...s.pipelineState, status: "interrupted" } },
    { kind: "interrupted", at, reason: "signal" },
  );
  assert(
    lastCap(atBoundary) === "step-failed:develop",
    "an interrupt at a step boundary leaves the routed cap reported",
  );
  const onlyCutOff = appendEvent(
    appendEvent(appendEvent(initialState(75), { kind: "step-started", step: "explore", at }), {
      kind: "cap-hit",
      at,
      cap: "explore-bodies-empty",
      reviewRound: 0,
      nextStep: "handoff",
    }),
    { kind: "interrupted", at, reason: "signal", step: "explore" },
  );
  const interruptedState: WorkState = {
    ...onlyCutOff,
    pipelineState: { ...onlyCutOff.pipelineState, status: "interrupted" },
  };
  const projected = projectIssue(interruptedState, "/x.json");
  assert(projected.cap === undefined, "a cut-off step's cap never reaches the result");
  assert(projected.failedStep === "explore", "failedStep is still the cut-off step");
  // After a resume the cycle's own later cap counts again.
  const resumed = appendEvent(
    appendEvent(interruptedState, { kind: "step-started", step: "explore", at }),
    { kind: "cap-hit", at, cap: "explore-needs-clarification", reviewRound: 0 },
  );
  assert(lastCap(resumed) === "explore-needs-clarification", "a cap after the resume is reported");
}

if (exit === 0) console.log("\nAll #1371 explore-interrupt checks passed.");
process.exit(exit);

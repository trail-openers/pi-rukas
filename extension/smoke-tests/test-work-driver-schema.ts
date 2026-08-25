#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 1-2: workflow-state schema round-trip + nextStep transition table.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nextStep } from "../src/work-driver-context.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  WORK_STATE_SCHEMA_VERSION,
  type WorkState,
  appendEvent,
  initialState,
  readState,
  workStateFile,
  writeState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// #533 — nextStep now returns a discriminated result; this helper keeps
// the transition-table assertions readable.
function stepOf(state: WorkState): string {
  const d = nextStep(state);
  return d.kind === "step" ? d.step : d.kind;
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// 1. Schema round-trip + atomic write.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-smoke-"));
  try {
    const issue = 547;
    let state = initialState(issue, 1000);
    assert(
      state.schemaVersion === WORK_STATE_SCHEMA_VERSION,
      "initialState carries schemaVersion 1",
    );
    assert(state.resumable === false, "initialState is observational-only (resumable=false)");
    assert(state.pipelineState.currentStep === "explore", "initialState starts at explore");
    assert(state.pipelineState.status === "running", "initialState status=running");
    assert(state.eventLog.length === 0, "initialState eventLog empty");

    // Read non-existent state → undefined.
    const missing = await readState(dir, issue);
    assert(missing === undefined, "readState returns undefined for missing file");

    // Persist, read back, verify identity.
    await writeState(dir, state);
    const roundTripped = await readState(dir, issue);
    assert(roundTripped !== undefined, "readState finds the file after writeState");
    assert(
      roundTripped?.pipelineState.currentStep === "explore",
      "round-tripped state preserves currentStep",
    );
    assert(roundTripped?.issue === issue, "round-tripped state preserves issue");

    // Append an event, persist, verify.
    state = appendEvent(state, {
      kind: "step-started",
      step: "explore",
      at: 1500,
    });
    await writeState(dir, state);
    const afterAppend = await readState(dir, issue);
    assert(afterAppend?.eventLog.length === 1, "appendEvent persists exactly one event");
    assert(afterAppend?.eventLog[0]?.kind === "step-started", "appended event has expected kind");

    // Schema-version mismatch must reject loudly.
    const file = workStateFile(dir, issue);
    await Bun.write(file, JSON.stringify({ ...state, schemaVersion: 99 }));
    try {
      await readState(dir, issue);
      assert(false, "schemaVersion mismatch should throw");
    } catch (err) {
      const msg = (err as Error).message;
      assert(
        msg.includes("schemaVersion=99") && msg.includes("expects 1"),
        "schema mismatch error names both versions",
      );
      assert(
        /rm to start fresh/.test(msg) && /git work is unaffected/.test(msg),
        "error names a real recovery and reassures that git work is untouched",
      );
      assert(
        !/PI_ENSEMBLE_WORK_DRIVER|legacy/i.test(msg),
        "#393: and does NOT point at the deleted legacy flow",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. nextStep transitions.
{
  const base = initialState(1, 1000);
  // Fresh state with no events: stays at explore (linear table's explore→plan)
  // — but the loop calls runStep("explore") first, which appends events. The
  // next-step decision happens AFTER the step. So on a fresh state with no
  // events, the linear table for explore is plan.
  assert(stepOf(base) === "plan", "fresh state at explore advances to plan");

  // Adversarial-approved with lastCompletedStep="develop" → commit-pr.
  // PR2: routing reads `lastCompletedStep` instead of `currentStep` (which
  // was clobbered to "adversarial" by runAdversarial). PR #239's check on
  // currentStep was always false and silently routed every adversarial-
  // approved to lens-review, skipping commit-pr. Confirmed live on #553.
  let s: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
    },
  };
  s = appendEvent(s, { kind: "adversarial-approved", at: 2000, jobId: "j1", rounds: 1 });
  assert(
    stepOf(s) === "commit-pr",
    "adversarial-approved with lastCompletedStep=develop routes to commit-pr",
  );

  // Adversarial-approved with lastCompletedStep="lens-fix" → re-run lens-review.
  s = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "lens-fix",
    },
    eventLog: [{ kind: "adversarial-approved", at: 2000, jobId: "j2", rounds: 1 }],
  };
  assert(
    stepOf(s) === "lens-review",
    "adversarial-approved with lastCompletedStep=lens-fix re-enters lens-review",
  );

  // lens-issues-found, round 1 → lens-fix.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review", reviewRound: 1 },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j3",
        round: 1,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(stepOf(s) === "lens-fix", "lens-issues-found within cap routes to lens-fix");

  // lens-issues-found, round 3 → handoff (round cap).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review", reviewRound: 3 },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j4",
        round: 3,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(stepOf(s) === "handoff", "lens-issues-found at round cap routes to handoff");

  // lens-issues-found, wall-clock cap exceeded → handoff.
  s = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "lens-review",
      reviewRound: 1,
      reviewCapStartedAt: Date.now() - 91 * 60 * 1000, // 91 min ago
    },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j5",
        round: 1,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(stepOf(s) === "handoff", "lens-issues-found past wall-clock cap routes to handoff");

  // cap-hit event with nextStep="step-back" — driver honours the embedded route.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review" },
    eventLog: [
      {
        kind: "cap-hit",
        at: 4000,
        cap: "round-cap",
        reviewRound: 3,
        nextStep: "step-back",
      },
    ],
  };
  assert(stepOf(s) === "step-back", "cap-hit event nextStep=step-back is honoured");

  // CI success → merged.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci" },
    eventLog: [{ kind: "ci-status", at: 5000, status: "success" }],
  };
  assert(stepOf(s) === "merged", "ci-status success routes to merged");

  // CI failure with ciRetryCount under cap → develop (re-fix).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci", ciRetryCount: 1 },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(
    stepOf(s) === "develop",
    "ci-status failure with ciRetryCount=1 (<MAX_CI_RETRIES) routes to develop",
  );

  // CI failure with ciRetryCount at cap → handoff. PR2 B5: prevents the
  // infinite ci → develop → adversarial → lens-review → ci loop that
  // surfaced on issue #553's live cycle when no PR existed for CI to watch.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci", ciRetryCount: 3 },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(
    stepOf(s) === "handoff",
    "ci-status failure with ciRetryCount>=MAX_CI_RETRIES routes to handoff",
  );

  // Terminal status → "done".
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "merged", status: "merged" },
  };
  assert(stepOf(s) === "done", "merged status returns done");

  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "handoff", status: "handoff" },
  };
  assert(stepOf(s) === "done", "handoff status returns done");

  // #533 — the transition table's answer is a discriminated result, not a
  // bare union: an unknown currentStep is its own member so the driver
  // halts naming the field instead of spinning to the safety counter.
  assert(
    nextStep(initialState(1, 1000)).kind === "step" &&
      nextStep(initialState(1, 1000)).step === "plan",
    "nextStep returns the discriminated step member on a fresh state",
  );
  assert(
    JSON.stringify(nextStep(s)).includes('"done"'),
    "nextStep returns the done member on a terminal state",
  );
  const unknownStep = initialState(1, 1000);
  unknownStep.pipelineState = { ...unknownStep.pipelineState, currentStep: "not-a-step" } as never;
  assert(
    nextStep(unknownStep).kind === "unknown-step" &&
      (nextStep(unknownStep) as { value: unknown }).value === "not-a-step",
    "nextStep names the unknown currentStep instead of returning undefined",
  );

  // #533 — the validator: a clean state yields no findings.
  assert(
    validateDiscriminants(initialState(1, 1000)).length === 0,
    "validateDiscriminants accepts a clean state",
  );
}

// 3. #533 — canary: unknown discriminants refuse reconstruction.
{
  // Unknown eventLog[0].kind: schemaVersion 1 passes the version check, so
  // the halt must come from the kind check, not the version check.
  const canary = initialState(533, 1000);
  const findings = validateDiscriminants({
    ...canary,
    eventLog: [{ kind: "not-a-real-kind", at: 1 }],
  } as unknown as Record<string, unknown>);
  assert(findings.length === 1, "unknown eventLog[0].kind produces exactly one finding");
  assert(findings[0].includes("not-a-real-kind"), "finding names the unknown kind");
  assert(findings[0].includes("0"), "finding names the eventLog index");
  assert(
    !findings[0].includes("schemaVersion"),
    "finding is NOT the version check (contrast with section 1)",
  );

  // The resume path refuses before any dispatch. The message reuses the
  // halt idiom of the inconsistency path: field + value first, then
  // inspect-or-rm recovery.
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-discriminant-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    await writeState(dir, {
      ...initialState(533, 1000),
      eventLog: [{ kind: "not-a-real-kind", at: 1 }],
    } as unknown as WorkState);
    const sent: string[] = [];
    const labels: string[] = [];
    await runWorkDriver({
      pi: { sendUserMessage: (c: unknown) => sent.push(String(c)) } as never,
      repoRoot: dir,
      issue: 533,
      issueBodyFetcherFn: async () => ({ stdout: "title:\tt\nstate:\tOPEN\n\nbody" }),
      dispatchFn: async (_pi, spec) => {
        labels.push(spec.role);
        return {
          role: spec.role,
          ok: false,
          text: "",
          toolUses: [],
          ms: 1,
          exitCode: 1,
          transcriptPath: "/tmp/stub.json",
        } as never;
      },
    } as DriverContext);
    assert(labels.length === 0, "the driver HALTS — no dispatch is paid for on an unknown kind");
    const halt = sent.find((m) => /halted on issue #533/.test(m));
    assert(halt !== undefined, "the halt message reaches the operator");
    assert(
      halt !== undefined && halt.includes("not-a-real-kind"),
      "halt message names the unknown value",
    );
    assert(halt !== undefined && halt.includes("eventLog[0].kind"), "halt message names the field");
    assert(
      halt !== undefined && /rm to start fresh/.test(halt) && /git work is unaffected/.test(halt),
      "halt message carries the inspect-or-rm recovery (the #284-291 idiom)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Each of the four pipelineState field positions, unknown value in each.
  // Each pipelineState field position, and each WorkStep-typed event field
  // position: unknown value in, finding naming the field out.
  const pipelinePositions: Array<[string, Record<string, unknown>]> = [
    ["pipelineState.currentStep", { currentStep: "wibble" }],
    ["pipelineState.status", { status: "zombie" }],
    ["pipelineState.lastCompletedStep", { lastCompletedStep: "quux" }],
  ];
  for (const [field, over] of pipelinePositions) {
    const findings2 = validateDiscriminants({
      ...initialState(533, 1000),
      pipelineState: { ...initialState(533, 1000).pipelineState, ...over },
    } as unknown as Record<string, unknown>);
    assert(
      findings2.length === 1 && findings2[0].includes(field),
      `unknown ${field} names the field in its finding`,
    );
  }
  const stepEvent = validateDiscriminants({
    ...initialState(533, 1000),
    eventLog: [{ kind: "step-started", step: "not-a-step", at: 1 }],
  } as unknown as Record<string, unknown>);
  assert(
    stepEvent.length === 1 && stepEvent[0].includes("eventLog[0].step") && stepEvent[0].includes("not-a-step"),
    "unknown eventLog[0].step names the field and the value",
  );
  const capPos = validateDiscriminants({
    ...initialState(533, 1000),
    eventLog: [{ kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "bogus" }],
  } as unknown as Record<string, unknown>);
  assert(
    capPos.length === 1 && capPos[0].includes("eventLog[0].nextStep") && capPos[0].includes("bogus"),
    "unknown cap-hit.nextStep names the field and the value",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

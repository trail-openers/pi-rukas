#!/usr/bin/env bun
/**
 * #1243 fix round — a cycle parks as `provider-unavailable` only when the
 * TERMINAL dispatch failure was the provider.
 *
 * Reproduced by execution (adversarial review): `stepParkedOnProvider` walked
 * the whole step window and returned true if ANY provider-shaped dispatch
 * appeared in it, while its own docstring said the opposite — "a step that met
 * the outage and then died of something else is not a provider park". The
 * consequence is the very mislabelling #1243 exists to remove, pointed the
 * other way: a cycle that met a blip early in the step, recovered, and then
 * CRASHED parked as `provider-unavailable` with `failure.kind: "provider"` and
 * a resumable handoff — both autonomously re-queueable by a headless caller —
 * while its own evidence said `cause=crashed`.
 *
 * Classification now reads the `tail` the router resolved through
 * `failureEventOf` at the call site, so the retry decision and the cap name
 * agree by construction rather than by two readings of the same log.
 *
 * Offline: the driver leg drives `runAdversarial` directly with a fake
 * `adversarialLoopFn` (the instrument test-work-driver-cap-kill-no-retry.ts
 * uses — a first-pass cap-hit hands off to a human, so an in-process driver
 * re-entry would be refused by the entry gate). The pure legs assert the
 * classifier, the cap + its evidence, the headless `failure` object, and the
 * queue's advice.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { failureOf } from "../src/headless/failure.ts";
import type { DispatchResult, ExtensionAPI } from "../src/types.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  type DispatchFailureEvent,
  dispatchFailCapFor,
  dispatchFailCapHit,
  stepParkedOnProvider,
} from "../src/work-driver-provider-park.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const OUTAGE = "Request timed out.";
const CRASH = "subagent exited non-zero with no structured cause";

/** A provider error-stop — the shape the taxonomy reads as `provider-severed`. */
const providerEvent = {
  kind: "dispatch-failed-provider",
  step: "adversarial",
  role: "adversarial-loop",
  jobId: "j-blip",
  label: "adversarial_loop",
  ms: 1_000,
  at: 1,
  providerMessage: OUTAGE,
} as DispatchFailureEvent;

/** A child that died of its own death: no provider stop, no structured kill. */
const crashEvent = {
  kind: "dispatch-failed",
  step: "adversarial",
  role: "adversarial-loop",
  jobId: "j-crash",
  label: "adversarial_loop",
  ms: 2_000,
  at: 2,
  exitCode: 1,
  errorTail: CRASH,
} as DispatchFailureEvent;

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

// ── 1. The classifier: the TERMINAL failure decides, not the window.
function classifierReadsTheTerminalFailure(): void {
  assert(
    stepParkedOnProvider(providerEvent) === true,
    "a provider error-stop as the terminal failure IS a provider park",
  );
  assert(
    stepParkedOnProvider(crashEvent) === false,
    "a crash as the terminal failure is NOT a provider park",
  );
  assert(
    stepParkedOnProvider(undefined) === false,
    "no terminal dispatch failure is not a provider park",
  );
  // A quota window is not cleared by waiting, so it never parks as provider —
  // the narrowness the docstring promises.
  assert(
    stepParkedOnProvider({
      ...providerEvent,
      jobId: "j-quota",
      providerMessage:
        "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
    }) === false,
    "a quota-window 429 is not a provider park — re-queueing meets the same window",
  );
}
void classifierReadsTheTerminalFailure();

// ── 2. The mixed window, executed through the driver.
//
// Call 1: the provider blip. Call 2: the crash the step actually ends on. With
// the whole-window scan both legs read as a provider park; the terminal reading
// must park `step-failed:adversarial`, carry no provider evidence, and leave the
// headless `failure.kind` non-provider.
{
  const dir = mkdtempSync(path.join(tmpdir(), "provider-park-terminal-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    const s = initialState(1243, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: dir },
      workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
      branchName: "feature/issue-1243",
      // The per-workstream in-step ladder is pre-spent, so the fan-out cannot
      // retry the blip into a provider-shaped terminal event: the crash is what
      // the step ends on, which is the case under test.
      adversarialTransientRetries: { default: 3 },
    };
    await writeState(dir, s);

    let calls = 0;
    const seen: string[] = [];
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: dir,
      issue: 1243,
      issueBodyFetcherFn: async () => ({ stdout: "mock body" }),
      adversarialLoopFn: async () => {
        calls += 1;
        if (calls === 1) {
          return mkResult({
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            errorStop: { reason: "error", message: OUTAGE },
            text: `Adversarial loop infrastructure failure: round 1 review dispatch ${OUTAGE}. No verdict was produced — this is NOT a review rejection.`,
          });
        }
        return mkResult({
          ok: false,
          exitCode: 1,
          loopOutcome: "infra-failure",
          text: `Adversarial loop infrastructure failure: round 1 review dispatch ${CRASH}. No verdict was produced — this is NOT a review rejection.`,
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        seen.push(`${spec.role}/${opts?.label}`);
        throw new Error(`smoke: halting at ${spec.role}/${opts?.label}`);
      },
    };

    const before = await readState(dir, 1243);
    if (!before) throw new Error("fixture did not persist");
    // The provider blip is this workstream's PRIOR outcome, so this is the
    // re-entry pass: the reviewer runs once more and the crash is what the step
    // ends on. `adversarialTransientRetries` is pre-spent so the fan-out's
    // in-step ladder cannot retry the crash into another attempt — the crash is
    // the terminal failure, which is the case under test.
    const withWindow = {
      ...before,
      eventLog: [
        ...before.eventLog,
        {
          kind: "adversarial-workstream-outcome",
          at: 1,
          workstreamId: "default",
          outcome: "infra-failure",
        } as WorkState["eventLog"][number],
        { ...providerEvent, jobId: "j-win-blip" } as WorkState["eventLog"][number],
        { ...crashEvent, jobId: "j-win-crash" } as WorkState["eventLog"][number],
        {
          kind: "adversarial-workstream-outcome",
          at: 2,
          workstreamId: "default",
          outcome: "infra-failure",
          errorTail: CRASH,
        } as WorkState["eventLog"][number],
      ],
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    } as any as WorkState;

    const after = await runAdversarial(ctx, withWindow, Date.now());
    const caps = after.eventLog.filter((e) => e.kind === "cap-hit");
    const cap = caps[caps.length - 1];
    // The in-step ladder is pre-spent, so this pass finds no retryable
    // workstream, dispatches nothing, and parks on the preserved window: the
    // provider blip is in it, the crash is what ended the step, and the park
    // must follow the crash. With the old whole-window scan this is the cycle
    // that parked `provider-unavailable` with a resumable, re-queueable handoff.
    assert(
      calls === 0,
      `the spent in-step budget means nothing was re-dispatched (calls=${calls})`,
    );
    assert(
      after.eventLog.some(
        (e) => e.kind === "dispatch-failed-provider" && e.providerMessage === OUTAGE,
      ),
      "the provider blip IS present in the step window (so the fix is doing work)",
    );
    assert(
      cap?.kind === "cap-hit" && cap.cap === "adversarial-infra-failure",
      `a crash terminal failure does NOT park as provider-unavailable (got ${cap?.kind === "cap-hit" ? cap.cap : "no cap"})`,
    );
    // The driver leg's mutation signal: the tail the router actually resolved
    // is the crash, and the cap it writes for that tail is not the provider
    // park. Pre-fix, the classifier scanned the whole window and said provider;
    // the terminal reading says the crash. Nothing is injected — the driver
    // above already recorded the window (blip first, crash terminal) and the
    // assertions below read it back from the state file.
    assert(
      dispatchFailCapFor("adversarial", crashEvent) === "step-failed:adversarial",
      "the cap the router writes for that tail is not the provider park (a window scan would flip it)",
    );
    assert(
      cap?.kind === "cap-hit" && cap.evidence === undefined,
      "the crash park carries no provider evidence for a caller to re-queue on",
    );
    // The window's TERMINAL event is a provider event — exactly the shape the
    // old whole-window scan mistook for "this step died of the endpoint", and
    // the reason it parked this cycle `provider-unavailable` with resumable,
    // re-queueable evidence. The terminal-only classifier parks the infra cap
    // instead, with no evidence, because the crash is the failure that ENDED the
    // step (`adversarial-workstream-outcome.errorTail`) and it is not provider-
    // shaped.
    const last = [...after.eventLog]
      .reverse()
      .find((e) => e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider");
    assert(
      // The dispatch window now ends on the crash (the provider blip still sits
      // earlier in it) — the shape the OLD whole-window scan read as "provider",
      // which is what made this cycle autonomously re-queueable.
      last?.kind === "dispatch-failed" && (last as { jobId?: string }).jobId === "j-win-crash",
      `the window ends on the crash with a provider event still behind it — the old scan's trigger (got ${last?.kind}/${(last as { jobId?: string } | undefined)?.jobId})`,
    );
    const terminalOutcome = [...after.eventLog]
      .reverse()
      .find(
        (e) =>
          e.kind === "adversarial-workstream-outcome" &&
          (e as { outcome?: string }).outcome === "infra-failure",
      );
    assert(
      (terminalOutcome as { errorTail?: string } | undefined)?.errorTail === CRASH,
      `the failure that ENDED the step is the crash, named on the workstream outcome (got ${JSON.stringify((terminalOutcome as { errorTail?: string } | undefined)?.errorTail)})`,
    );
    assert(
      stepParkedOnProvider(crashEvent) === false,
      "the terminal failure the driver actually died of classifies as NOT a provider park",
    );
    // Control: swap the terminal event for the provider stop and the SAME
    // seam says provider — so the assertions above are the tail's answer, not
    // an always-false predicate.
    assert(
      stepParkedOnProvider({
        ...providerEvent,
        jobId: "j-control",
        at: (last?.at ?? 0) + 1,
      }) === true,
      "control: the same seam on a provider-shaped tail still says provider",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3. The cap + evidence builder takes the tail, not the log.
{
  const state = {
    pipelineState: { reviewRound: 0 },
    eventLog: [],
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the seam reads
  } as any as WorkState;
  const providerHit = dispatchFailCapHit("adversarial", state, providerEvent);
  assert(
    providerHit.cap === "provider-unavailable",
    `a provider terminal failure parks with provider-unavailable (got ${providerHit.cap})`,
  );
  assert(
    (providerHit.evidence ?? "").includes(OUTAGE) &&
      (providerHit.evidence ?? "").includes("cause=provider-severed"),
    `the provider park carries the outage + its cause (got: ${providerHit.evidence})`,
  );
  const crashHit = dispatchFailCapHit("adversarial", state, crashEvent);
  assert(
    crashHit.cap === "step-failed:adversarial",
    `a crash terminal failure parks with step-failed:adversarial (got ${crashHit.cap})`,
  );
  assert(
    crashHit.evidence === undefined,
    "a crash park carries no provider evidence — nothing to re-queue on",
  );
}

// ── 4. The two surfaces a headless caller / operator switches on.
{
  const mkState = (events: readonly unknown[], cap: string, evidence?: string): WorkState => {
    const s = initialState(1243, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      failedStep: "adversarial",
    };
    return {
      ...s,
      eventLog: [
        ...events,
        {
          kind: "cap-hit",
          at: 9,
          cap,
          reviewRound: 0,
          nextStep: "handoff",
          ...(evidence ? { evidence } : {}),
        },
      ],
    } as unknown as WorkState;
  };

  const mixed = mkState(
    [
      { kind: "step-started", step: "adversarial", at: 0 },
      providerEvent,
      {
        kind: "dispatch-completed",
        step: "adversarial",
        role: "adversarial-loop",
        jobId: "j-ok",
        label: "adversarial_loop",
        ms: 500,
        at: 3,
        summary: "recovered after the blip",
      },
      crashEvent,
    ],
    "step-failed:adversarial",
  );
  const f = failureOf(mixed, "step-failed:adversarial", "adversarial");
  assert(
    f !== undefined && f.kind !== "provider",
    `the headless failure object does NOT call the mixed-window crash a provider outage (kind=${f?.kind})`,
  );
  assert(
    f?.cause === "crashed-unknown" || f?.cause === "crashed",
    `its own evidence names the crash as the cause (got ${f?.cause})`,
  );
  assert(
    f?.providerMessage === undefined,
    `no providerMessage leaks from the recovered blip (got ${f?.providerMessage})`,
  );

  const outage = mkState(
    [{ kind: "step-started", step: "adversarial", at: 0 }, providerEvent],
    "provider-unavailable",
    `${OUTAGE} · cause=provider-severed`,
  );
  const g = failureOf(outage, "provider-unavailable", "adversarial");
  assert(
    g?.kind === "provider" && g?.providerMessage === OUTAGE,
    `a genuine outage still reports kind=provider with the endpoint's own message (got ${g?.kind})`,
  );

  const why = explainCap("provider-unavailable", outage);
  // #1243 fix round — the advice and the behaviour have to agree. The park now
  // terminalises as `interrupted` (reason `provider`) precisely so a plain
  // `/work N` re-enters, so the advice says that, and says `--restart` is the
  // wrong verb. An earlier version of this test asserted a phrase no driver
  // path honoured: the park was a terminal `handoff`, which refuses a plain
  // re-run. Asserting the WORDS is the point — not that a substring appears.
  assert(
    /re-run `\/work 1243`/.test(why) && /Do NOT pass `--restart`/.test(why),
    `explainCap tells the operator to re-run without --restart (got: ${why.slice(0, 260)})`,
  );
  assert(
    /resumable/.test(why) && /interrupted/.test(why),
    "explainCap names the status that makes the park re-enterable, so the claim is checkable against the state file",
  );
  const action = humanActionFor("cap provider-unavailable", 1243);
  assert(
    /re-run `\/work 1243`/.test(action) && /do NOT pass --restart/.test(action),
    `humanActionFor matches explainCap — the re-run advice, never a bare --restart (got: ${action})`,
  );
  // The prohibition must survive a substring grep too: a reader scanning the
  // action for "--restart" must not conclude the queue recommends it.
  assert(
    !/re-run \/work 1243 --restart/.test(action),
    `the provider action never RECOMMENDS --restart (got: ${action})`,
  );
  const crashAction = humanActionFor("cap step-failed:adversarial", 1243);
  assert(
    crashAction !== action && /inspect/.test(crashAction),
    `a crash park keeps the inspect-and-restart advice (got: ${crashAction})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

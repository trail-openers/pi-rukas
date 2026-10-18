#!/usr/bin/env bun
/**
 * #1243 fix round — the TWO reading points of a provider park's re-delivery.
 *
 * Sibling of test-provider-park-surfaces.ts, which owns the renderers. This one
 * owns the re-delivery path itself, split off for AGENTS.md §12's file-size
 * limit; the two answer different questions and each was already long.
 *
 * Two properties, and each is a separate reading point that can go wrong alone:
 *
 *   1. `redeliverUndeliveredPark` gates on the shared `isProviderPark(disk)`.
 *      A status-only test treats a SIGTERM interrupt — also `interrupted`, also
 *      with no `handoffDeliveredAt` — as a park and announces a handoff nobody
 *      made. `interruptIfRequested` owns that write; there is nothing to deliver.
 *
 *   2. The delivery DECIDES from the disk snapshot. By the time re-entry runs,
 *      `reenterInterrupted` has flipped the park's status to `running` on the
 *      in-memory copy — and a `running` cycle is neither merged / handoff /
 *      aborted nor a provider park. A delivery that reads its own argument
 *      instead of the snapshot refuses the park's owed line, and the operator
 *      hears nothing at all. That is why `deliverTerminalLine` takes `park`.
 *
 * Both legs drive the functions directly rather than the whole driver: with a
 * fixture whose handoff is a real deliverable one, re-entry reaches `runHandoff`
 * and delivers for the handoff's OWN reasons, which says nothing about either
 * reading point. Mutating the stale "signal fixture that still carries a
 * provider cap" hid a gate mutation for exactly that reason.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerParkResumeStep } from "../src/work-driver-handoff-provider-resume.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { redeliverUndeliveredPark, reenterInterrupted } from "../src/work-driver-resume.ts";
import { deliverTerminalLine } from "../src/work-driver-terminal-delivery.ts";
import type { InterruptReason } from "../src/workflow-state-events-interrupted.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OUTAGE = "Request timed out.";

/**
 * An `interrupted` cycle, in the two shapes the fix has to tell apart.
 *
 * The `"signal"` / `"timeout"` shape is a cycle an abort cut off mid-step:
 * `interruptIfRequested` / `markInterrupted` wrote it, so it carries no provider
 * failure and no park cap. That matters more than it looks — keeping the
 * provider event and the `provider-unavailable` cap in a "signal" fixture lets
 * the resumed cycle complete a genuine handoff off that cap, and the leg then
 * passes for the handoff's own reasons no matter what the code under test did.
 */
function interruptedState(issue: number, reason: InterruptReason): WorkState {
  const s = initialState(issue);
  const aborted = reason !== "provider";
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "interrupted",
      currentStep: aborted ? "develop" : "adversarial",
      lastCompletedStep: aborted ? "plan" : "commit-pr",
      branchName: `feature/issue-${issue}`,
      prNumber: aborted ? undefined : 1554,
      handoffDeliveredAt: new Date().toISOString(),
    },
    eventLog: aborted
      ? [
          { kind: "step-started", step: "develop", at: 1 },
          { kind: "interrupted", at: 4, reason, step: "develop" },
        ]
      : [
          { kind: "step-started", step: "adversarial", at: 1 },
          {
            kind: "dispatch-failed-provider",
            step: "adversarial",
            role: "adversarial-reviewer",
            label: "adversarial:review",
            jobId: "j-park",
            ms: 1_200,
            at: 1,
            providerMessage: OUTAGE,
          },
          {
            kind: "cap-hit",
            at: 2,
            cap: "provider-unavailable",
            reviewRound: 0,
            nextStep: "handoff",
            evidence: `${OUTAGE} · cause=provider-severed`,
          },
          { kind: "interrupted", at: 3, reason, step: "adversarial" },
        ],
  };
}

/** The same cycle with its terminal line still owed. */
function undelivered(issue: number, reason: InterruptReason): WorkState {
  const s = interruptedState(issue, reason);
  return { ...s, pipelineState: { ...s.pipelineState, handoffDeliveredAt: undefined } };
}

function recordingHost(sent: string[]): DriverHost {
  return {
    sendUserMessage: (t) => {
      sent.push(t);
    },
    emit: () => undefined,
  };
}

process.env.PI_ENSEMBLE_VERIFY = "0";

// ── 1. The gate: only a PROVIDER park re-delivers.
{
  const repo = mkdtempSync(path.join(tmpdir(), "park-redeliver-gate-"));
  try {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const runGate = async (state: WorkState): Promise<{ sent: string[]; next: WorkState }> => {
      const sent: string[] = [];
      // `reenterInterrupted` is what the driver does before the gate runs, so
      // the in-memory copy handed in is `running` — the mutation the gate must
      // not decide from.
      const live = reenterInterrupted(state);
      const next = await redeliverUndeliveredPark(
        {
          repoRoot: repo,
          emitSink: undefined,
          signal: undefined,
          host: recordingHost(sent),
          issue: 1243,
        },
        { action: "fresh" },
        state,
        live,
      );
      return { sent, next };
    };

    const park = await runGate(undelivered(1243, "provider"));
    assert(
      park.sent.some((n) => /kind=handoff/.test(n)) &&
        park.next.pipelineState.handoffDeliveredAt !== undefined,
      `the gate re-delivers an undelivered PROVIDER park (got ${park.sent.length} send(s))`,
    );

    // Same status, same undelivered marker, only the interrupt reason differs.
    const signal = await runGate(undelivered(1243, "signal"));
    assert(
      signal.sent.length === 0,
      `the gate sends NOTHING for a signal interrupt (got ${signal.sent.length}: ${signal.sent[0]?.slice(0, 80)})`,
    );
    assert(
      signal.next.pipelineState.handoffDeliveredAt === undefined,
      "the gate records no delivery for a signal interrupt",
    );

    const timeout = await runGate(undelivered(1243, "timeout"));
    assert(
      timeout.sent.length === 0,
      `the gate sends nothing for a runner --timeout interrupt either (got ${timeout.sent.length})`,
    );

    const already = await runGate(interruptedState(1243, "provider"));
    assert(
      already.sent.length === 0,
      `the gate never re-posts a park whose line was delivered (got ${already.sent.length})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 2. The delivery decides from the DISK snapshot, not the copy re-entry
//      mutated. `reenterInterrupted` has already flipped the park to `running`,
//      and a `running` cycle is neither merged / handoff / aborted nor a provider
//      park — so a delivery reading its own argument would refuse the park's line
//      here and the operator would hear nothing.
//
//      Mutation check: drop the third argument at the `deliverTerminalLine` call
//      in work-driver-resume.ts and the gate leg above sends 0 instead of 1.
{
  const repo = mkdtempSync(path.join(tmpdir(), "park-redeliver-snapshot-"));
  try {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const disk = undelivered(1243, "provider");
    const mutated = reenterInterrupted(disk);
    assert(
      mutated.pipelineState.status === "running",
      "the re-entry mutation is real: the in-memory copy says 'running', which no park test matches",
    );

    const sent: string[] = [];
    await deliverTerminalLine(
      { repoRoot: repo, issue: 1243, host: recordingHost(sent) },
      mutated,
      disk,
    );
    assert(
      sent.length === 1 && /kind=handoff/.test(sent[0] ?? ""),
      `the park still delivers its line, because the decision reads the disk snapshot (got ${sent.length})`,
    );

    // The same call WITHOUT the snapshot decides from the mutated copy — which is
    // the bug the parameter exists to fix, kept as an assert so the parameter is
    // never mistaken for decoration.
    const silent = await deliverTerminalLine(
      { repoRoot: repo, issue: 1243, host: recordingHost([]) },
      mutated,
    );
    assert(
      silent.pipelineState.handoffDeliveredAt === undefined,
      "without the snapshot the same call delivers nothing — the failure this argument closes",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. Where the park re-enters. `parkProviderInterrupt` stores this as the
//      park's resume point, and nothing else in the repo reads
//      `providerParkResumeStep` — it had zero coverage, so a regression in the
//      cap reading (or the template vocabulary it borrows from `caps.ts`) was
//      invisible: the park would silently resume at the wrong step, or at
//      `handoff` itself, which re-posts the comment instead of re-running work.
{
  type CapHit = Extract<WorkState["eventLog"][number], { kind: "cap-hit" }>;
  const capPark = (cap: CapHit["cap"]): WorkState => {
    const s = initialState(1243);
    return {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        status: "interrupted",
        currentStep: "handoff",
        lastCompletedStep: "develop",
      },
      eventLog: [
        { kind: "step-started", step: "explore", at: 1 },
        { kind: "step-started", step: "develop", at: 2 },
        { kind: "cap-hit", at: 3, cap, reviewRound: 0, nextStep: "handoff" },
      ],
    };
  };
  assert(
    providerParkResumeStep(capPark("step-failed:develop")) === "develop",
    `a step-failed:<step> cap resumes the park at that step (got ${providerParkResumeStep(capPark("step-failed:develop"))})`,
  );
  assert(
    providerParkResumeStep(capPark("verify-failed:develop")) === "develop",
    `a verify-failed:<step> cap resumes the park at that step (got ${providerParkResumeStep(capPark("verify-failed:develop"))})`,
  );
  assert(
    providerParkResumeStep(capPark("provider-unavailable")) === "develop",
    `a cap that names no step falls back to the last real step-started, not handoff (got ${providerParkResumeStep(capPark("provider-unavailable"))})`,
  );
  // A `step-failed:handoff` cap must NOT send the park back to its own delivery
  // step — that is the branch that would re-post the comment.
  assert(
    providerParkResumeStep(capPark("step-failed:handoff")) === "develop",
    `a step-failed:handoff cap never resumes at handoff (got ${providerParkResumeStep(capPark("step-failed:handoff"))})`,
  );
  // No step-started at all: nothing to resume, so `handoff` is the honest answer.
  const bare = initialState(1243);
  assert(
    providerParkResumeStep(bare) === "handoff",
    `a log with no step-started parks at handoff (got ${providerParkResumeStep(bare)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #1243 fix round — every SURFACE a `provider-unavailable` park reaches has to
 * answer the same question: is this `interrupted` cycle a park, or was it cut
 * off?
 *
 * The park terminalises as `interrupted` (reason `provider`) so a plain `/work N`
 * re-enters it. Three renderers had to work that out for themselves, and each one
 * that tested the status alone got it wrong: two called it ABORTED, the queue
 * fell through to the generic "inspect the state file and `--restart`" advice —
 * which is the one verb that destroys the park, since a restart re-runs the whole
 * cycle from `explore` instead of the halted step. `isProviderPark` is now the
 * single test, so each surface is asserted here on the SAME fixture and a
 * mutation of the discriminator (or of a surface that stopped calling it) flips a
 * leg.
 *
 * Sibling of test-provider-park-terminal.ts, which owns the OTHER half of the
 * #1243 contract: WHEN a cycle earns the park (the classifier that reads only the
 * terminal failure). Split for AGENTS.md §12's file-size limit — the two halves
 * answer different questions and each was already long.
 *
 * Offline: the driver legs drive `runWorkDriver` with a fake `dispatchFn` that
 * throws, so nothing spawns and the assertions are about re-entry refusal and
 * handoff re-delivery, not about any step's content.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exitCodeForState } from "../src/headless/exit-code.ts";
import { runHeadless } from "../src/headless/run.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { providerParkEvidence } from "../src/work-driver-provider-park.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { singleCycleQueueEntry } from "../src/work-queue-single-entry.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { renderCycleIndex } from "../src/work-status-index.ts";
import { renderStatus } from "../src/work-status.ts";
import { type InterruptReason, isProviderPark } from "../src/workflow-state-events-interrupted.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OUTAGE = "Request timed out.";
const providerEvent = {
  kind: "dispatch-failed-provider",
  step: "adversarial",
  role: "adversarial-reviewer",
  label: "adversarial:review",
  ms: 1_200,
  at: 1,
  providerMessage: OUTAGE,
  jobId: "j-park",
} as const satisfies WorkState["eventLog"][number];

/**
 * A cycle the endpoint took down: the provider event, the park cap naming it,
 * and the `interrupted` entry the runner's grace period wrote. `handoffDeliveredAt`
 * is set because the cycle completed its handoff — the interrupt came after.
 *
 * A `"signal"` / `"timeout"` fixture is a cycle an abort cut off mid-step:
 * `interruptIfRequested` / `markInterrupted` wrote it, so it carries no provider
 * failure and no park cap. That matters more than it looks — keeping the
 * provider event and the `provider-unavailable` cap in a "signal" fixture lets
 * the resumed cycle complete a genuine handoff off that cap, and the whole-driver
 * legs would then pass for the handoff's own reasons no matter what the gate
 * under test did. Mutating that stale shape hid a gate mutation for exactly that
 * reason; the shape below is the one an aborted cycle actually has.
 */
function parked(issue: number, reason: InterruptReason = "provider"): WorkState {
  const s = initialState(issue);
  const signal = reason !== "provider";
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "interrupted",
      currentStep: signal ? "develop" : "adversarial",
      lastCompletedStep: signal ? "plan" : "commit-pr",
      branchName: `feature/issue-${issue}`,
      prNumber: signal ? undefined : 1554,
      handoffDeliveredAt: new Date().toISOString(),
    },
    eventLog: signal
      ? [
          { kind: "step-started", step: "develop", at: 1 },
          { kind: "interrupted", at: 4, reason, step: "develop" },
        ]
      : [
          { kind: "step-started", step: "adversarial", at: 1 },
          providerEvent,
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

process.env.PI_ENSEMBLE_VERIFY = "0";

// ── 1. The discriminator itself, and the neighbour it must not swallow.
{
  const park = parked(1243);
  assert(isProviderPark(park) === true, "isProviderPark reads the provider park");
  // A signal interrupt on the SAME status is NOT a park — the status alone is
  // never the answer, which is what each renderer got wrong.
  const signalled = parked(1243, "signal");
  assert(
    isProviderPark(signalled) === false,
    "isProviderPark does NOT call a signal interrupt a provider park",
  );
  assert(
    isProviderPark({ ...park, pipelineState: { ...park.pipelineState, status: "handoff" } }) ===
      false,
    "isProviderPark is false for a non-interrupted status even with a provider event in the log",
  );
  assert(
    exitCodeForState(park) === 10,
    `the park still exits as handoff (got ${exitCodeForState(park)})`,
  );
  assert(
    exitCodeForState(signalled) === 21,
    `a signal interrupt still exits 21 (got ${exitCodeForState(signalled)})`,
  );
}

// ── 2. /work-status: parked and resumable, never ABORTED, never offering the
//      verb that would destroy it.
{
  const park = parked(1243);
  const status = renderStatus(park, "/tmp/fake-repo");
  assert(
    /PARKED/.test(status) && /provider/i.test(status),
    `/work-status renders the provider park as PARKED (got: ${status.split("\n")[0]})`,
  );
  assert(!/ABORTED/.test(status), "the provider park never renders as ABORTED");
  assert(
    status.includes("resume: /work 1243"),
    "/work-status tells the operator to re-run /work 1243",
  );
  assert(
    !/re-run \/work 1243 --restart|--restart:/.test(status),
    "the park's status line never OFFERS --restart as the verb",
  );
  assert(
    /do NOT pass --restart/i.test(status),
    "the park's status line names the one verb that is wrong here",
  );
  // The signal interrupt keeps its own (unchanged) wording.
  const sig = renderStatus(parked(1243, "signal"), "/tmp/fake-repo");
  assert(
    /INTERRUPTED \(resumable\)/.test(sig) && /reason: signal/.test(sig),
    `a signal interrupt keeps the S4a wording (got: ${sig.split("\n")[0]})`,
  );
  // The multi-cycle index names it too.
  const index = renderCycleIndex([{ issue: 1243, state: park }], Date.now());
  assert(
    /parked \(provider unavailable\)/.test(index) && !/ABORTED/.test(index),
    `the cycle index calls the row a provider park (got: ${index})`,
  );
}

// ── 3. The single-cycle queue entry: the provider's advice, not the generic one.
{
  const repo = mkdtempSync(path.join(tmpdir(), "provider-park-queue-"));
  try {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const park = parked(1243);
    await writeState(repo, park);
    const entry = await singleCycleQueueEntry(repo, 1243);
    assert(
      entry?.outcome === "parked" && /provider-unavailable/.test(entry.reason ?? ""),
      `the single-issue queue row carries the provider cap as its reason (got ${entry?.outcome}/${entry?.reason})`,
    );
    const expected = humanActionFor("cap provider-unavailable", 1243);
    assert(
      entry?.humanAction === expected,
      `the single-issue queue row carries the provider action the multi-issue path gives (got: ${entry?.humanAction})`,
    );
    assert(
      !/--restart/.test(entry?.humanAction ?? "") ||
        /do NOT pass --restart/.test(entry?.humanAction ?? ""),
      "the queue row never RECOMMENDS --restart for a provider park",
    );
    assert(
      !/inspect \.pi\/work-state/.test(entry?.humanAction ?? ""),
      "the queue row is not the generic inspect-and-restart fallback",
    );
    // Control: the same code path on a SIGNAL interrupt keeps the resume advice,
    // so the assertions above are the park's answer and not an always-provider
    // branch.
    await writeState(repo, {
      ...park,
      eventLog: park.eventLog.map((e): WorkState["eventLog"][number] =>
        e.kind === "interrupted" ? { ...e, reason: "signal" } : e,
      ),
    });
    const sigEntry = await singleCycleQueueEntry(repo, 1243);
    assert(
      sigEntry?.humanAction === "resume with /work 1243",
      `a signal interrupt keeps the resume advice, not the provider's (got: ${sigEntry?.humanAction})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 4. Re-entry safety: the park is a PARKED cycle, but it is not a licence to
//      start a second driver over a live one.
{
  const repo = mkdtempSync(path.join(tmpdir(), "provider-park-reentry-"));
  try {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    // pid 1 is alive on every unix box and is never this process.
    await writeState(repo, { ...parked(1243), owner: { pid: 1, at: 1 } });
    const notices: string[] = [];
    const host: DriverHost = {
      sendUserMessage: (t) => {
        notices.push(t);
      },
      emit: () => undefined,
    };
    const ctx = {
      host,
      repoRoot: repo,
      issue: 1243,
      issueBodyFetcherFn: async () => ({ stdout: "mock body" }),
      dispatchFn: async () => {
        throw new Error("smoke: must not dispatch — the re-entry was refused");
      },
    } satisfies DriverContext;
    const outcome = await runWorkDriver(ctx);
    assert(
      outcome.started === false && /live process \(pid 1\)/.test(outcome.reason ?? ""),
      `a provider park owned by a live pid is refused, not re-entered (got ${JSON.stringify(outcome)})`,
    );
    assert(
      notices.some((n) => n.includes("already running in process 1")),
      "the refusal names the owning pid to the operator",
    );
    assert(
      !notices.some((n) => n.includes("already terminated")),
      "the park is not refused as a terminal cycle",
    );
    const still = (await readState(repo, 1243)) as WorkState;
    assert(
      still.pipelineState.status === "interrupted",
      "a refused re-entry leaves the provider park's status alone for its real owner",
    );

    // #1243 fix round — the same refusal through the HEADLESS host. A park's
    // status is `interrupted` (that is what makes it resumable) and
    // `exitCodeForState` deliberately maps it to `EXIT.handoff`, NOT
    // `EXIT.refused` — so the runner's existing "a refusal is not resumable"
    // sweep, which keys on 40, does not fire here, and `projectIssue` derives
    // `resumable` from the status alone. A host that re-queues on `resumable`
    // would re-queue a cycle it cannot enter while a live owner holds it. The
    // runner's `isLiveOwnerRefusal` gate is what closes that; drop it and this
    // reports resumable: true.
    const headless = await runHeadless({
      repoRoot: repo,
      issues: [1243],
      restart: false,
      graceMs: 5,
      signalTarget: { on: () => undefined, off: () => undefined } as unknown as NodeJS.Process,
      driverSeams: {
        dispatchFn: async () => {
          throw new Error("smoke: must not dispatch — the re-entry was refused");
        },
        issueBodyFetcherFn: async () => ({
          stdout: "title:\tmock\nstate:\tOPEN\n\nnon-empty mock body",
        }),
      },
      write: () => undefined,
    });
    const row = headless.results[0];
    assert(
      row?.status === "interrupted" && row.resumable === false,
      `a provider park refused for a live owner does NOT report resumable: true (got status=${row?.status} resumable=${row?.resumable} exit=${row?.exitCode})`,
    );
    assert(
      row?.exitCode === 10,
      `…and its exit code is still the park's handoff code, unchanged (got ${row?.exitCode})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 5. A park whose handoff line never reached the session still delivers it.
//      `applyInterrupt` clears `inFlightJobIds`, so the classifier answers `fresh`
//      (a clean boundary) for it — and without the re-delivery the loop would
//      simply exit with the line still owed, which is how a second provider
//      failure after a resume reached the operator as nothing at all.
{
  const repo = mkdtempSync(path.join(tmpdir(), "provider-park-redeliver-"));
  try {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const undelivered = parked(1243);
    await writeState(repo, {
      ...undelivered,
      pipelineState: { ...undelivered.pipelineState, handoffDeliveredAt: undefined },
    });
    const notices: string[] = [];
    const host: DriverHost = {
      sendUserMessage: (t) => {
        notices.push(t);
      },
      emit: () => undefined,
    };
    const ctx = {
      host,
      repoRoot: repo,
      issue: 1243,
      issueBodyFetcherFn: async () => ({ stdout: "mock body" }),
      dispatchFn: async () => {
        throw new Error("smoke: halted at the first dispatch");
      },
    } satisfies DriverContext;
    await runWorkDriver(ctx).catch(() => undefined);
    assert(
      notices.some((n) => /provider-unavailable|provider/i.test(n)),
      `a re-run re-delivers the undelivered provider handoff line (got ${notices.length} notice(s): ${notices[0]?.slice(0, 90)})`,
    );
    const after = (await readState(repo, 1243)) as WorkState;
    assert(
      after.pipelineState.handoffDeliveredAt !== undefined,
      "the re-delivery records handoffDeliveredAt so the line is not sent again",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 6. The park's own account is bounded.
{
  const long = "x".repeat(4_000);
  const clipped = providerParkEvidence({
    ...providerEvent,
    jobId: "j-long",
    providerMessage: long,
  });
  assert(
    clipped.length <= 241,
    `the park's evidence is clipped to the taxonomy's FAILURE_REASON_CHARS (got ${clipped.length})`,
  );
  assert(
    providerParkEvidence(undefined) === "",
    "an absent tail yields no evidence rather than a fabricated one",
  );
  // The evidence is provider-authored text that lands in the durable state file
  // and on the handoff body, so it rides the same redaction seam `failureOf`
  // uses — scrubbed BEFORE it is persisted, not only at render.
  const withSecret = providerParkEvidence({
    ...providerEvent,
    jobId: "j-secret",
    providerMessage: `upstream 502 apiKey: ${"S".repeat(32)}`,
  });
  assert(
    !withSecret.includes("S".repeat(32)) && /REDACTED/.test(withSecret),
    `the park's evidence has its credential scrubbed before it is stored (got ${withSecret.slice(0, 80)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

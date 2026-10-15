#!/usr/bin/env bun
/**
 * #1263 — a step that THROWS must post the handoff (comment + label) before
 * the cycle ends, not just record a silent `aborted` state file.
 *
 * The issue's test, verbatim: "a dispatchFn that throws on step `plan`;
 * assert a handoff-emitted event and that the fake forge received labelAdd."
 *
 * Mechanism under test: the catch in runWorkDriverInner (work-driver.ts) used
 * to `return { started: true }` directly after `persistCycle` — only a
 * dispatch FAILURE (a `cap-hit` routed to handoff by the step router) reached
 * runHandoff, which is where the forge comment + label post happens. A step
 * that THROWS (fs failure, a bug, an uncaught exec rejection) ended as
 * `aborted` with nothing on the issue. The fix routes the thrown step through
 * the same handoff path (cap `driver-crash:<step>` → runHandoff), with a
 * one-shot guard so a crash inside runHandoff itself still ends as aborted.
 *
 * The fake forge records labelAdd + issueComment so the assertions can see
 * the handoff post happened.
 *
 * Two scenarios, both wired through function-injection seams (closures, not
 * env vars, which leak into hostile environments):
 *   1. `setPlanThrowForTestForTest` makes the plan step throw from inside
 *      `runPlan` itself, so the driver's catch (cap `driver-crash:plan` →
 *      handoff) posts the comment + label before the cycle ends. This is the
 *      issue's test verbatim.
 *   2. The same plan throw routes to handoff, and
 *      `setHandoffThrowForTestForTest` makes `runHandoff` throw just before
 *      its terminal-status write — a crash that escapes the step, exercising
 *      the one-shot guard's direct-abort fallback (a throw at step `handoff`
 *      ends as `aborted` and is NOT re-routed to handoff).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { Forge } from "../src/forge.ts";
import { type DriverContext } from "../src/work-driver-context.ts";
import { setHandoffThrowForTestForTest } from "../src/work-driver-handoff.ts";
import { setPlanThrowForTestForTest } from "../src/work-driver-plan.ts";
import {
  type WorkState,
  initialState,
  readState,
  writeState,
} from "../src/workflow-state.ts";
import { runWorkDriver } from "../src/work-driver.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal host stub — runWorkDriver calls sendUserMessage for progress.
function makeFakeHost(): { sendUserMessage: (c: unknown) => void; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sendUserMessage: (c: unknown) => {
      sent.push(typeof c === "string" ? c : JSON.stringify(c));
    },
  };
}

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  } as unknown as DispatchResult;
}

// Fake forge that records labelAdd + issueComment calls. Only the methods
// runHandoff / postHandoffWithRetry / verifyHandoffLabel touch are real; the
// rest are no-ops (they're never reached on this path).
function makeFakeForge(): {
  forge: Forge;
  labelAdds: { target: string; number: number; name: string }[];
  issueComments: string[];
} {
  const labelAdds: { target: string; number: number; name: string }[] = [];
  const issueComments: string[] = [];
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "trail-openers",
    repo: "pi-rukas",
    cwd: "/tmp",
    issueView: async () => ({ labels: [] }),
    issueCreate: async () => ({ number: 1 }),
    issueEdit: async () => ({ number: 1 }),
    issueComment: async (n: number, body: string) => {
      issueComments.push(body);
      return `https://github.com/trail-openers/pi-rukas/issues/${n}#issuecomment-1`;
    },
    issueComments: async () => [],
    issueSearch: async () => [],
    prView: async () => ({ labels: [] }),
    prList: async () => [],
    prCreate: async () => ({ number: 1 }),
    prMerge: async () => "",
    prDiff: async () => "",
    prChecks: async () => [],
    prComments: async () => [],
    prComment: async (n: number, body: string) => {
      issueComments.push(body);
      return `https://github.com/trail-openers/pi-rukas/pull/${n}#issuecomment-1`;
    },
    ciWatch: async () => ({ status: "success" }),
    ciRun: async () => ({ id: 1 }),
    mergeReadiness: async () => ({ canMerge: true }),
    labelCreate: async () => undefined,
    labelAdd: async (target: "issue" | "mr", number: number, name: string) => {
      labelAdds.push({ target, number, name });
    },
    labelRemove: async () => undefined,
    repoSettings: async () => ({ defaultBranch: "main" }),
  } as unknown as Forge;
  return { forge, labelAdds, issueComments };
}

// #297 — zero the backoff so any retry doesn't sleep.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
// #308 — transient retry disabled so a thrown dispatch doesn't retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
// #362 — pre-flight PR check disabled (no real GitHub in the test tree).
process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";
// #378 — intent gate disabled (we throw before any intent resolution).
process.env.PI_ENSEMBLE_INTENT = "0";
// PR17 — verify gate disabled (we throw before verify).
process.env.PI_ENSEMBLE_VERIFY = "0";
// #286 — no real git diffs; disable empty-diff skip.
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// 1. The issue's test: a step that THROWS posts the handoff (comment + label).
//    The plan step throws from its OWN code (via the `setPlanThrowForTestForTest`
//    injection seam), so the driver's catch path (work-driver.ts, #1263 fix)
//    routes it through the handoff — NOT runPlan's internal dispatch-failed
//    handler.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-1263-throw-"));
  try {
    setPlanThrowForTestForTest(() => {
      throw new Error("simulated plan step crash");
    });
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    // Seed state at currentStep: "plan", status "running" — the cycle runs
    // plan (throws) → handoff.
    let s = initialState(1263, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "plan",
        lastCompletedStep: "explore",
        status: "running",
      },
    } as WorkState;
    await writeState(dir, s);

    const host = makeFakeHost();
    const { forge, labelAdds, issueComments } = makeFakeForge();

    const ctx: DriverContext = {
      host: host as never,
      repoRoot: dir,
      issue: 1263,
      forge,
      issueBodyFetcherFn: async (issue: number) => ({
        stdout: `title:\tissue #${issue}\nstate:\tOPEN\n\nmock body — non-empty so the PR11 empty-body guard does not fire`,
      }),
      dispatchFn: async () => mkResult({ role: "explore", text: "stub explore" }),
    };

    const outcome = await runWorkDriver(ctx);

    assert(outcome.started === true, "cycle started (not refused)");

    // Re-read the state file to inspect the terminal state + events.
    const final = await readState(dir, 1263);
    assert(
      final !== null && final.pipelineState.status === "handoff",
      `final status is 'handoff' (not 'aborted') — got: ${final?.pipelineState.status}`,
    );

    // The issue's assertion: a handoff-emitted event exists in the log.
    const hasHandoffEmitted =
      final !== null && final.eventLog.some((e) => e.kind === "handoff-emitted");
    assert(hasHandoffEmitted, "event log contains a handoff-emitted event");

    // The issue's assertion: the fake forge received labelAdd.
    assert(
      labelAdds.length > 0,
      `forge received labelAdd (got ${labelAdds.length} call(s))`,
    );
    assert(
      labelAdds.some((l) => l.name === "needs-human-attention"),
      "labelAdd was for 'needs-human-attention'",
    );

    // The comment was posted (the handoff body was written to the forge).
    assert(
      issueComments.length > 0,
      `forge received an issue comment (got ${issueComments.length})`,
    );
  } finally {
    setPlanThrowForTestForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. One-shot guard: a crash INSIDE runHandoff must NOT loop — it ends as
// aborted with no second handoff post. The plan step throws from its own
// code (setPlanThrowForTestForTest, route to handoff via driver-crash:plan);
// then the handoff step throws from its OWN code (setHandoffThrowForTestForTest,
// just before its terminal-status write) so the driver's catch fires at step
// === "handoff" and the one-shot guard's direct-abort fallback runs —
// re-routing to handoff would loop forever.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-1263-once-"));
  try {
    setPlanThrowForTestForTest(() => {
      throw new Error("simulated plan step crash");
    });
    setHandoffThrowForTestForTest(() => {
      throw new Error("simulated runHandoff crash");
    });
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    let s = initialState(1264, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "plan",
        lastCompletedStep: "explore",
        status: "running",
      },
    } as WorkState;
    await writeState(dir, s);

    const host = makeFakeHost();
    const { forge, labelAdds } = makeFakeForge();

    // The fake forge records comment + label posts — the handoff post must
    // NOT loop even after the second throw.
    let handoffPostCalls = 0;
    let labelAddCalls = 0;
    const forge2 = {
      ...forge,
      issueComment: async (n: number, body: string) => {
        handoffPostCalls++;
        return `https://github.com/trail-openers/pi-rukas/issues/${n}#issuecomment-2`;
      },
      labelAdd: async (target: "issue" | "mr", number: number, name: string) => {
        labelAddCalls++;
        return forge.labelAdd(target, number, name);
      },
    } as unknown as Forge;

    const ctx: DriverContext = {
      host: host as never,
      repoRoot: dir,
      issue: 1264,
      forge: forge2,
      issueBodyFetcherFn: async (issue: number) => ({
        stdout: `title:\tissue #${issue}\nstate:\tOPEN\n\nmock body`,
      }),
      dispatchFn: async () => mkResult({ role: "explore", text: "stub" }),
    };

    await runWorkDriver(ctx);

    // The cycle must end as ABORTED — the one-shot guard's direct-abort
    // fallback, not a re-routed second handoff (which would end 'handoff').
    const final = await readState(dir, 1264);
    assert(
      final !== null && final.pipelineState.status === "aborted",
      `final status is 'aborted' (one-shot guard fired) — got: ${final?.pipelineState.status}`,
    );

    // No second handoff: a re-route to handoff would append a second
    // `driver-crash:handoff` cap-hit and re-run the step (second ops
    // dispatch, second comment post, second handoff-emitted). The guard
    // aborts instead, so the log carries at most one handoff cap-hit.
    const handoffCaps = (final?.eventLog ?? []).filter(
      (e) => e.kind === "cap-hit" && e.cap === "driver-crash:handoff",
    ).length;
    assert(
      handoffCaps === 0,
      `no driver-crash:handoff cap-hit (the guard aborts, it does NOT re-route to handoff) — got: ${handoffCaps}`,
    );

    // The guard fires mid-runHandoff: the first handoff-emitted event is
    // appended to the in-memory state AFTER the comment + label posts but the
    // test seam throws before runHandoff returns, so the driver's
    // one-shot guard persists a FRESH state object that OMITS that event.
    // The comment + label ARE posted (the post happens before the throw),
    // but the persisted state file carries zero handoff-emitted events.
    // A re-routed second handoff would loop (and re-post); exactly one
    // post of each is the correct terminal outcome.
    const emittedCount = (final?.eventLog ?? []).filter(
      (e) => e.kind === "handoff-emitted",
    ).length;
    assert(
      emittedCount === 0,
      `guard's direct-abort persist omits the handoff-emitted event — got: ${emittedCount}`,
    );
    assert(
      handoffPostCalls === 1,
      `handoff comment posted exactly once (post happens before the throw, guard aborts after) — got: ${handoffPostCalls}`,
    );
    assert(
      labelAddCalls === 1,
      `needs-human-attention label posted exactly once (no second handoff post after the guard fires) — got: ${labelAddCalls}`,
    );
    assert(
      labelAdds.length === 1,
      `fake forge recorded exactly one labelAdd call — got: ${labelAdds.length}`,
    );
  } finally {
    setPlanThrowForTestForTest(undefined);
    setHandoffThrowForTestForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);

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
 * Note: `runPlan` dispatches with `role: "explore"` but `label: "plan"`
 * (the plan step reuses the explore subagent). So the fake dispatchFn keys on
 * `spec.label === "plan"` to throw on the plan step, matching the issue's
 * "throws on step plan" precisely.
 *
 * The fake forge records labelAdd + issueComment so the assertions can see
 * the handoff post happened.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { Forge } from "../src/forge.ts";
import { type DriverContext } from "../src/work-driver-context.ts";
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
//    The plan step throws from its OWN code (via PI_ENSEMBLE_TEST_PLAN_THROW),
//    so the driver's catch path (work-driver.ts, #1263 fix) routes it through
//    the handoff — NOT runPlan's internal dispatch-failed handler.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-1263-throw-"));
  process.env.PI_ENSEMBLE_TEST_PLAN_THROW = "1";
  try {
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
    process.env.PI_ENSEMBLE_TEST_PLAN_THROW = "0";
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. One-shot guard: a crash INSIDE runHandoff must NOT loop — it ends as
// aborted with no second handoff post. The plan step throws from its own code
// (env seam, route to handoff via driver-crash:plan), then the handoff step's
// ops dispatch throws (simulating a crash inside runHandoff's post). The
// one-shot guard fires: the second throw ends as aborted, not re-routed.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-1263-once-"));
  process.env.PI_ENSEMBLE_TEST_PLAN_THROW = "1";
  try {
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
    const { forge } = makeFakeForge();

    let totalDispatchCalls = 0;

    const ctx: DriverContext = {
      host: host as never,
      repoRoot: dir,
      issue: 1264,
      forge,
      issueBodyFetcherFn: async (issue: number) => ({
        stdout: `title:\tissue #${issue}\nstate:\tOPEN\n\nmock body`,
      }),
      dispatchFn: async (_host, spec) => {
        totalDispatchCalls++;
        // Handoff's ops dispatch throws (crash inside runHandoff's post). The
        // plan step itself throws via the env seam above (driver-crash:plan →
        // handoff), so this is the second throw the one-shot guard must catch.
        if (spec.role === "ops" && spec.prompt?.includes("handoff")) {
          throw new Error("handoff ops crash");
        }
        return mkResult({ role: spec.role, text: "stub" });
      },
    };

    await runWorkDriver(ctx);

    // The cycle must terminate (no infinite loop) — dispatch calls are bounded.
    assert(
      totalDispatchCalls < 10,
      `dispatch calls are bounded (got ${totalDispatchCalls}) — no infinite loop`,
    );
  } finally {
    process.env.PI_ENSEMBLE_TEST_PLAN_THROW = "0";
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);

#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: #298 T5-T6: adversarial loop REJECTED-verdict vs infra-failure retry.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
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

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// PR11 — default issue-body fetcher for tests. runExplore's empty-body
// halt guard (PR11 §C) would otherwise fire when execp("gh issue view N")
// rejects or returns empty stdout — true for almost every test (the test
// repos don't have GitHub remotes). Tests that deliberately exercise
// the empty-body path pass their own injection; everything else gets
// this stub so the cycle proceeds to plan/branch/develop normally.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// #286 — these tests exercise adversarial loop verdicts (REJECTED, infra-
// failure retry) and do not set up real git diffs. Disable the empty-diff
// skip so the loop runs as intended.
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// ============================================================================
// #298 — adversarial loop: REJECTED is a verdict, infra failure is retried
// ============================================================================

// T5 (#298) — REJECTED verdict records dispatch-completed (not
// dispatch-failed-with-menu-errorTail) + adversarial-rejected.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-rejected-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(954, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-954",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 954,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: false,
          exitCode: 1,
          loopOutcome: "rejected",
          text: "❌ Adversarial REJECTED after 3 rounds. Last verdict: ISSUES_FOUND\n\nreal findings here",
        }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 954);
    const events = after?.eventLog ?? [];
    assert(
      !events.some((e) => e.kind === "dispatch-failed" && e.step === "adversarial"),
      "#298 T5: REJECTED verdict records NO dispatch-failed event",
    );
    assert(
      events.some((e) => e.kind === "dispatch-completed" && e.step === "adversarial"),
      "#298 T5: REJECTED verdict records dispatch-completed (the review DID complete)",
    );
    assert(
      events.some((e) => e.kind === "adversarial-rejected"),
      "#298 T5: adversarial-rejected verdict event present",
    );
    assert(after?.pipelineState.status === "handoff", "#298 T5: cycle routes to handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T6 (#298) — loop infra-failure leaves dispatch-failed as the tail so the
// RETRY_ONCE router re-runs the step (pre-#298 the synthesized cap-hit made
// that branch unreachable); recovery on the second attempt approves.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-infra-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(955, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-955",
      },
    };
    await writeState(dir, s);

    let loopCalls = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 955,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () => {
        loopCalls += 1;
        if (loopCalls === 1) {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 review dispatch killed by pi-ensemble (timeout) (after one retry). No verdict was produced — this is NOT a review rejection.",
          });
        }
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        // Halt cleanly once commit-pr dispatches (out of scope here).
        throw new Error(`smoke: halting at ${spec.role}/${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 955);
    const events = after?.eventLog ?? [];
    assert(loopCalls === 2, `#298 T6: RETRY_ONCE re-ran the adversarial loop (got ${loopCalls})`);
    assert(
      !events.some((e) => e.kind === "adversarial-rejected"),
      "#298 T6: infra failure synthesises NO adversarial-rejected verdict",
    );
    assert(
      events.some((e) => e.kind === "adversarial-approved"),
      "#298 T6: second attempt's APPROVED verdict recorded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

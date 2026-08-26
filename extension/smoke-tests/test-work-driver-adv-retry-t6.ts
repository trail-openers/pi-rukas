#!/usr/bin/env bun
/**
 * #298 T6 — adversarial loop infra-failure leaves dispatch-failed as the
 * tail so the RETRY_ONCE router re-runs the step (pre-#298 the synthesized
 * cap-hit made that branch unreachable); recovery on the second attempt
 * approves. Split from test-work-driver-adversarial-retry.ts (AGENTS.md
 * §12 file-size limit).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function makeFakePi(): ExtensionAPI {
  // biome-ignore lint/suspicious/noExplicitAny: stub; only sendUserMessage is called
  return { sendUserMessage: () => {} } as any;
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});

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

// Offline suite: fully stubbed driver — no real spawn can start.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-infra-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
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
      pi: makeFakePi(),
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
      // Halt cleanly once commit-pr dispatches (out of scope here).
      dispatchFn: async (_pi, spec, opts) =>
        Promise.reject(new Error(`smoke: halting at ${spec.role}/${opts?.label}`)),
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

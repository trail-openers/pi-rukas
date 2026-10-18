#!/usr/bin/env bun
/**
 * Smoke test: a step retry says what it discards, and a retried developer is
 * told its predecessor's work is still in the worktree.
 *
 * The router's transient retry dispatches a brand-new child. Before this test
 * existed the retry line carried only the cause, and the second developer got
 * a prompt byte-identical to the first one's — in a worktree that still held
 * the first one's edits.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LifecycleDetails, attach, detach } from "../src/lifecycle-events.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { FAILURE_REASON_CHARS, failureCauseReason } from "../src/work-driver-failure-taxonomy.ts";
import {
  interruptedDevelopNote,
  interruptedLensFixNote,
  lostAttemptLine,
  lostAttemptOnStep,
} from "../src/work-driver-retry-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { retryTreeLine } from "../src/work-retry-tree-clean.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
// #1243 — the provider-class floor is minutes by default; zero it so the retry
// legs of this test do not sleep.
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

const severed = {
  kind: "dispatch-failed-provider" as const,
  step: "explore" as const,
  role: "explore",
  jobId: "j1",
  label: "explore",
  ms: 909_265,
  at: 1,
  providerMessage: "terminated",
  usage: { input: 400_000, output: 12_000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 45 },
};

// 1. The line names step, attempt, elapsed, turns and tokens.
{
  const line = lostAttemptLine("explore", 1, severed);
  assert(
    line ===
      "explore attempt 1 lost: 15m09s, 45 turns, 412k tokens — the step restarts from the beginning",
    `explore loss line is complete (got: ${line})`,
  );
  const dev = lostAttemptLine("develop", 2, { ...severed, step: "develop", role: "developer" });
  assert(
    dev.startsWith("develop attempt 2 lost: 15m09s") && dev.includes("worktree are kept"),
    "develop loss line says the worktree survives",
  );
  const { usage: _u, ...bare } = severed;
  assert(
    lostAttemptLine("explore", 1, bare) ===
      "explore attempt 1 lost: 15m09s — the step restarts from the beginning",
    "an event without usage reports elapsed only, never a synthesised 0",
  );
}

// 1b. #1243 — the reason beside that line is not cut. The three tehas cycles all
//     printed `subagent failed: Adversarial loop infrastructure failure: round 2
//     review disp` — 60 characters of our own composite text, so the cost that
//     followed was invisible and the number that survived read like a constant.
{
  const longMessage = `Adversarial loop infrastructure failure: round 2 review dispatch provider/transport error: Request timed out. ${"chain ".repeat(60)}`;
  const line = failureCauseReason({
    kind: "dispatch-failed-provider",
    providerMessage: longMessage,
  });
  assert(
    line.includes("round 2 review dispatch") && line.includes("Request timed out."),
    `the whole reason survives, not its first clause (got: ${line.slice(0, 120)}…)`,
  );
  assert(
    line.length <= longMessage.length && line.length > 60 + 40,
    `the reason keeps ${FAILURE_REASON_CHARS} chars rather than 60 (got ${line.length})`,
  );
  // The lost cost is the attempt's own, not a constant: two attempts with
  // different durations read differently, which is the half of the incident the
  // identical "3m54s" in all three cycles made look like a fixed string.
  const slow = lostAttemptLine("explore", 1, { ...severed, ms: 234_000, usage: undefined });
  const fast = lostAttemptLine("explore", 1, { ...severed, ms: 12_000, usage: undefined });
  assert(
    slow.includes("3m54s") && fast.includes("12") && slow !== fast,
    `each attempt reports its own elapsed (got ${slow} / ${fast})`,
  );
}

// 2. The developer note exists only on a transient retry, and never quotes
//    the provider's message.
{
  const base = initialState(960, 1_000_000);
  assert(interruptedDevelopNote(base) === undefined, "first attempt carries no note");
  const failed = { ...severed, step: "develop" as const, role: "developer" };
  const retried = {
    ...base,
    eventLog: [...base.eventLog, failed],
    pipelineState: { ...base.pipelineState, transientRetryAttempts: { develop: 1 } },
  };
  const note = interruptedDevelopNote(retried) ?? "";
  assert(note.includes("cause: provider-severed"), "note names the classified cause");
  assert(note.includes("15m09s, 45 turns"), "note says how far the lost attempt got");
  assert(note.includes("git status --short"), "note sends the developer to the worktree first");
  assert(!note.includes("terminated"), "the provider's own message stays out of the prompt");
}

// 2b. #1391 — the retry line carries what the clean did, a retried fixer is told
//     where the saved work is, and attribution reads BOTH retry budgets.
{
  const tree = retryTreeLine({
    kind: "cleaned",
    tree: "/r/.worktrees/w",
    files: ["DESIGN.md"],
    ref: "refs/pi-rukas/retry-preserved/issue-1/lens-fix-1",
    patch: "/r/tmp/issue-1/retry-lens-fix-1.patch",
  });
  const line = lostAttemptLine("lens-fix", 1, { ...severed, step: "lens-fix" }, tree);
  assert(
    line.includes("refs/pi-rukas/retry-preserved/issue-1/lens-fix-1") &&
      line.includes("retry-lens-fix-1.patch") &&
      line.includes('"DESIGN.md"'),
    "the retry line names the files, the saved ref and the patch",
  );
  assert(
    retryTreeLine({ kind: "none" }) === undefined,
    "a clean tree adds nothing to the retry line, so it never claims a save",
  );
  const base = initialState(1391, 1);
  assert(interruptedLensFixNote(base) === undefined, "a normal lens-fix round carries no note");
  const retried = {
    ...base,
    eventLog: [
      ...base.eventLog,
      { ...severed, step: "lens-fix" as const, role: "developer" },
      {
        kind: "retry-tree-clean" as const,
        at: 3,
        step: "lens-fix" as const,
        attempt: 1,
        outcome: "cleaned" as const,
        worktree: "/r/.worktrees/w",
        files: ["DESIGN.md"],
        fileCount: 1,
        ref: "refs/pi-rukas/retry-preserved/issue-1391/lens-fix-1",
        patch: "/r/tmp/issue-1391/retry-lens-fix-1.patch",
      },
    ],
    pipelineState: { ...base.pipelineState, transientRetryAttempts: { "lens-fix": 1 } },
  };
  const note = interruptedLensFixNote(retried) ?? "";
  assert(
    note.includes("git apply /r/tmp/issue-1391/retry-lens-fix-1.patch"),
    "a retried fixer is told how to restore the saved work",
  );
  assert(lostAttemptOnStep(retried, "lens-fix"), "a transient retry attributes the dirt");
  assert(
    lostAttemptOnStep(
      { ...base, pipelineState: { ...base.pipelineState, retryAttempts: { "lens-fix": 1 } } },
      "lens-fix",
    ),
    "a RETRY_ONCE retry attributes the dirt too",
  );
  assert(!lostAttemptOnStep(retried, "develop"), "attribution is scoped to the step");
}

// 3. End to end: a developer severed once is re-dispatched with the note, and
//    the scrollback retry line carries the loss.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-retry-lost-"));
  const entries: LifecycleDetails[] = [];
  const pi = {
    sendUserMessage: () => {},
    appendEntry: (_t: string, data?: unknown) => {
      entries.push(data as LifecycleDetails);
    },
    registerEntryRenderer: () => {},
  } as unknown as ExtensionAPI;
  attach(pi);
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const wtDir = path.join(dir, ".worktrees", "issue-960-default");
    await fs.mkdir(wtDir, { recursive: true });
    let s = initialState(960, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
      },
    };
    await writeState(dir, s);

    const mk = (o: Partial<DispatchResult>): DispatchResult => ({
      role: "developer",
      ok: true,
      text: "stub",
      toolUses: [],
      ms: 100,
      exitCode: 0,
      transcriptPath: "/tmp/stub-transcript.json",
      ...o,
    });
    const devPrompts: string[] = [];
    const ctx: DriverContext = {
      host: pi,
      repoRoot: dir,
      issue: 960,
      issueBodyFetcherFn: async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nmock body" }),
      // The retry re-enters develop, which first reads the worktree for work to
      // save; the tmp dir is not a git repo, so answer "nothing uncommitted".
      verifyExecFn: async () => ({ stdout: "" }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mk({ role: "ops", text: "Posted." });
        if (spec.role === "ops") {
          return mk({
            role: "ops",
            text: `branch: feature/issue-960-retry-test\n\n## Worktrees\n- default: ${wtDir}`,
          });
        }
        if (spec.role === "developer") {
          devPrompts.push(spec.prompt);
          if (devPrompts.length === 1) {
            return mk({
              ok: false,
              text: "",
              ms: 990_000,
              errorStop: { reason: "error", message: "terminated" },
              usage: { input: 9000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 7 },
            });
          }
          throw new Error("smoke: halting at the retried developer");
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    assert(devPrompts.length === 2, `developer re-dispatched once (got ${devPrompts.length})`);
    const [first = "", second = ""] = devPrompts;
    assert(
      !first.includes("was interrupted"),
      "first developer prompt carries no interruption note",
    );
    assert(
      second.includes("A previous attempt at this step was interrupted") &&
        second.includes("cause: provider-severed") &&
        second.includes("16m30s, 7 turns, 10k tokens"),
      "retried developer is told the previous attempt was cut and what it had spent",
    );
    assert(
      second.replace(/## A previous attempt[\s\S]*?\n\n[^\n]*\n\n/, "") === first,
      "the note is the only difference between the two prompts",
    );
    const retry = entries.find((e) => e.kind === "step-retry" && e.label === "develop");
    assert(
      (retry?.reason ?? "").includes("develop attempt 1 lost: 16m30s, 7 turns, 10k tokens"),
      `scrollback retry line says what was lost (got: ${retry?.reason})`,
    );
  } finally {
    detach();
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);

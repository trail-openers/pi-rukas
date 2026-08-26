#!/usr/bin/env bun
/**
 * #534 — usage on dispatch events: round-trips through the state file
 * (writeState/readState), and `buildCompletionEvent` threads it into every
 * dispatch outcome event. Split from test-work-driver-schema.ts
 * (AGENTS.md §12 file-size limit — the usage assertions grew the schema
 * test past the 500-line gate).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCompletionEvent } from "../src/work-driver-merged.ts";
import {
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

// #534 — usage on dispatch events round-trips; absent stays absent.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-usage-"));
  try {
    const issue = 548;
    let state = initialState(issue, 1000);
    const usage = { input: 100, output: 20, cacheRead: 400, cacheWrite: 10, cost: 0.123, turns: 3 };
    state = appendEvent(state, {
      kind: "dispatch-completed",
      step: "explore",
      role: "explore",
      jobId: "job-usage-rt",
      label: "explore",
      ok: true,
      ms: 1234,
      at: 1600,
      summary: "ok",
      usage,
    });
    state = appendEvent(state, {
      kind: "dispatch-failed",
      step: "develop",
      role: "developer",
      jobId: "job-usage-fail",
      label: "developer:ws-1",
      ms: 5678,
      at: 1700,
      errorTail: "exit 1",
      usage: { ...usage, input: 50, cost: 0.05 },
    });
    state = appendEvent(state, {
      kind: "dispatch-failed-provider",
      step: "adversarial",
      role: "adversarial-developer",
      jobId: "job-usage-prov",
      label: "adversarial",
      ms: 9000,
      at: 1800,
      providerMessage: "timeout",
      usage: { ...usage, output: 0 },
    });
    state = appendEvent(state, {
      kind: "dispatch-failed",
      step: "branch",
      role: "ops",
      jobId: "job-no-usage",
      label: "ops:branch",
      ms: 100,
      at: 1900,
      errorTail: "git pull --ff-only failed",
    });
    await writeState(dir, state);
    const withUsageEv = await readState(dir, issue);
    const completedEv = withUsageEv?.eventLog.find(
      (e) => e.kind === "dispatch-completed" && e.jobId === "job-usage-rt",
    );
    assert(
      completedEv?.kind === "dispatch-completed" &&
        completedEv.usage?.input === 100 &&
        completedEv.usage.output === 20 &&
        completedEv.usage.cacheRead === 400 &&
        completedEv.usage.cacheWrite === 10 &&
        completedEv.usage.cost === 0.123 &&
        completedEv.usage.turns === 3,
      "dispatch-completed usage round-trips through writeState/readState",
    );
    const failedEv = withUsageEv?.eventLog.find(
      (e) => e.kind === "dispatch-failed" && e.jobId === "job-usage-fail",
    );
    assert(
      failedEv?.kind === "dispatch-failed" && failedEv.usage?.input === 50,
      "dispatch-failed usage round-trips",
    );
    const providerEv = withUsageEv?.eventLog.find(
      (e) => e.kind === "dispatch-failed-provider" && e.jobId === "job-usage-prov",
    );
    assert(
      providerEv?.kind === "dispatch-failed-provider" && providerEv.usage?.output === 0,
      "dispatch-failed-provider usage round-trips",
    );
    const noUsageEv = withUsageEv?.eventLog.find(
      (e) => e.kind === "dispatch-failed" && e.jobId === "job-no-usage",
    );
    assert(
      noUsageEv?.kind === "dispatch-failed" && noUsageEv.usage === undefined,
      "absent usage stays absent (no zero synthesis) on round-trip",
    );

    // Schema-version mismatch must reject loudly (moved here with the
    // event-log fixture it inspects).
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

// #534 — buildCompletionEvent threads flushed usage into the outcome events.
{
  const ctx = { repoRoot: "/tmp/usage", issue: 548 } as unknown as Parameters<
    typeof buildCompletionEvent
  >[0];
  const base = {
    role: "developer" as const,
    text: "done",
    toolUses: [],
    ms: 100,
    exitCode: 0,
  };
  const usage = { input: 40, output: 250, cacheRead: 0, cacheWrite: 0, cost: 1.23, turns: 4 };

  const ok = await buildCompletionEvent(ctx, "develop", "developer", "dev", {
    ...base,
    ok: true,
    usage,
  });
  assert(
    ok.kind === "dispatch-completed" && ok.usage?.output === 250,
    "success WITH usage → dispatch-completed carries flushed spend",
  );

  const fail = await buildCompletionEvent(ctx, "develop", "developer", "dev", {
    ...base,
    ok: false,
    exitCode: 1,
    usage,
  });
  assert(
    fail.kind === "dispatch-failed" && fail.usage?.output === 250,
    "process failure WITH usage → dispatch-failed carries flushed spend",
  );

  const prov = await buildCompletionEvent(ctx, "adversarial", "adversarial-developer", "adv", {
    ...base,
    errorStop: { reason: "error", message: "terminated" },
    usage,
  });
  assert(
    prov.kind === "dispatch-failed-provider" && prov.usage?.cost === 1.23,
    "errorStop WITH usage → dispatch-failed-provider carries it",
  );

  const killed = await buildCompletionEvent(ctx, "ci", "ops", "ops:ci", {
    ...base,
    killCause: "timeout",
    killBudgetMs: 600_000,
    usage,
  });
  assert(
    killed.kind === "dispatch-failed" && killed.usage?.turns === 4,
    "killCause WITH usage → dispatch-failed carries flushed usage",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

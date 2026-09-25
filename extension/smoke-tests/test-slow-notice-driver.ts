#!/usr/bin/env bun
/**
 * #799 — the driver path of the slow-run watch: the dispatch-slow event
 * recorded by the per-step `onSlow` recorder (slowRecorder) landing in the
 * driver's pending buffer, keyed by the cycle's primary issue, and drained
 * into the cycle's event log at the step boundary.
 *
 * Split from test-slow-notice.ts (§12 file-size limit). Drives the REAL
 * driver steps (runSingleDispatch / runPlan / the adversarial fan-out) with
 * fake dispatch/loop functions whose children cross the threshold via onSlow.
 * The fan-out test uses a hermetic temp git fixture: the old shape resolved
 * baseSha from the REAL repo's origin/main / main / HEAD~3, which may not
 * exist in a shallow CI checkout (fetch-depth 1) — empty diff → the child
 * is skipped → onSlow never fires → the test fails for the wrong reason.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runSingleDispatch } from "../src/work-driver-merged.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function fakePi(notices: string[]) {
  return { sendUserMessage: (text: string, _opts?: { deliverAs?: string }) => notices.push(text) };
}

// ------------------------------------------- 1. runSingleDispatch + onSlow
await withEnv({ PI_ENSEMBLE_SLOW_NOTICE_TURNS: "2" }, async () => {
  const { REPO } = await import("./slow-notice-fixtures.ts");
  const state = initialState(799, 1_000_000);
  const fakeDispatch: NonNullable<DriverContext["dispatchFn"]> = async (_pi, _spec, opts) => {
    // The fake dispatch crosses the threshold directly via onSlow (the watch
    // is keyed by the job id startJob mints, which the driver does not see
    // until beginDispatch — the recorder's buffer is what carries the event).
    const onSlow = opts?.onSlow;
    assert(typeof onSlow === "function", "runSingleDispatch threads onSlow");
    onSlow?.({
      step: "branch",
      role: "ops",
      jobId: "fake-job",
      label: "ops:branch",
      elapsedMs: 12_000,
      turns: 3,
      tokens: 1234,
      at: Date.now(),
    });
    return { role: "ops", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0, transcriptPath: "/tmp/x" };
  };
  const ctx: DriverContext = {
    pi: fakePi([]),
    issue: 799,
    issues: [799],
    repoRoot: REPO,
    dispatchFn: fakeDispatch,
  } as unknown as DriverContext;
  const out = await runSingleDispatch(ctx, state, "branch", "ops", "ops:branch", Date.now(), () => "prompt");
  // #799 — the slow recorder no longer folds into a per-step state ref: the
  // crossing is collected in the driver's pending buffer (keyed by the
  // cycle's primary issue, 799 here) and drained at the step boundary
  // (routeStepOutcome, the single persistence point). Drain it here exactly
  // as the driver does, then check the union is exactly one.
  const { drainSlowEvents } = await import("../src/slow-notice.ts");
  const drained = drainSlowEvents(799);
  const slowEvents = [...out.eventLog, ...drained].filter((e) => e.kind === "dispatch-slow");
  assert(slowEvents.length === 1, "driver dispatch crossing → one dispatch-slow in the log (buffer drain)");
  const ev = slowEvents[0];
  if (ev && ev.kind === "dispatch-slow") {
    assert(ev.step === "branch", "dispatch-slow carries the step");
    assert(ev.turns === 3 && ev.tokens === 1234, "dispatch-slow carries turns + tokens");
    assert(ev.jobId === "fake-job", "dispatch-slow carries the job id");
  }
  // The completion event lands in the step's own returned state (the buffer
  // drain at the step boundary lands the slow event in the PERSISTED log).
  const last = out.eventLog[out.eventLog.length - 1];
  assert(last?.kind === "dispatch-completed", "completion event is the tail of the step's own state");
});

// ------------------------------------ 2. runSingleDispatch has no heartbeat loop
{
  const src = readFileSync(path.join(import.meta.dir, "../src/work-driver-merged.ts"), "utf8");
  // #799 — the periodic heartbeat is gone: no setInterval in the dispatch
  // path (a comment mentioning it is fine; a live loop is not).
  assert(!/setInterval\(/.test(src), "work-driver-merged.ts: no heartbeat loop remains");
  const slowSrc = readFileSync(path.join(import.meta.dir, "../src/slow-notice.ts"), "utf8");
  assert(/watchSlowDispatch/.test(slowSrc), "slow-notice.ts: the watch module exists");
}

// ---------------------------------------------------------------- 3. runPlan slow event
{
  process.env.PI_ENSEMBLE_RESUME = "0";
  process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
  const { runPlan } = await import("../src/work-driver-plan.ts");
  const { clearSlowEventsForTesting, drainSlowEvents } = await import("../src/slow-notice.ts");
  clearSlowEventsForTesting();
  const fakeDispatch: any = async (_pi: unknown, _spec: unknown, opts: any) => {
    opts?.onSlow?.({
      step: "plan",
      role: "explore",
      jobId: "x",
      label: "plan",
      elapsedMs: 1,
      turns: 151,
      tokens: 3,
      at: Date.now(),
    });
    return { role: "explore", ok: true, text: "done", toolUses: [], ms: 5, exitCode: 0 };
  };
  const ctx: any = {
    pi: { sendUserMessage: () => {} },
    issue: 799,
    issues: [799],
    repoRoot: "/tmp",
    dispatchFn: fakeDispatch,
  };
  const out = await runPlan(ctx, initialState(799, 1_000_000));
  // #799 — the plan-time crossing is collected in the pending buffer (the
  // old shape folded into a throwaway ref that was never folded back, so it
  // was lost); the driver drains it at the step boundary.
  const drained = drainSlowEvents(799);
  const slowEvents = [...out.eventLog, ...drained].filter((e) => e.kind === "dispatch-slow");
  assert(
    slowEvents.length === 1 &&
      slowEvents[0]?.kind === "dispatch-slow" &&
      slowEvents[0]?.step === "plan",
    "runPlan: the dispatch-slow recorded during the plan step lands exactly once (pending buffer drain)",
  );
  assert(out.eventLog.length >= 1, "runPlan: the step completed (its own state still carries its own events)");
}

// ------------------------------------ 4. adversarial fan-out slow event
{
  // #799 — the fan-out's slow recorder: the old shape wrote into a
  // `fanoutStateRef` the fan-out never read back (the crossings were lost).
  // The recorder now collects into the driver's pending buffer, which the
  // step boundary drains. Drive the REAL `fanOutAdversarial` with a fake
  // loop fn whose child crosses the threshold (onSlow fires). The child
  // must actually run (not be skipped by the empty-diff short-circuit), so
  // the diff below is non-empty BY CONSTRUCTION: a hermetic temp git fixture
  // with commit A (base) and commit B (a file change), baseSha = A. No real
  // repo refs involved — works in a shallow CI checkout.
  process.env.PI_ENSEMBLE_RESUME = "0";
  process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
  const { fanOutAdversarial } = await import("../src/work-driver-adversarial-fanout.ts");
  const { clearSlowEventsForTesting, drainSlowEvents } = await import("../src/slow-notice.ts");
  clearSlowEventsForTesting();
  const fixture = mkdtempSync(path.join(os.tmpdir(), "pi-ens-799fan-"));
  const git = (args: string) =>
    execSync(`git -C ${JSON.stringify(fixture)} ${args}`, {
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init -q");
  writeFileSync(path.join(fixture, "a.txt"), "v1\n");
  git("add a.txt");
  git("commit -qm 'commit A'");
  const shaA = git("rev-parse HEAD").toString().trim();
  writeFileSync(path.join(fixture, "a.txt"), "v2 changed\n");
  git("commit -qam 'commit B'");
  const state = initialState(799, 1_000_000);
  state.pipelineState.worktrees = { default: fixture };
  state.pipelineState.baseSha = shaA;
  // #799 — the fake loop is injected through DriverContext, which is NOT part
  // of the type below (the cast is load-bearing: the type has no such field).
  const fakeLoop: NonNullable<DriverContext["adversarialLoopFn"]> = async (_params) => {
    _params.onSlow?.({
      step: "adversarial",
      role: "adversarial-developer",
      jobId: "fanout-fake",
      label: "adversarial_loop",
      elapsedMs: 12_000,
      turns: 3,
      tokens: 1234,
      at: Date.now(),
    });
    return { role: "adversarial-loop", ok: true, text: "VERDICT: APPROVED\n\nNo issues.", toolUses: [], ms: 1, exitCode: 0 };
  };
  const ctx: any = {
    pi: { sendUserMessage: () => {} },
    issue: 799,
    issues: [799],
    repoRoot: fixture,
    adversarialLoopFn: fakeLoop,
  };
  const { next } = await fanOutAdversarial(ctx, state, ["default"], new Map(), false, null);
  const drained = drainSlowEvents(799);
  const slowEvents = [...next.eventLog, ...drained].filter((e) => e.kind === "dispatch-slow");
  assert(
    slowEvents.length === 1 &&
      slowEvents[0]?.kind === "dispatch-slow" &&
      slowEvents[0]?.step === "adversarial",
    "adversarial fan-out: the dispatch-slow recorded during the fan-out lands exactly once (pending buffer drain)",
  );
  assert(
    !next.eventLog.some((e) => e.kind === "adversarial-skipped-empty-diff"),
    "adversarial fan-out: the child ran (the fixture diff is non-empty, no skip)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

// The same env-isolation helper the watch sections use (the driver sections
// need it too).
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) process.env[k] = undefined;
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) process.env[k] = undefined;
      else process.env[k] = v;
    }
  }
}

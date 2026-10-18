#!/usr/bin/env bun
/**
 * Smoke test (#1391): the step router's retries clean the lost attempt's tree
 * BEFORE re-dispatch, asserted on the git argv sequence through the executor
 * seam (`ctx.verifyExecFn`), against real git.
 *
 *  - HALT-class transient retry (develop, lens-fix): status → stage → verify
 *    the index → commit-tree → update-ref → patch diff → reset --hard → clean,
 *    in that order, and the retry proceeds with a `retry-tree-clean` event.
 *  - RETRY_ONCE retry (adversarial): the tree under review is the work, so the
 *    retry makes no mutating git call and the tree is byte-identical.
 *  - A failed save parks the cycle naming the failure; no reset or clean runs.
 *  - The status view and the handoff name the saved ref and patch.
 */
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { __setSleepFn, routeStepOutcome } from "../src/work-driver-step-router.ts";
import { fmtEvent } from "../src/work-status-events.ts";
import { type WorkState, type WorkStep, initialState } from "../src/workflow-state.ts";
import { gitIn } from "./lib/git-worktree-fixture.ts";
import { at, dirty, recorder, retryFixture } from "./lib/retry-tree-fixture.ts";

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
const restoreSleep = __setSleepFn(async () => {});
const dirs: string[] = [];

/** A cycle whose `step` child was just severed by the provider. */
function lostOn(step: WorkStep, wt: string, baseSha: string): WorkState {
  const s = initialState(1391, 1);
  return {
    ...s,
    eventLog: [
      ...s.eventLog,
      {
        kind: "dispatch-failed-provider",
        step,
        role: "developer",
        jobId: "j1",
        label: step,
        ms: 1_369_000,
        at: 2,
        providerMessage: "terminated",
      },
    ],
    pipelineState: {
      ...s.pipelineState,
      currentStep: step,
      baseSha,
      branchName: "feature/issue-1391-retry",
      worktrees: { default: wt },
    },
  };
}

const MUTATING = ["add", "rm", "write-tree", "commit-tree", "update-ref", "reset", "clean"];

async function route(step: WorkStep, failOn?: string, atBase = true) {
  const f = retryFixture(`seq-${step}`);
  dirs.push(f.dir);
  if (atBase) gitIn(f.wt, ["checkout", "-q", "--detach", f.baseSha]);
  dirty(f.wt);
  const { exec, calls } = recorder(failOn);
  const ctx = { repoRoot: f.repo, issue: 1391, verifyExecFn: exec } as unknown as DriverContext;
  const out = await routeStepOutcome(
    ctx,
    lostOn(step, f.wt, f.baseSha),
    step,
    { num: 7, total: 9 },
    2,
    Date.now(),
  );
  return { f, calls, out };
}

function inOrder(calls: string[][]): boolean {
  const seq = [
    at(calls, "status"),
    at(calls, "--literal-pathspecs", "add"),
    at(calls, "diff", "--cached", "--name-only"),
    at(calls, "write-tree"),
    at(calls, "commit-tree"),
    at(calls, "update-ref"),
    at(calls, "diff", "--binary", "--cached"),
    at(calls, "reset", "--hard"),
    at(calls, "clean", "-fd", "-e", "/.pi/", "-e", "/tmp/"),
  ];
  return seq.every((v, i) => v >= 0 && (i === 0 || v > (seq[i - 1] ?? -1)));
}

// 1. HALT-class transient retry: develop and lens-fix both save then clean, then retry.
for (const step of ["develop", "lens-fix"] as const) {
  const { f, calls, out } = await route(step, undefined, step === "develop");
  assert(out.retry, `${step}: the router retries`);
  assert(inOrder(calls), `${step}: save → ref → patch → reset → clean, before the retry`);
  const ev = out.state.eventLog.find((e) => e.kind === "retry-tree-clean");
  assert(
    ev?.kind === "retry-tree-clean" && ev.outcome === "cleaned" && !!ev.ref && !!ev.patch,
    `${step}: a retry-tree-clean event records the ref and the patch`,
  );
  assert(!out.state.eventLog.some((e) => e.kind === "cap-hit"), `${step}: the cycle does not park`);
  assert(
    gitIn(f.wt, ["status", "--porcelain"]).trim() === "?? .pi/\n?? tmp/",
    `${step}: only .pi/ and tmp/ remain`,
  );
  if (ev?.kind === "retry-tree-clean") {
    const line = fmtEvent(ev);
    assert(
      line.includes(ev.ref ?? "?") && line.includes(ev.patch ?? "?"),
      `${step}: /work-status names ref and patch`,
    );
    const md = renderHandoffMarkdown(out.state);
    assert(
      md.includes(ev.ref ?? "?") && md.includes(ev.patch ?? "?"),
      `${step}: the handoff names ref and patch`,
    );
  }
}

// 2. RETRY_ONCE retry (adversarial): retried, and the tree under review is never touched.
{
  const { f, calls, out } = await route("adversarial");
  assert(out.retry, "adversarial: the router retries");
  assert(
    !calls.some((c) => MUTATING.includes(c[0] ?? "") || MUTATING.includes(c[1] ?? "")),
    "adversarial: no mutating git call",
  );
  assert(
    readFileSync(path.join(f.wt, "a.txt"), "utf8") === "half-written\n",
    "adversarial: tree intact",
  );
}

// 3. A failed save parks, naming the failure; nothing destructive runs.
{
  const { f, calls, out } = await route("develop", "write-tree");
  const tail = out.state.eventLog[out.state.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit" &&
      tail.cap === "step-failed:develop" &&
      !!tail.evidence?.includes("could not be saved"),
    "fail: parks at step-failed:develop, naming the save failure",
  );
  assert(out.state.pipelineState.currentStep === "handoff", "fail: routed to handoff");
  assert(
    at(calls, "reset", "--hard") === -1 && at(calls, "clean") === -1,
    "fail: no reset, no clean",
  );
  assert(readFileSync(path.join(f.wt, "a.txt"), "utf8") === "half-written\n", "fail: work intact");
}

restoreSleep();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(exit);

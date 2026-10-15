#!/usr/bin/env bun
/**
 * #1292 — the draft-state rule, part 2 (split from test-draft-pr.ts for the
 * 500-line cap). Pinned here:
 *
 *  - a draft PR's ready command is the forge's real one (GitHub / GitLab);
 *  - `pr ready` attempts are bounded per mark point and per cycle;
 *  - a resumed headless cycle with no recorded draft fact reads isDraft live,
 *    and a cycle with drafts off never does;
 *  - the ops fallback records what the forge reports, once the number is known;
 *  - runStep's ci step marks the draft ready before any ci work.
 *
 * Offline: fake forge, no model. Real temp dir only where runCi persists state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import {
  MAX_READY_ATTEMPTS_PER_CYCLE,
  draftPrHandoffLines,
  markDraftPrReady,
  recordFallbackDraftFact,
} from "../src/work-driver-draft-pr.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runStep } from "../src/work-driver-run-step.ts";
import {
  type WorkEvent,
  type WorkState,
  appendEvent,
  initialState,
} from "../src/workflow-state.ts";

process.env.PI_ENSEMBLE_FORGE = "github";
delete process.env.PI_ENSEMBLE_DRAFT_PR;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 1292;
const BRANCH = "fix/issue-1292-x";
const PR = 7;
const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

/** A forge whose `prReady` fails the first `failures` calls. */
function mkForge(failures: number) {
  const ready: number[] = [];
  const forge = {
    forge: "github",
    prReady: async (n: number) => {
      ready.push(n);
      if (ready.length <= failures) throw new Error("GraphQL: Could not mark ready (simulated)");
    },
    prView: async () => ({ labels: [], state: "OPEN", headRefName: BRANCH }),
    prComments: async () => [],
    issueComments: async () => [],
    labelCreate: async () => undefined,
    labelAdd: async () => undefined,
  } as unknown as Forge;
  return { forge, ready };
}

const at = (n: number) => 1_000_000 + n;
function reviewState(events: WorkEvent[], prDraft?: WorkState["pipelineState"]["prDraft"]) {
  let s = initialState(ISSUE, at(0));
  s = { ...s, pipelineState: { ...s.pipelineState, prNumber: PR, branchName: BRANCH, prDraft } };
  return appendEvent(s, ...events);
}
const started = (step: "commit-pr" | "lens-review", n: number): WorkEvent => ({
  kind: "step-started",
  step,
  at: at(n),
});
const approved: WorkEvent = { kind: "lens-approved", at: at(3), jobId: "j", round: 1 };

const noSleep = async () => undefined;
const execStub = (async () => ({ stdout: "" })) as unknown as NonNullable<
  DriverContext["verifyExecFn"]
>;

{
  // The handoff names the real ready command for the cycle's forge.
  const ps = reviewState([started("commit-pr", 1)], { status: "draft" }).pipelineState;
  const gl = draftPrHandoffLines(ps, "gitlab").join("\n");
  assert(gl.includes("glab mr update 7 --ready"), "handoff on GitLab names glab mr update --ready");
  assert(!gl.includes("gh pr ready"), "…and never the GitHub command");
}

{
  // Bounded: 3 attempts per mark point, 6 per cycle, however often ci loops.
  const { forge, ready } = mkForge(99);
  const ctx = { host: fakePi, repoRoot: "/nonexistent", issue: ISSUE, forge } as DriverContext;
  let s = reviewState([started("commit-pr", 1)], { status: "draft" });
  for (let i = 0; i < 3; i++) s = await markDraftPrReady(ctx, s, noSleep);
  assert(
    ready.length === MAX_READY_ATTEMPTS_PER_CYCLE,
    `three mark points make at most ${MAX_READY_ATTEMPTS_PER_CYCLE} pr ready calls (made ${ready.length})`,
  );
  assert(
    s.pipelineState.prDraft?.status === "ready-failed" &&
      s.pipelineState.prDraft?.attempts === MAX_READY_ATTEMPTS_PER_CYCLE &&
      /attempts are spent/.test(s.pipelineState.prDraft?.error ?? ""),
    "…the spent budget is recorded with its reason",
  );
}

{
  // Crash safety: a resumed headless cycle with no draft fact reads isDraft live.
  const live = (isDraft: boolean) => {
    const calls: number[] = [];
    const readyCalls: number[] = [];
    const forge = {
      prView: async () => (calls.push(1), { isDraft, state: "OPEN", headRefName: BRANCH }),
      prReady: async (n: number) => void readyCalls.push(n),
    } as unknown as Forge;
    return { forge, calls, readyCalls };
  };
  const ctxWith = (forge: Forge, headless: boolean) =>
    ({ host: fakePi, repoRoot: "/nonexistent", issue: ISSUE, headless, forge }) as DriverContext;
  const noFact = reviewState([started("commit-pr", 1)]);
  const d = live(true);
  const marked = await markDraftPrReady(ctxWith(d.forge, true), noFact, noSleep);
  assert(
    d.readyCalls.length === 1 && marked.pipelineState.prDraft?.status === "ready",
    "a resumed headless cycle with no draft fact reads isDraft live and marks it ready",
  );
  const nd = live(false);
  const notDraft = await markDraftPrReady(ctxWith(nd.forge, true), noFact, noSleep);
  assert(
    nd.readyCalls.length === 0 && notDraft.pipelineState.prDraft === undefined,
    "a PR that is not a draft is left alone, with no fact recorded",
  );
  const off = live(true);
  await markDraftPrReady(ctxWith(off.forge, false), noFact, noSleep);
  assert(
    off.calls.length === 0 && off.readyCalls.length === 0,
    "a cycle with drafts off never reads or touches an absent draft fact",
  );
}

{
  // The ops fallback records what the forge reports, once the PR number is known.
  const ctxWith = (prView: () => Promise<unknown>) =>
    ({
      host: fakePi,
      repoRoot: "/nonexistent",
      issue: ISSUE,
      headless: true,
      forge: { prView } as unknown as Forge,
    }) as DriverContext;
  const base = reviewState([started("commit-pr", 1)]);
  const asDraft = await recordFallbackDraftFact(
    ctxWith(async () => ({ isDraft: true, state: "OPEN", headRefName: BRANCH })),
    base,
    PR,
    execStub,
  );
  assert(asDraft.pipelineState.prDraft?.status === "draft", "fallback: a draft PR is recorded as draft");
  const asReady = await recordFallbackDraftFact(
    ctxWith(async () => ({ isDraft: false, state: "OPEN", headRefName: BRANCH })),
    base,
    PR,
    execStub,
  );
  assert(
    asReady.pipelineState.prDraft?.status === "ready",
    "fallback: a PR the child opened ready is recorded ready, not as a draft",
  );
  const unread = await recordFallbackDraftFact(
    ctxWith(async () => {
      throw new Error("gh unavailable (simulated)");
    }),
    base,
    PR,
    execStub,
  );
  assert(unread.pipelineState.prDraft === undefined, "fallback: an unreadable view records nothing");
}

{
  // The ci step marks the draft ready BEFORE it dispatches the ci check.
  const order: string[] = [];
  const { forge } = mkForge(0);
  const recording = {
    ...forge,
    prReady: async () => void order.push("ready"),
  } as unknown as Forge;
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
    if (cmd.startsWith("gh pr view")) {
      return { stdout: JSON.stringify({ number: PR, state: "OPEN", headRefName: BRANCH }) };
    }
    return { stdout: "" };
  };
  const ctx = {
    host: fakePi,
    repoRoot: "/nonexistent",
    issue: ISSUE,
    forge: recording,
    verifyExecFn: exec,
    dispatchFn: async () => {
      order.push("dispatch");
      throw new Error("ci dispatch (simulated)");
    },
  } as unknown as DriverContext;
  const state = reviewState([started("commit-pr", 1), approved], { status: "draft" });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "pi-ens-draft-ci-"));
  const next = await runStep(
    { ...ctx, repoRoot: stateDir } as unknown as Parameters<typeof runStep>[0],
    state,
    "ci",
  ).catch(() => undefined);
  rmSync(stateDir, { recursive: true, force: true });
  assert(
    order[0] === "ready" && next?.pipelineState.prDraft?.status === "ready",
    `runStep(ci) marks the draft ready before any ci work (${order.join(" → ")})`,
  );
}

{
  // Identity (#1292 round 2): a wrong PR number — another branch's draft — is
  // never recorded and never marked ready, at any mark point or in the fallback.
  const foreign = { isDraft: true, state: "OPEN", headRefName: "feature/issue-999-other" };
  const readyCalls: number[] = [];
  const forge = {
    prView: async () => foreign,
    prReady: async (n: number) => void readyCalls.push(n),
  } as unknown as Forge;
  const ctx = { host: fakePi, repoRoot: "/nonexistent", issue: ISSUE, headless: true, forge } as DriverContext;
  const noFactState = reviewState([started("commit-pr", 1), approved]);
  const viaLive = await markDraftPrReady(ctx, noFactState, noSleep);
  const held = await markDraftPrReady(ctx, reviewState([started("commit-pr", 1), approved], { status: "draft" }), noSleep);
  const viaFallback = await recordFallbackDraftFact(ctx, noFactState, PR, execStub);
  assert(
    readyCalls.length === 0 && viaLive.pipelineState.prDraft === undefined && held.pipelineState.prDraft?.status === "draft" && held.pipelineState.prDraft?.holdReason === undefined && viaFallback.pipelineState.prDraft === undefined,
    "a PR whose head is another branch is never recorded, never marked ready",
  );
}

process.exit(exit);

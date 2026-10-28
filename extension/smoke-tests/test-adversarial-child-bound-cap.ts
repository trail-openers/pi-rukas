#!/usr/bin/env bun
/**
 * #1863 — a round review killed at its per-child run bound.
 *
 * Field shape: a headless /work whose adversarial round-review child is ended
 * by its run bound ("child-bound: ended at …ms bound + grace (killed)") ended
 * exit 30 with no handoff. Two of the causes were classification and cap
 * attribution, both fixed here:
 *
 *  1. `classifyDispatchOutcome` had NO `child-bound` branch, so a bound kill
 *     fell to the `!r.ok` → `crashed` / shouldRetry:true / maxRetries:1
 *     fallback and `runPhaseWithInfraRetry` re-spawned the SAME round review
 *     into the SAME bound. It now matches work-driver-failure-taxonomy.ts:
 *     self-killed, no retry — so exactly one reviewer dispatch happens, with
 *     no `-retry` tag on it.
 *  2. `RETRY_LADDER_KILL_CAUSES` dropped `child-bound`, so `infraFailureResult`
 *     projected no killCause at all and the driver could not tell a bound kill
 *     from a provider severance. It now survives the projection.
 *  3. The step handler records the fixed literal `child-timeout:adversarial`
 *     itself (the router's `child-timeout:${step}` branch is unreachable for a
 *     `RETRY_ONCE` step with a one-attempt budget), in both of its no-verdict
 *     sites: the N>1 fan-out shortfall and the N=1 pure-infra first pass.
 *  4. The PM tool path (`adversarial_loop`) shares the same classifier, so the
 *     same child reports an infra failure with `killCause: child-bound`.
 *
 * Offline: no spawn, no real sleep. `ctx.adversarialLoopFn` is the seam the
 * real fan-out calls; `runPhaseWithInfraRetry` / `infraFailureResult` are the
 * real ones, so a dropped field or a missing branch is visible.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import {
  type InfraCtx,
  infraFailureResult,
  runPhaseWithInfraRetry,
} from "../src/adversarial-retry.ts";
import { formatSingleReport } from "../src/async-jobs-report.ts";
import type { DispatchResult, ExtensionAPI } from "../src/types.ts";
import { capKilledString } from "../src/work-driver-cap-killed.ts";
import {
  capKillOutcomeFields,
  retryLadderKillCause,
} from "../src/work-driver-adversarial-fanout-capkill.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import { initCleanRepo } from "./lib/clean-repo-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-developer",
    ok: false,
    text: "",
    toolUses: [],
    ms: 100,
    exitCode: 143,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

function infraCtx(): InfraCtx {
  return {
    start: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    lastTranscript: "/tmp/stub.json",
    lastModel: "stub",
    toRoundRecords: () => [],
  };
}

/** The child as spawn hands it back after the bound's kill lands. */
function boundChild(): DispatchResult {
  return mkResult({
    killCause: "child-bound",
    killBudgetMs: 1_800_000,
    lastActivity: { kind: "toolCall in flight: bash", agoMs: 1000, linesSeen: 42 },
  });
}

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
// #286 — the test trees carry no real git diffs; without this the fan-out
// skips the loop entirely and there is nothing to classify.
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// ── 1. The classifier: parity with the shared taxonomy, and no retry.
{
  const r = boundChild();
  const cls = classifyDispatchOutcome(r);
  assert(
    cls.cause === "self-killed:child-bound" && cls.shouldRetry === false && cls.maxRetries === 0,
    `classifyDispatchOutcome: child-bound → self-killed:child-bound, shouldRetry=false, maxRetries=0 (got ${JSON.stringify(cls)})`,
  );
  const tax = classifyFailureCause({ kind: "dispatch-failed", killCause: "child-bound" });
  assert(
    tax.cause === cls.cause && tax.shouldRetry === cls.shouldRetry,
    "four-site parity: the taxonomy and the adversarial classifier agree on child-bound",
  );
  assert(
    capKilledString({ killCause: "child-bound" }) === undefined,
    "child-bound is NOT a dispatch-cap kill (DISPATCH_CAP_KILL_CAUSES governs checkpoints)",
  );
}

// ── 2. Exactly one reviewer dispatch, with no `-retry` tag.
{
  const tags: string[] = [];
  const signal = new AbortController().signal;
  const r = boundChild();
  let settled = false;
  // The whole await is a test's own bound: a regression that reintroduces the
  // retry must be seen as an extra tag, never as a hung test.
  const out = await Promise.race([
    runPhaseWithInfraRetry("adversarial-developer", "round3-review", "p", "/tmp", {
      runPhase: async (_role, tag) => {
        tags.push(tag);
        return r;
      },
      accumulate: () => {},
      signal,
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("runPhase hung")), 5000)),
  ]).catch((e: Error) => {
    assert(false, `runPhaseWithInfraRetry did not settle: ${e.message}`);
    settled = true;
    return mkResult();
  });
  if (!settled) {
    assert(tags.length === 1, `one reviewer dispatch for a bound-killed round (tags: ${tags.join(", ")})`);
    assert(
      !tags.some((t) => t.includes("-retry")),
      `no -retry tag on a bound-killed round (tags: ${tags.join(", ")})`,
    );
    assert(out.killCause === "child-bound", "the child's killCause is child-bound");
  }
}

// ── 3. The killCause survives the projection in adversarial-retry.ts.
{
  const r = boundChild();
  const synth = infraFailureResult(3, "review", r, classifyDispatchOutcome(r), infraCtx());
  assert(
    synth.killCause === "child-bound",
    `infraFailureResult keeps killCause child-bound through the projection (got ${JSON.stringify(synth.killCause)})`,
  );
  assert(
    retryLadderKillCause(r) === "child-bound",
    "retryLadderKillCause no longer drops child-bound",
  );
  // PARKING must still be the two dispatch caps only — widening the
  // projection must not promote a bound kill into a fixed-literal cap kill.
  assert(
    capKillOutcomeFields(synth).killCause === undefined,
    "a child-bound kill stays out of the cap-kill projection",
  );
  assert(
    synth.loopOutcome === "infra-failure",
    `the synthesized result is an infra-failure (got ${synth.loopOutcome})`,
  );
  assert(
    !synth.text.includes("NOT a review rejection") === false,
    "the infra-failure text still says explicitly it is not a rejection",
  );
}

// ── 4. The fan-out equivalent: N>1 parks with child-timeout:adversarial.
async function fanoutParks(
  name: string,
  opts: { multi: boolean; priorInfra: boolean },
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-1863-${name}-`));
  try {
    const s = initialState(1863, 1_000_000);
    const ids = opts.multi ? ["task-a", "task-b"] : ["default"];
    const tree: Record<string, string> = {};
    const streams: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }> = {};
    for (const w of ids) {
      if (w === "default") continue;
      tree[w] = `${dir}/.worktrees/${w}`;
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
      initCleanRepo(tree[w]);
    }
    if (!opts.multi) initCleanRepo(dir);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      // N=1 has no worktree: the fan-out reviews at repoRoot, which IS `dir`.
      worktrees: opts.multi ? tree : {},
      workstreams: opts.multi ? streams : undefined,
      branchName: "feature/issue-1863",
    };
    if (opts.priorInfra) {
      // Re-entry shape: the prior pass recorded a no-verdict outcome, so the
      // step-level router has already had its one retry.
      s.eventLog = [
        ...s.eventLog,
        {
          kind: "adversarial-workstream-outcome",
          at: Date.now(),
          workstreamId: opts.multi ? "task-a" : "default",
          outcome: "infra-failure",
          roundsExecuted: 0,
        },
      ] as never;
    }
    await writeState(dir, s);

    const attempts: string[] = [];
    const ctx: DriverContext = {
      host: makeFakePi(),
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "default";
        attempts.push(id);
        if (id !== "task-b") {
          // The REAL projection: what the loop hands back for a bound kill is
          // what infraFailureResult produces for the bound child.
          const child = boundChild();
          return infraFailureResult(1, "review", child, classifyDispatchOutcome(child), infraCtx());
        }
        return mkResult({
          ok: true,
          exitCode: 0,
          role: "adversarial-loop",
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
          adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
        });
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };

    const state = (await readState(dir, 1863))!;
    const after = await runAdversarial(ctx, state, Date.now());
    const caps = after.eventLog.filter((e) => e.kind === "cap-hit");
    const bound = caps.filter((e) => e.kind === "cap-hit" && e.cap === "child-timeout:adversarial");
    const infraCaps = caps.filter(
      (e) => e.kind === "cap-hit" && e.cap === "adversarial-infra-failure",
    );
    const label = opts.multi ? "N>1 fan-out" : "N=1 pure-infra";
    assert(
      bound.length === 1,
      `${label}: records the fixed literal child-timeout:adversarial (got ${JSON.stringify(caps.map((e) => (e.kind === "cap-hit" ? e.cap : "?")))})`,
    );
    assert(
      infraCaps.length === 0,
      `${label}: does NOT park with the generic adversarial-infra-failure cap`,
    );
    const mine = attempts.filter((a) => a !== "task-b");
    assert(
      mine.length === 1,
      `${label}: exactly one reviewer dispatch for the bound-killed workstream (got ${mine.length})`,
    );
    const tail = after.eventLog[after.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.nextStep === "handoff",
      `${label}: the step's tail is the cap-hit routed to handoff (got ${tail?.kind})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await fanoutParks("fanout", { multi: true, priorInfra: false });
await fanoutParks("n1", { multi: false, priorInfra: false });
await fanoutParks("n1-reentry", { multi: false, priorInfra: true });

// ── 5. The PM tool path (`adversarial_loop`) reports the same thing.
{
  const r = boundChild();
  const cls = classifyDispatchOutcome(r);
  assert(
    cls.cause === "self-killed:child-bound" && cls.shouldRetry === false,
    "adversarial_loop tool path: the shared classifier says infra failure, no retry",
  );
  const report = formatSingleReport("adv-1863", "adversarial-loop", r);
  assert(
    !report.includes("FAILED-PROVIDER-ERROR"),
    "adversarial_loop tool path: a bound kill is not reported as a provider error",
  );
  assert(
    !report.includes("should be retried"),
    "adversarial_loop tool path: the report does not suggest a retry",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

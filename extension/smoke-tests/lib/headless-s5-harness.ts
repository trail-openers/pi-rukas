#!/usr/bin/env bun
/**
 * Shared harness for the headless S5 (#1025) offline gate tests.
 *
 * The suite was one file until the merge-authority cases grew past the 500-line
 * cap (AGENTS.md §12). The harness lives here so the two test files
 * (`test-headless-gates.ts` for the CLI / env / exit-code contracts and
 * `test-headless-merge-authority.ts` for the merge-gate contracts) share one
 * copy of the environment setup, the parked-at-merged cycle runner, and the
 * assertion helpers, without either file carrying the other's cases.
 *
 * Merge commands are never spelled as literals here or in the fixture: the
 * mode-independent merge guard reads the bash command text of every tool call,
 * and a test that quotes the forbidden form trips it for a reason unrelated to
 * what the test asserts (#1390 / #1417).
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DriverContext } from "../../src/work-driver-context.ts";
import type { PolicyJudgeFn } from "../../src/work-driver-policy.ts";
import { runHeadless } from "../../src/headless/run.ts";
import {
  type WorkState,
  initialState,
  readState,
  writeStateSync,
} from "../../src/workflow-state.ts";
import {
  FIXTURE_PR,
  type MergeExecLog,
  type MergeVerdict,
  headlessRepo,
  mergeExec,
  okResult,
} from "./headless-s5-fixture.ts";

/** The env the runner and the merged step read; restored by `restoreEnv` at the end. */
const ENV_KEYS = [
  "PI_ENSEMBLE_SANDBOX_MODE",
  "PI_ENSEMBLE_TRUST_MODE",
  "PI_ENSEMBLE_MERGE_AUTHORITY",
  "PI_ENSEMBLE_POLICY_JUDGE",
  "PI_ENSEMBLE_HANDOFF_CHANNEL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

/**
 * Put the process in the offline-suite baseline: no forge, no live spawn, no
 * per-call gating chatter. Each test file calls this once at the top and
 * `restoreEnv` at the bottom.
 */
export function initEnv(): void {
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  process.env.PI_ENSEMBLE_VERIFY = "0";
  process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
  // Nothing in the offline suite reaches a provider or a forge.
  process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN = "1";
  // The handoff channel is not what these cases assert; `host` keeps the cycle
  // off the real forge (no comment, no label, no gh).
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

/** Undo `initEnv`'s `ENV_KEYS` capture so a sibling test file sees a clean process. */
export function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A process that never signals — these cases assert the cycle, not a Ctrl-C. */
export const noSignals = { on: () => undefined, off: () => undefined } as unknown as NodeJS.Process;

/** The seam subset the headless runner forwards to the driver. */
export type DriverSeams = Pick<
  DriverContext,
  "dispatchFn" | "issueBodyFetcherFn" | "verifyExecFn" | "policyJudgeFn"
>;

/** A state file parked at the merge step, holding a PR the forge says is green. */
export function readyToMerge(issue: number, baseSha: string): WorkState {
  const base = initialState(issue);
  return {
    ...base,
    // `owner.pid` is left UNSET deliberately. `classifyRunningState` refuses a
    // live owner only when its pid differs from this process, which is
    // load-bearing for crash-resume — but a fixture cannot clear it, so a state
    // file carrying a stale pid from an earlier bun run would refuse the cycle
    // before its first step and every assertion downstream would report the
    // refusal. An owner-less `running` file classifies as `fresh`.
    pipelineState: {
      ...base.pipelineState,
      currentStep: "merged",
      lastCompletedStep: "ci",
      status: "running",
      // The #406 base. Carried in from the fixture rather than patched in after
      // a read-back: `workStateDir` anchors on `process.cwd()`, so in this suite
      // the file does not live under the fixture's repoRoot and a read-back
      // would return a different cycle's state.
      baseSha,
      branchName: `feature/issue-${issue}`,
      prNumber: FIXTURE_PR,
      // Already ready: a draft cannot merge and would halt the step for a
      // reason unrelated to what these cases assert.
      prDraft: { status: "ready" },
    },
  };
}

/** Run the headless runner over one parked-at-merged cycle. */
export async function mergedRun(opts: {
  issue: number;
  grant: string | undefined;
  merge: MergeVerdict;
  refuseDoctrine?: boolean;
  /** A judge to put in front of whatever doctrine the read produced. */
  judge?: PolicyJudgeFn;
}): Promise<{ code: number; state: WorkState | undefined; log: MergeExecLog; baseSha: string }> {
  const repo = headlessRepo(opts.grant);
  const log: MergeExecLog = { calls: [], mergeCmds: [], unexpected: [], doctrineReads: [] };
  // The judge child is a real `spawnSpecialist`. The offline suite never
  // spawns, so the switch is forced OFF for every run that did not inject a
  // judge — and explicitly ON for a run that did, so an injected judge's answer
  // is what the gate acted on rather than the first line of `askPolicy`.
  const judgeWas = process.env.PI_ENSEMBLE_POLICY_JUDGE;
  if (opts.judge === undefined) process.env.PI_ENSEMBLE_POLICY_JUDGE = "0";
  else delete process.env.PI_ENSEMBLE_POLICY_JUDGE;
  try {
    mkdirSync(path.join(repo.repoRoot, ".pi", "work-state"), { recursive: true });
    // Synchronous on purpose. `writeState` queues behind every prior write to
    // the same file NAME, and each case gets its own throwaway repoRoot — so an
    // awaited pre-write from case N would still be in the chain when case N+1's
    // driver read its state, and the driver would fall back to `initialState`
    // with no `baseSha` and read doctrine from nowhere.
    writeStateSync(repo.repoRoot, readyToMerge(opts.issue, repo.baseSha));
    const result = await runHeadless({
      repoRoot: repo.repoRoot,
      issues: [opts.issue],
      restart: false,
      signalTarget: noSignals,
      driverSeams: {
        dispatchFn: async () => okResult("Mechanized merge succeeded."),
        issueBodyFetcherFn: async () => ({
          stdout: `title:\ts5\nstate:\tOPEN\n\nbody`,
        }),
        verifyExecFn: mergeExec(
          {
            merge: opts.merge,
            repoRoot: repo.repoRoot,
            refuseDoctrine: opts.refuseDoctrine,
          },
          log,
        ),
        ...(opts.judge ? { policyJudgeFn: opts.judge } : {}),
      } satisfies DriverSeams,
      write: () => undefined,
    });
    return {
      code: result.exitCode,
      state: await readState(repo.repoRoot, opts.issue),
      log,
      baseSha: repo.baseSha,
    };
  } finally {
    if (judgeWas === undefined) delete process.env.PI_ENSEMBLE_POLICY_JUDGE;
    else process.env.PI_ENSEMBLE_POLICY_JUDGE = judgeWas;
    repo.dispose();
  }
}

/**
 * A judge that always answers `answer`, quoting `quote`.
 *
 * The merged step builds its judge internally (`judgePolicy` → a spawnSpecialist
 * child), so without this seam a case cannot distinguish "the doctrine was
 * unreadable" from "the judge is switched off for the whole process" — which is
 * what made the doctrine-denial case vacuous. An eager judge is the point: a
 * green PR plus a judge that WANTS to grant still refuses, and the refusal is
 * attributable to the documents it was handed.
 */
export function judgeThatAnswers(
  answer: "permitted" | "forbidden",
  quote?: string,
): PolicyJudgeFn {
  return async () => ({
    toolUses: [
      {
        name: "report_policy",
        arguments: { verdict: answer, quote, sourceFile: "AGENTS.md" },
      },
    ],
  });
}

/**
 * Nothing the fixture had no answer for.
 *
 * An unexpected `git`/`gh` read means the production path changed what it asks
 * the forge or git for. Answering it with an empty stdout is how a gate ends up
 * judging nothing and reporting a verdict, so every case that reaches a gate
 * fails on this instead. Takes the file's `assert` so the two files keep their
 * own pass/fail counters.
 */
export function assertLogClean(assert: (cond: boolean, msg: string) => void, log: MergeExecLog) {
  assert(
    log.unexpected.length === 0,
    `the seam answered every command the cycle asked — nothing unexpected (${log.unexpected.join(" | ") || "clean"})`,
  );
}

/**
 * The evidence gate's own 3-field probe was issued.
 *
 * Without this, a `blocked`/`unopen` PR can be refused by something downstream —
 * the PR-identity check, or the mechanized merge's own verify — while the gate
 * the case names was never consulted. Asserting the probe is what makes "the
 * evidence gate refused" mean the evidence gate refused.
 */
export function assertEvidenceProbe(
  assert: (cond: boolean, msg: string) => void,
  r: { log: MergeExecLog },
) {
  assert(
    r.log.calls.some((c) => c.includes("mergeStateStatus,mergeable,state")),
    "the evidence gate ran its 3-field `gh pr view` probe — the refusal is attributable to that gate",
  );
}

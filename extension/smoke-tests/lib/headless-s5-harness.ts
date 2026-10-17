#!/usr/bin/env bun
/**
 * Shared harness for the headless S5 (#1025) offline gate tests.
 *
 * The suite was one file until the merge-authority cases grew past the 500-line
 * cap (AGENTS.md §12). The harness lives here so the two test files
 * (`test-headless-gates.ts` for the CLI / env / exit-code contracts and
 * `test-headless-evidence-gate.ts` for the merge-gate contracts) share one
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
import { runHeadless } from "../../src/headless/run.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import type { PolicyJudgeFn } from "../../src/work-driver-policy.ts";
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

/**
 * Every env key this harness WRITES, and the baseline value it writes.
 *
 * One table, used by both mechanisms: `initEnv` sets each key and captures the
 * host value under it, and `mergedRun` re-asserts the same baseline per case (a
 * sibling case that left one of these set cannot change what the next one
 * sees). Restoring from the same list `initEnv` wrote from is what makes the
 * file leave the process as it found it — the earlier list was a hand-maintained
 * subset that had drifted from what was actually written, so `QUIET_STATUS`,
 * `VERIFY`, `TRANSIENT_RETRY_BACKOFF_MS` and `FORBID_LIVE_SPAWN` leaked into
 * every later test file in the same bun process.
 */
const HARNESS_BASELINE: Readonly<Record<string, string>> = {
  PI_ENSEMBLE_QUIET_STATUS: "1",
  PI_ENSEMBLE_VERIFY: "0",
  PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS: "0",
  // Nothing in the offline suite reaches a provider or a forge.
  PI_ENSEMBLE_FORBID_LIVE_SPAWN: "1",
  // The handoff channel is not what these cases assert; `host` keeps the cycle
  // off the real forge (no comment, no label, no gh).
  PI_ENSEMBLE_HANDOFF_CHANNEL: "host",
  // Consolidation shells git at repoRoot and is not what any case here asserts;
  // a handoff that consolidated would answer git reads this fixture does not
  // serve and show up as `unexpected` rather than as the contract.
  PI_ENSEMBLE_HANDOFF_CONSOLIDATE: "0",
};

const savedEnv: Record<string, string | undefined> = {};

/**
 * Put the process in the offline-suite baseline: no forge, no live spawn, no
 * per-call gating chatter, no handoff consolidation. Each test file calls this
 * once at the top and `restoreEnv` at the bottom.
 */
export function initEnv(): void {
  for (const [key, value] of Object.entries(HARNESS_BASELINE)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

/** Undo `initEnv`'s capture so a sibling test file sees a clean process. */
export function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * The per-case env, restored in the `finally` so no case leaks into the next.
 *
 * The baseline is re-asserted first (not relied upon from `initEnv`), then the
 * two keys a case may legitimately move: `PI_ENSEMBLE_POLICY_JUDGE`, which is
 * forced OFF unless the case injected a judge, and
 * `PI_ENSEMBLE_FORBID_LIVE_SPAWN`, which a case may drop to prove the merged
 * step ignores an injected judge outside the offline harness.
 */
function withCaseEnv(
  opts: { judge?: PolicyJudgeFn; forbidLiveSpawn?: boolean; forcePolicyJudgeOff?: boolean },
  run: () => Promise<void>,
): Promise<void> {
  const keys = [...Object.keys(HARNESS_BASELINE), "PI_ENSEMBLE_POLICY_JUDGE"];
  const before: Record<string, string | undefined> = {};
  for (const k of keys) before[k] = process.env[k];
  for (const [key, value] of Object.entries(HARNESS_BASELINE)) process.env[key] = value;
  // `forcePolicyJudgeOff` is what keeps an offline case OFF the real judge: with
  // the injected seam suppressed for the reason under test, the real
  // `judgePolicy` would otherwise spawn a live child. `askPolicy` denies at its
  // first line instead, so the case asserts the deny without a spawn.
  if (opts.judge === undefined || opts.forcePolicyJudgeOff === true)
    process.env.PI_ENSEMBLE_POLICY_JUDGE = "0";
  else delete process.env.PI_ENSEMBLE_POLICY_JUDGE;
  if (opts.forbidLiveSpawn === false) delete process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN;
  return run().finally(() => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  });
}

/** A process that never signals — these cases assert the cycle, not a Ctrl-C. */
export const noSignals = { on: () => undefined, off: () => undefined } as unknown as NodeJS.Process;

/** The seam subset the headless runner forwards to the driver. */
export type DriverSeams = Pick<
  DriverContext,
  "dispatchFn" | "issueBodyFetcherFn" | "verifyExecFn" | "policyJudgeFn"
>;

/**
 * A state file parked at the merge step, holding a PR the forge says is green.
 *
 * `widePrView: true` leaves `prDraft` UNSET. That is the only way a case gets
 * the forge adapter's wide `gh pr view` read at all: `runMerged` opens with
 * `markDraftPrReady`, which returns at its `!draft || draft.status === "ready"`
 * guard when a ready fact is already persisted and never calls `readOwnPr` →
 * `forge.prView`. With the fact absent, the headless cycle (`headless: true`,
 * so `draftPrEnabled` holds) reads the PR live to decide whether it is a draft.
 * The fixture answers `isDraft: false`, so `recordLiveDraftFact` records
 * nothing, `markDraftPrReady` short-circuits on the same guard, and the merge
 * step proceeds exactly as it does with `prDraft: {status: "ready"}` — the
 * case's verdict is unchanged, only the reads the cycle made are more.
 */
export function readyToMerge(
  issue: number,
  baseSha: string,
  opts: { widePrView?: boolean } = {},
): WorkState {
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
      // reason unrelated to what these cases assert. `widePrView` leaves the
      // fact absent instead — see `readyToMerge`.
      ...(opts.widePrView ? {} : { prDraft: { status: "ready" as const } }),
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
  /**
   * `false` drops `PI_ENSEMBLE_FORBID_LIVE_SPAWN` for this case, which is how a
   * case asks what the merged step does with an injected judge when it is NOT
   * running inside the offline harness. Pair it with `forcePolicyJudgeOff`,
   * which sets `PI_ENSEMBLE_POLICY_JUDGE=0`: the offline suite must never reach
   * the real judge, because that spawns a live child — the switch makes the
   * real path deny at its first line instead.
   */
  forbidLiveSpawn?: boolean;
  /** See `forbidLiveSpawn` — forces `PI_ENSEMBLE_POLICY_JUDGE=0` even when a judge is injected. */
  forcePolicyJudgeOff?: boolean;
  /**
   * `true` persists the state file with NO `prDraft` fact, which is what makes
   * the merged step read the forge's wide `gh pr view` (via
   * `markDraftPrReady` → `readOwnPr`) instead of short-circuiting on a stored
   * `ready`. Only a case that asserts on `log.prViewAnswers` wants this — the
   * assertion is vacuous over an empty answer log.
   */
  widePrView?: boolean;
  /**
   * Set to capture what the environment actually said at the moment the case
   * ran, which `withCaseEnv` restores on the way out. The host-inertness case
   * asserts against the harness having dropped the live-spawn ban, and an
   * assertion that reads the env AFTER the case would read the restored value.
   */
  captureEnv?: string[];
}): Promise<{
  code: number;
  state: WorkState | undefined;
  log: MergeExecLog;
  baseSha: string;
  env: Record<string, string | undefined>;
}> {
  const repo = headlessRepo(opts.grant);
  const log: MergeExecLog = {
    calls: [],
    mergeCmds: [],
    prViewAnswers: [],
    unexpected: [],
    doctrineReads: [],
  };
  let code = -1;
  let state: WorkState | undefined;
  const env: Record<string, string | undefined> = {};
  await withCaseEnv(opts, async () => {
    for (const k of opts.captureEnv ?? []) env[k] = process.env[k];
    mkdirSync(path.join(repo.repoRoot, ".pi", "work-state"), { recursive: true });
    // Synchronous on purpose. `writeState` queues behind every prior write to
    // the same file NAME, and each case gets its own throwaway repoRoot — so an
    // awaited pre-write from case N would still be in the chain when case N+1's
    // driver read its state, and the driver would fall back to `initialState`
    // with no `baseSha` and read doctrine from nowhere.
    writeStateSync(
      repo.repoRoot,
      readyToMerge(opts.issue, repo.baseSha, { widePrView: opts.widePrView }),
    );
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
    code = result.exitCode;
    state = await readState(repo.repoRoot, opts.issue);
  });
  repo.dispose();
  return { code, state, log, baseSha: repo.baseSha, env };
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
export function judgeThatAnswers(answer: "permitted" | "forbidden", quote?: string): PolicyJudgeFn {
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
 * A judge that records that it was asked, and answers `permitted`.
 *
 * The host-inertness case needs the call itself observed: "the injected judge
 * was ignored" is only falsifiable if an injected judge that WAS honoured would
 * have shown up here.
 */
export function judgeThatRecords(
  calls: Array<{ prompt: string }>,
  answer: "permitted" | "forbidden" = "permitted",
  quote?: string,
): PolicyJudgeFn {
  const inner = judgeThatAnswers(answer, quote);
  return async (prompt: string, signal?: AbortSignal) => {
    calls.push({ prompt });
    return inner(prompt, signal);
  };
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

/**
 * The hold's `evidenceReason` starts with the exact prefix `gatherMergeEvidence`
 * writes for this refusal, read from that function and not paraphrased.
 *
 * `includes("CLOSED")` passed while the string was carried by the wide `prView`
 * answer rather than by the gate; a prefix assertion against the reason the gate
 * actually builds is what ties the hold to the gate. `reasonFromEvidence` in
 * `work-driver-merge-authority.ts` routes on the same prefixes — a rename that
 * breaks this assertion breaks that routing too, which is the point.
 */
export function assertEvidenceReason(
  assert: (cond: boolean, msg: string) => void,
  r: { state: WorkState | undefined },
  prefix: string,
  label: string,
) {
  const reason = r.state?.pipelineState.mergeHold?.evidenceReason;
  assert(
    typeof reason === "string" && reason.startsWith(prefix),
    `the ${label} hold's evidenceReason starts with the gate's own \`${prefix}\` (got ${JSON.stringify(reason)})`,
  );
}

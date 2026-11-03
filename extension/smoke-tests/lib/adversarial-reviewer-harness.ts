/**
 * Shared harness for the two offline tests of the adversarial reviewer arm
 * (#1827 the bound, #1978 the budget arms): the stubbed spawn that records what
 * the child ACTUALLY received, and the two ways to drive one report-only pass —
 * the real phase with armed budget params, and a stubbed phase whose child dies.
 *
 * Splitting the test file along this seam kept both under the size gate without
 * shortening a single line of the reasoning, which lives in the case blocks.
 */

import { mock } from "bun:test";
import type { RunningState } from "../../src/progress.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";
import { isolateLedger } from "./review-ledger-test-helpers.ts";

isolateLedger();

export type SpawnCall = {
  role: string;
  tag?: string;
  childBoundMs?: number;
  onSteer?: unknown;
  reviewSkillPath?: string;
  /** #1978 — what the child ACTUALLY received. A budget arm dropped by a spread
   * is invisible any other way, so every #1978 assertion reads these. */
  signal?: AbortSignal;
  onProgress?: (s: RunningState) => void;
  /** #1978 — the cause this dispatch died of, set per case. */
  killCause?: DispatchResult["killCause"];
};

export const spawnCalls: SpawnCall[] = [];
/** #1978 — the cause the next reviewer dispatch reports, so the loop's projection
 * is driven through the REAL loop rather than asserted on a synthesiser. */
export let nextReviewerKillCause: DispatchResult["killCause"] | undefined;
export function setNextReviewerKillCause(c: DispatchResult["killCause"] | undefined): void {
  nextReviewerKillCause = c;
}
/** #1978 — the turns the stub reports on its progress tick, so a case can cross
 * the budget's lever on the child's own numbers. */
let nextProgressTurns = 0;
/** Whether the stub emits a tick at all: a case that counts the DECK's ticks
 * needs the tick and not only the budget's hook, which returns early. */
let emitTick = true;
export function setNextProgressTurns(n: number, { emit = true }: { emit?: boolean } = {}): void {
  nextProgressTurns = n;
  emitTick = emit;
}
/** #1978 — the reply the next reviewer dispatch prints, for the case that needs
 * the loop to reach its report-only return with a killed child. */
let nextReviewerText: string | undefined;
export function setNextReviewerText(t: string | undefined): void {
  nextReviewerText = t;
}

function resultFor(role: string): DispatchResult {
  return {
    role,
    ok: true,
    text:
      role === "adversarial-developer"
        ? (nextReviewerText ?? "VERDICT: ISSUES_FOUND\n1. silent failure on the bound path")
        : "fixed",
    toolUses: [],
    ms: 1,
    exitCode: 0,
  };
}

/** The tick a real child's stdout handler emits — a budget hook is only
 * observable if something calls it. */
function tick(role: string, onProgress?: (s: RunningState) => void): void {
  if (nextProgressTurns <= 0 || !emitTick || onProgress === undefined) return;
  onProgress({
    role,
    turns: nextProgressTurns,
    toolUses: 0,
    totalTokens: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    elapsedMs: 1,
    done: false,
  });
}

mock.module(new URL("../../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1827-bound",
  spawnSpecialist: async (
    spec: { role: string },
    opts: {
      tag?: string;
      childBoundMs?: number;
      onSteer?: unknown;
      reviewSkillPath?: string;
      signal?: AbortSignal;
      onProgress?: (s: RunningState) => void;
    },
  ) => {
    const killCause = spec.role === "adversarial-developer" ? nextReviewerKillCause : undefined;
    spawnCalls.push({
      role: spec.role,
      tag: opts.tag,
      childBoundMs: opts.childBoundMs,
      onSteer: opts.onSteer,
      reviewSkillPath: opts.reviewSkillPath,
      signal: opts.signal,
      onProgress: opts.onProgress,
      ...(killCause === undefined ? {} : { killCause }),
    });
    tick(spec.role, opts.onProgress);
    // A killed child never completed its assignment, so `spawn.ts` marks it
    // failed whatever its exit code (`failedByKill`). ok:true here would let a
    // case prove the projection on a child the classifier refuses instead.
    if (killCause !== undefined) return { ...resultFor(spec.role), ok: false };
    return resultFor(spec.role);
  },
}));

const realDeck = await import("../../src/dispatch-deck.ts");
/** #1978 — counts the deck's own updateEntry so "the phase's feed still runs"
 * (composition) is told apart from "the budget's hook replaced it". */
export let deckTicks = 0;
export function resetDeckTicks(): void {
  deckTicks = 0;
}
mock.module(new URL("../../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...realDeck,
  startEntry: () => {},
  updateEntry: () => {
    deckTicks++;
  },
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
}));
const realRegistry = await import("../../src/async-jobs-registry.ts");
mock.module(new URL("../../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...realRegistry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));
const realLedger = await import("../../src/adversarial-ledger.ts");
mock.module(new URL("../../src/adversarial-ledger.ts", import.meta.url).href, () => ({
  ...realLedger,
  writeAdversarialLedgerEntry: () => undefined,
}));

export const { runAdversarialLoop } = await import("../../src/adversarial.ts");

/** One report-only pass with `arms` on the params, under `env`. */
export async function deliver(
  arms: {
    childBoundMs?: number;
    signal?: AbortSignal;
    onProgress?: (s: RunningState) => void;
  },
  env: Record<string, string | undefined> = {},
): Promise<{
  reviewer: SpawnCall | undefined;
  fix: SpawnCall | undefined;
  loop: DispatchResult;
  deckTicks: number;
}> {
  spawnCalls.length = 0;
  resetDeckTicks();
  let loop: DispatchResult | undefined;
  // The knob is read at DISPATCH time, so the pin must outlive the loop: the
  // body is awaited inside `withEnv`, which is what makes the restore happen
  // after the reviewer was dispatched rather than before it.
  await withEnv(env, async () => {
    loop = await runAdversarialLoop(
      {
        diff: "diff --git a/a.ts b/a.ts\n+hello",
        context: "budget arms",
        workCwd: process.cwd(),
        reportOnly: true,
        reportVerdict: "routed",
        reportRound: 1,
        ...arms,
      },
      new AbortController().signal,
      "job-1978-arms",
    );
  });
  return {
    reviewer: spawnCalls.find((c) => c.role === "adversarial-developer"),
    fix: spawnCalls.find((c) => c.role === "developer"),
    loop: loop as DispatchResult,
    deckTicks,
  };
}

/**
 * #1978 — the killed-child pass driven through a stubbed phase.
 *
 * `makeRunPhase` is replaced, not the loop: the arms, the deck composition and
 * the killCause projection are all still the production code, and the child's
 * death is the only fabricated fact. A stubbed `deps.adversarial` would prove
 * nothing about any of it.
 */
export async function deliverKilled(
  killCause: DispatchResult["killCause"],
  opts: { text?: string } = {},
): Promise<{ loop: DispatchResult; tags: string[] }> {
  spawnCalls.length = 0;
  const tags: string[] = [];
  const phase = await import("../../src/adversarial-phase.ts");
  mock.module(new URL("../../src/adversarial-phase.ts", import.meta.url).href, () => ({
    ...phase,
    makeRunPhase: () => async (role: string, tag: string) => {
      tags.push(tag);
      return {
        role,
        ok: false,
        text: opts.text ?? "",
        toolUses: [],
        ms: 900_000,
        exitCode: 0,
        ...(killCause === undefined ? {} : { killCause }),
      };
    },
  }));
  const loop = await runAdversarialLoop(
    {
      diff: "diff --git a/a.ts b/a.ts\n+hello",
      context: "killed reviewer",
      workCwd: process.cwd(),
      reportOnly: true,
      reportVerdict: "routed",
      reportRound: 1,
    },
    new AbortController().signal,
    "job-1978-killed",
  );
  return { loop, tags };
}

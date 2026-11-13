#!/usr/bin/env bun
/**
 * lib/classic-caller-harness — drives the real adversarial loop with its child
 * boundary mocked, for the suites that pin what the loop's OWN seats received.
 *
 * Two observations, both read off the running loop rather than rebuilt from a
 * string: the prompt a reviewer or fix-round developer was ACTUALLY dispatched
 * with, and the params object the boundary in front of the loop built. A prompt
 * cannot show a key that was stripped
 * before the loop ran, and a params object cannot show what the prompt builders
 * did with it, so a suite that cares about either needs both.
 *
 * The child answers from a queue set by `setChildReplies` — the head is consumed
 * and the last entry repeats. #1978 is why: a child killed by a bound makes the
 * loop's phase RETRY the dispatch, and a mock that answered every attempt identically
 * (say, always `APPROVED`) would have the loop retry forever. A suite that wants a
 * round to ROUTE TO A FIXER therefore queues a blocking verdict followed by an
 * approving one, and the queue is reset per drive — a stale `APPROVED` at its head
 * would end the loop before any fixer ran.
 *
 * `stubAdversarialChildren()` installs the mocks and returns the recorders; the
 * suite calls it BEFORE importing anything under test. `mock.module` only takes
 * effect for imports that come after it (the rule `lib/lens-stub-spawn.ts`
 * states), so a mock installed after the real module was awaited leaves the real
 * child spawn in place — and the "mock" then tries to run `pi`.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { mock } from "bun:test";
import type { DispatchResult } from "../../src/types.ts";

/** Every prompt a child was dispatched with, by role, in call order. */
export interface AdversarialChildCalls {
  prompts: { role: string; prompt: string }[];
  /** The params objects every `runAdversarialLoop` call received, in order — read
   * by the suites that assert on what a boundary stripped or minted. */
  loopArgs: unknown[];
  /** Script the children: `reviewers` are verdicts in dispatch order (the last
   * one repeats), `developers` what each fix round returns. */
  setReplies(replies: { reviewers: string[]; developers?: string[] }): void;
}

/** Install the mocks over the loop's child boundary. Call before importing the
 * loop or any tool that calls it. */
export async function stubAdversarialChildren(): Promise<AdversarialChildCalls> {
  const prompts: { role: string; prompt: string }[] = [];
  const loopArgs: unknown[] = [];
  let reviewerReplies: string[] = [];
  let developerReplies: string[] = [];

  mock.module(new URL("../../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-classic-caller",
    spawnSpecialist: async (spec: { role: string; prompt: string }): Promise<DispatchResult> => {
      prompts.push({ role: spec.role, prompt: spec.prompt });
      const text =
        spec.role === "developer"
          ? (developerReplies.shift() ?? "guarded the draw")
          : (reviewerReplies.shift() ?? "VERDICT: APPROVED");
      return { role: spec.role, ok: true, text, toolUses: [], ms: 1, exitCode: 0 };
    },
  }));

  // EVERY mock below spreads the real module's surface rather than listing the
  // handful of names this suite cares about. Bun resolves a module's named exports
  // at load, so a mock that omits one another importer asks for fails the whole
  // file before the first assertion (`Export named 'reset' not found in ...`).
  const realDeck = await import("../../src/dispatch-deck.ts");
  mock.module(new URL("../../src/dispatch-deck.ts", import.meta.url).href, () => ({
    ...realDeck,
    startEntry: () => {},
    updateEntry: () => {},
    clearBatchEntry: () => {},
    clearEntry: () => {},
    startBatchEntry: () => {},
    updateBatchProgress: () => {},
  }));

  const realRegistry = await import("../../src/async-jobs-registry.ts");
  mock.module(new URL("../../src/async-jobs-registry.ts", import.meta.url).href, () => ({
    ...realRegistry,
    childHandles: new Map(),
    registerChildHandle: () => {},
    setOrchestratorActiveChild: () => {},
    markOrchestrator: () => {},
  }));

  // The ledger write is a disk write the suite is not about; the arms that care
  // about the row itself drive the writer's own suite.
  const realLedger = await import("../../src/adversarial-ledger.ts");
  mock.module(new URL("../../src/adversarial-ledger.ts", import.meta.url).href, () => ({
    ...realLedger,
    writeAdversarialLedgerEntry: () => undefined,
  }));

  return {
    prompts,
    loopArgs,
    setReplies(replies) {
      reviewerReplies = [...replies.reviewers];
      developerReplies = [...(replies.developers ?? [])];
    },
  };
}

/** Round 1's reviewer BLOCKS — the only way the loop ever builds a fix-round
 * prompt — then the fixer replies and round 2 approves. Queued rather than
 * counted: see `setChildReplies`. */
export const BLOCK_THEN_APPROVE = {
  reviewers: [
    "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- a.ts:1 — the draw is not guarded",
    "VERDICT: APPROVED",
  ],
  developers: ["guarded the draw"],
};

/** Wrap the real loop so its params object is recorded, then install the wrapper
 * over the module the tool boundary resolves.
 *
 * `loopModule` MUST be the module imported BEFORE this call, and is the source of
 * both the wrapped function and the surface the mock spreads. A wrapper that
 * resolved the loop through the module it is itself replacing recurses through its
 * own mock until the stack overflows — and a loop that never returns looks exactly
 * like a slow review, so the hang gives no hint of the cause. */
export function recordLoopArgs(
  loopModule: {
    runAdversarialLoop: (...args: unknown[]) => Promise<unknown>;
  },
  loopArgs: unknown[],
): void {
  const realLoop = loopModule.runAdversarialLoop;
  const recording = (...args: unknown[]): Promise<unknown> => {
    loopArgs.push(args[0]);
    return realLoop(...args);
  };
  mock.module(new URL("../../src/adversarial.ts", import.meta.url).href, () => ({
    ...loopModule,
    runAdversarialLoop: recording,
  }));
}

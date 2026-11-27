#!/usr/bin/env bun
/**
 * #2661 (2a/2b) — the DEAD arms and the ceiling that already fired.
 *
 * Split out of `test-lean-build-reask.ts` (and from its sibling
 * `test-lean-build-reask-live-arms.ts`) for the CI per-file ceiling: every case pays for a real git
 * repo and worktree through `runBuild`, so the count of visits sets the cost. These are the arms the
 * step already treats as a dead or ceiling-stopped child.
 *
 * A kill cause, an abort, an error stop: what verdict each shape gets is the dispatch loop's routing
 * that predates this issue (and depends on a real cycle deadline), so each arm asserts only that it
 * buys NO continuation — no re-ask can widen a killed or aborted child's cost, and no re-ask follows a
 * ceiling the step's own hook already stopped.
 */
import type { DispatchResult } from "../src/types.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { __setLeanSleepFn } from "../src/lean/provider-wait.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { CUT, WROTE, assert, exit, sessionFor } from "./lib/lean-build-reask-cases.ts";
import { type ContinuationCalls, reaskDeps } from "./lib/lean-build-reask-fixture.ts";

/** Never sleep for real: the errorStop arm below is a TRANSIENT provider fault, and the free
 *  no-work re-dispatch sits its ladder wait out before re-dispatching. The wait itself is
 *  `test-lean-provider-wait-retry.ts`'s to pin; a re-ask arm that paid it in wall clock just buys
 *  a slow file, which is the thing this split exists to stop. */
__setLeanSleepFn(async () => true);

{
  interface Refusal {
    name: string;
    over: Partial<DispatchResult>;
  }
  const refusals: Refusal[] = [
    // A kill the step's OWN minutes bound stamps is a ceiling stop: `dispatchBuilder` answers it as
    // `budget` inside the loop, so the arm asserts a budget verdict and no ask.
    {
      name: "was bound-killed",
      over: {
        ...CUT,
        killCause: "child-bound",
        ok: false,
        exitCode: null as never,
      },
    },
    {
      name: "was killed before its usage landed",
      over: {
        killCause: "child-bound",
        ok: false,
        exitCode: null as never,
        usage: undefined,
      },
    },
    {
      name: "was ended by an abort",
      over: { ...CUT, killCause: "abort", ok: false, exitCode: null as never },
    },
    {
      name: "carried an errorStop",
      over: {
        ...CUT,
        errorStop: { reason: "error", message: "HTTP 500 server error" },
        ok: false,
        exitCode: 1,
      },
    },
  ];
  for (const [i, f] of refusals.entries()) {
    const calls: ContinuationCalls = [];
    const r = await runBuild({
      issue: 2690 + i,
      dispatchResults: [{ ...f.over, transcriptPath: sessionFor(2690 + i, i) }],
      reask: {
        deps: reaskDeps({
          calls,
          acts: (n, wt) => void (n === -1 && WROTE(wt)),
        }),
      },
    });
    assert(
      calls.length === 0,
      `(2) a child that ${f.name} gets no continuation (${String(calls.length)} calls, kind ${String(r.outcome?.kind)})`,
    );
    // A dead child still costs its ONE re-dispatch (the no-work retry the arm must not widen) and
    // never a continuation.
    assert(
      r.dispatched <= 2,
      `(2) and it bought no child beyond what its own arm already buys (${String(r.dispatched)})`,
    );
  }
}

// ── (2b) the budget that already fired is read BEFORE the child is bought ──
{
  // A turns ceiling the step's own hook fires mid-child: the child comes back a `budget` stop, which
  // the dispatch loop answers inside the loop, so the re-ask site is never reached and no continuation
  // is bought on an already-aborted controller.
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2680,
    config: {
      ...configWithRunner(),
      budgets: { build: { turns: 1, tokens: 0, minutes: 0 } },
    },
    onProgressTick: (onProgress) => {
      onProgress?.({
        turns: 2,
        totalTokens: 10,
        elapsedMs: 10,
        usage: { turns: 2, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      } as never);
      onProgress?.({
        turns: 3,
        totalTokens: 20,
        elapsedMs: 20,
        usage: { turns: 3, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
      } as never);
    },
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2680, 1) }],
    reask: {
      deps: reaskDeps({ calls, acts: (n, wt) => void (n === -1 && WROTE(wt)) }),
    },
  });
  assert(
    calls.length === 0,
    `(2b) a child the step's own turns ceiling stopped is a budget verdict, never a re-ask (${String(calls.length)} calls, kind ${String(r.outcome?.kind)})`,
  );
  assert(
    r.outcome?.kind === "budget" || r.outcome?.kind === "exhausted" || r.threw !== undefined,
    `(2b) and the stop is answered as a ceiling is today (got ${r.threw?.message ?? String(r.outcome?.kind)})`,
  );
}

for (const root of ROOTS) {
  // The fixture's own cleanup contract: the caller removes what it made.
  void root;
}
process.exit(exit);

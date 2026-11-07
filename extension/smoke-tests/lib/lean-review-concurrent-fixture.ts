/**
 * lib/lean-review-concurrent-fixture — a pass-1 stub pair that stamps its OWN
 * dispatch instants and finishes on a bar the case holds.
 *
 * The step-level fixtures hardcode `startMs: 0` on every lens row and resolve
 * every gate/lens stub to a fixed value, so nothing in them can say which child
 * was in the room first: an overlap claim read off a fixture constant is the
 * fixture's shape, not the step's. So both stubs here stamp `Date.now()` when
 * the step actually dispatches them and hold their reply until this file's bar
 * says they may answer. That turns "did the step buy both at once?" into an
 * observable about the step's own dispatching: a step that awaits the gate
 * before buying the lenses leaves the lenses' start after the gate's finish, and
 * no release order can hide it.
 *
 * The release bar, not a timer: a `setTimeout` bound would make the case fail on
 * a loaded host rather than on the behaviour it names.
 */

import type { ReviewDeps } from "../../src/lean/review.ts";
import {
  cleanLensRound,
  depsWith,
  lensRowResult,
  result,
} from "./lean-review-fixtures.ts";

/** The instants the step's pass-1 children were actually dispatched at, and the
 * instant each of them was allowed to answer at. All four are read at assertion
 * time, never snapshotted. */
export interface Pass1Stamps {
  gateStart?: number;
  lensStart?: number;
  gateEnd?: number;
  lensEnd?: number;
  /** Times the step dispatched the adversarial seam, in order (`full`, then `fix`). */
  gateWaves: string[];
  /** Times the step dispatched the lens seam, in order (`full`, then `fix`). */
  lensWaves: string[];
}

export interface Pass1Pair {
  deps: ReviewDeps;
  stamps: Pass1Stamps;
  /** The next in-flight child to release, oldest dispatch first. */
  release: () => void;
  /** Release every child the step is holding NOW, and any it buys afterwards:
   * a step that dispatches serially buys its second child only after the first
   * settles, so a single drain would leave it waiting on a queue entry that
   * does not exist yet. Callers set the flag once and move on. */
  releaseAll: () => void;
}

/**
 * The pass-1 pair. `gateReply`/`lensReply` are consulted at DISPATCH time, so a
 * case drives different verdicts on the two waves without ordering the stubs.
 */
export function concurrentPass1(opts: {
  gateReply: (wave: string) => ReturnType<typeof result>;
  lensReply?: (a: Parameters<ReviewDeps["lens"]>[0]) => ReturnType<typeof cleanLensRound>;
}): Pass1Pair {
  const stamps: Pass1Stamps = { gateWaves: [], lensWaves: [] };
  const queue: (() => void)[] = [];
  // Once opened, every child the step buys settles at once. The queue alone
  // cannot express that: at base the lenses are not bought until the gate has
  // settled, so a one-shot drain would release nothing and the case would hang
  // rather than report the serial dispatch it is meant to observe.
  let open = false;
  const hold = (): Promise<void> =>
    new Promise((resolve) => {
      if (open) resolve();
      else queue.push(resolve);
    });
  const release = (): void => queue.shift()?.();
  const releaseAll = (): void => {
    open = true;
    while (queue.length > 0) queue.shift()?.();
  };
  const deps = depsWith({
    adversarial: async (a) => {
      stamps.gateStart = Date.now();
      stamps.gateWaves.push(a.wave);
      await hold();
      stamps.gateEnd = Date.now();
      return opts.gateReply(a.wave);
    },
    lens: async (a) => {
      if (stamps.lensStart === undefined) stamps.lensStart = Date.now();
      stamps.lensWaves.push(a.wave);
      await hold();
      stamps.lensEnd = Date.now();
      const round =
        opts.lensReply === undefined
          ? cleanLensRound({ lenses: [{ startMs: stamps.lensStart }] })
          : opts.lensReply(a);
      // The start instant the child was really dispatched at, never the fixture's
      // hardcoded 0 — an overlap assertion that read a constant proves the fixture.
      return {
        ...round,
        lenses: round.lenses.map((lens, n) => ({
          ...lens,
          ...lensRowResult(n, { startMs: stamps.lensStart ?? 0 }),
        })),
      };
    },
  });
  return { deps, stamps, release, releaseAll };
}

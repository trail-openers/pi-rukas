/**
 * #1360 lens 4/5 support — a counted capture seam for the adversarial loop.
 *
 * `arms/loop-behaviour.ts` asserts that the `/work` driver path runs NO
 * per-round capture while the tool path runs exactly one. Counting the loop's
 * own call needs a mock of `adversarial-ledger-capture.ts` whose `captureRound`
 * still does the real work — and Bun's `mock.module` factory resolves that
 * module to its own replacement, so a factory that spreads the live module and
 * delegates makes `captureRound` call itself. This helper keeps the real
 * implementation OUT of the module registry, which is the only place it cannot
 * alias itself: it calls `captureBinding` in a DIFFERENT module.
 */

import type { BindingState } from "../../../src/adversarial-ledger-capture.ts";
import { captureBinding } from "../../../src/adversarial-ledger-binding.ts";
import type { VerifyExecFn } from "../../../src/work-driver-git.ts";

export interface CountedCapture {
  /** The wrapper to install as `captureRound` in the test's mock factory. */
  captureRound: (
    state: BindingState,
    cwd: string,
    baseRef: string | undefined,
    headRef: string | undefined,
    execFn?: VerifyExecFn,
  ) => Promise<void>;
  /** How many times the loop called it since the last reset. */
  calls: () => number;
  reset: () => void;
  /** Install a capture the round did NOT earn — the stale/partial binding the
   * writer must refuse. `unpoison` restores real capture. */
  poison: (binding: Record<string, string | undefined>) => void;
  unpoison: () => void;
}

export function countedCapture(): CountedCapture {
  let n = 0;
  let poisoned: Record<string, string | undefined> | undefined;
  return {
    // The body is `captureRound`'s, verbatim: assign the capture, record the
    // ref it was taken for, and never let a capture failure reach the review.
    // Only the counter and the poison seam are added.
    captureRound: async (state, cwd, baseRef, headRef, execFn) => {
      n++;
      if (poisoned) {
        state.binding = poisoned as BindingState["binding"];
        state.capturedHeadRef = headRef;
        return;
      }
      try {
        state.binding = await captureBinding(cwd, baseRef, headRef, execFn);
        state.capturedHeadRef = headRef;
      } catch (err) {
        state.binding = {
          bindingUnavailable: `the round capture failed (${(err instanceof Error ? err.message : String(err)).slice(0, 120)})`,
        };
        state.capturedHeadRef = headRef;
      }
    },
    calls: () => n,
    reset: () => {
      n = 0;
    },
    poison: (binding) => {
      poisoned = binding;
    },
    unpoison: () => {
      poisoned = undefined;
    },
  };
}

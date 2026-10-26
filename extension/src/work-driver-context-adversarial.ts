/**
 * work-driver-context-adversarial — the adversarial step's injection points on
 * `DriverContext`, extracted (AGENTS.md §12 file-size limit).
 *
 * `DriverContext` is a bag of optional seams, one per dependency the driver
 * might want to fake in a test, and the bag itself is what crosses the size
 * cap — not any one member. Each step's seams therefore live beside each other
 * in a module of their own and are intersected back in work-driver-context.ts,
 * so `DriverContext` remains the single type every caller names and a test
 * still constructs one object literal.
 *
 * These two belong together because they are the adversarial gate's pair: the
 * loop is the review that is faked, and the diff exec is the gate's OWN read
 * that a test must be able to break. Asserting "the gate refuses to approve an
 * unreadable tree" needs both halves — without the second, the only way to make
 * the read fail was to strip `git` from `process.env.PATH` for the duration of
 * a callback, process-global state that every concurrent git user in the test
 * process races with.
 */

import type { DispatchResult } from "./types.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

export interface DriverContextAdversarialSeams {
  /**
   * Optional injection point for tests: replace `runAdversarialLoop` with a
   * fake. Production callers omit this — `runAdversarial` uses the real
   * orchestrator from adversarial.ts. Added in PR8 alongside the
   * per-workstream adversarial fanout so the smoke tests can validate fanout
   * shape without spawning real Pi children.
   */
  adversarialLoopFn?: (
    params: { diff: string; context: string; workCwd?: string; processGroup?: boolean },
    signal: AbortSignal,
    orchestratorJobId: string,
  ) => Promise<DispatchResult>;
  /**
   * #1634 — optional test seam for the adversarial gate's OWN diff read
   * (`readWorktreeDiff`). Default `execp`. Narrow by design: it reaches the diff
   * read and nothing else, so a fake cannot make a verify or a checkpoint pass
   * vacuously.
   */
  diffExecFn?: VerifyExecFn;
}

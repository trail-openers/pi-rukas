// Shared harness for the two suites that pin the routed report's bound: the rig-driven
// behavioural cases in `test-lean-handback-report-bound.ts` and the ceiling measurement
// in `test-lean-report-bound-ceiling.ts`. Both drive the same production reporting step,
// so both need the same env pin, the same per-drive guard, and the same way of holding a
// handler pending — a second copy would let one suite drift from what the other asserts.
import { readFileSync } from "node:fs";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { leanStateFile } from "../../src/lean/state.ts";
import { makeAssert } from "../headless-verb-harness.ts";
import { withEnv } from "./env-scope.ts";
import { captureWarns } from "./lean-review-bound-fixtures.ts";
import { ENV, driveToDeadline, walkToReview } from "./lean-verified-handback-deadline-rig.ts";
import { ISSUE } from "./lean-verified-handback-fixture.ts";
import { repoWithFixHead } from "./lean-verified-handback-repo.ts";

const { assert, state } = makeAssert();

/** How long a case waits for its drive before it calls the drive hung. Well above
 *  every bound this file pins (the largest is 6 s) and far below the suite's per-test
 *  ceiling, so a regression prints a failure instead of burning the test budget. */
const GUARD_MS = 20_000;

/** The rig's `ENV` pins `PI_ENSEMBLE_CYCLE_BUDGET_MS` at 240 min — the budget
 *  `crossingAfter` resolves its late position against — and the handoff allowance at
 *  2 min with it. A case that shrinks the allowance to make the bound cheap moves the
 *  arm `resolveCycleDeadline` picks while the clock's late position stays 240 min out,
 *  so the run is stopped at an ordinary boundary and the drive ends on a handler-error
 *  record that tests nothing. Pinning the arm ABSOLUTELY decouples the two: the
 *  crossing stays the deadline stop the shared rig was built to produce, at whatever
 *  allowance the case wants to watch being cut. */
function rigEnv(allowanceMs: number, extra: Record<string, string | undefined> = {}) {
  return {
    ...ENV,
    PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(allowanceMs),
    PI_ENSEMBLE_CYCLE_BUDGET_MS: undefined,
    PI_ENSEMBLE_CYCLE_DEADLINE: String(Date.now() + 30 * 60_000),
    ...extra,
  };
}

/** A drive raced against its own guard. The guard is `unref`'d: a passing drive must
 *  not be held open by the timer that was meant to catch it hanging, and the timer is
 *  unref'd so a green file exits. */
async function guarded<T>(what: string, body: () => Promise<T>): Promise<T | `HUNG:${string}`> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body(),
      new Promise<`HUNG:${string}`>((resolve) => {
        timer = setTimeout(() => resolve(`HUNG:${what}`), GUARD_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The hung reporting step: pending forever, until the case hands it the key that
 *  lets it settle (used by (c), where "no bound" must be shown as a wait for the
 *  handler rather than as a hang). */
function hungHandler(): {
  handler: LeanHandlers["handback"];
  calls: number;
  releases: number;
  release: () => void;
} {
  let releases = 0;
  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle: LeanHandlers["handback"] = async (ctx) => {
    calls++;
    await gate;
    releases++;
    return { kind: "done", reason: `posted late for ${ctx.stepKey}` };
  };
  return {
    get calls() {
      return calls;
    },
    get releases() {
      return releases;
    },
    handler: handle,
    release,
  };
}

/** Read the state file's raw bytes: what a second process — or an operator with
 *  `/runs` — reads, and the only witness that settles what the run wrote. */
function recordBytes(repoRoot: string): string {
  return readFileSync(leanStateFile(repoRoot, ISSUE), "utf8");
}

/** The green the deadline walk needs: a decided verify at the base, so the rule's
 *  premise is the certified-head one (case (a)'s origin assertion reads it). */
function greenAt(baseSha: string): ReturnType<typeof walkToReview> {
  return walkToReview({
    kind: "green",
    verifiedHead: baseSha,
    reason: `all frozen tests green at ${baseSha}`,
  });
}


export type Driven = Awaited<ReturnType<typeof driveToDeadline>>;
export { assert, state, GUARD_MS, rigEnv, guarded, hungHandler, recordBytes, greenAt };

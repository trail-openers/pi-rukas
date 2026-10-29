/**
 * #1871 — the shared fixtures for the two owner-identity suites.
 *
 * Split out of test-owner-identity-readers.ts for the 500-line gate (AGENTS.md
 * §12). The seam is the fixture, not the assertion: `claim()`, `noState` and
 * `runningState` are what both the reader/writer suite
 * (`test-owner-identity-readers.ts`) and the entry-shape suite
 * (`test-owner-claim-entry-shape.ts`) need, and a second copy of them is how
 * the two drift into agreeing with each other instead of with the code.
 *
 * A helper no test calls still shows up in `test-seams-wired.ts`'s `lib/` scan,
 * which is why they live here rather than being duplicated.
 */
import { spawnSync } from "node:child_process";
import type { PathClaimEntry } from "../../src/work-driver-path-claims-staleness.ts";
import type { WorkState } from "../../src/workflow-state.ts";

/** A host no identity on this machine can belong to. */
export const FOREIGN_HOST = "not-this-container";
/** The fixed clock both suites pin their age rules against. */
export const NOW = 1_800_000_000_000;
/** Older than CLAIM_STALE_MS (1 h), so the age bound WOULD delete it. */
export const ANCIENT = NOW - 3 * 3_600_000;
/** Twice the stale bound — the age at which F1's exemption is observable. */
export const ANCIENT_2X = NOW - 2 * 3_600_000;
/** A pid that is certainly not ours; its fate must not matter, because the
 * identity check runs first and the probe is never reached. */
export const SOMEONE_ELSES_PID = 4242;

/**
 * A pid no process can hold, for "this cycle's owner died" fixtures.
 *
 * Above the `pid_max` any current Linux box runs with (the 4 194 304 ceiling is
 * the documented maximum; `0x7ffffffe` is far beyond it), and not a signal-0
 * special case — `processAlive()` answers false without racing a real pid. A
 * fixture that reaches for a small pid like 999 is a flake with a schedule: on a
 * CI runner with a low `pid_max`, 999 is an ordinary live process, and "this owner
 * is certainly dead" silently becomes "that owner is alive".
 */
export const deadPid = (): number => 0x7ffffffe;

/** A claim entry with this issue's defaults, overridden per case. */
export function claim(over: Partial<PathClaimEntry> = {}): PathClaimEntry {
  return {
    issue: 700,
    pid: process.pid,
    paths: ["src/foo.ts"],
    startedAt: NOW,
    ...over,
  };
}

/** Throws: the reader's `stateUnreadable` branch is reached by an exception,
 * not by an absent file (an `undefined` return reads as "verified, no state"). */
export const noState = async (): Promise<WorkState | undefined> => {
  throw new Error("fixture: no state file");
};

/** A readable, non-terminal claimant state: without one the reader's AGE rule
 * (pre-existing, `unverifiable-age`) fires, which is a different question from
 * the liveness verdict these cases pin. */
export const runningState = async (): Promise<WorkState | undefined> =>
  ({
    resumable: true,
    issue: 700,
    startedAt: 0,
    updatedAt: 0,
    pipelineState: { status: "running", currentStep: "develop", inFlightJobIds: [] },
    eventLog: [],
  }) as unknown as WorkState;

/** The pass/fail counter, one per suite file. */
export function makeAssert(): {
  assert: (cond: boolean, msg: string) => void;
  /** 0 when every assertion so far held; the suite's own exit code. */
  status: () => 0 | 1;
} {
  let failed = 0;
  return {
    assert(cond: boolean, msg: string): void {
      if (cond) console.log(`✓ ${msg}`);
      else {
        console.error(`✗ ${msg}`);
        failed = 1;
      }
    },
    status: () => (failed === 0 ? 0 : 1),
  };
}

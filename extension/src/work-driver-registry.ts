/**
 * work-driver-registry — which cycles are live *in this process*.
 *
 * The on-disk owner check cannot answer this. `classifyRunningState` refuses a
 * running cycle only when `owner.pid !== selfPid`, and that exclusion is
 * load-bearing: a driver resuming its own crashed state file must not refuse
 * itself. The consequence is that two cycles started from the *same* process
 * see a matching pid and neither refuses.
 *
 * That was harmless while `/work` was reachable only by a human typing it —
 * you cannot type two slash commands at once. It stops being harmless the
 * moment a tool can start a cycle, because an LLM can call a tool twice, and
 * the result is two drivers on one branch: interleaved commits, a PR nobody
 * can review, and a state file written by two writers.
 *
 * Keyed by *every* issue in the group, not just the primary. A grouped cycle
 * for #10+#11 must collide with a later single cycle for #11, which a
 * primary-only key would miss.
 *
 * In-process only, deliberately. Cross-process is the state file's job, and it
 * already does it correctly.
 */

import { trace } from "./trace.ts";

/** issue number -> the primary issue of the cycle that holds it. */
const held = new Map<number, number>();

export interface CycleClaim {
  /** Release every issue this claim holds. Idempotent. */
  release(): void;
}

export type ClaimResult =
  | { ok: true; claim: CycleClaim }
  | { ok: false; conflictIssue: number; heldByCycle: number };

/**
 * Claim a cycle for `issues`, or report which one is already live.
 *
 * All-or-nothing: a partial claim would leave issues locked by a cycle that
 * never started.
 */
export function claimCycle(primary: number, issues?: number[]): ClaimResult {
  const all = [...new Set([primary, ...(issues ?? [])])];
  for (const n of all) {
    const holder = held.get(n);
    if (holder !== undefined) {
      return { ok: false, conflictIssue: n, heldByCycle: holder };
    }
  }
  for (const n of all) held.set(n, primary);
  trace(`work-driver: claimed cycle #${primary} (issues: ${all.join(", ")})`);

  let released = false;
  return {
    ok: true,
    claim: {
      release() {
        if (released) return;
        released = true;
        for (const n of all) {
          // Only drop keys this cycle owns. A later cycle re-claiming an issue
          // after a stale release must not have its claim silently deleted.
          if (held.get(n) === primary) held.delete(n);
        }
        trace(`work-driver: released cycle #${primary}`);
      },
    },
  };
}

/** Live cycle primaries, for diagnostics. */
export function liveCycles(): number[] {
  return [...new Set(held.values())].sort((a, b) => a - b);
}

/** Test-only: drop all claims. Never called from production. */
export function resetRegistry(): void {
  held.clear();
}

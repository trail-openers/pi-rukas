/**
 * spawn-stall — the driver's stall action of the child-supervision policy
 * (#1567 item 4, piece P5 / #1313).
 *
 * The slow-run notice used to be the only response to a frozen driver child:
 * it told the PM, and a PM in a headless cycle asked an operator who could not
 * answer, so a frozen child ran until the container was stopped. The driver
 * now acts by itself, on the slow notice's elapsed levels (20 min · 2^n,
 * `PI_ENSEMBLE_SLOW_NOTICE_MS` sets the base):
 *
 *   - at each level the child's progress (child-progress.ts) is checked
 *     against the previous level. A HEAD or dirty-tree change in the child's
 *     cwd, sampled here once per level, counts as progress too;
 *   - a child with no progress across a whole level is frozen. The slow
 *     notice's own steer lands at each level, so a frozen child is also one
 *     that did not answer that steer with a new turn;
 *   - a frozen child with no tool call in flight is ended with kill cause
 *     `no-progress`;
 *   - a frozen child with a tool call in flight is the call-kill's case
 *     (#1465 part b, P2: kill the call's subtree, not the child). Until that
 *     lands it is left alone here; the tool-inactivity watchdog still bounds it.
 *
 * Armed only for driver children (dispatchCore, the driver's adversarial
 * rounds): a PM's own child stays the PM's call. Inert under
 * `PI_ENSEMBLE_DISPATCH_CAPS=0` (the caps master switch) and
 * `PI_ENSEMBLE_SLOW_NOTICE=0`. One instance per spawn.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChildProgress } from "./child-progress.ts";
import { levelThresholds } from "./slow-notice.ts";
import { killProcessTree } from "./spawn-kill.ts";
import { trace, traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 16 << 20 }, (err, stdout) =>
      resolve(err ? undefined : String(stdout)),
    );
  });
}

/** HEAD, the dirty-tree paths and their line counts, hashed; undefined when unreadable. */
export async function workspaceFingerprint(cwd: string): Promise<string | undefined> {
  const [status, diff] = await Promise.all([
    git(cwd, ["status", "--porcelain=v2", "--branch", "-uall"]),
    git(cwd, ["diff", "HEAD", "--numstat"]),
  ]);
  if (status === undefined) return undefined;
  return createHash("sha1")
    .update(status)
    .update(diff ?? "")
    .digest("hex");
}

export interface StallKill {
  /** The child was ended as frozen (kill cause `no-progress`). */
  killed(): boolean;
  /** ms without progress when it was ended. */
  frozenMs(): number;
  stop(): void;
}

export function armStallKill(o: {
  child: ChildProcess;
  progress: ChildProgress;
  cwd: string;
  /** A driver child; false arms nothing. */
  enabled: boolean;
  /** The child is ending anyway (exited, reported, or another kill landed). */
  settled: () => boolean;
  /** Test seams. */
  baseMs?: number;
  fingerprint?: (cwd: string) => Promise<string | undefined>;
  kill?: () => void;
  now?: () => number;
}): StallKill {
  let killed = false;
  let frozenMs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const result: StallKill = {
    killed: () => killed,
    frozenMs: () => frozenMs,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
  const baseMs = o.baseMs ?? levelThresholds(0).ms;
  if (!o.enabled || process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0" || !Number.isFinite(baseMs)) {
    return result;
  }
  const now = o.now ?? Date.now;
  const fingerprint = o.fingerprint ?? workspaceFingerprint;
  const kill = o.kill ?? (() => killProcessTree(o.child));
  const startedAt = now();
  let lastCheckAt: number | undefined;
  let lastPrint: string | undefined;

  const check = async (level: number) => {
    const print = await fingerprint(o.cwd);
    if (stopped || o.settled()) return;
    if (lastCheckAt !== undefined && print !== lastPrint) o.progress.recordWorkspaceChange();
    lastPrint = print;
    const t = now();
    const frozen = lastCheckAt !== undefined && o.progress.lastProgressAt <= lastCheckAt;
    lastCheckAt = t;
    if (frozen) {
      const calls = o.progress.inFlightCalls();
      if (calls.length > 0) {
        // P2 (#1465 part b) call-kills here; until then the call runs on.
        trace(
          `stall: frozen at level ${level} with ${calls[0]?.toolName} in flight — no call-kill yet`,
        );
      } else {
        frozenMs = t - o.progress.lastProgressAt;
        killed = true;
        trace(`stall: no progress for ${frozenMs}ms across slow level ${level} — ending the child`);
        try {
          kill();
        } catch (err) {
          traceWarn(`stall kill failed: ${String(err)}`);
        }
        return;
      }
    }
    schedule(level + 1);
  };
  const schedule = (level: number) => {
    const at = startedAt + baseMs * 2 ** level;
    timer = setTimeout(() => void check(level), Math.max(0, at - now()));
    timer.unref?.();
  };
  schedule(0);
  return result;
}

/**
 * Fold the stall kill into the result, after the cap attribution and the child
 * bound. `no-progress` ranks below the structural caps and above `child-bound`
 * and the backstop (resolveKillCause), so it replaces only those.
 */
export function applyStallKill(stall: StallKill, result: DispatchResult): void {
  const cause = result.killCause;
  // A child that finished its reply before the kill landed is done, not frozen.
  if (!stall.killed() || result.ok) return;
  if (cause && cause !== "timeout" && cause !== "abort" && cause !== "child-bound") return;
  result.killCause = "no-progress";
  result.killBudgetMs = stall.frozenMs();
}

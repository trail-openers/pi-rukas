/**
 * The exec/context builders the merged-step tests share.
 *
 * Extracted from `test-work-driver-merged-mechanized.ts` when its #1533 head-pin
 * cases moved to `test-work-driver-merged-pin.ts` (§12 file-size cap): the two
 * files drive the same production functions, and a copy of `mkExec`/`mkCtx` in
 * each would mean a fixture fix made twice and agreeing with itself by
 * accident. `HEAD_OID` is the verified head every merge in both files pins to,
 * so an assertion in one file cannot quietly describe a different commit than
 * the other.
 */

import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";

/** #1533 — the verified head every merge in the merged-step tests pins to. */
export const HEAD_OID = "7".repeat(39) + "e";

/** A host with no UI: the merged step never sends a chat message in these tests. */
export function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

export interface MockExec {
  fn: VerifyExecFn;
  calls: string[];
}

/**
 * A recording exec fake that answers by substring. The keys are matched in
 * insertion order, so a specific probe (the evidence gate's
 * `mergeStateStatus,mergeable,state`) must be listed before a general one
 * (`gh pr view`) that would otherwise answer it with the wrong shape.
 */
export function mkExec(
  o: Record<string, { stdout?: string; stderr?: string; error?: boolean }> = {},
): MockExec {
  const calls: string[] = [];
  const fn: VerifyExecFn = async (rawCmd, opts) => {
    const cmd = opts?.argv ? [rawCmd, ...opts.argv].join(" ") : rawCmd;
    calls.push(cmd);
    for (const [k, v] of Object.entries(o)) {
      if (cmd.includes(k)) {
        if (v.error) {
          const e = new Error(v.stderr ?? "err") as Error & { stderr?: string };
          e.stderr = v.stderr;
          throw e;
        }
        return { stdout: v.stdout ?? "", stderr: v.stderr };
      }
    }
    return { stdout: "" };
  };
  return { fn, calls };
}

/**
 * A driver context for the merged step. `mergeGrant: true` grants authority the
 * way `/work N --merge` does — the gate itself is covered by
 * test-merge-authority.ts, so these fixtures are not re-testing it.
 */
export function mkCtx(
  issue: number,
  exec: VerifyExecFn,
  opts?: { dispatchFn?: DriverContext["dispatchFn"]; repoRoot?: string },
): DriverContext {
  return {
    repoRoot: opts?.repoRoot ?? "/fake",
    issue,
    host: mkPi(),
    verifyExecFn: exec,
    mergeGrant: true,
    issueBodyFetcherFn: async () => ({
      stdout: `title:\ttest #${issue}\nstate:\tOPEN\n\nbody`,
    }),
    ...(opts?.dispatchFn ? { dispatchFn: opts.dispatchFn } : {}),
  } as DriverContext;
}

/**
 * public-hygiene-push-half — the PUSH half of a publish decision (#1788 round 1),
 * split out of `public-hygiene-guard.ts` at the AGENTS.md §12 size seam.
 *
 * ## The two rules this file owns
 *
 * **No executor means no push verdict, and that is not a clean pass.** A push is
 * only this guard's business when the outgoing range can be read, so with no
 * executor wired in the push half is passed — refusing every push of a role that
 * pushes all day (@ops) for a reason unrelated to hygiene is how a guard earns
 * its escape hatch, and the escape hatch switches off the check that matters.
 * Any PUBLISH SURFACE the same command carries (a `-m`, a `--body`) is still
 * judged by the caller on the text it collected. A caller that DOES supply an
 * executor and whose git then fails still gets the fail-closed problem: that is a
 * read that was attempted and broke.
 *
 * **The scan's own wall clock is not the hook's.** `exec` is a caller-supplied
 * seam, and one that ignores the timeout it is handed must not hang the hook —
 * a guard that hangs a session is a guard an operator disables. So the whole read
 * sits behind `boundedScan` at four times the per-git-call bound, generous
 * enough that a slow-but-alive git is never mistaken for a hung one.
 *
 * ## What leaves this file
 *
 * `texts` and `problems` in the scan's own shapes, so the caller's single
 * `firstHit` pass sees push-diff text and command-line text as one list. The
 * remote-URL seam is threaded through rather than left to `scanPushRange`'s
 * default: a caller that pins the trigger (the offline smoke test) must not have
 * a second, unpinned git read re-resolve it behind its back.
 */

import { scanPushRange } from "./public-hygiene-push.ts";
import { PUSH_SCAN_TIMEOUT_MS } from "./public-hygiene-scan.ts";
import type { PublishText, ScanProblem } from "./public-hygiene-types.ts";
import type { ExecFn } from "./worktree.ts";

/** What the push half of a command contributed to the decision. */
export interface PushHalf {
  texts: PublishText[];
  problems: ScanProblem[];
}

/**
 * The bounded scan every git read the guard makes goes through: a caller-owned
 * executor that ignores its timeout must not hang the hook.
 */
export async function boundedScan<T>(ms: number, work: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the outgoing range of a push and report its texts and problems.
 *
 * `undefined` from `scanPushRange` is a TIMEOUT and is reported as an unreadable
 * range, never as an empty range; a throw is reported with its error code and
 * never as a clean one.
 */
export async function readPushHalf(
  command: string,
  cwd: string,
  exec: ExecFn | undefined,
  opts: { remoteUrl?: (remote: string) => Promise<string>; pushVerb?: string },
): Promise<PushHalf> {
  if (exec === undefined) {
    return {
      texts: [],
      problems: [
        {
          location: "push range",
          reason: "could not be read (a publish surface was found but the range was not read)",
        },
      ],
    };
  }
  try {
    const pushed = await boundedScan(PUSH_SCAN_TIMEOUT_MS * 4, () =>
      scanPushRange({
        exec,
        cwd,
        remoteUrl: opts.remoteUrl,
        command,
        pushVerb: opts.pushVerb ?? "push",
      }),
    );
    if (pushed === undefined) {
      return {
        texts: [],
        problems: [
          {
            location: "push",
            reason: "the outgoing range could not be read within the scan's time limit",
          },
        ],
      };
    }
    return { texts: pushed.texts, problems: pushed.problems };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    return {
      texts: [],
      problems: [
        {
          location: "push",
          reason: `the outgoing range could not be read (${typeof code === "string" ? code : "error"})`,
        },
      ],
    };
  }
}

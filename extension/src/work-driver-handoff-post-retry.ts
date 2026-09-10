/**
 * work-driver-handoff-post-retry — retry-with-backoff for the in-process
 * handoff post (comment + label).
 *
 * The in-process forge fallback in `runHandoff` (work-driver-handoff.ts) is
 * the driver's last chance to post the handoff comment + apply the
 * needs-human-attention label before it gives up and prints the
 * "HANDOFF DISPATCH INCOMPLETE" banner with manual `gh` commands for the
 * operator. Historically that fallback was a SINGLE shot: a transient API
 * hiccup (rate limit, 5xx, network blip) on the first `issueComment` call
 * immediately became a manual-recovery task, even though a short wait and
 * retry would likely have succeeded. #659/#660 both hit exactly this shape
 * ("comment posted: [FAILED] NOT posted / label applied: [FAILED] NOT
 * applied" on the first handoff attempt).
 *
 * This module follows the same shape as `dispatch-retry.ts` /
 * `work-driver-failure-taxonomy.ts` (small bounded retries with backoff,
 * jittered, escape-hatch env var), adapted to a forge call that cannot be
 * classified by provider delay: the backoff is a fixed linear schedule
 * (1s * attempt) with full jitter, bounded to 3 total attempts.
 *
 * Idempotency notes (edge-case #674):
 *   - `issueComment` is retried only when the previous attempt threw
 *     (a thrown call posted nothing); a call that returned a value was
 *     recorded by the caller before the retry loop, so it is never
 *     re-issued. A transient API hiccup between "server accepted" and
 *     "client saw the response" could still double-post on the retry —
 *     the existing re-entry dedupe (`priorHandoffCommentUrl`) covers the
 *     crash-resume shape, and a duplicate handoff comment is recoverable
 *     whereas a missing one is not.
 *   - `labelCreate` is idempotent server-side ("already exists" is
 *     swallowed) and `labelAdd` is idempotent (`gh --add-label` semantics),
 *     so retrying either is safe by construction.
 *
 * The banner in work-driver-handoff-message.ts is unchanged: it still
 * fires when commentUrl/labelApplied are missing, which now happens only
 * AFTER retries are exhausted.
 */

import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import { parseHandoffCommentUrl } from "./work-driver-handoff.ts";

/** Max attempts (total calls, not retries). 3 = initial + 2 retries. */
const MAX_POST_ATTEMPTS = 3;

/**
 * Escape hatch: `PI_ENSEMBLE_HANDOFF_POST_RETRY=0` restores the
 * single-attempt behaviour (matches the `PI_ENSEMBLE_TRANSIENT_RETRY=0`
 * convention in work-driver-failure-taxonomy.ts).
 */
export function handoffPostRetryEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY;
  return v !== "0" && v !== "false";
}

/**
 * Base backoff in ms, scaled by attempt. Overridable so the offline
 * suite doesn't actually sleep (same pattern as `transientRetryBackoffMs`).
 */
export function handoffPostBackoffMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 1_000;
}

export interface ForgePostResult {
  /** Parsed comment URL, or undefined when the post never succeeded. */
  commentUrl: string | undefined;
  /** True once the label was applied (idempotent — safe to re-apply). */
  labelApplied: boolean;
  /** Number of issueComment attempts actually made (0 when not needed). */
  commentAttempts: number;
  /** Number of label attempts actually made (0 when not needed). */
  labelAttempts: number;
}

/**
 * Post the handoff comment + apply the attention label via the forge,
 * retrying transient failures with jittered linear backoff.
 *
 * `needsComment` / `needsLabel` mirror the `!commentUrl` / `!labelApplied`
 * guards at the call site — a healthy dispatch that parsed a URL skips the
 * comment post entirely (the label is still applied mechanically because
 * `--add-label` is idempotent and narration cannot establish a side effect
 * happened — #408).
 *
 * Best-effort: a forge that hard-fails every attempt degrades to
 * `commentUrl: undefined` / `labelApplied: false`, which is exactly the
 * shape the INCOMPLETE banner renders. This function never throws.
 */
export async function postHandoffWithRetry(
  forge: Forge,
  opts: {
    issue: number;
    body: string;
    targetId: number;
    /** "issue" when the target is the issue (forge issue-comment shape), "pr" otherwise. */
    objType: "issue" | "pr";
    needsComment: boolean;
    needsLabel: boolean;
    /** Injectable clock/sleep for the offline suite. */
    sleep?: (ms: number) => Promise<void>;
    rand?: () => number;
    /** Injectable clock for the trace line. */
    now?: () => number;
  },
): Promise<ForgePostResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.rand ?? Math.random;
  const now = opts.now ?? Date.now;
  const result: ForgePostResult = {
    commentUrl: undefined,
    labelApplied: false,
    commentAttempts: 0,
    labelAttempts: 0,
  };

  const backoffFor = (attempt: number): number => {
    // Linear schedule (1s * attempt) with full jitter on top — the same
    // shape as the step-router's transient backoff, sized for a transient
    // API hiccup rather than a provider quota window.
    const base = handoffPostBackoffMs() * attempt;
    return Math.ceil(rand() * Math.max(base, 0));
  };

  // The effective attempt bound: the escape hatch (PI_ENSEMBLE_HANDOFF_POST_RETRY=0)
  // restores single-attempt behaviour by capping the loop at 1.
  const maxAttempts = handoffPostRetryEnabled() ? MAX_POST_ATTEMPTS : 1;

  // Comment post (retry only when the previous attempt THREW — a returned
  // value was recorded before the loop advanced, so a successful call is
  // never re-issued).
  if (opts.needsComment) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result.commentAttempts = attempt;
      try {
        const out = await forge.issueComment(opts.issue, opts.body);
        const parsed = parseHandoffCommentUrl(out) ?? out.trim();
        if (parsed) {
          result.commentUrl = parsed;
          break;
        }
        // Empty / unparseable response: the post did not succeed, but it
        // also did not throw. Treat like a failure and retry (idempotency
        // note above applies).
        trace(
          `work-driver: handoff forge issueComment returned an unparseable value (attempt ${attempt}/${MAX_POST_ATTEMPTS})`,
        );
      } catch (err) {
        trace(
          `work-driver: handoff forge issueComment failed (attempt ${attempt}/${MAX_POST_ATTEMPTS}): ${(err as Error).message?.slice(0, 200)}`,
        );
      }
      if (attempt < maxAttempts) {
        const wait = backoffFor(attempt);
        if (wait > 0) await sleep(wait);
      }
    }
  }

  // Label: create (idempotent, swallow "already exists") then add.
  if (opts.needsLabel) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result.labelAttempts = attempt;
      try {
        try {
          await forge.labelCreate("needs-human-attention", "FFAA00");
        } catch {
          /* already exists or no perms; continue (same as the original) */
        }
        await forge.labelAdd(
          opts.objType === "pr" ? "mr" : "issue",
          opts.targetId,
          "needs-human-attention",
        );
        result.labelApplied = true;
        break;
      } catch (err) {
        trace(
          `work-driver: handoff forge label post failed (attempt ${attempt}/${MAX_POST_ATTEMPTS}): ${(err as Error).message?.slice(0, 200)}`,
        );
      }
      if (attempt < maxAttempts) {
        const wait = backoffFor(attempt);
        if (wait > 0) await sleep(wait);
      }
    }
  }

  if (!result.commentUrl || !result.labelApplied) {
    trace(
      `work-driver: handoff post retries exhausted (now=${now()}) — commentAttempts=${result.commentAttempts} labelAttempts=${result.labelAttempts}; the INCOMPLETE banner will surface the manual gh commands`,
    );
  }
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

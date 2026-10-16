/**
 * work-driver-dirty-root-exempt-notice — #1362 fix round: making an unreadable
 * `.pi/dirty-root-exempt` visible to the operator, not only on stderr.
 *
 * The issue's settlement says a broken config yields the empty list **plus a
 * trace**. That is right for a cycle that goes on to succeed and wrong for the
 * one shape where it costs the most: the cycle then blocks on repo-root
 * residue, and the handoff an operator reads says "your repo root is dirty —
 * here are the paths" with no hint that the file which would have exempted them
 * failed to load. Every one of those paths was judged against an EMPTY list, so
 * a tool's own settings file reads exactly like a previous cycle's residue.
 * `traceWarn` writes to stderr, which is not an artifact anybody reads.
 *
 * So the failure is recorded, on three surfaces, because each has a different
 * reader and none of them sees the others:
 *
 *   1. the cycle context — the branch step's dirty-root block folds it into its
 *      own residue report, which is the message an operator who blocked
 *      actually reads (work-driver-branch-residue.ts);
 *   2. `pipelineState.plumbReports` — `plumbReportSection` renders THAT field
 *      into the handoff body; it does not read the event log, so recording only
 *      an event would be invisible in the same way a trace is;
 *   3. a `plumb-report` **event** — what `/work-status` and any event-log
 *      reader sees.
 *
 * The event reuses the existing `plumb-report` kind deliberately: a NEW kind
 * would change the event-log tail, and `nextStep()` routes on it.
 */

import type { CycleContext } from "./work-driver-context.ts";
import {
  dirtyRootExemptReadEvent,
  dirtyRootExemptReadNotice,
} from "./work-driver-dirty-root-exempt.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Record an unreadable exemption file on the cycle context (surface 1) for the
 * rest of the cycle.
 *
 * It sets ONLY the context field. Surfaces 2 and 3 are written by
 * `withDirtyRootExemptReadFailure`, which `runWorkDriverInner` applies to the
 * state immediately before its first persist — the one writer of that record.
 * This function deliberately does not persist anything itself: it is called
 * before that first write exists, so a write here would either create a state
 * file the driver's own first snapshot then overwrite, or fire a
 * read-then-write after it and race a later step's snapshot onto a stale copy.
 * Both are the #1162 per-file write-ordering hazard; one writer avoids it.
 *
 * So the record is deferred by one step-boundary rather than lost: every path
 * that reads the exemption file goes through `runWorkDriver`'s one read point,
 * which is called from `runWorkDriverInner`'s own preamble.
 */
export function noticeDirtyRootExemptReadFailure(ctx: CycleContext, reason: string): void {
  ctx.dirtyRootExemptReadFailed = reason;
}

/**
 * Surfaces 2 + 3 applied to a state. Idempotent — a resumed cycle whose file
 * already carries the record comes back byte-identical rather than with a second
 * copy of the same sentence, which a handoff with three of these in it would
 * read as three failures.
 *
 * Exported for `runWorkDriverInner`'s first persist and for the smoke test that
 * asserts the handoff actually renders it.
 */
export function withDirtyRootExemptReadFailure(state: WorkState, reason: string): WorkState {
  const body = dirtyRootExemptReadNotice(reason);
  const already = (state.pipelineState.plumbReports ?? []).some((r) => r.body === body);
  const logged = state.eventLog.some((e) => e.kind === "plumb-report" && e.body === body);
  if (already && logged) return state;
  const next = logged ? state : appendEvent(state, dirtyRootExemptReadEvent(reason));
  if (already) return next;
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      plumbReports: [
        ...(next.pipelineState.plumbReports ?? []),
        { step: "branch", role: "driver", body, at: Date.now() },
      ],
    },
  };
}

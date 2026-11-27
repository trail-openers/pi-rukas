/**
 * lean/pre-verify-share — the wall the steps BEFORE the first verify share, and what a stop says.
 *
 * `specify` and `challenge` are bounded per CHILD and never together, so a cell could spend
 * 1100 to 1800 of its 4200 seconds on the pair and still be asked to open `review`, which needs
 * the handoff allowance plus {@link REVIEW_DEADLINE_RESERVE_MS} left just to START (see
 * `review-bound.ts`). The reserve then fired on a head that was already green and published — the
 * cell handed back unverified. This module bounds the PAIR, so the run reaches its gate with time
 * for the review behind it.
 *
 * Both readings happen BEFORE a dispatch and neither is a kill: the pair's spend is the sum over
 * every `specify` and `challenge` entry in the DURABLE step log (so a resumed run is charged what
 * an earlier process spent, and every visit counts), and once the share of the cell is used the
 * step dispatches nobody further; `challenge` is skipped instead of run. At `challenge` entry the
 * time the resolved deadline still leaves is measured against the same reserve plus
 * {@link ONE_VERIFY_MS}.
 *
 * `inert` says so rather than reporting a bound that held, on both of its arms: no resolved
 * deadline (an absent deadline is never a reason to shrink work), or `PI_ENSEMBLE_DISPATCH_CAPS=0`.
 * A child already in flight is never cut here — the per-child ceilings stay the only kill lever.
 */
import { capsEnabled } from "../spawn-child-bound.ts";
import { MINUTE_MS, handoffAllowanceMs } from "./deadline.ts";
import { leanPreVerifySharePercent } from "./pre-verify-share-switch.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./review-bound.ts";
import type { Step } from "./state.ts";

/** The gate the skipped round stands in for: the figure `verify` is planned around. `verify` has no
 *  `DEFAULT_BUDGETS` row, so this is a named figure the skip quotes, not a budget it is armed from. */
export const ONE_VERIFY_MS = 20 * MINUTE_MS;

/** What the two steps share, from the run's own record and its resolved deadline. */
export interface PreVerifyShare {
  /** Dispatch nothing further. Present only when a live bound stopped the step. */
  stop?: true;
  /** Nothing was bounded: no resolved deadline, or the caps master switch is off. */
  inert: boolean;
  /** Seconds of the cell the pair has spent. */
  usedSeconds: number;
  /** Why nothing was bought — one stable, printable line, and the record's own field. */
  reason?: string;
}

/** The pair's whole spend over EVERY visit in the durable log, in seconds; a still-running entry
 *  is charged up to the reading instant. */
function usedSecondsOf(steps: Step[], now: number): number {
  let ms = 0;
  for (const step of steps)
    if (step.state === "specify" || step.state === "challenge")
      ms += Math.max(0, (step.endedAt ?? now) - step.startedAt);
  return Math.floor(ms / 1000);
}

/** The skip's one stable line: the bench counts it per cell, so the wording is the contract. */
function skipped(usedSeconds: number, cause: string): PreVerifyShare {
  return { inert: false, usedSeconds, stop: true, reason: `challenge SKIPPED: ${cause}` };
}

/**
 * Where the pair stands against its share, right now — asked at each step entry and at each
 * dispatch point, since a bound read once would bound only the first child. `cellMs` is the
 * resolved cycle deadline less the instant the run began. The bound is inert — and says so — with
 * no deadline, with caps off, or at the switch's `0`, which short-circuits HERE rather than in the
 * reader: a zero percent would otherwise make the share zero seconds and bound the pair at its
 * TIGHTEST, the opposite of taking the change out.
 */
export function preVerifyShare(
  steps: Step[],
  deadlineMs: number | undefined,
  startedMs: number | undefined,
  now: number,
): PreVerifyShare {
  const usedSeconds = usedSecondsOf(steps, now);
  const percent = leanPreVerifySharePercent();
  if (percent === 0 || deadlineMs === undefined || startedMs === undefined || !capsEnabled())
    return { inert: true, usedSeconds };
  const cellMs = deadlineMs - startedMs;
  // Whole SECONDS, the unit the record and the reason line both print.
  const shareSeconds = Math.round((cellMs * percent) / 100_000);
  if (usedSeconds < shareSeconds) return { inert: false, usedSeconds };
  return skipped(
    usedSeconds,
    `pre-verify share ${String(percent)}% of the ${String(
      Math.round(cellMs / 1000),
    )}s cell used up (used ${String(usedSeconds)}s)`,
  );
}

/**
 * Whether `challenge` runs at all. The share decides first; then the time the deadline still
 * leaves at this instant, which must cover the review reserve (the two helpers the review step
 * itself reads, never a literal) and one verify.
 */
export function challengeSkip(
  steps: Step[],
  deadlineMs: number | undefined,
  startedMs: number | undefined,
  now: number,
): PreVerifyShare {
  const share = preVerifyShare(steps, deadlineMs, startedMs, now);
  if (share.stop === true || share.inert) return share;
  const leftMs = (deadlineMs ?? now) - now;
  const floorMs = handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS + ONE_VERIFY_MS;
  if (leftMs > floorMs) return share;
  return skipped(
    share.usedSeconds,
    `cycle deadline left ${String(Math.max(0, Math.round(leftMs / MINUTE_MS)))} min, inside the ${String(
      Math.round(floorMs / MINUTE_MS),
    )} min reserve plus one verify (used ${String(share.usedSeconds)}s)`,
  );
}

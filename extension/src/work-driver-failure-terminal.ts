/**
 * work-driver-failure-terminal — the TERMINAL rungs of the 429 ladder, and the
 * one place a KILLED dispatch is allowed to read them (#1798 rounds 3 + 4).
 *
 * Split out of `work-driver-failure-taxonomy.ts` (AGENTS.md §12 file-size
 * limit), following the same seam as `work-driver-provider-backoff.ts`: the
 * taxonomy stays the single classifier and the owner of every `cause` name;
 * this module answers one question — *does this provider text name an outage
 * that waiting cannot clear?* — and both of the classifier's terminal call
 * sites ask it here, so they cannot drift apart about what "terminal" means.
 *
 * That drift was #1798 round 3's actual defect: the classifier read a kill as
 * a self-kill while the same text halted the whole queue from the other
 * surface, because two modules had each derived "is this a spend cap" for
 * themselves.
 *
 * No import from the taxonomy: it imports THIS module, and a leaf that imports
 * its own consumer back for one constant turns a clean seam into a cycle. The
 * burst threshold is therefore passed IN by each caller — the classifier's own
 * `burstThresholdSeconds()`, read once per classification, so there is still
 * exactly one knob and one reading of it.
 */

import {
  type DispatchFailureCause,
  isRateLimit429Msg,
  isSpendCapMsg,
  parseRetryDelaySeconds,
} from "./types.ts";
import { isFixerBoundKill } from "./work-driver-lens-fix-bound-land.ts";

/** The two terminal causes, narrowed from the full cause union. A caller that
 *  branches on these does not get to add a third by widening the union. */
export type TerminalProviderCause = "rate-limited:quota-terminal" | "rate-limited:quota-window";

/**
 * #1798 round 3/4 — the terminal rung of the 429 ladder, in one place.
 *
 * A 429 says two different things and only the number inside it tells them
 * apart: a spend cap (waiting cannot clear it, so every later group meets it)
 * and a quota window whose stated delay is beyond the burst threshold (nothing
 * will succeed until it resets). Both are terminal; a quota window carries
 * `waitMs`, the delay the provider asked for, in ms.
 *
 * NOT terminal, so not returned: a burst (a delay short enough to wait out in
 * cycle — the classifier's own retryable rung) and a 429 with no delay stated
 * (the conservative pre-#366 halt, which is a rung of its own).
 *
 * THE ladder, not a second reading of it: `classifyFailureCause`'s 429 block
 * and `terminalProviderClassOnKill` both ask this one question.
 */
export function terminalProviderClass(
  msg: string,
  burstThresholdS: number,
): { cause: TerminalProviderCause; waitMs?: number } | undefined {
  if (!isRateLimit429Msg(msg)) return undefined;
  // A spend cap: waiting cannot clear it, and every later group meets it. No
  // wait to report — there is nothing to wait for.
  if (isSpendCapMsg(msg)) return { cause: "rate-limited:quota-terminal" };
  const delayS = parseRetryDelaySeconds(msg);
  if (delayS === undefined || delayS <= burstThresholdS) return undefined;
  return { cause: "rate-limited:quota-window", waitMs: Math.ceil(delayS * 1000) };
}

/**
 * #1798 round 3 — a TERMINAL provider fact outranks a structured kill.
 * ROUND 4 — SCOPED to the event that actually owns the provider's words.
 *
 * The #296 rule ("a self-kill is never a provider failure") is about the KIND
 * of the event and about not re-dispatching a child we killed on purpose, and
 * both hold here: this returns a classification only for a TERMINAL outage
 * class, whose `shouldRetry` is false, so no kill is ever retried because of
 * it. What the rule was never meant to do is DELETE the provider's own words.
 * `buildCompletionEvent`'s kill branch owns the event and stamps
 * `providerMessage` when the stream was severed at the same moment (#1798
 * round 1), and the kill branches all returned before that field was read — so
 * a fixer killed at its bound by a spend-cap 429 classified
 * `self-killed:timeout`, `isSystemicFailure` (work-queue.ts) saw a non-provider
 * cause and let the remaining groups start, and each of them met the same cap.
 *
 * ROUND 4 — WHAT THE OVERRIDE IS ALLOWED TO READ. Round 3 applied it on ANY
 * kill, and that is too wide: a child-supervision kill (`no-progress`,
 * `stuck-tool`) is pi-rukas ending a child it judged stalled, and #1682 puts
 * such deaths on the PROVIDER kind — so an adversarial reviewer killed by the
 * supervision policy whose stream happened to carry 429 spend-cap text HALTED
 * THE WHOLE QUEUE, on text nobody in the driver is obliged to believe. The
 * override is therefore gated on two things:
 *
 *  - `kind === "dispatch-failed"` — the member `buildCompletionEvent`'s kill
 *    branch owns, which is the ONLY writer that stamps `providerMessage` on a
 *    killed dispatch, and does so from `result.errorStop.message`: the
 *    endpoint's own response, captured by the spawn layer. A provider-kind
 *    event never reaches here; it classifies through the ordinary 429 ladder,
 *    which has always read `providerMessage` for every event.
 *  - `isFixerBoundKill(killCause)` — the two causes a bound pi-rukas ARMED for
 *    THIS child produced (`timeout`, `child-bound`). A child the supervision
 *    policy ended is not a child whose bound the provider cut, and it keeps the
 *    classification its own kill cause chooses.
 *
 * Beyond that pair the rule stays STEP-AGNOSTIC, deliberately: a develop step
 * killed at its own bound whose stream a spend cap cut IS systemic — the next
 * group meets the same cap whatever the step was. Step is not read.
 *
 * Read ONLY from `providerMessage` — the endpoint's own text, never the child's
 * prose, which is the same evidence bar as `isProviderOutage`.
 */
export function terminalProviderClassOnKill(
  tail: {
    kind: string;
    killCause?: Parameters<typeof isFixerBoundKill>[0];
    providerMessage?: string;
  },
  burstThresholdS: number,
): { cause: TerminalProviderCause } | undefined {
  if (tail.kind !== "dispatch-failed") return undefined;
  if (!isFixerBoundKill(tail.killCause)) return undefined;
  const msg = tail.providerMessage;
  if (msg === undefined || msg.length === 0) return undefined;
  const terminal = terminalProviderClass(msg, burstThresholdS);
  if (terminal === undefined) return undefined;
  // No `waitMs` on a KILL: the child is never re-dispatched, so a wait it will
  // not sit out is a number nobody acts on (and `isSystemicFailure` derives its
  // own hours figure from the provider's stated delay). The terminal CAUSE is
  // the fact the queue halts on.
  return { cause: terminal.cause };
}

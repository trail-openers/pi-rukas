/**
 * review-bounds-verdict-stop — the live post-verdict stop and its accumulator
 * (#1827 round 5).
 *
 * Split out of `review-bounds.ts` along the seam that module already had: this file
 * owns the object that ACCUMULATES the reviewer's reply and decides, from the
 * message in hand, whether that reply ends the review. The verdict READING rules
 * are `review-bounds-verdict.ts` (`verdictEndingMessage`); the seam that ENDS a
 * child on the decision is `observeReviewBounds` in `review-bounds.ts`, which is
 * also the only caller of `markEnded()`.
 *
 * The round-5 reason the accumulator lives beside the budget it obeys: the
 * accumulation IS the result the spawn reports when the stop fires, so the cap and
 * the matched closing block have to be read together — see
 * `VERDICT_ACCUMULATION_BUDGET` and the forced append below.
 */

import { adapterFor } from "./model-adapters.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import {
  type VerdictStatus,
  appendBounded,
  verdictEndingMessage,
} from "./review-bounds-verdict.ts";

/** The same master switch every other reviewer cap honours: with
 *  `PI_ENSEMBLE_DISPATCH_CAPS=0` no bound of ours ends a child. Read per call so
 *  a test (or an operator) that flips the knob between spawns is respected. */
function capsOn(): boolean {
  return process.env.PI_ENSEMBLE_DISPATCH_CAPS !== "0";
}

export interface VerdictStop {
  /** Feed one parsed child event. True once a verdict has been seen. */
  observe(event: PiJsonEvent): boolean;
  /** The accumulated assistant text the verdict was parsed from. */
  text(): string;
  /** The parsed verdict, once stopped. Typed as `VerdictStatus` (#1827 round 4):
   *  a bare `string` here let a caller compare the stop's word against a typo the
   *  compiler could not see, and it is the value the fold reports as accepted. */
  status(): VerdictStatus | undefined;
  /** Record that the stop ENDED this child. The only caller is
   *  `observeReviewBounds`, on the branch that arms, closes stdin and kills — so
   *  `stopped()` below means "this child was actually ended", never merely "a
   *  verdict was seen". The fold's SINGLE source of that fact (#1827 round 4 —
   *  the wiring's duplicate `stoppedByVerdict` boolean is gone, so a clean end
   *  is recorded in exactly one place). */
  markEnded(): void;
  /** The stop FIRED — the child was armed, its stdin closed and ended. */
  stopped(): boolean;
}

/**
 * The live post-verdict stop. Accumulates every text block of every assistant
 * `message_end` (that accumulation is the RESULT the spawn reports when the
 * stop fires), and decides from the message it is handed — never from a
 * cross-message window. The first version read the newest eight blocks joined,
 * so a menu echoed three turns earlier was still in the scan of the turn that
 * stopped the child.
 *
 * The decision itself is `verdictEndingMessage` in review-bounds-verdict.ts:
 * the LAST non-empty text block of a tool-free message, naming exactly one
 * distinct verdict, on a line outside any fence. The reviewer's own brief
 * quotes all four values as a menu, so "the marker appears somewhere in the
 * tail" was never a question that could distinguish a verdict from a quotation.
 *
 * `text()` returns the whole accumulation, and the fold sets `result.text` to
 * it whenever the stop fired — so the status the stop recorded and
 * `parseVerdict(result.text).status` are the same value, and the findings text
 * `parseVerdict` records alongside the status is the reviewer's whole report
 * rather than its last paragraph.
 */
export function createVerdictStop(): VerdictStop {
  // The same master switch as the re-read cap: with `PI_ENSEMBLE_DISPATCH_CAPS=0`
  // no bound of ours ends a child, and docs/configuration.md says so. The stop
  // is gated at the decision rather than at the accumulator — the accumulation
  // is the RESULT the spawn reports, so it must keep collecting text whatever
  // the caps say. A disabled stop can never report a status and can never be
  // marked stopped, so the caller's kill branch is unreachable, the fold stays
  // silent, and the reviewer runs its natural tail.
  const active = capsOn();
  const parts: string[] = [];
  // Running total of `parts` (plus the "\n" joins), maintained by
  // `appendBounded` — re-summing the buffer per block was quadratic on a child
  // that may run 400+ turns.
  const used = { total: 0 };
  let stopped: VerdictStatus | undefined;
  // Set on the branch of `observeReviewBounds` that ends the child, through the
  // seam below. Distinct from `stopped`, which the parse sets: with the caps off
  // a verdict is read and nothing is ended.
  let ended = false;
  return {
    observe: (event) => {
      const msg = event.message;
      if (event.type !== "message_end" || msg?.role !== "assistant") return stopped !== undefined;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") return stopped !== undefined;
      // Resolved ONCE for the message, not once per text block: the adapter is a
      // property of the model that produced it, and this is the hot path.
      const adapter = adapterFor(msg.model, msg.provider);
      const texts: Array<{ type: "text"; text: string }> = (msg.content ?? []).filter(
        (b) => b.type === "text" && !!b.text,
      ) as Array<{ type: "text"; text: string }>;
      const keeps = texts.filter((b) => adapter.isArtifactText?.(b.text) !== true);
      // Everything but the LAST kept block: the closing block is held back until
      // the decision below, because if a stop fires it must be appended past the
      // budget WHOLE (`force`), and appending it here too would double it.
      for (const block of keeps.slice(0, Math.max(0, keeps.length - 1))) {
        // The SAME model-adapter filter `collapseEvents` applies, so a GLM
        // "None" placeholder never reaches `result.text` through the frozen
        // reply, and the SAME bounded append: the accumulation is the result the
        // spawn reports, so it collects under the caps too and must not grow
        // without limit on a 400-turn child.
        appendBounded(parts, block.text, used);
      }
      if (stopped) return true;
      if (!active) {
        // Caps off: nothing ends a child, but the reply still accumulates in full.
        const tail = keeps[keeps.length - 1];
        if (tail) appendBounded(parts, tail.text, used);
        return false;
      }
      // One reader, one rule, on the message in hand: no text block, a tool
      // call anywhere in the message, or a last block that does not close on a
      // single unfenced verdict — all return undefined and the child runs on.
      const hit = verdictEndingMessage(msg);
      const closing = keeps[keeps.length - 1];
      if (hit) {
        stopped = hit;
        // #1827 round 5 — the block the stop MATCHED goes in past the budget,
        // WHOLE, and it is the ONLY block that ever does. The fold sets
        // `result.text` to this accumulation, so a budget that dropped the matched
        // line — or filled the room that was left with a truncated prefix no reader
        // matches — made `parseVerdict(result.text)` disagree with the very stop
        // that ended the child, and a clean review read as incomplete. The memory
        // bound is therefore the budget plus one closing block.
        if (closing) appendBounded(parts, closing.text, used, true);
      } else if (closing) {
        // No stop: the closing block is ordinary prose and obeys the budget.
        appendBounded(parts, closing.text, used);
      }
      return stopped !== undefined;
    },
    text: () => parts.join("\n"),
    status: () => stopped,
    markEnded: () => {
      ended = true;
    },
    // Read at the fold, so it must reflect the ACT of stopping — set on the
    // branch in `observeReviewBounds` that ends the child — and not merely the
    // accumulation, which runs whatever the caps say.
    stopped: () => ended,
  };
}

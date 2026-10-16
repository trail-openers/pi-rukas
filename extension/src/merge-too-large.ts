/**
 * merge-too-large — the refusal the size bound (merge-size.ts) emits, kept
 * beside the `refuse()` shape it has to produce.
 *
 * #1417 restored the bound after #962 deleted it, and the classifier that
 * applies it (merge-allowlist.ts) was already at the file-size limit. The
 * bound's clause is three lines of prose and its own constant, so the pair
 * lives here: merge-size.ts owns the NUMBER and the PREDICATE, this module
 * owns the WORDING, and merge-allowlist.ts owns the call. One reason code,
 * one sentence, one place each.
 */

import type { MergeCommand } from "./merge-allowlist.ts";

/**
 * The bound's refusal. The code is bare (`too-large`) per the #1417 split —
 * `reason` for consumers that compare it, `detail` for the human reading the
 * hold — and the length is named, because "your command is too long" without
 * the number is not actionable.
 */
export function refuseTooLarge(length: number): MergeCommand {
  return {
    kind: "refused",
    reason: "too-large",
    detail: `the command is ${length} characters, past the bound the guard will read, so nothing in it was analysed — split it into shorter commands`,
  };
}

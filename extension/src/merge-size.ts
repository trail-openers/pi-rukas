/**
 * merge-size — the merge-guard classifier's size bound (#955 lens round 6,
 * restored by #1417) and the single place it is applied.
 *
 * The history is why this is its own module rather than a constant at the
 * call site. The pre-#962 matcher (`mergesPr`) walked every shell segment and
 * recursed into `( … )` / `$( … )` / backtick bodies — O(depth × length),
 * pathological on long nested-substitution input: a 64k-char merge-bearing
 * command took >10s. The bound refused such a command explicitly instead of
 * walking it, and `merge-guard.ts` and `bash-merges-pr.ts` shared ONE
 * constant and ONE predicate so the guard's refusal and the matcher's
 * fail-closed span could never disagree about which commands exceed it.
 *
 * #962 replaced the walk with a strict allowlist — every pass is now linear,
 * so the DoS the bound was measured against no longer exists — and deleted
 * this module along with the matcher. #1417 restores it for the reason that
 * has nothing to do with time: an unanalysably long merge-bearing command must
 * be HELD, not answered. Without a bound a 40k-char `gh … merge …` command
 * lexes to `not-a-forge-command` at best and, when its words do spell the
 * accepted form, falls through to current-branch PR resolution — the #955
 * failure mode, where the guard merges the branch's PR on a command it never
 * actually read.
 *
 * The bound stays LOW (8000) for the same reason as before: well above the
 * longest realistic merge command (a few hundred chars) with margin. What it
 * bounds is only the commands that could BE a merge — see
 * `exceedsAnalysisBound`. #1417 round 1: the first cut bounded every
 * forge-naming command, which held a long READ (`gh pr view 17 --json body`
 * plus a long argument) on the length axis — the same symptom #1417 exists to
 * remove, and one the troubleshooting entry told the agent to cure by "writing
 * a plain `gh api` GET", a remedy that cannot work when length alone is the
 * hold.
 */

import type { MergeCommand } from "./merge-allowlist.ts";
import { FORGE_WORD } from "./merge-lex-views.ts";
import { refuseTooLarge } from "./merge-too-large.ts";
import { triggerCode } from "./merge-trigger.ts";

/**
 * Maximum length (chars) of a merge-bearing command the classifier reads.
 * A command LONGER than this that also names a forge word AND spells a merge
 * word is refused as `too-large` — held, named, and never resolved to the
 * current branch's PR. See `exceedsAnalysisBound` for the exemptions.
 */
export const MERGE_COMMAND_SIZE_BOUND = 8000;

/**
 * True when `command` exceeds the size bound AND is merge-bearing — the only
 * shape whose words the classifier cannot be trusted to read.
 *
 * Two exemptions, both of which make the bound say the same thing the rest of
 * the classifier would have said anyway:
 *
 * - a long command that names no forge word at all — a 30k-char
 *   `git commit -m "…merge…"`, a 9 kB `git log` or `echo` — is never too
 *   large: reading it is cheap and its honest answer is "not a merge";
 *
 * The forge test is the trigger's own word set, `FORGE_WORD`, not a narrower
 * `includes("gh")`/`includes("glab")` pair. The bound exists so that a command
 * whose words the classifier cannot be trusted to read is HELD rather than
 * answered; "which commands could be a merge" is therefore the same question
 * the trigger asks, and must be answered with the same pattern. A `curl -X PUT
 * https://api.github.com/repos/o/r/pulls/1/merge` of 9 kB is exactly such a
 * command — the REST merge door of #955, spelled with an HTTP client instead
 * of `gh` — and a substring test on the two forge CLIs called it exempt, so it
 * fell past the bound to `not-a-forge-command` on unbounded text instead of
 * taking the ledger-checked `too-large` path.
 * - a long command that spells **no merge word at all** — a `gh pr view` with
 *   a long `--jq` filter, a labels or timeline read, a 9 kB pasted changelog
 *   in a `gh pr create --body`. The trigger is a literal word search, so
 *   `triggerCode` answers that question in the same linear pass the bound
 *   itself costs, and the answer is identical to the one the classifier gives
 *   below the bound: no merge word → `none` → the command runs.
 *
 * That is a widening, not a weakening. Nothing past the bound is ever read as
 * a `merge` with or without this exemption — the bound refuses anything it
 * bounds — so an agent cannot reach current-branch PR resolution (#955) by
 * making its command long. What the exemption costs is a hold on a command
 * that could not have merged; what it buys is that length stops being a
 * reason to refuse a read, which is the #1417 symptom on its last axis.
 */
export function exceedsAnalysisBound(command: string): boolean {
  if (command.length <= MERGE_COMMAND_SIZE_BOUND) return false;
  if (!FORGE_WORD.test(command)) return false;
  return holdsLongCommand(command);
}

/**
 * Whether a long forge-word-naming command is one the guard would have to read:
 * it spells a merge word, a `pr|mr merge|accept` verb pair, or a GraphQL
 * `mutation` naming a merge. A cheap shape test, not a lex — this runs on the
 * path every bash tool_call takes. Anything it lets through still faces the
 * trigger and the grammar afterwards, so the exemption can only ever shorten a
 * refusal, never manufacture a merge.
 */
function holdsLongCommand(command: string): boolean {
  return triggerCode(command) !== undefined;
}

/**
 * The bound's verdict for a command, or undefined when the bound does not
 * apply. `readMergeCommand` calls this first, before the read allowlist, so
 * the one question this module answers is answered in one place: a
 * merge-bearing command too long to read is refused with `too-large` and the
 * length that triggered it, never analysed and never passed through.
 */
export function analysisBound(command: string): MergeCommand | undefined {
  return exceedsAnalysisBound(command) ? refuseTooLarge(command.length) : undefined;
}

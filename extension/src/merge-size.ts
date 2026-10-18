/**
 * merge-size — the merge-guard size bound (#955 lens round 6, restored by
 * #1417) and the single place it is applied.
 *
 * The history is why this is its own module rather than a constant at the
 * call site. The matcher that pre-dated #962's allowlist (`mergesPr`, in
 * `bash-merges-pr.ts`) walked every shell segment and recursed into `( … )` /
 * `$( … )` / backtick bodies — O(depth × length), pathological on long
 * nested-substitution input: a 64k-char merge-bearing command took >10s. The
 * bound refused such a command explicitly instead of walking it, and the guard
 * and that matcher shared ONE constant and ONE predicate so the guard's
 * refusal and the matcher's fail-closed span could never disagree about which
 * commands exceed it. That matcher — and `merge-analyse.ts`, `merge-parse.ts`,
 * `merge-tokens.ts`, `merge-verb-head.ts`, `merge-wrappers.ts` and this module
 * with them — was DELETED by #1357 (c26dd86) when the walk became a strict
 * allowlist, so it is not in this branch and is not a live consumer; #1417
 * restores the bound for the reason that has nothing to do with time: an
 * unanalysably long merge-bearing command must be HELD, not answered. Without
 * a bound a 40k-char `gh … merge …` command
 * lexes to `not-a-forge-command` at best and, when its words do spell the
 * accepted form, falls through to current-branch PR resolution — the #955
 * failure mode, where the guard merges the branch's PR on a command it never
 * actually read.
 *
 * The bound stays LOW (8000) for the same reason as before: well above the
 * longest realistic merge command (a few hundred chars) with margin. #1417
 * round 1: the first cut bounded every forge-naming command, which held a long
 * READ (`gh pr view 17 --json body` plus a long argument) on the length axis —
 * the same symptom #1417 exists to remove, and one the troubleshooting entry
 * told the agent to cure by "writing a plain `gh api` GET", a remedy that
 * cannot work when length alone is the hold.
 *
 * TWO PREDICATES, TWO CONSUMERS — do not collapse them into one.
 *
 *   - `exceedsAnalysisBound` — length past the bound AND a forge word, and
 *     NOTHING ELSE. This is the matcher's predicate: the one a caller that
 *     has to fail CLOSED answers "should I keep analysing?" with. A command it
 *     calls too large gets no analysis at all, so its caller must be holding a
 *     merge; nothing in it may reach a `not a merge` verdict.
 *   - `exceedsClassifierBound` — the same, AND `holdsLongCommand` (the command
 *     spells a merge shape). `analysisBound` / `readMergeCommand` are its only
 *     consumers. #1417's exemption lives HERE and only here: a long command
 *     that spells no merge word is a read, and the classifier is entitled to
 *     answer `none` for it because it can answer that in one linear pass.
 *
 * Sharing one predicate between the two makes #1417's exemption leak into
 * fail-closed territory — a long REST merge door naming only `curl` would be
 * handed to the walk instead of held. Each consumer takes the one whose
 * semantics it needs; the doc on each states which.
 *
 * Today the classifier is the only live consumer (`readMergeCommand` via
 * `analysisBound`, and it takes the classifier predicate). `exceedsAnalysisBound`
 * is exported, exercised and pinned by `test-merge-size-bound.ts` as the
 * fail-closed predicate the matcher shape is written against, so a matcher
 * revived or written fresh has the correct one to import, and neither
 * predicate can quietly take over the other's job. That contract — fail CLOSED,
 * i.e. report a merge span for every command this calls too large, never "not a
 * merge" — belongs to the matcher's own seam, which is where it is stated.
 */

import type { MergeCommand } from "./merge-allowlist.ts";
import { FORGE_WORD } from "./merge-lex-views.ts";
import { refuseTooLarge } from "./merge-too-large.ts";
import { triggerCode } from "./merge-trigger.ts";

/**
 * Maximum length (chars) of a merge-bearing command the guard reads. Both
 * predicates below share it: the matcher refuses anything LONGER than this
 * that names a forge word, and the classifier refuses anything longer than
 * this that also spells a merge shape (`exceedsClassifierBound`).
 */
export const MERGE_COMMAND_SIZE_BOUND = 8000;

/**
 * The MATCHER's bound: past the size bound AND naming a forge word — and
 * nothing else. Its consumer is the fail-closed path: a caller that answers
 * "is this a merge?" must never report `not a merge` for a command it refuses
 * to analyse, so this predicate asks only the question a fail-closed caller
 * can ask before it stops reading. Every long command for which it is true is
 * one that caller reports AS a merge, whatever its words spell — which is why
 * `holdsLongCommand` must never move into it.
 *
 * The forge test is the trigger's own word set, `FORGE_WORD`, not a narrower
 * `includes("gh")`/`includes("glab")` pair. "Which commands could be a merge?"
 * is the same question the trigger asks, and must be answered with the same
 * pattern. A `curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge` of
 * 9 kB is exactly such a command — the REST merge door of #955, spelled with
 * an HTTP client instead of `gh` — and a substring test on the two forge CLIs
 * called it exempt, so it fell past the bound to `not-a-forge-command` on
 * unbounded text instead of taking the ledger-checked `too-large` path.
 *
 * A long command naming NO forge word at all — a 30k-char
 * `git commit -m "…merge…"`, a 9 kB `git log` or `echo` — is exempt: nothing
 * in it can be a merge door, the analysis is cheap, and its honest answer is
 * "not a merge". The merge-shape exemption is NOT here: it belongs to the
 * classifier, which can afford it, and putting it here is what let a long
 * `curl -X PUT …/pulls/1/merge` fall out of the fail-closed span. See
 * `exceedsClassifierBound`.
 */
export function exceedsAnalysisBound(command: string): boolean {
  if (command.length <= MERGE_COMMAND_SIZE_BOUND) return false;
  return FORGE_WORD.test(command);
}

/**
 * The CLASSIFIER's bound: `exceedsAnalysisBound` AND a merge shape. Its only
 * consumers are `analysisBound` / `readMergeCommand`.
 *
 * #1417's exemption lives here and only here: a long command that spells **no
 * merge word at all** — a `gh pr view` with a long `--jq` filter, a labels or
 * timeline read, a 9 kB pasted changelog in a `gh pr create --body` — is not
 * too large, because the classifier's own answer for it below the bound is
 * `none`, and the trigger reaches that answer in the same linear pass the
 * bound itself costs. That is a widening, not a weakening: nothing this
 * bounds is ever read as a `merge`, so an agent cannot reach current-branch
 * PR resolution (#955) by making its command long; what the exemption buys is
 * that length stops being a reason to refuse a read.
 *
 * It must NOT be used by a fail-closed caller: for one, the merge-shape test
 * is exactly the question it cannot answer without the analysis it is being
 * spared. That is why this is a separate function rather than one predicate
 * with a parameter.
 */
export function exceedsClassifierBound(command: string): boolean {
  if (!exceedsAnalysisBound(command)) return false;
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
 * length that triggered it, never analysed and never passed through. Uses the
 * CLASSIFIER's predicate (`exceedsClassifierBound`), so a long read that
 * spells no merge word answers `none` here exactly as it would below the
 * bound; the matcher's fail-closed path is `exceedsAnalysisBound`.
 */
export function analysisBound(command: string): MergeCommand | undefined {
  return exceedsClassifierBound(command) ? refuseTooLarge(command.length) : undefined;
}

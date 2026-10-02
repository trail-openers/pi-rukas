/**
 * merge-size — the merge-guard matcher's size bound (#955 lens round 6).
 *
 * `mergesPr` walks every shell segment and recurses into `( … )` / `$( … )`
 * / backtick bodies — an O(depth × length) walk that becomes pathological
 * on long nested-substitution input (a 64k-char merge-bearing command took
 * >10s; the original 20000 bound was set against that measurement). The
 * bound is deliberately LOW now (8000): a live merge with a long `--body`
 * value or a long endpoint is still a merge the guard must analyse, and
 * 8000 sits well above the longest realistic merge command (a few hundred
 * chars) with margin for the worst case measured — a nested `$(…)` merge
 * just under the bound finishes in <300ms (measured: ~40ms).
 *
 * The bound is its own module so the guard (merge-guard.ts) and the
 * matcher (bash-merges-pr.ts) share one constant and one predicate
 * without importing each other, and the guard's explicit
 * "too large to analyse" refusal is driven by the same test the matcher's
 * fail-closed span is driven by — the two cannot disagree about which
 * commands exceed the bound.
 */

/**
 * Maximum length (chars) of a merge-bearing command the matcher walks.
 * A merge-bearing command LONGER than this that also names `gh`/`glab`
 * cannot be analysed in bounded time — the guard refuses it explicitly
 * ("too large to analyse — split the command") instead of walking it or
 * falling through to current-branch PR resolution.
 */
export const MERGE_COMMAND_SIZE_BOUND = 8000;

/**
 * True when `command` exceeds the size bound AND names a forge
 * (`gh`/`glab`) — the shape the expensive walk could not finish in
 * bounded time. A merge-bearing command that does NOT name a forge
 * (a long `git commit -m "…merge…"`) is never too large: the walk is
 * cheap there (no REST endpoint to search, the verb door's segment walk
 * terminates fast on a single long token) and must keep returning its
 * honest answer (not a merge), so it is excluded from the bound.
 */
export function exceedsAnalysisBound(command: string): boolean {
  return (
    command.length > MERGE_COMMAND_SIZE_BOUND &&
    (command.includes("gh") || command.includes("glab"))
  );
}

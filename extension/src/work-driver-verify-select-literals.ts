/**
 * work-driver-verify-select-literals — #2649: the literal rules of the selector,
 * split out of `work-driver-verify-select.ts`.
 *
 * Two selection rules answer a question about what a test's code SAYS rather than
 * what it imports: the classifier's exact namers of a changed repository file, and
 * the helper rule that finds the tests quoting a shell helper's path. Both read the
 * roster of offline tests (`work-driver-verify-offline-tests`), and a selection asks
 * them about every changed path at once — so the scan over the roster's lexed
 * literals is done once for all targets rather than once per path, with the same
 * spelling rules and the same roster order the per-path scans used.
 */

import type { OfflineTests } from "./work-driver-verify-offline-tests.ts";
import { isRepoPath } from "./work-driver-verify-repo-paths.ts";

/** A leading interpolation or relative prefix that does not change which file a literal names — the classifier's own rule. */
const NAMER_LEADING_RE = /^(?:\$\{[^}]*\}\/|\.{1,2}\/|extension\/)*/;

/**
 * Does a literal spell `rel` as an exact repository path, once its leading
 * interpolation or relative prefix is ignored? The classifier's exact-namer rule
 * and the shared spelling rules of `work-driver-verify-repo-paths` are the contract.
 */
function isExactNamerLiteral(literal: string, rel: string): boolean {
  return isRepoPath(literal) && literal.replace(NAMER_LEADING_RE, "") === rel;
}

/**
 * The offline tests whose lexed literals name each of `targets`, indexed by the
 * target they name. Roster order is sorted, so each bucket is sorted too — the same
 * answer the per-path scans produced, from one pass over the roster's literals.
 *
 * The two rules spell "names this path" differently — the helper rule wants the exact
 * path as quoted, the classifier reads the exact path after the leading prefix — so
 * the caller says which one is asking by passing the helper rule's single-path form
 * (`literalReferrers`, from the selector) or nothing for the classifier's scan. A
 * bucket is meaningful under exactly one of them, and the caller keeps them apart.
 */
export function namersForPaths(
  roster: OfflineTests,
  targets: ReadonlySet<string>,
  /** The helper rule's single-path form, injected by the selector so that rule stays
   * the one place the reference test is spelled — and the one line the mutation gate
   * in `test-verify-select-classify.ts` edits. */
  referrers: (roster: OfflineTests, rel: string) => string[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const push = (key: string, name: string) => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [name]);
    else if (!bucket.includes(name)) bucket.push(name);
  };
  const targetList = [...targets];
  const quoting = referrers !== undefined;
  for (const name of roster.names) {
    const lexed = roster.lexed.get(name);
    if (lexed === undefined) continue;
    if (quoting) {
      // One test per roster file: a helper is quoted wholly or not at all, so every
      // target is asked with the caller's single-path rule — the reference rule the
      // mutation gate edits, spelled in `work-driver-verify-select.ts`.
      if (!targetList.some((t) => referrers(roster, t).includes(name))) continue;
      for (const target of targetList) push(target, name);
      continue;
    }
    for (const s of [...lexed.strings, ...lexed.templates]) {
      for (const target of targetList) {
        if (isExactNamerLiteral(s, target)) push(target, name);
      }
    }
  }
  return index;
}

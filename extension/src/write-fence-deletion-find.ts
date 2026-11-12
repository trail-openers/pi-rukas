/**
 * write-fence-deletion-find — the `find` half of the deletion rule (#2200): which
 * paths a `find` removes, and which form cannot be judged at all.
 *
 * `-delete` removes the start paths it names, or its own directory when it named
 * none. `-exec` / `-execdir` / `-ok` / `-okdir` run their words once per MATCH, so
 * what they remove cannot be named before the match exists — the same fail-closed
 * shape as an unresolvable expansion, and precisely the form the #2200 incident's
 * prefix sweep used (`find <shared temp root> -name 'p*' -print0 | xargs -0 -r rm -rf`).
 */

import type { Word } from "./write-fence-bash-lex.ts";

/** The `find` actions that run their words as a command, once per match. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** The paths a removing `find` deletes, as its own words; empty when it removes nothing. */
export function findRemovals(args: Word[]): Word[] {
  let from = 0;
  while (from < args.length && /^-[HLP]$/.test(args[from]?.text ?? "")) from++;
  let to = from;
  while (to < args.length && !/^[-(!]/.test(args[to]?.text ?? "")) to++;
  const starts = args.slice(from, to);
  const expr = args.slice(to);
  if (expr.some((a) => FIND_EXEC.has(a.text))) {
    // The removed paths are the matches, which nothing before the run can name.
    return [{ text: "(matched files)", dyn: true }];
  }
  if (!expr.some((a) => a.text === "-delete")) return [];
  return starts.length > 0 ? starts : [{ text: ".", dyn: false }];
}

/**
 * review-accept-selector — git's repo-location / config selectors, and the one question
 * they answer: can this selector be CLEARED, i.e. can the guard name the repository the
 * read will run against? Split out of `review-accept-arms.ts` because the two answer
 * different questions — the arms decide whether a segment is an admitted read, this module
 * decides whether a segment's own `-C` / `-c` / `--git-dir` pair is readable at all — and
 * BOTH the scope test (clause (3)) and the git arms ask this one, which is exactly the
 * shape that drifts when it is duplicated.
 *
 * A selector that cannot be cleared both makes the command the guard's business and keeps
 * the git arms from admitting it; a cleared one is invisible to both.
 */

import {
  UNREADABLE,
  eraseBackslashes,
  isAcceptScriptToken,
  unquote,
} from "./review-accept-command.ts";
import { gitOptionNames } from "./review-accept-verb.ts";
import { isProtectedToken } from "./review-protected-names.ts";

/** git's repo-location / config selectors that are NEVER cleared by their target: the
 * rows of the ONE table in `review-accept-verb.ts` whose `clearable` column is false —
 * `--git-dir` and `--work-tree` move the object store or the work tree the read runs
 * against, `--exec-path` can shadow `git-shell` with a program of the caller's choosing,
 * and `--namespace` / `--super-prefix` / `--config-env` rewrite what git reports or read
 * their value out of the environment. Refused by whole word and `=`-attached, either case.
 * Derived, not spelled: the verb scan that steps over these options and this audit that
 * refuses them are the same rows or they drift (#1764 fix round 3, H3). */
const NEVER_CLEARED_SELECTOR = new RegExp(
  `^(?:${gitOptionNames((s) => !s.clearable)})(?:=|$)`,
  "i",
);
/** The same selectors as a regex, for the FORGE read arm, which resolves nothing: `gh` and
 * `glab` have no `-C <path>` form to resolve, so a forge read carrying any of them is
 * refused outright (`armForgeRead` maps `unquote` over the segment before matching the
 * subcommand, so `hasFlag` would be looking at the quote characters rather than the
 * flag). */
export const REPO_LOCATION_FLAG = new RegExp(
  `^(?:-c|${gitOptionNames((s) => !s.clearable)})(?:=|\s|$)`,
  "i",
);
/** `-C <path>` / `-c key=value`, the selectors whose MEANING is in their value, taken from
 * the same table's `clearable` column. The arms receive the segment LOWERCASED, so an
 * uppercase `-C <path>` is the word `-c <path>` here; a lowercase `-c` is therefore
 * indistinguishable from it, and that is sound: git accepts `-c` only as `-c key=value`,
 * so a value carrying no `=` cannot be a config assignment and can only be the path form
 * (#1643). */
const VALUE_SELECTOR = new RegExp(`^(?:${gitOptionNames((s) => s.clearable)})(.*)$`, "i");
/** A value that is a config assignment rather than a path (`-c core.pager=cat`): the `=`
 * is what makes it a hook / pager / alias the program then RUNS, which no target test can
 * clear. */
const CONFIG_VALUE = /=/;
/** A `-C` / `--git-dir` target carrying one of these is a path the guard cannot name: the
 * shell expands it onto whatever it matches, so the resolved path is unknown and the pair
 * cannot be cleared. The bracket class is included with `*` and `?` because `[.g]*` is a
 * glob too. Asked separately from `UNREADABLE` because `{}` is not a glob in the shells
 * this guard cares about but IS a substitution the other test already refuses. */
const GLOBISH = /[*?[]/;
/** Does a `-C` target reach the findings store's repo location? The store's data file and
 * its siblings live IN the git common dir, so a target that IS or CONTAINS `.git`, carries
 * a `..`, a glob, or names a protected / accept-script segment, is the store's location and
 * stays refused. An empty or expansion-bearing target is refused too — a path the guard
 * cannot resolve is a path it cannot clear. Each of those shapes is asked PER SEGMENT, the
 * unit the pair is read at; the expansion test is asked of the WHOLE value because splitting
 * on a separator deletes a backslash rather than leaving it in a segment.
 *
 * A LEADING `~` is the exception (#1738): `~/…` expands to HOME, which is nobody's findings
 * store, and refusing it re-created #1643's misfire on the common `git -C ~/work/wt status`.
 * `~user` expands to somebody else's home and a `~` anywhere else in the path is a form the
 * guard cannot resolve, so both stay refused. So is this selector MATCHED, not resolved: a
 * symlink or a glob onto `.git` is not caught, which is why anything that makes the text
 * stand for a different path than the one being read keeps the selector refused. */
function targetReachesStore(target: string): boolean {
  const value = unquote(target).replace(/^['"]+|['"]+$/g, "");
  if (value === "" || UNREADABLE.test(value)) return true;
  const segments = value.split(/[\\/]/);
  if ((segments[0] ?? "") !== "~" && segments.some((s) => s.includes("~"))) return true;
  return segments.some(
    (segment) =>
      segment === ".." ||
      segment === ".git" ||
      GLOBISH.test(segment) ||
      isProtectedToken(segment) ||
      isAcceptScriptToken(segment),
  );
}

/**
 * The resolved-target test (#1643 Decision 1) for one git segment. Every repo-location /
 * config selector is read together with its value, and one that cannot be CLEARED both
 * makes the command the guard's business and keeps the git arms from admitting it:
 *
 *  - every option the table marks `clearable: false` — `--git-dir` / `--work-tree` /
 *    `--exec-path`, spaced or `=`-attached, and `--namespace` / `--super-prefix` /
 *    `--config-env`: never cleared;
 *  - `-c key=value` (or `-C` spelling a `key=value`): a config the program then runs — a
 *    pager, a hook path, an alias — so no target test clears it (clause (b)'s accepted
 *    cost, and the position the case tables already record);
 *  - `-C <path>` whose path IS or CONTAINS the git common dir (`.git`), walks (`..`),
 *    globs (`*?[`), names a protected file, or cannot be resolved at all (empty, or
 *    carrying an expansion): refused. A leading `~/` is HOME and clears;
 *  - `git -C <worktree>` — the form AGENTS.md mandates — clears, and its VALUE is the
 *    only word the loop steps over: an ATTACHED selector (`-C/tmp/x`, `-C=/tmp/x`) carries
 *    its own value, so the following word is an ordinary argument and still gets asked.
 *    Stepping over it unexamined was the fail-open this closes (#1738 lens review:
 *    `git -C/tmp/x -c core.fsmonitor=/tmp/p log` never read its own `-c`).
 *
 * Each word is asked TWICE, as written and with its backslashes gone — the shell removes an
 * escape before the program reads the word, so `-\c key=value` IS a selector by the time git
 * sees it (#1738). A selector at the END of the segment (no value at all) is unresolved, and
 * so is a SPACED one whose next word is another option (`git -C -c core.pager=cat log`):
 * that word is no value, so nothing is consumed and the loop still reads it as the selector
 * it is.
 */
export function hasUnresolvedRepoSelector(words: string[]): boolean {
  let unresolved = false;
  for (let i = 0; i < words.length; i++) {
    const a = unquote(words[i] ?? "");
    const views = a.includes("\\") ? [a, eraseBackslashes(a)] : [a];
    if (views.some((v) => NEVER_CLEARED_SELECTOR.test(v))) {
      unresolved = true;
      continue;
    }
    let attached: string | null = null;
    for (const v of views) {
      const value = VALUE_SELECTOR.exec(v);
      if (value !== null) {
        attached = value[1] ?? "";
        break;
      }
    }
    if (attached === null) continue;
    let target = attached.startsWith("=") ? attached.slice(1) : attached;
    // A selector that spelled NO value takes its target from the NEXT word, and that word
    // is then consumed. An attached one consumed nothing, so the next word stays where the
    // loop will reach it.
    const spaced = target === "";
    if (spaced) {
      const next = unquote(words[i + 1] ?? "");
      if (next.startsWith("-")) {
        unresolved = true;
        continue;
      }
      target = next;
    }
    if (CONFIG_VALUE.test(target) || targetReachesStore(target)) unresolved = true;
    else if (spaced) i++;
  }
  return unresolved;
}

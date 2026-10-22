/**
 * #1764 fix round 3 — the shapes the second review proved the guard still let through,
 * each recorded with what it was doing at the commit the round started from.
 *
 * These are not extra strings to keep the table long. Every row here was run through the
 * guard at `ebdb32fe` (where it answered ALLOW, base commit answered REFUSE) and through
 * the guard as it stands (where it answers REFUSE); the paired table records the commands
 * that must NOT have moved. A row that flips in either direction fails
 * `test-review-accept-guard-round3.ts`, which is the point: the round-2 fix narrowed the
 * guard's views and each narrowing opened one of these holes.
 */

import type { ScopeClause } from "../src/review-accept-scope.ts";

/** One command, what it was doing at the round's start, and the clause that must refuse
 * it now. */
export interface Round3Case {
  readonly c: string;
  readonly why: string;
  readonly clause: ScopeClause;
}

const NL = String.fromCharCode(10);
const D = String.fromCharCode(36);

/**
 * C1 — a QUOTED heredoc's own redirections. `withoutHeredocBodies` already drops the body
 * and keeps `> $F`; the operand scan then dropped the body AGAIN, reported the command
 * unreadable at the `<<`, and truncated there — losing exactly the target the first view
 * had kept. C2 — a file-descriptor duplication (`>&`, `<&`) was cut as a background `&`,
 * so the operator and its target landed in different segments and neither test saw the
 * pair. H4 — `<<<` is a here-string, not a heredoc with a delimiter that never returns.
 */
export const ROUND3_REDIRECTIONS: readonly Round3Case[] = [
  {
    c: `cat <<'PY' > ${D}F${NL}x${NL}PY`,
    why: "a quoted heredoc redirecting to an unresolved path",
    clause: "unreadable-word",
  },
  {
    c: `cat <<'PY' >> ${D}F${NL}x${NL}PY`,
    why: "the append spelling of the same hole",
    clause: "unreadable-word",
  },
  {
    c: `cat <<'PY' 2> ${D}F${NL}x${NL}PY`,
    why: "a numbered fd redirected beside a quoted body",
    clause: "unreadable-word",
  },
  {
    c: `cat <<'PY'${NL}x${NL}PY > ${D}F`,
    why: "the redirection on the delimiter line, after the tag",
    clause: "unreadable-word",
  },
  {
    c: `grep x f <<'PY' > ${D}F${NL}x${NL}PY`,
    why: "a search tool whose quoted body hides a redirect",
    clause: "unreadable-word",
  },
  {
    c: `echo hi <<'PY' > ${D}F${NL}x${NL}PY`,
    why: "a PRINT tool — whose kind says nothing about its redirection",
    clause: "unreadable-word",
  },
  {
    c: `cat x >&${D}F`,
    why: "an fd duplication glued to its target",
    clause: "unreadable-word",
  },
  {
    c: `cat x >& ${D}F`,
    why: "the spaced fd duplication",
    clause: "unreadable-word",
  },
  {
    c: `cat x 2>&${D}F`,
    why: "a numbered fd duplicated onto an unreadable target",
    clause: "unreadable-word",
  },
  {
    c: `cat <&${D}F`,
    why: "the input-side duplication `<&`",
    clause: "unreadable-word",
  },
  {
    c: `cat <<<${D}F`,
    why: "a HERE-STRING read from an unreadable word",
    clause: "unreadable-word",
  },
];

/**
 * H1 — a long option whose value is the NEXT word. The `=` spelling was already asked;
 * spaced, the value fell through as an ordinary word, and for a SEARCH tool the first
 * ordinary word is the PATTERN, which is prose. The tool opens these values.
 */
export const ROUND3_OPTION_VALUES: readonly Round3Case[] = [
  {
    c: `grep --exclude-from ${D}L -r x .`,
    why: "a spaced long option whose value is a file grep opens",
    clause: "unreadable-word",
  },
  {
    c: `grep --exclude ${D}E -r x .`,
    why: "the same shape on `--exclude`",
    clause: "unreadable-word",
  },
  {
    c: `grep --include ${D}F -r x .`,
    why: "the same shape on `--include`",
    clause: "unreadable-word",
  },
  {
    c: `grep --regexp ${D}P f`,
    why: "the long pattern flag, whose value is a word the tool receives",
    clause: "unreadable-word",
  },
  {
    c: `grep --exec ${D}CMD x .`,
    why: "`--exec` RUNS its value",
    clause: "unreadable-word",
  },
  {
    c: `rg --ignore-file ${D}I x .`,
    why: "rg's ignore list, read from a path the guard cannot name",
    clause: "unreadable-word",
  },
  {
    c: `rg --pre-glob ${D}G x .`,
    why: "rg's pre-glob list",
    clause: "unreadable-word",
  },
  {
    c: `rg --pre ${D}CMD x .`,
    why: "`--pre` runs a filter program named by the value",
    clause: "unreadable-word",
  },
];

/**
 * H2 — assignment resolution may ADD a name to the store-name test and must never REMOVE
 * an unresolved word from the expansion / operand tests. A name bound twice with different
 * values, anywhere in the command, is unreadable: the guard cannot say which binding the
 * shell used at the point of use.
 */
export const ROUND3_ASSIGNMENTS: readonly Round3Case[] = [
  {
    c: `F=a; cat ${D}F; F=b`,
    why: "a decoy rebinding later in the command leaves `$F` unreadable at its use",
    clause: "unreadable-word",
  },
  {
    c: `F=a; F=b; cat ${D}F`,
    why: "the same name bound twice before the use",
    clause: "unreadable-word",
  },
];

/** The commands that must NOT have moved: each is allowed at base and allowed now, and
 * every one of them sits one character from a row above. */
export const ROUND3_STILL_ALLOWED: readonly { c: string; why: string }[] = [
  {
    c: `cat <<'PY' > notes.md${NL}price ${D}5${NL}PY`,
    why: "the same heredoc shape redirecting to a path the guard CAN name",
  },
  {
    c: `cat <<'PY'${NL}echo ${D}HOME${NL}PY`,
    why: "a quoted body carrying an expansion, redirecting nowhere",
  },
  { c: "cat x 2>&1", why: "an fd duplication onto a literal descriptor" },
  { c: "cat x >&2", why: "the same onto stderr" },
  { c: "bun test t.ts 2>&1 | tail -8", why: "a test run logging to stderr" },
  { c: "make -j4 & echo started", why: "a BACKGROUND ampersand, still a separator" },
  { c: "a && b", why: "a list operator, still a separator" },
  {
    c: "git --namespace refs/heads/x log",
    why: "a namespace naming a ref, not a path — the row H3 must not over-refuse",
  },
  {
    c: `grep -o -E "[a-z][a-z0-9][a-z0-9.+-]*[[:space:]]+\\\\${D}" /repo/Dockerfile`,
    why: "a `-E` pattern carrying a `$` — folded onto `-e`, whose value stays prose",
  },
  {
    c: `f=notes.md; cat ${D}f`,
    why: "one literal binding, resolved the way the shell resolves it",
  },
];

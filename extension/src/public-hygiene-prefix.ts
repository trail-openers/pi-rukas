/**
 * public-hygiene-prefix — the words before a command name (#1788).
 *
 * `oo gh pr comment …` and `FOO=bar gh pr comment …` run the same publish as
 * `gh pr comment …`, so every reader that asks "does this argv publish?" must
 * skip the same prefix. This rule had three private copies (the scan's noun
 * table, the target resolver, and — absent — the substitution path): the missing
 * copy is how `oo gh pr comment 3 --body "$(cat f)"` published an unreadable body
 * while the identical command without `oo` was refused. One copy, here.
 */

/** A `KEY=value` word, as bash accepts before a command name. */
export function isAssignment(w: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
}

/**
 * How many leading words of `argv` are a runner/assignment prefix rather than
 * the command itself (`oo`, `KEY=value`).
 */
export function commandPrefixLength(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length && (argv[i] === "oo" || isAssignment(argv[i] ?? ""))) i++;
  return i;
}

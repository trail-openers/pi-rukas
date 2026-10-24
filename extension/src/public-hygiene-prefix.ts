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

/**
 * The program word of one argv, with its directory removed: the command word is
 * `argv[commandPrefixLength(argv)]` — the first word after the runner/assignment
 * prefix — and a path-prefixed program (`/usr/local/bin/gh`, `./gh`, `bin/gh`) is
 * the same program. `commandPrefixLength` skips only `oo`/`NAME=value` because
 * process wrappers have already been removed by `publishArgv` upstream.
 *
 * This is the word that decides which noun table reads the command, so a path
 * that survived here used to make `gh` invisible to the gh reader and `git`
 * invisible to the commit reader — the command then fell to the backstop as an
 * unreadable publish instead of being scanned. git already strips its own path
 * inside `scanGitCommit`; this is that rule applied to every command word, and
 * the place the gh noun table gets it from.
 */
export function commandWord(argv: readonly string[]): string {
  const w = argv[commandPrefixLength(argv)] ?? "";
  const slash = w.lastIndexOf("/");
  return slash < 0 ? w : w.slice(slash + 1);
}

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

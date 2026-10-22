/**
 * review-protected-names — what NAMES the store, for the accept guard's clause (a)
 * (#1125 (a)): the stems, the basename shapes, the token matcher, the erasures a name
 * can hide behind (quotes, braces, backslashes, line continuations), the operator
 * script's own token, and the one predicate `namesStore` that asks a command text of
 * all of them at once.
 *
 * Split out of the command-text module by §12's file-size limit, along a seam that was
 * already there: that module turns a command string into SHELL views (segments, words,
 * quoted spans), this one decides whether a word NAMES the store, and neither uses the
 * other's code. The command-text module re-exports every symbol here, so the guard's
 * modules keep importing the vocabulary from the one place they always pointed at.
 */

/** The names whose stem marks a protected path, whatever suffix follows. */
export const PROTECTED_STEMS = [
  String.fromCharCode(
    114,
    101,
    118,
    105,
    101,
    119,
    45,
    102,
    105,
    110,
    100,
    105,
    110,
    103,
    115,
    45,
    115,
    116,
    111,
    114,
    101,
  ),
  String.fromCharCode(114, 101, 118, 105, 101, 119, 45, 97, 99, 99, 101, 112, 116),
  String.fromCharCode(114, 101, 118, 105, 101, 119, 45, 102, 105, 110, 100, 105, 110, 103, 115),
];
/** A basename that IS the store: the data file, its siblings, the modules. */
export const PROTECTED_BASENAME =
  /^review-(?:findings\.json(?:\.[a-z0-9-]+)?|findings-store(?:\.[a-z0-9-]+)?|accept(?:-row)?)(?:\.ts)?$/;

/** Characters that make a word UNREADABLE, so its final form is unknown: `$` (an
 * expansion or command substitution), a backtick, a backslash, and the brace / comma of
 * a brace expansion. One regex for the whole guard: the segment-wide gate in
 * `review-accept-guard.ts` and the `-C <path>` target test in `review-accept-arms.ts`
 * ask the SAME question — what the guard cannot read it cannot clear — and two literals
 * that must stay identical are one literal short of drifting. */
export const UNREADABLE = /[$`\\{}]/;

/** The characters that make a word an EXPANSION — text the SHELL will substitute, so the
 * guard cannot read what the program finally receives. One regex for the whole guard: the
 * scope test in `review-accept-scope.ts`, the read-tool operand test in
 * `review-accept-readtools.ts` and the assignment view in `review-accept-views.ts` all ask
 * the SAME question — which word has no determinable final text — and three literals that
 * must stay identical are two literals short of drifting.
 *
 * NARROWER than `UNREADABLE` on purpose: a backslash, a brace or a comma is not an
 * expansion the shell resolves later (`echo -e "a\nb"`, `echo {a,b}` are ordinary text,
 * #1665), and an escaped or braced spelling of the store's name is caught by the erased
 * views of `namesStore` instead. */
export const EXPANSION = /[$`]/;

/** Tokenise into maximal runs of word / dot / hyphen / slash characters. */
export function tokensOf(text: string): string[] {
  return Array.from(text.matchAll(/[A-Za-z0-9._/-]+/g), (m) => m[0] as string);
}

/** The basename of a token, on either separator. */
export function baseName(token: string): string {
  const i = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return i < 0 ? token : token.slice(i + 1);
}

/** Does a token name the findings store — as path, module, bare stem or sibling?
 *
 * The stem test is a PREFIX, not an equality: an exact-basename match loses to a
 * one-byte suffix, so `cat review-findings.json?`, `…:` and `…*` all read as ordinary
 * words while the shell still expands them onto the store's bytes. A name that merely
 * STARTS with a protected stem is therefore protected, and the collateral refusals
 * (`review-acceptance-notes`, `review-findings.jsonx`) are clause (b)'s accepted cost.
 * A name that ends in a MODULE extension is the one exception — `review-accept-guard.ts`
 * is a module BESIDE the store and `review-findings-store.ts` is the store module — so
 * `.ts`/`.tsx` are stripped and compared for EQUALITY, exactly as before. Any other
 * spelling takes the PREFIX: a name that merely STARTS with a stem is refused, which is
 * what catches `review-findings.jsonx` (a `.json` sibling carrying one more byte) and,
 * through the `?*[]:,;` strip above, the glob and punctuation spellings of the data file.
 *
 * TWO erasures are asked of every name, because both happen before the program ever sees
 * an argument. QUOTES: `cat 'rev''iew-findings.json'` is ONE word that the shell
 * concatenates into the exact store name, and at this level a balanced quoted span is
 * indistinguishable from a concatenation — so the word is matched twice, once as written
 * and once with ALL quote characters removed, which is the text the shell passes. CASE:
 * the candidate is lowercased HERE, so every caller is case-insensitive rather than one
 * caller remembering to do it. Both erasures point the same way (clause (b)'s accepted
 * cost), and `review-accept-guard.ts` — a module BESIDE the store — is still admitted,
 * because a `.ts` name is stripped and compared for EQUALITY.
 */
export function isProtectedToken(token: string): boolean {
  const matches = (base: string): boolean => {
    if (PROTECTED_BASENAME.test(base)) return true;
    if (/\.tsx?$/.test(base)) return PROTECTED_STEMS.includes(base.replace(/\.tsx?$/, ""));
    return PROTECTED_STEMS.some((stem) => base.startsWith(stem));
  };
  // The word as the shell hands it over: every quote character gone (a `'a''b'`
  // concatenation is one word, not prose), then the trailing glob / punctuation bytes,
  // then the case a case-insensitive filesystem does not distinguish.
  return [token, baseName(token).replace(/["']/g, "")].some((word) =>
    matches(
      baseName(word)
        .replace(/^['"]+|['"]+$/g, "")
        .replace(/[?*\[\]:,;]+$/, "")
        .toLowerCase(),
    ),
  );
}

/**
 * Clause (a): does this text name the store anywhere, token-wise? Asked of the text
 * AS WRITTEN and, inside `namesStore`, of its views — quote removal must not be able
 * to hide a name that the shell still hands to a program.
 */
export function namesProtected(text: string): boolean {
  return tokensOf(text).some(isProtectedToken);
}

/** Every quote, brace and comma character, gone: the text the shell passes when it
 * performs a concatenation (`'rev''iew-findings.json'`) or a brace expansion
 * (`rev{iew-findings}.json`). Both spellings name the store although the raw text
 * never spells it, so the matcher is also asked of THIS view. */
export function eraseShellPunctuation(text: string): string {
  return text.replace(/["'`{},]/g, "");
}

/** Every backslash, gone: the text the program receives once the shell has removed its
 * escapes. `cat re\view-findings.json` is one ordinary-looking word that becomes the
 * exact store name on the way to `cat`, so the matcher is asked of THIS view too (#1665).
 * It is what lets a backslash out of the "unreadable word" scope rule — where it was
 * refusing `echo -e "a\nb"`, `printf 'x\n'` and every `grep` BRE — without letting an
 * escaped spelling of the store's name through that door. Removing backslashes is
 * conservative in the REFUSING direction: it can only add a match, never lose one.
 *
 * A LINE CONTINUATION is erased FIRST, and deleted rather than left in: `foo \<newline>bar`
 * is one word `foobar` to the shell, so the pair vanishes and the two halves join. Erasing
 * the backslashes alone kept the newline, which is a token separator in `tokensOf`, so
 * `.git/review\` + newline + `-findings.json` came back as two words that name nothing and
 * the store hid behind a line break (lens review of #1738). CRLF is the same continuation
 * with a carriage return in it, so it joins too. */
export function eraseBackslashes(text: string): string {
  return text.replace(/\\\r?\n/g, "").replace(/\\/g, "");
}

/** The operator script's basename stem. Its own name is protected — running it from an
 * agent shell is the act the whole guard exists to refuse — while a name that merely
 * STARTS with it (`review-acceptance-notes`) and the guard module beside it
 * (`review-accept-guard.ts`) are not: a word is asked for EQUALITY here, not for the
 * stem prefix the store's own names take. */
const SCRIPT_STEM = String.fromCharCode(
  114,
  101,
  118,
  105,
  101,
  119,
  45,
  97,
  99,
  99,
  101,
  112,
  116,
);
/** Does a token name the operator's accept script, or the script run by path
 * (`extension/scripts/review-accept.ts`)? The BASENAME is what decides, so a command
 * that spells the script by path is in scope; a word that merely starts with the stem
 * (`review-acceptance-notes`) and the guard module beside it (`review-accept-guard.ts`)
 * are not. */
export function isAcceptScriptToken(token: string): boolean {
  const base = baseName(token)
    .replace(/["']/g, "")
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[?*\[\]:,;]+$/, "")
    .toLowerCase();
  return base === SCRIPT_STEM || base === `${SCRIPT_STEM}.ts` || base === `${SCRIPT_STEM}-row.ts`;
}

/**
 * The gate of clause (a): does this command name the findings store — the data file,
 * the store module, their stems, a `.tmp` / `.corrupt` sibling? Asked of every view
 * listed below, because each spelling reaches the store's bytes by a different route,
 * and the matcher (`isProtectedToken`) supplies its own quote-erasure and case folding:
 *
 *  (i)   the RAW text — a name is a name wherever it appears;
 *  (ii)  the NORMALISED text — quoted spans already folded away, so this is what a
 *        program receives as an argument;
 *  (iii) the raw text with every quote, brace and comma REMOVED — the word the shell
 *        assembles from a concatenation or a brace expansion;
 *  (iv)  the heredoc body, which is part of the raw text, so (i) already covers it;
 *  (v)   an `extra` matcher the caller adds — the guard passes the OPERATOR SCRIPT's
 *        basename, whose path (`extension/scripts/…`) is the route the acceptance runs;
 *  (vi)  a value ATTACHED to an option, which no tokeniser ever hands out bare: a
 *        pickaxe / grep value (`git log -Greview-findings-store`, `-S…`, `--grep=…`) or
 *        an output value (`git show HEAD:x -oreview-findings.json`), where the option
 *        prefix GLUES the name to the flag. Each is matched case-insensitively because
 *        the guard asks this of its lowercased view, and git reads such a value exactly
 *        as written.
 *  (vii) the raw text with every BACKSLASH removed — the word the program receives once
 *        the shell has unescaped it, which is how `cat re\view-findings.json` is the store
 *        although no word spells it (#1665) — and with every LINE CONTINUATION joined
 *        first, which is how a name split across two lines by `\` + newline is the store
 *        although no line spells it either (#1738).
 *
 * Clause (a) scopes the allowlist to commands that name the store, so this predicate —
 * not the arms — decides whether the adjudication applies at all. A command that does
 * not name the store (`mkdir -p tmp/x`, `git add -A`, `npm install`) is an ordinary
 * agent command and no arm is asked of it.
 */
export function namesStore(
  command: string,
  normalised: string,
  extra?: (token: string) => boolean,
): boolean {
  const asked = extra ? (t: string): boolean => isProtectedToken(t) || extra(t) : isProtectedToken;
  return [
    command,
    normalised,
    eraseShellPunctuation(command),
    eraseBackslashes(command),
    eraseBackslashes(eraseShellPunctuation(command)),
  ].some((text) => tokensOf(text).some(asked));
}

/** An option value ATTACHED to its flag lives in `review-accept-names.ts` (#1764, §12's
 * file-size limit): it is the one protected-name route the tokeniser cannot see, and the
 * question it answers is not the question this module answers. */

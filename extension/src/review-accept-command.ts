/**
 * review-accept-command — the command-text readers the accept guard builds on
 * (#1125): one tokeniser, one protected-name matcher, one normaliser and the shell
 * segment / word splitters. NO command scanner lives here: the adjudication rule of
 * #1125 (a) permits exactly one allowlist, and it is in review-accept-guard.ts. This
 * file only turns a command string into views another module can match arms against; the
 * git VERB position is one such view and lives in `review-accept-verb.ts`.
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

/** An option value ATTACHED to its flag, with the flag removed: `-G<name>`, `-S<name>`,
 * `--grep=<name>`, `-o<name>`, `--output=<name>`, `-f<name>`, `-t<name>` (git's
 * `--template`), `-e<code>` (a runtime's inline program). Returns the value, or `null`
 * for a word that is not an attached value. */
function attachedValue(word: string): string | null {
  const bare = word.replace(/^["']+|["']+$/g, "");
  for (const flag of ["--grep", "--output", "-grep", "--pickaxe", "--template"] as const) {
    if (bare.startsWith(`${flag}=`)) return bare.slice(flag.length + 1);
  }
  // `t` is git's `--template` (a FILE whose contents become the commit message) and `e` a
  // runtime's inline-program flag, so `-treview-findings.json` and `-ereview-accept.ts`
  // are exactly the attached spellings no tokeniser hands out bare.
  if (/^-[gsotfe]/i.test(bare) && bare.length > 2) return bare.slice(2);
  return null;
}

/**
 * Clause (a), part (vi): does an ATTACHED option value name the store? The shapes are
 * `git log -Greview-findings-store` (a pickaxe regex), `git log -S<name>` / `--grep=<name>`
 * and `git show HEAD:x -oreview-findings.json` (an output path). None of them ever hands
 * a tokeniser the bare name — the option prefix glues it to the flag — so the token match
 * in `namesStore` cannot see them, and the arms cannot either (`-o<name>` is one word,
 * not the `-o <name>` pair their operand test reads). They are asked case-insensitively:
 * the guard evaluates this over its LOWERCASED view while git matches such a value
 * exactly, so a folded name still counts as naming it.
 */
export function namesAttachedValue(text: string): boolean {
  return tokensOf(text).some((token) => {
    const value = attachedValue(token);
    if (value === null) return false;
    return tokensOf(value).some(
      (t) => isProtectedToken(t.toLowerCase()) || isAcceptScriptToken(t.toLowerCase()),
    );
  });
}

/** Collapse whitespace and newlines to a single space. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Skip one heredoc starting at `start` and return the index just past it, or
 * PARSE_FAIL when the delimiter never returns — the body is REPORTED unreadable rather
 * than guessed at, and what an unreadable command MEANS is the guard's scope predicate's
 * call, not this parser's (clause (a)). Handles `<<TAG`, `<<-TAG`, `<<~TAG` and a
 * quoted tag.
 */
export function skipHeredoc(command: string, start: number): number | "PARSE_FAIL" {
  let i = start + 2;
  while (command[i] === "-" || command[i] === "~") i++;
  const from = i;
  while (i < command.length && /[A-Za-z0-9_]/.test(command[i] as string)) i++;
  if (i === from) return "PARSE_FAIL";
  const tag = command.slice(from, i).replace(/^['"]|['"]$/g, "");
  const lineEnd = command.indexOf("\n", i);
  if (lineEnd < 0) return "PARSE_FAIL";
  let cursor = lineEnd + 1;
  for (;;) {
    const at = command.indexOf("\n", cursor);
    const line = command.slice(cursor, at < 0 ? undefined : at).trim();
    if (line === tag) return at < 0 ? command.length : at + 1;
    if (at < 0) return "PARSE_FAIL";
    cursor = at + 1;
  }
}

/**
 * ONE normalisation pass (see the header). Balanced quoted spans become a single
 * space — their contents are prose, and a `|` inside them must not open a segment.
 * Each heredoc BODY is replaced by the bare marker `<<`, which `armsOf` reads back as
 * its own segment: the body is text the guard cannot see, so whatever the marker
 * belongs to is refused unless it matches an arm with the marker alone.
 */
/** The words of a command WITH their quoted contents visible: normalise() replaces a
 * whole quoted span by a space, which is right for prose but hides a selector or an
 * option living inside quotes (`python3 -c 'print(1)'` is one word here). Backslash
 * escapes are removed, because the shell removes them before the program sees them. */
export function shellVisible(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      out += command.slice(i, end < 0 ? command.length : end + 1);
      i = end < 0 ? command.length : end + 1;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Why the one normalisation pass could not read a command. REPORTED, never guessed at: what
 * an unreadable command MEANS is the guard's scope predicate's call, not this parser's, and a
 * separate re-derivation of the cause in the guard is a second copy that can only drift. */
export type ParseCause =
  | "unbalanced single quote"
  | "unbalanced double quote"
  | "heredoc body never terminates"
  | "unparseable";
/** The pass either produced the folded text, or says which shape of its own it tripped on. */
export type NormaliseResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly cause: ParseCause };

export function normalise(command: string): NormaliseResult {
  const fail = (cause: ParseCause): NormaliseResult => ({ ok: false, cause });
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return fail(ch === "'" ? "unbalanced single quote" : "unbalanced double quote");
      out += " ";
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return fail("heredoc body never terminates");
      out += " << ";
      i = past;
      continue;
    }
    out += ch;
    i++;
  }
  for (const quote of ["'", '"'])
    if ((out.match(new RegExp(quote, "g")) ?? []).length % 2 !== 0)
      return fail(quote === "'" ? "unbalanced single quote" : "unbalanced double quote");
  return { ok: true, text: squeeze(out.toLowerCase()) };
}

/**
 * Split a command into shell segments. An operator inside a quoted span is LITERAL —
 * `echo "a && b"` is one command — but a quoted span may still be glued to an operator
 * (`x.ts;rm`), so the span is stepped over and the operator outside it still cuts. The
 * `<<` marker normalise() left behind becomes its own segment: the heredoc body is
 * text the guard cannot see, so it is never read as arguments of the command before it.
 */
export function armsOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const flush = () => {
    if (cur.trim() !== "") out.push(cur.trim());
    cur = "";
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      const stop = end < 0 ? text.length : end + 1;
      cur += text.slice(i, stop);
      // A quote with no partner leaves `stop` equal to `i`, which would re-enter this
      // branch forever and OOM the process: the scan must always move forward.
      i = stop > i ? stop : i + 1;
      continue;
    }
    if (text.startsWith("&&", i) || text.startsWith("||", i)) {
      flush();
      i += 2;
      continue;
    }
    if (c === "|" || c === ";" || c === "&" || c === "\n") {
      flush();
      i++;
      continue;
    }
    if (c === "<" && text.startsWith("<<", i)) {
      let j = i + 2;
      while (text[j] === "<") j++;
      if (j === text.length || /\s/.test(text[j] as string)) {
        cur += " << ";
        // A run of `<` that runs off the end of the text still has to advance: the
        // previous shape left `i` where it was and looped forever, so a trailing `<`
        // hung the scan (and an unguarded scan is the guard failing open).
        i = j > i ? j : i + 1;
        continue;
      }
    }
    cur += c;
    i++;
  }
  flush();
  return out;
}

/** One shell word: adjacent quoted and unquoted runs glue together as the shell glues them. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] as string)) {
      i++;
      continue;
    }
    let word = "";
    while (i < text.length && !/\s/.test(text[i] as string)) {
      const c = text[i] as string;
      // An operator ends the word AND the segment: `x.ts;rm` is two words in two
      // segments, so a glued operator cannot be mistaken for part of an argument.
      // The index still has to move: `break` without `i++` handed the same character
      // straight back to the outer loop, which pushed `""` forever and OOM-killed the
      // scan on any command carrying `;`, `|` or `&` past the fast path.
      if (c === "|" || c === ";" || c === "&") {
        if (word !== "") {
          words.push(word);
          word = "";
        }
        i++;
        break;
      }
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1);
        if (end >= 0) {
          word += text.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        // No closing quote: the character is literal and the walk still has to move
        // past it. The previous shape fell through to neither branch, so `echo "abc`
        // spun here until the process ran out of memory — and an unbounded scan is the
        // guard failing open, not failing closed.
      }
      word += c;
      i++;
    }
    words.push(word);
  }
  return words;
}

/** A word with its quote characters gone — the text the tool actually receives. */
export function unquote(word: string): string {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i] as string;
    if (c === "'" || c === '"') {
      const end = word.indexOf(c, i + 1);
      if (end >= 0) {
        out += word.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * review-accept-command — the command-text readers the accept guard builds on
 * (#1125): one tokeniser, one protected-name matcher, one normaliser and the shell
 * segment / word splitters. NO command scanner lives here: the adjudication rule of
 * #1125 (a) permits exactly one allowlist, and it is in review-accept-guard.ts. This
 * file only turns a command string into views another module can match arms against; the
 * git VERB position is one such view and lives in `review-accept-verb.ts`.
 */

// The protected-NAME vocabulary lives in `review-protected-names.ts` (§12's file-size
// limit): deciding what NAMES the store is a different question from what the shell will
// run. Re-exported so every consumer keeps importing the vocabulary from the one module
// the guard's readers have always pointed at.
export {
  EXPANSION,
  PROTECTED_BASENAME,
  PROTECTED_STEMS,
  UNREADABLE,
  baseName,
  eraseBackslashes,
  eraseShellPunctuation,
  isAcceptScriptToken,
  isProtectedToken,
  namesProtected,
  namesStore,
  tokensOf,
} from "./review-protected-names.ts";

/** Collapse whitespace and newlines to a single space. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What one heredoc scan learned. `end` is the index just past the delimiter; `quoted`
 * says whether the TAG was quoted, which is the ONLY spelling whose body the shell does
 * not expand — a view that drops a body may drop only those (#1764 fix round,
 * criterion 4). `bodyStart` / `bodyEnd` frame the body so a caller can keep it or set it
 * aside without re-parsing; everything from `bodyEnd` to `end` is the DELIMITER LINE's
 * tail, which the shell still parses (`cat <<EOF\nx\nEOF | sh` keeps `| sh`, criterion 5). */
export interface HeredocSkip {
  readonly end: number;
  readonly quoted: boolean;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** The words after the closing tag on the delimiter line (`| sh`), which the shell
   * still parses as the command's own arguments. */
  readonly tail: string;
  /** The words AFTER the opening tag on its own line (`cat <<EOF > $F` — the `> $F`),
   * which the shell parses as this command's arguments too. Dropping them made a quoted
   * heredoc write wherever an unreadable path pointed (#1764 fix round, criterion 5). */
  readonly head: string;
}

/**
 * Skip one heredoc starting at `start`, or report PARSE_FAIL when the delimiter never
 * returns — the body is REPORTED unreadable rather than guessed at, and what an
 * unreadable command MEANS is the guard's scope predicate's call, not this parser's
 * (clause (a)). Handles `<<TAG`, `<<-TAG`, `<<~TAG` and a quoted tag.
 *
 * The closing line is a line that IS the tag or STARTS with the tag and a space: the
 * words after the tag on that line are not body, and a scanner that swallowed them made
 * `cat <<EOF\nx\nEOF | sh` read as a command that runs nothing.
 */
export function skipHeredoc(command: string, start: number): HeredocSkip | "PARSE_FAIL" {
  let i = start + 2;
  while (command[i] === "-" || command[i] === "~") i++;
  // A QUOTED delimiter is the common spelling of a non-expanding heredoc (`<<'EOF'`,
  // `<<"PY"`). It used to be unreadable here — the tag class below accepts only word
  // characters, so the `'` ended the tag before it began, every quoted heredoc parsed
  // as PARSE_FAIL, and the guard adjudicated the whole command on its raw text (#1764).
  // The quote is stripped, exactly as the shell strips it: the DELIMITER that closes the
  // body is the bare word either way.
  const quote = command[i] === "'" || command[i] === '"' ? command[i] : undefined;
  if (quote) i++;
  const from = i;
  while (i < command.length && /[A-Za-z0-9_]/.test(command[i] as string)) i++;
  if (i === from) return "PARSE_FAIL";
  const tag = command.slice(from, i);
  if (quote) {
    // `<<'PY` with no closing quote is not a delimiter the guard can read.
    if (command[i] !== quote) return "PARSE_FAIL";
    i++;
  }
  const lineEnd = command.indexOf("\n", i);
  if (lineEnd < 0) return "PARSE_FAIL";
  const quoted = quote !== undefined;
  // Whatever sits between the tag and the newline is an argument of THIS command, not
  // body: `cat <<'EOF' > $F` redirects to `$F`, and a scanner that began the body at the
  // newline lost the redirection from every view the scope test reads.
  const head = command.slice(i, lineEnd).trim();
  let cursor = lineEnd + 1;
  for (;;) {
    const at = command.indexOf("\n", cursor);
    const line = command.slice(cursor, at < 0 ? undefined : at);
    const end = at < 0 ? command.length : at + 1;
    if (line.trim() === tag)
      return { quoted, end, bodyStart: lineEnd + 1, bodyEnd: cursor, tail: "", head };
    // `EOF | sh`: the tag closes the body and the rest of the line is an argument list.
    const trimmed = line.trim();
    if (trimmed.startsWith(tag) && /^\s/.test(trimmed.slice(tag.length))) {
      const lead = line.length - line.trimStart().length;
      // `bodyEnd` is the ABSOLUTE index the caller slices the command with; `tail` is
      // read out of `line`, which is already cut at its own start. Mixing the two reads
      // the tail out of the wrong string.
      const bodyEnd = cursor + lead + tag.length;
      return {
        quoted,
        end,
        bodyStart: lineEnd + 1,
        bodyEnd,
        tail: line.slice(lead + tag.length).trim(),
        head,
      };
    }
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
      const end = closingQuote(command, i);
      if (end < 0) return fail(ch === "'" ? "unbalanced single quote" : "unbalanced double quote");
      out += " ";
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return fail("heredoc body never terminates");
      // The body becomes the bare marker (the arms refuse it whatever it spells); the
      // words AFTER the closing tag are arguments and stay where they were (#1764
      // criterion 5 — `cat <<EOF\nx\nEOF | sh` runs a shell, and a scanner that dropped
      // `| sh` read it as a command that runs nothing). The words after the OPENING tag
      // are arguments of the same command (`cat <<EOF > $F`), so they stay too.
      const args = [past.head, past.tail].filter((x) => x !== "").join(" ");
      out += args === "" ? " << " : ` << ${args} `;
      i = past.end;
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
 * The index of the quote that CLOSES the span opening at `i`, or -1 when it never
 * closes. Single quotes have no escapes — the first `'` ends the span. Inside double
 * quotes a backslash escapes the next character (`\"` is a literal quote the shell
 * removes the escape from), so `--jq ".title + \"|\" + .body"` is ONE word and the `|`
 * inside it never opens a segment (#1764: a quoted `--jq` filter's pipe used to split a
 * `gh pr view` read into two segments, the second of which matched no arm). Every
 * scanner in this module asks this one function, so the segmenter, the tokeniser and the
 * normaliser cannot disagree about where a quoted span ends.
 */
export function closingQuote(text: string, i: number): number {
  const quote = text[i] as string;
  if (quote !== "'" && quote !== '"') return -1;
  for (let j = i + 1; j < text.length; j++) {
    if (quote === '"' && text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === quote) return j;
  }
  return -1;
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
      const end = closingQuote(text, i);
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

/**
 * The segments a PIPE feeds: every segment whose own start was cut by a single `|`, and
 * nothing else. `armsOf` throws the operator away, so `echo x; sh f` and `echo x | sh`
 * are the same pair of segments to it — but only the second hands the shell a program on
 * stdin, which is the difference clause (4) decides on (#1764 fix round, criterion 8).
 * `&&`, `||`, `&`, `;` and a newline are separators that do NOT pipe, so a segment opened
 * by one of them is never a pipe target.
 */
export function pipeTargets(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  // The operator that OPENED the segment being accumulated: "" before the first cut.
  let sep = "";
  let i = 0;
  const flush = (next: string) => {
    if (sep === "|" && cur.trim() !== "") out.push(cur.trim());
    cur = "";
    sep = next;
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'" || c === '"') {
      const end = closingQuote(text, i);
      const stop = end < 0 ? text.length : end + 1;
      cur += text.slice(i, stop);
      // Same rule as every other walk here: an unpaired quote must still move forward.
      i = stop > i ? stop : i + 1;
      continue;
    }
    if (text.startsWith("&&", i)) {
      flush("&&");
      i += 2;
      continue;
    }
    if (text.startsWith("||", i)) {
      // A list operator, not a pipe: the segment it opens runs on the failing exit, not
      // on the bytes of the previous command.
      flush("||");
      i += 2;
      continue;
    }
    if (c === "|" || c === ";" || c === "&" || c === "\n") {
      flush(c);
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  flush("");
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
        const end = closingQuote(text, i);
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
      const end = closingQuote(word, i);
      if (end >= 0) {
        // Inside DOUBLE quotes the shell removes an escape before the program sees the
        // word. Inside SINGLE quotes a backslash is LITERAL — `'a\nb'` is four
        // characters — so the span comes out with its backslashes intact (#1764 fix
        // round: folding both kinds alike silently rewrote every single-quoted pattern).
        const inner = word.slice(i + 1, end);
        out += c === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner;
        i = end + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

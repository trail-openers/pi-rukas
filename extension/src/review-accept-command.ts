/**
 * review-accept-command — the command-text readers the accept guard builds on
 * (#1125): one tokeniser, one protected-name matcher, one normaliser and the shell
 * segment / word splitters. NO command scanner lives here: the adjudication rule of
 * #1125 (a) permits exactly one allowlist, and it is in review-accept-guard.ts. This
 * file only turns a command string into views another module can match arms against.
 */

/** The names whose stem marks a protected path, whatever suffix follows. */
export const PROTECTED_STEMS = ["review-findings-store", "review-accept", "review-findings"];
/** A basename that IS the store: the data file, its siblings, the modules. */
export const PROTECTED_BASENAME =
  /^review-(?:findings\.json(?:\.(?:tmp|corrupt-[a-z0-9]+))?|findings-store|accept(?:-row)?)(?:\.ts)?$/;

/** Tokenise into maximal runs of word / dot / hyphen / slash characters. */
export function tokensOf(text: string): string[] {
  return Array.from(text.matchAll(/[A-Za-z0-9._/-]+/g), (m) => m[0] as string);
}

/** The basename of a token, on either separator. */
export function baseName(token: string): string {
  const i = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return i < 0 ? token : token.slice(i + 1);
}

/** Does a token name the findings store — as path, module, bare stem or sibling? */
export function isProtectedToken(token: string): boolean {
  const base = baseName(token);
  if (PROTECTED_BASENAME.test(base)) return true;
  return PROTECTED_STEMS.includes(base.replace(/\.tsx?$/, ""));
}

/**
 * Clause (a): does this text name the store anywhere, token-wise? Asked of BOTH the
 * raw command and the normalised one — quote removal must not be able to hide a name
 * that the shell still hands to a program.
 */
export function namesProtected(text: string): boolean {
  return tokensOf(text).some(isProtectedToken);
}

/** Collapse whitespace and newlines to a single space. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Skip one heredoc starting at `start` and return the index just past it, or
 * PARSE_FAIL when the delimiter never returns — an unreadable body is refused, never
 * guessed at (clause (a)). Handles `<<TAG`, `<<-TAG`, `<<~TAG` and a quoted tag.
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
export function normalise(command: string): string | "PARSE_FAIL" {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return "PARSE_FAIL";
      out += " ";
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return "PARSE_FAIL";
      out += " << ";
      i = past;
      continue;
    }
    out += ch;
    i++;
  }
  for (const quote of ["'", '"'])
    if ((out.match(new RegExp(quote, "g")) ?? []).length % 2 !== 0) return "PARSE_FAIL";
  return squeeze(out.toLowerCase());
}

/** The operator characters that end a shell segment (see armsOf for the real walk). */

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
      i = stop;
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
        i = j;
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
      if (c === "|" || c === ";" || c === "&") break;
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1);
        if (end >= 0) {
          word += text.slice(i, end + 1);
          i = end + 1;
          continue;
        }
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

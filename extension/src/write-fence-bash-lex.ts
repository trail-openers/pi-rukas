/**
 * write-fence-bash-lex — the lexer for the bash side of the write fence (#1655).
 *
 * bash-command-parser.ts replaces every quoted argument with a sentinel, so it
 * cannot yield the path a redirect names. This lexer keeps each word's text. It
 * is not a shell: it resolves the expansions that are static (`$HOME`, `~`,
 * `~/`, `~+`, ANSI-C `$'…'` escapes) and marks every other expansion `dyn`, so a
 * path built from one is refused rather than guessed.
 *
 * A command substitution (`$(…)` or a backtick) is not a separator, which the
 * old lexer made it: that dropped the path after it (`echo x > $(git rev-parse
 * --show-toplevel)/bin/keep`). Its body is returned in `subs` for the caller to
 * check as a command of its own, and the word that contains it stays `dyn`.
 *
 * `lex` returns undefined when the command does not lex (an unterminated quote,
 * substitution or ANSI-C string). The fence refuses that command; it does not
 * guess its shape.
 */

import { type Heredoc, heredocDelimiter, skipHeredocBodies } from "./write-fence-bash-heredoc.ts";
import {
  decodeAnsiC,
  dollarExpansion,
  skipBacktick,
  skipDoubleQuoted,
  skipSubst,
} from "./write-fence-bash-words.ts";
import { expandHome } from "./write-fence-path.ts";

/** One word of a command: its text, and whether the text depends on a run-time value. */
export interface Word {
  text: string;
  dyn: boolean;
}

export type Tok = { kind: "word"; word: Word } | { kind: "op"; text: string };

/** The lexer's output: the token stream, and the body of each substitution found in it. */
export interface Lexed {
  toks: Tok[];
  subs: string[];
}

/** The lexer's running state, threaded through the helpers that build words. */
interface State {
  toks: Tok[];
  subs: string[];
  word?: string;
  dyn: boolean;
}

function add(s: State, text: string): void {
  s.word = (s.word ?? "") + text;
}

function mark(s: State): void {
  s.word ??= "";
  s.dyn = true;
}

function endWord(s: State): void {
  if (s.word !== undefined) s.toks.push({ kind: "word", word: { text: s.word, dyn: s.dyn } });
  s.word = undefined;
  s.dyn = false;
}

function op(s: State, text: string): void {
  endWord(s);
  s.toks.push({ kind: "op", text });
}

/** A bare fd number before a redirect (`2>file`) names the redirect's fd, not an argument. */
function dropFdNumber(s: State): void {
  if (s.word !== undefined && /^\d+$/.test(s.word)) s.word = undefined;
}

/**
 * A `$` or backtick expansion at `src[k]`, applied to the word. Returns the position
 * after it, -1 when it is not closed, or undefined when the `$` is literal.
 */
function expansionAt(s: State, src: string, k: number): number | undefined {
  if (src[k] === "`") {
    const end = skipBacktick(src, k);
    if (end < 0) return -1;
    s.subs.push(src.slice(k + 1, end - 1));
    mark(s);
    return end;
  }
  if (src[k + 1] === "(") {
    const end = skipSubst(src, k);
    if (end < 0) return -1;
    s.subs.push(src.slice(k + 2, end - 1));
    mark(s);
    return end;
  }
  const exp = dollarExpansion(src, k);
  if (exp === undefined) return undefined;
  if (exp.end < 0) return -1;
  add(s, exp.text);
  if (exp.dyn) s.dyn = true;
  return exp.end;
}

/** A double-quoted string starting at `src[i]`. Returns the position after its closing quote, or -1. */
function lexDouble(s: State, src: string, i: number): number {
  if (skipDoubleQuoted(src, i) < 0) return -1;
  s.word ??= "";
  for (let k = i + 1; k < src.length; ) {
    const c = src[k] ?? "";
    if (c === '"') return k + 1;
    if (c === "\\") {
      // Inside double quotes a backslash escapes only these; before any other character it stays.
      const nx = src[k + 1] ?? "";
      add(s, '$`"\\\n'.includes(nx) ? nx : `\\${nx}`);
      k += 2;
      continue;
    }
    if (c === "$" || c === "`") {
      const next = expansionAt(s, src, k);
      if (next !== undefined) {
        k = next;
        continue;
      }
    }
    add(s, c);
    k++;
  }
  return -1;
}

/** `src[i]` opens an unquoted `~`, which expands at the start of a word. Returns the position after it. */
function lexTilde(s: State, src: string, i: number): number {
  const name = /^~([^\s'"`$;&|<>()\\/]*)/.exec(src.slice(i))?.[1] ?? "";
  if (name === "") {
    add(s, expandHome("~"));
    return i + 1;
  }
  if (name === "+") {
    // `~+` is the working directory: the command's own cwd, which the targets module supplies.
    add(s, ".");
    return i + 2;
  }
  // `~-` (OLDPWD) and `~user` cannot be resolved statically.
  mark(s);
  add(s, `~${name}`);
  return i + 1 + name.length;
}

/** Lex a command. Undefined when it does not lex (see the module doc). */
export function lex(src: string): Lexed | undefined {
  const s: State = { toks: [], subs: [], dyn: false };
  const heredocs: Heredoc[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    const next = src[i + 1] ?? "";
    if (ch === "\\") {
      // `\<newline>` is a line continuation: it joins nothing and is not a word break.
      if (next !== "\n") add(s, next);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return undefined;
      add(s, src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = lexDouble(s, src, i);
      if (end < 0) return undefined;
      i = end;
      continue;
    }
    if (ch === "$" && next === "'") {
      let k = i + 2;
      while (k < src.length && src[k] !== "'") k += src[k] === "\\" ? 2 : 1;
      if (k >= src.length) return undefined;
      const decoded = decodeAnsiC(src.slice(i + 2, k));
      if (decoded === undefined) return undefined;
      add(s, decoded);
      i = k + 1;
      continue;
    }
    if (ch === "~" && s.word === undefined) {
      i = lexTilde(s, src, i);
      continue;
    }
    if (ch === "$" || ch === "`") {
      const end = expansionAt(s, src, i);
      if (end === -1) return undefined;
      if (end !== undefined) {
        i = end;
        continue;
      }
      add(s, ch);
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord(s);
      i++;
      continue;
    }
    if (ch === "\n") {
      op(s, "\n");
      i = skipHeredocBodies(src, i + 1, heredocs);
      continue;
    }
    if (ch === "#" && s.word === undefined) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (ch === "&" && next === "&") {
      op(s, "&&");
      i += 2;
    } else if (ch === "|" && next === "|") {
      op(s, "||");
      i += 2;
    } else if (ch === "|") {
      op(s, "|");
      i += next === "&" ? 2 : 1;
    } else if (ch === ";" || ch === "(" || ch === ")") {
      op(s, ";");
      i++;
    } else if (ch === "&" && next === ">") {
      // `&>file` and `&>>file` write the file.
      op(s, ">");
      i += src[i + 2] === ">" ? 3 : 2;
    } else if (ch === "&") {
      op(s, "&");
      i++;
    } else if (ch === ">") {
      dropFdNumber(s);
      if (next === "&") {
        // `>&N` / `>&-` duplicate a descriptor; `>&file` writes the file.
        const after = src[i + 2] ?? "";
        op(s, /[\d-]/.test(after) ? "dup" : ">");
        i += 2;
      } else {
        op(s, ">");
        i += next === ">" || next === "|" ? 2 : 1;
      }
    } else if (ch === "<") {
      dropFdNumber(s);
      if (next === "<" && src[i + 2] === "<") {
        op(s, "<");
        i += 3;
      } else if (next === "<") {
        const heredoc = heredocDelimiter(src, i);
        if (heredoc === -1) return undefined;
        heredocs.push({ delim: heredoc.delim, strip: heredoc.strip });
        op(s, "<<");
        i = heredoc.end;
      } else {
        op(s, "<");
        i++;
      }
    } else {
      add(s, ch);
      i++;
    }
  }
  endWord(s);
  return { toks: s.toks, subs: s.subs };
}

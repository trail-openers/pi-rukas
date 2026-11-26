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

import {
  type Heredoc,
  heredocDelimiter,
  heredocSubstitutions,
  skipHeredocBodies,
} from "./write-fence-bash-heredoc.ts";
import {
  decodeAnsiC,
  dollarExpansion,
  skipBacktick,
  skipDoubleQuoted,
  skipSubst,
} from "./write-fence-bash-words.ts";
import { expandHome } from "./write-fence-path.ts";

/**
 * One word of a command: its text, and whether the text depends on a run-time value.
 * `glob`: the word has an unquoted `*`, `?` or `[`, which the shell expands to the
 * files it matches. The fence cannot know those, so the word is opaque at a write position.
 */
export interface Word {
  text: string;
  dyn: boolean;
  glob?: boolean;
  /**
   * The word as the child TYPED it, when that differs from `text` — today only a
   * leading `~` / `~/`, which `text` carries already expanded against THIS process's
   * home. A judge that must ask "which home did the PARENT mean?" cannot recover the
   * spelling from the expansion: a helper child's home is the scratch tree the
   * harness redirected it to, and the operator's config lives at another home.
   */
  raw?: string;
  /**
   * Set on a synthetic word the fence refuses outright, with the reason. Used for a
   * write whose path the command does not name (`git config` writes the shared config).
   */
  refusal?: string;
}

/** Unquoted characters the shell expands as a pathname pattern. */
const GLOB_CHARS = new Set(["*", "?", "["]);

/** What a `$` or backtick at a position became: literal, applied up to `end`, or never closed. */
type Expanded = { status: "none" } | { status: "ok"; end: number } | { status: "unclosed" };

export type Tok = { kind: "word"; word: Word } | { kind: "op"; text: string };

/** The lexer's output: the token stream, the body of each substitution, and every heredoc body. */
export interface Lexed {
  toks: Tok[];
  subs: string[];
  /**
   * Every heredoc body, quoted delimiter or not. A heredoc is how a child hands a
   * PROGRAM to an interpreter (`python3 - << 'PY'`, `bash << 'EOF'`), so the caller
   * that judges reads has to see the body whatever the shell would expand in it —
   * the quoting decides expansion, not whether the child wrote the path.
   */
  bodies: string[];
}

/** The lexer's running state, threaded through the helpers that build words. */
interface State {
  toks: Tok[];
  subs: string[];
  bodies: string[];
  word?: string;
  dyn: boolean;
  glob: boolean;
  /** The word as typed, when it began with a bare `~` or `~/` (see `lexTilde`). */
  raw?: string;
}

function add(s: State, text: string): void {
  s.word = (s.word ?? "") + text;
}

function mark(s: State): void {
  s.word ??= "";
  s.dyn = true;
}

function endWord(s: State): void {
  if (s.word !== undefined) {
    s.toks.push({
      kind: "word",
      word: { text: s.word, dyn: s.dyn, glob: s.glob, raw: s.raw },
    });
  }
  s.word = undefined;
  s.dyn = false;
  s.glob = false;
  s.raw = undefined;
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
 * A `$` or backtick expansion at `src[k]`, applied to the word. `none` when the `$`
 * is literal; `unclosed` when the expansion never closes (the command does not lex).
 */
function expansionAt(s: State, src: string, k: number): Expanded {
  if (src[k] === "`") {
    const end = skipBacktick(src, k);
    if (end < 0) return { status: "unclosed" };
    s.subs.push(src.slice(k + 1, end - 1));
    mark(s);
    return { status: "ok", end };
  }
  if (src[k + 1] === "(") {
    const end = skipSubst(src, k);
    if (end < 0) return { status: "unclosed" };
    s.subs.push(src.slice(k + 2, end - 1));
    mark(s);
    return { status: "ok", end };
  }
  const exp = dollarExpansion(src, k);
  if (exp === undefined) return { status: "none" };
  if (exp.end < 0) return { status: "unclosed" };
  add(s, exp.text);
  if (exp.dyn) s.dyn = true;
  return { status: "ok", end: exp.end };
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
      const exp = expansionAt(s, src, k);
      if (exp.status === "unclosed") return -1;
      if (exp.status === "ok") {
        k = exp.end;
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
    // The word began with a bare `~`: keep the RAW spelling alongside the expansion.
    // A judge that must ask "which home did the PARENT mean?" cannot recover it from text
    // already substituted with THIS process's home, which for a helper child is the
    // scratch tree the harness redirected it to.
    // The whole word as typed, not just the `~`: a judge that re-expands it under
    // another home needs the part after the marker too.
    if (s.word === undefined) s.raw = src.slice(i);
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
  const s: State = { toks: [], subs: [], bodies: [], dyn: false, glob: false };
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
      const exp = expansionAt(s, src, i);
      if (exp.status === "unclosed") return undefined;
      if (exp.status === "ok") {
        i = exp.end;
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
      const unquoted: string[] = [];
      const all: string[] = [];
      i = skipHeredocBodies(src, i + 1, heredocs, unquoted, all);
      // Every body travels, quoted or not: a `cat <F>` inside a quoted body is a
      // read even though the shell expands nothing there. The substitutions of an
      // UNQUOTED body are additionally judged as commands, because the shell runs them.
      s.bodies.push(...all);
      for (const body of unquoted) {
        const subs = heredocSubstitutions(body);
        if (subs === undefined) return undefined;
        s.subs.push(...subs);
      }
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
      // A parenthesis keeps its own token: a subshell's `cd` ends with the subshell.
      op(s, ch);
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
        // A here-string (`<<<`). Its operand is DATA, so a caller that judges reads
        // has to be able to tell it from an input redirect: the lexer otherwise keeps
        // both operands as plain words and emits the SAME `<` token for each. The
        // operator's text carries the difference, and `<<<` is no operator the
        // write-side splitter or the read judge treats as a file-opening redirect.
        op(s, "<<<");
        i += 3;
      } else if (next === "<") {
        const heredoc = heredocDelimiter(src, i);
        if (heredoc === -1) return undefined;
        heredocs.push({ delim: heredoc.delim, strip: heredoc.strip, quoted: heredoc.quoted });
        op(s, "<<");
        i = heredoc.end;
      } else {
        op(s, "<");
        i++;
      }
    } else {
      if (GLOB_CHARS.has(ch)) s.glob = true;
      add(s, ch);
      i++;
    }
  }
  endWord(s);
  return { toks: s.toks, subs: s.subs, bodies: s.bodies };
}

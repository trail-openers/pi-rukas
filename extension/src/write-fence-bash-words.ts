/**
 * write-fence-bash-words — the scanning helpers under the bash lexer (#1655).
 *
 * Each function takes the command text and a position, and returns the position
 * after the construct it scanned, or -1 when the construct is not closed (the
 * command does not lex). Nothing here decides what a word means; that is the
 * lexer's job. The one exception is `dollarExpansion`, which says whether a `$`
 * expansion is static (`$HOME`) or only known at run time.
 */

import { homeDir } from "./write-fence-path.ts";

/** What a `$` expansion means to the fence: the text it stands for, and whether that text is unknowable. */
export interface Expansion {
  /** Position after the expansion, or -1 when it is not closed. */
  end: number;
  /** The static text (`$HOME` is the home directory); the raw source for a run-time expansion. */
  text: string;
  /** The value is only known when the command runs, so a path built from it cannot be judged. */
  dyn: boolean;
}

/** The single-character escapes bash resolves inside `$'…'`. */
const ANSI_SIMPLE = new Map<string, string>([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

/** Numeric escapes of `$'…'`: octal `\nnn`, hex `\xHH`, and Unicode `\uHHHH` / `\UHHHHHHHH`. */
const ANSI_NUMERIC = /^(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8})/;

/**
 * The text of an ANSI-C quoted body (`$'…'`, without its quotes). Unknown escapes
 * keep their backslash, as bash does. Undefined when a numeric escape names no
 * code point, which the lexer treats as a command it cannot read.
 */
export function decodeAnsiC(raw: string): string | undefined {
  let out = "";
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k] ?? "";
    if (c !== "\\" || k + 1 >= raw.length) {
      out += c;
      continue;
    }
    const nx = raw[k + 1] ?? "";
    const simple = ANSI_SIMPLE.get(nx);
    if (simple !== undefined) {
      out += simple;
      k++;
      continue;
    }
    const m = ANSI_NUMERIC.exec(raw.slice(k + 1));
    if (m) {
      const digits = m[0];
      const isHex = digits[0] === "x" || digits[0] === "u" || digits[0] === "U";
      const code = isHex ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 8);
      if (!Number.isFinite(code) || code > 0x10ffff) return undefined;
      out += String.fromCodePoint(isHex ? code : code & 0xff);
      k += digits.length;
      continue;
    }
    out += "\\";
  }
  return out;
}

/** `src[i]` is a backtick. The position after its closing backtick, or -1. */
export function skipBacktick(src: string, i: number): number {
  for (let k = i + 1; k < src.length; ) {
    const c = src[k];
    if (c === "\\") k += 2;
    else if (c === "`") return k + 1;
    else k++;
  }
  return -1;
}

/** `src[i]` is a double quote. The position after its closing quote, or -1. */
export function skipDoubleQuoted(src: string, i: number): number {
  for (let k = i + 1; k < src.length; ) {
    const c = src[k];
    if (c === '"') return k + 1;
    if (c === "\\") k += 2;
    else if (c === "$" && src[k + 1] === "(") k = skipSubst(src, k);
    else if (c === "`") k = skipBacktick(src, k);
    else k++;
    if (k < 0) return -1;
  }
  return -1;
}

/**
 * `src[i]` is the `$` of `$(`. The position after the matching `)`, or -1. Quotes
 * and nested substitutions are skipped as units, so a `)` inside them does not close it.
 */
export function skipSubst(src: string, i: number): number {
  let depth = 1;
  for (let k = i + 2; k < src.length; ) {
    const c = src[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", k + 1);
      if (close < 0) return -1;
      k = close + 1;
      continue;
    }
    if (c === '"') k = skipDoubleQuoted(src, k);
    else if (c === "`") k = skipBacktick(src, k);
    else if (c === "$" && src[k + 1] === "(") {
      k = skipSubst(src, k);
    } else {
      if (c === "(") depth++;
      if (c === ")" && --depth === 0) return k + 1;
      k++;
    }
    if (k < 0) return -1;
  }
  return -1;
}

/**
 * The `$` expansion at `src[k]`, when it is one the fence reads. `$(…)` and
 * backticks are substitutions, handled by the lexer (they carry a command body).
 * Undefined for a literal `$`, and for `$'…'` (the lexer decodes that one) and
 * `$"…"` (a plain double-quoted string).
 */
export function dollarExpansion(src: string, k: number): Expansion | undefined {
  const rest = src.slice(k);
  if (rest.startsWith("$'")) return undefined;
  if (rest.startsWith('$"')) return { end: k + 1, text: "", dyn: false };
  if (/^\$HOME(?![A-Za-z0-9_])/.test(rest)) return { end: k + 5, text: homeDir(), dyn: false };
  if (rest.startsWith("${HOME}")) return { end: k + 7, text: homeDir(), dyn: false };
  if (rest.startsWith("${")) {
    const close = src.indexOf("}", k + 2);
    return close < 0
      ? { end: -1, text: "", dyn: true }
      : { end: close + 1, text: src.slice(k, close + 1), dyn: true };
  }
  const name = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?!$-])/.exec(rest);
  if (name) return { end: k + name[0].length, text: name[0], dyn: true };
  return undefined;
}

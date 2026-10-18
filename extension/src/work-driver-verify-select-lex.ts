/**
 * work-driver-verify-select-lex — #1647: one tokenizer for the selector's import
 * graph.
 *
 * The selector needs the code of a TypeScript file with its comments gone and
 * its literals kept apart, so that an `import` written inside a comment or a
 * string cannot create an edge and a `/` inside a regex cannot hide one. It is
 * a small lexer, not a parser, and it does not need `typescript`: the extension
 * declares that as a dev dependency only, and the selector runs in the shipped
 * extension.
 *
 * Output: `code`, the source with comments removed, every quoted string
 * replaced by `<index>`, every template literal by
 * `<index>` and every regex literal by ``. The literal values
 * sit in `strings` and `templates` by index. A regex literal is recognised by
 * the token before its `/`: where an operand could not end, the `/` opens one.
 *
 * Anything the lexer cannot close (an unterminated string, comment, template or
 * regex) returns `undefined`. The selector treats that file as unreadable and
 * falls back to the full suite, because a graph built from a misread file is a
 * selection that can silently miss a test.
 */

export interface LexedSource {
  code: string;
  strings: string[];
  templates: string[];
}

/** Keywords after which an operand can begin, so a following `/` opens a regex. */
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** Punctuation after which an operand can begin (not `)`, `]` or `}`, which end one). */
const REGEX_AFTER_PUNCT = new Set("(,=:[!&|?{};+-*%<>~^".split(""));

// Private-use code points stand in for the literals. Source that already contains
// one is refused below, so a placeholder can never be mistaken for real text.
const STR = "";
const TPL = "";
const REG = "";
const PLACEHOLDER_RE = /[-]/;

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[\w$]/.test(c);

/** Returns the index just past a `/`-delimited regex starting at `i`, or -1 when it does not close on this line. */
function skipRegex(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\") {
      j++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "/") {
      let k = j + 1;
      while (k < text.length && isIdentPart(text[k] as string)) k++;
      return k;
    }
  }
  return -1;
}

/** Returns the index just past a quoted string starting at `i`, or -1 when it is unterminated. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === "\n") return -1;
  }
  return -1;
}

/**
 * Returns the index just past a template literal starting at `i`, or -1.
 * `${…}` is skipped by brace depth; a backtick nested inside an interpolation
 * is not tracked, which makes such a template end early and then fail to
 * reconcile. Test sources in this repo do not nest templates in interpolations.
 */
function skipTemplate(text: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (depth === 0 && c === "`") return j + 1;
    if (c === "$" && text[j + 1] === "{") {
      depth++;
      j++;
    } else if (depth > 0 && c === "}") depth--;
  }
  return -1;
}

/** Lex one TypeScript source. `undefined` when a comment, string, template or regex does not close. */
export function lexSource(text: string): LexedSource | undefined {
  if (PLACEHOLDER_RE.test(text)) return undefined;
  const strings: string[] = [];
  const templates: string[] = [];
  let code = "";
  let i = 0;
  // The last significant token, for the regex-or-division decision.
  let last = "";
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (/\s/.test(c)) {
      code += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      code += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      code += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(text, i);
      if (end < 0) return undefined;
      strings.push(text.slice(i + 1, end - 1));
      code += `${STR}${strings.length - 1}${STR}`;
      i = end;
      last = "value";
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(text, i);
      if (end < 0) return undefined;
      templates.push(text.slice(i + 1, end - 1));
      code += `${TPL}${templates.length - 1}${TPL}`;
      i = end;
      last = "value";
      continue;
    }
    if (c === "/") {
      const opensRegex =
        last === "" ||
        (last.length === 1 && REGEX_AFTER_PUNCT.has(last)) ||
        REGEX_AFTER_WORDS.has(last);
      if (opensRegex) {
        const end = skipRegex(text, i);
        if (end < 0) return undefined;
        code += REG;
        i = end;
        last = "value";
        continue;
      }
    }
    if (isIdentStart(c) || /[0-9]/.test(c)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j] as string)) j++;
      const word = text.slice(i, j);
      code += word;
      i = j;
      last = REGEX_AFTER_WORDS.has(word) ? word : "value";
      continue;
    }
    code += c;
    i++;
    last = c;
  }
  return { code, strings, templates };
}

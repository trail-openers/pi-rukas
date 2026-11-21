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
 * replaced by `<STR><index><STR>`, every template literal by
 * `<TPL><index><TPL>` and every regex literal by `<REG>`. The literal values
 * sit in `strings` and `templates` by index. A regex literal is recognised by
 * the token before its `/`: where an operand could not end, the `/` opens one.
 *
 * A template's interpolations are code again, so nesting is tracked on a stack:
 * a `${...}` may open a template whose own `${...}` opens another, and each closes
 * at its own level. A quoted string, by contrast, is inert text.
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

// Private-use code points stand in for the literals, each written as a \u escape so
// this module stays ordinary ASCII and can lex itself. A marker the lexer did not
// write is a collision it cannot resolve, so GUARD_RE refuses any source carrying
// one. A bare marker with a vouching ESC before it is one this pass wrote itself:
// a template value legitimately holds the placeholder of a template nested inside
// it, and `escapePlaceholders` prefixes each with ESC to say so.
const STR = "\uE000";
const TPL = "\uE001";
const REG = "\uE002";
/** Marks a following code point as one the lexer wrote, not one the source carried. */
const ESC = "\uE003";
// Per-marker lookbehind, not a whole-file test: this module spells the markers as
// escapes and spells GUARD_RE itself as a character class, so every marker in its
// own source is vouched for by a preceding ESC and the lexer can lex itself.
const GUARD_RE = new RegExp(`(?<!${ESC})[${STR}${TPL}${REG}]`);
const PLACEHOLDER_CHARS = [STR, TPL, REG];
/**
 * The literal placeholder characters, for a consumer whose regexes match them.
 * A pattern that spells them as `\u` escapes carries a vouching ESC and so lexes
 * cleanly; one that pastes the raw code point is a placeholder collision, which
 * the guard above refuses — see test-verify-select-lex-tree.ts.
 */
export const LITERAL_MARKERS = { STR, TPL, REG, ESC } as const;
/** True when the source itself carries a marker the lexer did not write — a collision the lexer cannot resolve. */
const carriesPlaceholder = (text: string): boolean => GUARD_RE.test(text);

/** Prefix every marker in `value` with ESC, so only this pass's markers stay bare. */
function escapePlaceholders(value: string): string {
  let out = value;
  for (const ch of PLACEHOLDER_CHARS) out = out.split(ch).join(`${ESC}${ch}`);
  return out;
}

/**
 * The template value as the source spelled it. A consumer that reads a template
 * token back out of `LexedSource.templates` compares or prints real source text,
 * so it must see the unescaped value: the escape is the lexer's bookkeeping, not
 * part of the file.
 */
export function unplaceholder(value: string): string {
  let out = value;
  for (const ch of PLACEHOLDER_CHARS) out = out.split(`${ESC}${ch}`).join(ch);
  return out;
}

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
 *
 * A stack of open templates, not a brace counter. A `${...}` interpolation is
 * ordinary code, so it can open a nested template whose own interpolation opens
 * another, and the only way to know which backtick closes which template is to
 * remember the level each one opened at: in `` a ${`${b}^{c}`} d `` the outer
 * template is closed by the LAST backtick, not the first one after the
 * interpolation opened. A single depth counter took the inner template's closing
 * `}` for the interpolation's, went to −1 and reported the file unlexable — which
 * is how every `git rev-parse ${JSON.stringify(`${ref}^{tree}`)}` in this repo
 * silently disabled the develop-round test selection.
 *
 * Inside an interpolation, `}` closes it only at that interpolation's own brace
 * depth, so an object literal or an arrow body is balanced text. Comments and
 * quoted strings are inert at every level: a `}` or a backtick inside either is
 * text, and the level is restored exactly as it was.
 */
function skipTemplate(text: string, i: number): number {
  // One frame per open template: `tpl` false while inside that template's
  // interpolation, where `brace` counts the braces the interpolation itself
  // carries.
  const stack: { tpl: boolean; brace: number }[] = [{ tpl: true, brace: 0 }];
  for (let j = i + 1; j < text.length; j++) {
    const top = stack[stack.length - 1];
    if (top === undefined) return -1;
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (top.tpl) {
      if (c === "`") {
        stack.pop();
        if (stack.length === 0) return j + 1;
        continue;
      }
      if (c === "$" && text[j + 1] === "{") {
        top.tpl = false;
        j++;
      }
      continue;
    }
    // Inside an interpolation: this is code, so a comment or a literal is inert
    // text, a nested template is another frame on the same stack, and — the
    // case a plain character scan gets wrong — a `/` can open a REGEX, whose
    // body may spell a quote or a brace. `quoteWord` below is the real shape:
    // `` `'${w.replace(/'/g, "'\\''")}'` `` reads its regex body as code unless
    // the regex is recognised here, and then the interpolation never closes.
    if (c === "/" && text[j + 1] === "/") {
      const end = text.indexOf("\n", j);
      if (end < 0) return -1;
      j = end - 1; // the loop's j++ lands on the newline
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      if (end < 0) return -1;
      j = end; // the loop's j++ lands just past `*/`
      continue;
    }
    if (c === "/" && opensOperand(text, j)) {
      const end = skipRegex(text, j);
      // A `/` that does not close a regex on its line is division or a path
      // separator, not an unterminated literal: it stays ordinary text.
      if (end >= 0) {
        j = end - 1;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(text, j);
      if (end < 0) return -1;
      j = end - 1;
      continue;
    }
    if (c === "`") {
      stack.push({ tpl: true, brace: 0 });
      continue;
    }
    if (c === "{") top.brace++;
    else if (c === "}") {
      if (top.brace === 0) {
        // This `}` closes the interpolation, so the frame under it is the
        // template the interpolation was written in: back to template level,
        // NOT off the stack — popping here would forget the very template
        // whose closing backtick this walk still has to find.
        top.tpl = true;
        continue;
      }
      top.brace--;
    }
  }
  return -1;
}

/**
 * True when a `/` inside an interpolation opens a regex rather than dividing.
 *
 * The top-level lexer decides with the last significant token; here the same
 * question is answered from the characters already walked. An operand can
 * follow `(`, `,`, `=`, `:` or an operator, and can never follow an identifier
 * or a closing bracket — so scanning back past whitespace and comments for the
 * last significant character answers it. Anything unrecognised is reported as a
 * non-operand position, the safe side of the doubt: a `/` mistaken for division
 * is still ordinary text, while one mistaken for a regex can swallow the
 * interpolation's closing brace and unlex the whole file.
 */
function opensOperand(text: string, from: number): boolean {
  for (let k = from - 1; k >= 0; k--) {
    const c = text[k] as string;
    if (/\s/.test(c)) continue;
    // A regex, a string or a closing bracket ends an operand; an identifier or
    // a digit does too. Everything else is where an operand can begin.
    if (/[)\]}'"`]/.test(c)) return false;
    if (isIdentPart(c) || /[0-9]/.test(c)) return false;
    return true;
  }
  return true;
}

/** Lex one TypeScript source. `undefined` when a comment, string, template or regex does not close. */
export function lexSource(text: string): LexedSource | undefined {
  if (carriesPlaceholder(text)) return undefined;
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
      // The value spans the whole outer template, nested templates included,
      // so it can already contain markers this pass wrote for those nested
      // ones. Escaping them keeps every bare placeholder in `code` one the
      // lexer made at THIS level — which is what makes the placeholder-collision
      // guard above a guard rather than a coin flip. `unplaceholder` undoes it
      // for a consumer that wants the source text back.
      templates.push(escapePlaceholders(text.slice(i + 1, end - 1)));
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

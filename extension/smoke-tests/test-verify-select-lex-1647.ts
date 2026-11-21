#!/usr/bin/env bun
/**
 * #2450 — the selector's tokenizer on nested templates.
 *
 * `skipTemplate` tracked `${…}` by brace depth alone, so a backtick nested
 * inside an interpolation was read as the OUTER template's closing quote. The
 * inner template's own closing `}` was then taken for an interpolation close,
 * the depth went to −1 and `lexSource` returned `undefined`. Nine graph nodes
 * in this repo are shaped that way — every `git rev-parse ${JSON.stringify
 * (`${ref}^{tree}`)}` — and the selector treats an unlexable file as a reason
 * to run the whole suite, so selection has been inert since the lexer landed.
 *
 * The lexer is the selector's single entry point (both consumers call only
 * `lexSource`) and had no test of its own until this file: a defect in it
 * could only be seen through the selection it disabled.
 *
 * Each case below is measured UNLEXABLE on the pre-fix `skipTemplate`, so a
 * regression that restores the brace-depth-only walk fails here by name rather
 * than silently turning the develop gate back into the full suite. The
 * measured-passing cases are pinned in the same block: an interpolation
 * holding an object literal or an arrow body already lexed, and a fix that
 * breaks one of those is the worse failure (it would send a clean file to the
 * full suite).
 */
import { lexSource, unplaceholder } from "../src/work-driver-verify-select-lex.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

/** Lex a snippet the way a source file would carry it. */
const lex = (snippet: string) => lexSource(`const q = ${snippet};\n`);
const lexes = (name: string, snippet: string, msg: string) =>
  assert(lex(snippet) !== undefined, `${name}: ${msg}`);
const refuses = (name: string, snippet: string, msg: string) =>
  assert(lex(snippet) === undefined, `${name}: ${msg}`);
/**
 * Lex text that ENDS where the file ends, with no `;\n` grafted on.
 *
 * `lex` above appends `;\n` because that is how a snippet sits inside a real
 * statement — and that suffix is what closes a construct the file never closed.
 * `buildGraph` hands `lexSource` the bytes of a truncated file, so an EOF the
 * lexer reads as a complete template is invisible to a suffixed snippet: only
 * text that stops at its last character measures the fail-closed exit.
 */
const refusesAtEof = (name: string, text: string, msg: string) =>
  assert(lexSource(text) === undefined, `${name}: ${msg}`);

// --- nested templates whose interpolation contains a brace ------------------
// The exact shape at src/worktree-loss.ts:450 (`${fromRef}^{tree}`).
lexes(
  "nested brace in a nested interpolation",
  "`a ${`${b}^{c}`} d`",
  "`a ${`${b}^{c}`} d` lexes — the measured UNLEXABLE case that made nine graph nodes unlexable",
);
// The production site itself: an outer template holding JSON.stringify of a nested template.
lexes(
  "JSON.stringify of a nested template",
  "`git rev-parse ${JSON.stringify(`${fromRef}^{tree}`)}`",
  "the `git rev-parse ${JSON.stringify(`${ref}^{tree}`)}` shape lexes",
);
lexes(
  "a nested interpolation holding a block",
  "`a ${ (() => { const x = 1; return x })() } b`",
  "an interpolation holding a block body lexes",
);
// The three shapes the issue's suggested criteria name as measured UNLEXABLE on
// main. The first is the `${fromRef}^{tree}` production form; the third is the one
// a brace counter cannot survive even without a nested template, because the
// tail text after the inner template carries a further `}`.
lexes(
  "nested interpolation holding a brace (y\${t}^{tree} form)",
  "`git rev-parse \${JSON.stringify(\`${y}^{tree}\`)}`",
  "the y\${t}^{tree} form lexes — measured UNLEXABLE on main",
);
lexes(
  "a nested interpolation whose tail text holds a further }",
  "`a ${`${b}`} } c`",
  "a further } in the text after a nested template lexes — measured UNLEXABLE on main",
);
// A placeholder (private-use code point) inside a NESTED template's own value is
// the case the escape exists for: without it the marker inside the parent's value
// would read as a bare collision and unlex a clean file.
lexes(
  "a nested template whose value carries the lexer's own marker",
  "`outer \${ \`\${inner}\` } tail`",
  "a nested template's placeholder inside its parent's value is not read as a collision",
);
lexes(
  "a nested interpolation holding an object literal",
  "`a ${ {k:1} } b`",
  "an interpolation holding an object literal still lexes (measured passing pre-fix — a regression here widens the fallback)",
);
lexes(
  "a nested interpolation holding an arrow body",
  "`a ${(() => { return 1 })()} b`",
  "an interpolation holding an arrow body still lexes (measured passing pre-fix)",
);
lexes(
  "a nested interpolation whose tail text carries a quoted }",
  '`a ${ `${b}` + "}" } c`',
  "a tail text carrying a further `}` lexes (measured passing pre-fix)",
);
lexes(
  "three levels of nesting",
  "`a ${`${`${b}`}^{c}`} d`",
  "three levels of template nesting lex",
);
lexes(
  "a nested template after a join in the same interpolation",
  '`${a}${Array.from({ length: 8 }, (_, i) => `d${i + 1}/`).join("")}x`',
  "a nested template built inside an array callback in an interpolation lexes",
);
lexes(
  "an escaped backtick",
  "`a \\` b ${c}`",
  "an escaped backtick does not open a nested template",
);
lexes(
  "a backtick inside a string inside an interpolation",
  '`a ${ "x`y" } b`',
  "a backtick inside a double-quoted string inside an interpolation does not open a template",
);
lexes(
  "a closing brace inside a string inside an interpolation",
  '`a ${ "}" } b`',
  "a `}` inside a string inside an interpolation does not close the interpolation",
);
lexes(
  "a comment inside an interpolation",
  "`a ${ /* } ` inside a comment */ b } c`",
  "a `}` and a backtick inside a comment in an interpolation are inert",
);
// The literals are still the text between the OUTERMOST template's quotes: the
// placeholder stack has to pop back to the right level to report them.
{
  const r = lex("`a ${`${b}^{c}`} d`");
  assert(
    r?.templates.join("|") === "a ${`${b}^{c}`} d",
    `the whole outer template is one literal, nested text included (got ${JSON.stringify(r?.templates)})`,
  );
  assert(
    /^const q = [\uE001]0[\uE001];\n$/.test(r?.code ?? ""),
    `the lexed code is the source with the WHOLE outer template replaced by one placeholder token — no interior text leaks into code (got ${JSON.stringify(r?.code)})`,
  );
  // The nested template had to be lexed on the way to the outer one end, so its
  // own placeholder lands inside the parent value. `unplaceholder` is what hands
  // a consumer back the source text it expected to see.
  assert(
    unplaceholder(r?.templates[0] ?? "") === "a ${`${b}^{c}`} d",
    `unplaceholder restores the source text of a template whose interior held a nested one (got ${JSON.stringify(r?.templates[0])})`,
  );
}
// An unterminated nested template is still refused: the fix must not make the
// lexer optimistic about a quote that never closes.
refuses(
  "an unterminated nested template",
  "`a ${`${b} d`",
  "a nested template that never closes is unlexable, not an early success",
);
refuses(
  "an unterminated outer template",
  "`a ${b} d",
  "an outer template that never closes is unlexable",
);
refuses(
  "an unterminated string",
  '"unterminated',
  "an unterminated string is unlexable",
);
// --- an unclosed construct at the END of the text ---------------------------
// The cases above all sit inside a suffixed snippet, so a construct they leave
// open is closed by the `;\n` the harness grafts on. These are the bytes of a
// truncated file: no suffix, the text simply stops. An EOF the lexer reads as a
// complete template hands the selector an edge cut out of the middle of a file,
// which selects fewer tests than the diff needs — so each of these is measured
// LEXES when its own fail-closed `return -1` in `skipTemplate` is turned into an
// EOF-optimistic return.
refusesAtEof(
  "a template that never closes before the end of the file",
  "export const q = `abc",
  "a template still open at the last byte is unlexable",
);
refusesAtEof(
  "a template that ends in an opening interpolation",
  "export const q = `${",
  "a file whose last characters are `${` is unlexable",
);
refusesAtEof(
  "an interpolation left open at end of text",
  "export const q = `a ${ b",
  "a template whose interpolation never closes by the end of the file is unlexable",
);
refusesAtEof(
  "an unclosed nested template at end of text",
  "export const q = `a ${`x`",
  "a nested template still open at the end of the file is unlexable",
);
refusesAtEof(
  "a line comment left open inside an interpolation",
  "export const q = `a ${ b // the comment never ends",
  "a line comment with no newline after it inside an interpolation is unlexable",
);
refusesAtEof(
  "a block comment left open inside an interpolation",
  "export const q = `a ${ b /* no terminator",
  "a block comment with no `*/` inside an interpolation is unlexable",
);
refusesAtEof(
  "a quoted string left open inside an interpolation",
  'export const q = `a ${ "unclosed',
  "a string with no closing quote inside an interpolation is unlexable",
);
refusesAtEof(
  "an open line comment on a later line of the file",
  "const a = 1;\nexport const q = `a ${ b // tail",
  "a comment open to the last byte unlexes the file however early the template opened",
);
// The same comment shapes closed by a terminator are ordinary code: the refusals
// above must come from the missing terminator, not from a comment being illegal
// inside an interpolation. The newline arm is load-bearing in both directions —
// a `}` past a TERMINATED comment belongs to the interpolation, so the walk has to
// resume on the newline and still read it as code.
lexes(
  "a line comment closed by a newline inside an interpolation",
  "`a ${ b // ok\n}`",
  "a line comment inside an interpolation is inert when a newline ends it",
);
lexes(
  "a block comment closed inside an interpolation",
  "`a ${ b /* ok */}`",
  "a block comment inside an interpolation is inert when `*/` ends it",
);

// --- the placeholder collision guard ---------------------------------------
// A source that already carries one of the private-use code points the lexer
// substitutes for literals is refused, because a placeholder that was already
// there would be read as one the lexer made. Untested until now: a false
// positive here silently unlexes a clean file, which is the same inert-selector
// failure this issue exists to kill.
{
  const clean = 'export const a = 1;\nconst s = "x";\n';
  assert(lexSource(clean) !== undefined, "a clean file with no placeholder code point lexes");
  assert(
    lexSource(`${clean}const p = "\u{E000}";\n`) === undefined,
    "a source carrying a placeholder code point is refused (a pre-existing placeholder would be misread as one the lexer made)",
  );
  assert(
    lexSource(`${clean}// \u{E002}\n`) === undefined,
    "the refusal covers every placeholder code point, not only the string marker",
  );
}

process.exit(exit);

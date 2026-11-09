#!/usr/bin/env bun
/**
 * #2141 — source-level pin: no plan-renderer `replace`/`replaceAll` may pass
 * untrusted text as its REPLACEMENT argument.
 *
 * `String.prototype.replace` expands dollar patterns inside a *string*
 * replacement: the backtick form re-inserts everything before the match, the
 * apostrophe form everything after it, the ampersand form the matched text, the
 * digit forms the capture groups. /plan's Open Questions splice did exactly that
 * and re-rendered the whole issue body once per pattern. A replacer FUNCTION is
 * immune, and so is a literal whose bytes the author typed.
 *
 * Scanned set — exactly the module list the spec's References name:
 * plan-draft.ts, plan-writeback.ts, plan-pi-spec.ts, plan-pi-spec-text.ts,
 * plan-block-walk.ts, plan-validate.ts, plan-types.ts.
 *
 * Method: per line of comment-stripped source, find each `.replace(`/
 * `.replaceAll(`, read its second argument with a paren- and quote-aware scan of
 * THAT CALL only, and classify the argument's first characters. An argument that
 * cannot be read or classified is a ✗ — the pin fails closed rather than
 * skipping, and a scan that judged no site fails on its own count below.
 *
 * DISCLOSED BLIND SPOTS (each is a false PASS, never a false failure):
 *   - comments are stripped by the two-regex idiom copied from
 *     test-plan-research-signal-canary.ts, so a `//` inside a string or regex
 *     literal truncates the real code that follows it on that line;
 *   - the scan is per line, so a call whose argument list spans lines is
 *     unclassified (and therefore a ✗) unless its opening line closes the call.
 * Closing these needs a tokenizer, which costs more than the rule protects
 * (AGENTS.md §6). test-plan-replace-patterns.ts is what actually pins the render.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
const D = String.fromCharCode(36);
const B = String.fromCharCode(92);
// The one dollar-carrying string the rule allows, spelled from char codes so
// this file never holds the literal sequence: "\ <backslash> $ &".
const ESCAPER = `"${B}${B}${D}&"`;

const SRC = path.resolve(import.meta.dirname, "..", "src");
const FILES = [
  "plan-draft.ts",
  "plan-writeback.ts",
  "plan-pi-spec.ts",
  "plan-pi-spec-text.ts",
  "plan-block-walk.ts",
  "plan-validate.ts",
  "plan-types.ts",
];

/**
 * The source text of a regex literal starting at `from`, or null when it does
 * not terminate on this line. `/` is not quoted, so its character classes have
 * to be tracked: `/[.,;:!?)]+$/` and `/[,;:)]+[)\]]*$/g` both hold the `)` and
 * `]` that a quote-only scan would treat as the end of the call.
 */
/**
 * The source text of a regex literal starting at `from`, or null when it does
 * not terminate on this line. A pattern is a PATTERN, never a replacement, so it
 * is skipped whole — and skipping it is what stops a character class's `)` or
 * `]` (`/[.,;:!?)]+$/`, `/[,;:)]+[)\]]*$/g`) from ending the call early.
 */
function regexLiteral(line: string, from: number): string | null {
  let i = from + 1;
  let inClass = false;
  for (; i < line.length; i++) {
    const c = line[i] as string;
    if (c === B) {
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
  }
  if (i >= line.length) return null;
  i++;
  while (i < line.length && /[dgimsuvy]/.test(line[i] as string)) i++;
  return line.slice(from, i);
}

/** Second argument of the call whose `(` sits at `open`, or null if unreadable. */
function secondArg(line: string, open: number): string | null {
  let depth = 0;
  let i = open;
  const args: string[] = [];
  let cur = "";
  for (; i < line.length; i++) {
    const c = line[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < line.length) {
        if (line[i] === B) i += 2;
        else if (line[i] === c) break;
        else i++;
      }
      if (i >= line.length) return null; // never closed on this line
      cur += line.slice(start, i + 1);
      continue;
    }
    // A pattern is a PATTERN, never a replacement, so it is skipped whole — and
    // skipping it is what stops a class's `)` or `]` from ending the call early.
    if (c === "/" && !/\w/.test(line.slice(0, i).trimEnd().slice(-1) ?? "")) {
      const lit = regexLiteral(line, i);
      if (lit === null) return null;
      cur += lit;
      i += lit.length - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        args.push(cur);
        return args.length >= 2 ? args[1] : null;
      }
    }
    if (depth === 1 && c === ",") {
      args.push(cur);
      cur = "";
      continue;
    }
    if (depth >= 1) cur += c;
  }
  return null; // the call did not close on this line
}

/** Classify the replacement. True = safe; anything else is a ✗ (fails closed). */
function safeReplacement(arg: string): boolean {
  const a = arg.trim();
  const quote = a[0] as string;
  if (quote === '"' || quote === "'" || quote === "`") {
    if (a === ESCAPER) return true; // the escapeRe escaper idiom, exact source text
    const rest = a.slice(1, -1);
    if (rest.includes(D)) return false; // untrusted bytes in the replacement
    return quote !== "`" || !rest.includes(`${D}{`);
  }
  if (a.startsWith("=>") || /^[\w$]+\s*=>/.test(a) || /^function\b/.test(a)) return true;
  // An identifier is only ever a VARIABLE here — a call's second argument names
  // no parameter, so there is nothing in scope it could denote a function. A
  // bare identifier therefore carries text of unknown origin and must fail.
  return false; // a variable, interpolation, concatenation, or member expression
}

const bad: string[] = [];
let sites = 0;

for (const file of FILES) {
  const src = readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  const lines = src.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string;
    for (const m of line.matchAll(/\.(replace|replaceAll)\s*\(/g)) {
      const verb = m[1] as string;
      const at = (m.index ?? 0) + verb.length + 1; // the `(` of the call
      sites++;
      const arg = secondArg(line, at);
      // An unreadable argument is `null`, which is not `true`: it fails closed.
      if (arg === null || !safeReplacement(arg)) {
        const why =
          arg === null
            ? "the call could not be read on this line"
            : `replacement ${(arg ?? "").trim().slice(0, 48)}`;
        bad.push(`${file}:${n + 1} ${verb} — ${why}`);
      }
    }
  }
}

console.log(
  `${bad.length === 0 ? "✓" : "✗"} ${sites} replace/replaceAll sites in ${FILES.length} plan-renderer files: replacements are literals or functions`,
);
for (const b of bad) console.error(`✗ ${b}`);
if (bad.length > 0) exit = 1;
console.log(
  `${sites >= 15 ? "✓" : "✗"} the pin judged ${sites} sites (a scan that found nothing judged nothing)`,
);
if (sites < 15) exit = 1;

process.exit(exit);

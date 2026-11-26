/**
 * work-driver-verify-select-edges — #1647: one file's import edges, from its text.
 *
 * The selector's graph is built from the source text rather than a bundler: static
 * `import` / `export … from` / side-effect `import "x"`, a literal dynamic
 * `import("x")` or `require("x")`, and — for a smoke test — an `src/…ts` path spelled
 * as a whole string literal, because a test that opens a source file by name depends
 * on it in a way no import shows. Comments and literals are separated by one
 * tokenizer (`work-driver-verify-select-lex`), so an import written inside a comment
 * or a string creates no edge.
 *
 * A file whose comment, string, template or regex the tokenizer cannot close has no
 * edges: the walk reports it as unreadable and the selection falls back rather than
 * trust a graph built from a misread file.
 */

import path from "node:path";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";

/** A relative specifier: `./x`, `../x`, `.`, `..`. Bare package names are not edges. */
const RELATIVE_SPEC_RE = /^\.\.?(?:\/|$)/;
/** A static import or re-export on lexed code: the specifier is the string token that ends the statement head. */
// The markers are spelled as \u escapes rather than pasted, because a bare private-use
// code point in this file would be a placeholder collision to the very lexer whose
// output these patterns match — lexSource would refuse the file and the whole graph
// would fall back. biome's useRegexLiterals would rewrite them to the raw code points,
// which is the regression this comment is the standing reason against.
// biome-ignore lint/complexity/useRegexLiterals: the escapes are the point, not an avoidance of escaping.
const STATIC_RE = new RegExp(
  "\\b(?:import|export)\\s+(?:type\\s+)?(?:[\\w*{}\\s,$]+\\s+from\\s+)?\\uE000(\\d+)\\uE000",
  "g",
);
/** A call head `import(` or `require(`, on lexed code. */
const CALL_RE = /\b(import|require)\s*\(/g;
/** A string token as the first argument of a call, the rest of the call's head. */
// See STATIC_RE: the \u escapes keep this file free of a bare placeholder the lexer would refuse.
// biome-ignore lint/complexity/useRegexLiterals: the escapes are the point, not an avoidance of escaping.
const LITERAL_ARG_RE = new RegExp("^\\s*\\uE000(\\d+)\\uE000\\s*\\)");
/** `src/x.ts` (optionally `extension/`- or `../`-prefixed) as a whole string value. */
const PATH_LITERAL_RE = /^(?:\.{1,2}\/)*(?:extension\/)?(src\/[^\s]+?\.ts)$/;

export interface FileEdges {
  /** Relative specifiers this file imports (static, re-export, literal dynamic or literal require). */
  specifiers: string[];
  /** Extension-relative `src/…ts` targets named by a path string literal. */
  paths: string[];
  /** True when a dynamic import or require names its target through a non-literal. */
  dynamic: boolean;
  /**
   * True when a smoke test spells a bare `"src"` string (`path.join(ext, "src", "x.ts")`):
   * it reaches source modules through a path no specifier shows, so it depends on all of them.
   */
  touchesSrc: boolean;
}

/**
 * The edges of one file, from its text. Undefined when the tokenizer cannot
 * close a comment, string, template or regex: the file is then unreadable, and
 * the selector falls back rather than trust a graph built from it.
 */
export function edgesOf(fileRel: string, raw: string): FileEdges | undefined {
  const lexed = lexSource(raw);
  if (lexed === undefined) return undefined;
  return factsOf(fileRel, lexed);
}

export function factsOf(fileRel: string, lexed: LexedSource): FileEdges {
  const { code, strings } = lexed;
  const specifiers: string[] = [];
  const add = (spec: string | undefined) => {
    if (spec !== undefined && RELATIVE_SPEC_RE.test(spec)) specifiers.push(spec);
  };
  for (const m of code.matchAll(STATIC_RE)) add(strings[Number(m[1])]);
  let dynamic = false;
  for (const m of code.matchAll(CALL_RE)) {
    const from = (m.index ?? 0) + m[0].length;
    const lit = LITERAL_ARG_RE.exec(code.slice(from, from + 64));
    if (lit) add(strings[Number(lit[1])]);
    else dynamic = true;
  }
  const isSmoke = fileRel.startsWith("smoke-tests/");
  const paths: string[] = [];
  if (isSmoke) {
    for (const s of strings) {
      const m = PATH_LITERAL_RE.exec(s);
      if (m?.[1] !== undefined) paths.push(m[1]);
    }
  }
  return {
    specifiers,
    paths,
    dynamic,
    touchesSrc: isSmoke && strings.includes("src"),
  };
}

/**
 * Resolve a relative specifier to a graph node: the file as written (with a
 * `.js` spelling read as `.ts`), then the same name with `.ts`, then a directory
 * index. Undefined when nothing in the graph matches.
 */
function resolveSpecifier(
  fromRel: string,
  spec: string,
  nodes: ReadonlySet<string>,
): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (joined === ".." || joined.startsWith("../")) return undefined;
  const stem = /\.(?:ts|js)$/.test(joined) ? joined.slice(0, -3) : joined;
  for (const candidate of [`${stem}.ts`, `${stem}/index.ts`]) {
    if (nodes.has(candidate)) return candidate;
  }
  return undefined;
}

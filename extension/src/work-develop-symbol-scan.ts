/**
 * work-develop-symbol-scan — #1323: the text scans behind the sibling-symbol
 * merge-and-retry (work-develop-symbol-merge.ts).
 *
 *   - `missingSymbolsIn` — the identifiers a verify failure says do not
 *     exist: TypeScript's TS2305 / TS2724 (no exported member), TS2339 (no
 *     such property), TS2353 (unknown object-literal key), TS2304 / TS2552
 *     (cannot find name), plus the equivalent rustc, Python and Go messages.
 *   - `missingModulesIn` — the modules a failure says cannot be resolved
 *     (TS2307), as the repo path the import resolves to from the importing
 *     file the error line names (`src/a/b.ts` + `../c` → `src/c`).
 *   - `addedSymbolsInDiff` — the identifiers a unified diff DECLARES:
 *     exported (TS/JS), `pub` (Rust), capitalised (Go) and top-level
 *     (Python def/class) declarations, `export { … }` lists, and fields —
 *     but a field only inside a type / interface / struct / class body of a
 *     source file. An indented `id:` in a fixture, an object literal or a
 *     YAML file is not a declaration and never counts.
 *   - `addedFilesInDiff` — the files a diff creates, extension dropped.
 *
 * A false match merges two workstreams and resets the consumer's worktree,
 * so the scans stay narrow: only declarations, only source files.
 */

import path from "node:path";
import { symbolKey } from "./work-driver-plan-contract.ts";

/** One pattern per compiler message; group 1 is the missing identifier. */
const MISSING_SYMBOL_PATTERNS: RegExp[] = [
  // TS2305 / TS2724 — Module '"./x"' has no exported member ['named'] 'Foo'.
  /has no exported member(?: named)? '([A-Za-z_$][\w$]*)'/g,
  // TS2339 — Property 'foo' does not exist on type 'X'.
  /Property '([A-Za-z_$][\w$]*)' does not exist on type/g,
  // TS2353 — Object literal may only specify known properties, and 'foo' does not exist in type 'X'.
  /'([A-Za-z_$][\w$]*)' does not exist in type/g,
  // TS2304 / TS2552 — Cannot find name 'Foo'.
  /Cannot find name '([A-Za-z_$][\w$]*)'/g,
  // rustc — cannot find value `foo`; no field `foo` on type; no method named
  // `foo`; unresolved import `a::foo`; no `foo` in `a`.
  /cannot find (?:value|function|type|struct|trait|macro) `([\w:]+)`/g,
  /no field `(\w+)` on type/g,
  /no method named `(\w+)`/g,
  /unresolved import `([\w:]+)`/g,
  /no `(\w+)` in `/g,
  // Python — cannot import name 'foo'; has no attribute 'foo'; name 'foo' is not defined.
  /cannot import name '(\w+)'/g,
  /has no attribute '(\w+)'/g,
  /name '(\w+)' is not defined/g,
  // Go — undefined: foo / undefined: pkg.Foo; has no field or method Foo.
  /undefined: ([\w.]+)/g,
  /has no field or method (\w+)/g,
];

/** #1323 — the identifiers a verify failure says are missing (deduplicated). */
export function missingSymbolsIn(text: string): string[] {
  const out = new Set<string>();
  for (const re of MISSING_SYMBOL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const k = symbolKey(m[1] ?? "");
      if (k) out.add(k);
    }
  }
  return [...out];
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|rs|go|py|java|kt|swift|cs|c|h|cc|cpp|hpp|rb|php|scala)$/;

/** A path without its source extension, `./` and trailing `/index`-free. */
function stripExt(p: string): string {
  return path.posix.normalize(p).replace(SOURCE_EXT, "");
}

/** The importing file at the start of a compiler line: `f.ts(1,2):` or `f.ts:1:2`. */
const IMPORTER = /^\s*([^\s:(]+\.[A-Za-z]+)(?:\(\d+,\d+\)|:\d+:\d+)/;
const MISSING_MODULE = /Cannot find module '(\.{1,2}\/[^']*)'/;

/**
 * #1323 — the repo-relative module paths (extension dropped) a failure says
 * cannot be resolved. Only relative imports with a named importing file
 * resolve; a bare package name or an unattributed line yields nothing. A
 * directory import also yields its `/index` form.
 */
export function missingModulesIn(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const mod = MISSING_MODULE.exec(line);
    const imp = IMPORTER.exec(line);
    if (!mod?.[1] || !imp?.[1]) continue;
    const resolved = stripExt(path.posix.join(path.posix.dirname(imp[1]), mod[1]));
    if (resolved.startsWith("..") || resolved === ".") continue;
    out.add(resolved);
    out.add(`${resolved}/index`);
  }
  return [...out];
}

/**
 * Two repo paths name the same module when one is a segment-boundary suffix
 * of the other (the verify command may run in a subdirectory, so its paths
 * lack a prefix the diff has) and the shorter one has at least two segments:
 * a bare `index` or `types` never matches on its own.
 */
export function sameModule(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.split("/").length >= 2 && long.endsWith(`/${short}`);
}

/** Declarations on an added line; group 1 is the declared identifier. */
const DECL_PATTERNS: RegExp[] = [
  // TS/JS — export [default] [declare] [abstract] [async] function|class|… Name
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/,
  // Rust — pub fn|struct|enum|trait|type|const|static|mod name
  /^\s*pub(?:\([\w:]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/,
  // Python — top-level def / class.
  /^(?:async\s+)?def\s+(\w+)/,
  /^class\s+(\w+)/,
  // Go — exported (capitalised) func [receiver] Name, type Name.
  /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/,
  /^type\s+([A-Z]\w*)/,
];

/** `export { a, b as c }` — every exported name (the alias when present). */
const EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;

/** A line that opens a type body: interface / type = { / struct / class / enum. */
const TYPE_OPENER =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:pub(?:\([\w:]+\))?\s+)?(?:abstract\s+)?(?:interface\s+\w+|type\s+\w+(?:<[^>]*>)?\s*=|struct\s+\w+|class\s+\w+|enum\s+\w+)[^{;]*\{\s*$/;

/** A field inside a type body: `name?: T`, `readonly name: T`, `pub name: T`, `Name T` (Go). */
const FIELD =
  /^\s+(?:readonly\s+|public\s+|private\s+|protected\s+|pub(?:\([\w:]+\))?\s+)?([A-Za-z_$][\w$]*)\??\s*:(?!:)/;

/**
 * #1323 — the identifiers a unified diff (`git diff base..HEAD`) declares on
 * its added lines, in source files only. Context lines are read too, to
 * know when a hunk is inside a type body (the hunk header's function
 * context counts as an opener).
 */
export function addedSymbolsInDiff(diff: string): string[] {
  const out = new Set<string>();
  let source = false;
  let depth = 0; // > 0 while inside a type body
  const add = (raw: string | undefined) => {
    const k = raw ? symbolKey(raw) : undefined;
    if (k) out.add(k);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      source = SOURCE_EXT.test(line.slice(4).trim());
      depth = 0;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) continue;
    if (line.startsWith("@@")) {
      depth = TYPE_OPENER.test(line.replace(/^@@[^@]*@@/, "")) ? 1 : 0;
      continue;
    }
    if (!source || line.startsWith("-")) continue;
    const added = line.startsWith("+");
    const body = line.slice(1);
    if (depth > 0) {
      if (added && depth === 1) add(FIELD.exec(body)?.[1]);
      depth += (body.match(/\{/g) ?? []).length - (body.match(/\}/g) ?? []).length;
      if (depth < 0) depth = 0;
      continue;
    }
    if (TYPE_OPENER.test(body)) depth = 1;
    if (!added) continue;
    const list = EXPORT_LIST.exec(body);
    if (list?.[1]) {
      for (const part of list[1].split(","))
        add(
          part
            .trim()
            .split(/\s+as\s+/)
            .pop(),
        );
      continue;
    }
    for (const re of DECL_PATTERNS) {
      const m = re.exec(body);
      if (m?.[1]) {
        add(m[1]);
        break;
      }
    }
  }
  return [...out];
}

/** #1323 — the source files a diff creates (repo paths, extension dropped). */
export function addedFilesInDiff(diff: string): string[] {
  const out: string[] = [];
  let created = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      created = line === "--- /dev/null";
      continue;
    }
    if (line.startsWith("+++ b/") && created) {
      const p = line.slice(6).trim();
      if (SOURCE_EXT.test(p)) out.push(stripExt(p));
      created = false;
    }
  }
  return out;
}

/**
 * work-develop-symbol-scan — #1323: the two text scans behind the
 * sibling-symbol merge-and-retry (work-develop-symbol-merge.ts).
 *
 *   - `missingSymbolsIn` — the identifiers a verify failure says do not
 *     exist: TypeScript's TS2305 / TS2724 (no exported member), TS2339 (no
 *     such property), TS2353 (unknown object-literal key), TS2304 / TS2552
 *     (cannot find name) and TS2307 (unresolved module), plus the
 *     equivalent messages from rustc, Python and Go.
 *   - `addedSymbolsInDiff` — the identifiers a unified diff ADDS: exported
 *     declarations, `export { … }` lists, type/struct fields, top-level
 *     Python/Go/Rust declarations, and the base names of added files (so an
 *     unresolved import of a module a sibling creates still matches).
 *
 * Both return keys in the #1322 `symbolKey` form (last segment of a
 * qualified name), so they compare directly with a plan's `introduces`.
 * Both over-match rather than under-match: a false match costs one merged
 * retry, which the caller bounds to one per cycle; a missed match parks the
 * cycle exactly as before.
 */

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
  // rustc — cannot find value `foo` in this scope; no field `foo` on type;
  // no method named `foo`; unresolved import `a::foo`; no `foo` in `a`.
  /cannot find (?:value|function|type|struct|trait|macro|module) `([\w:]+)`/g,
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

/** TS2307 / node — an unresolved module path; matched on its base name. */
const MISSING_MODULE = /Cannot find module '([^']+)'/g;

/** A module specifier's base name without extension (`./a/foo.ts` → `foo`). */
function moduleBase(spec: string): string | undefined {
  const base = spec
    .split("/")
    .pop()
    ?.replace(/\.[cm]?[jt]sx?$|\.py$|\.rs$|\.go$/, "");
  return base && /^[A-Za-z_$][\w$-]*$/.test(base) ? base : undefined;
}

/** #1323 — the identifiers a verify failure says are missing (deduplicated). */
export function missingSymbolsIn(text: string): string[] {
  const out = new Set<string>();
  for (const re of MISSING_SYMBOL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const k = symbolKey(m[1] ?? "");
      if (k) out.add(k);
    }
  }
  for (const m of text.matchAll(MISSING_MODULE)) {
    const k = moduleBase(m[1] ?? "");
    if (k) out.add(k);
  }
  return [...out];
}

/** Declarations on an added line; group 1 is the declared identifier. */
const ADDED_DECL_PATTERNS: RegExp[] = [
  // TS/JS — export [default] [declare] [abstract] [async] function|class|… Name
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/,
  // A field on a type, interface, class or struct: `  name?: T`, `  readonly name: T`, `  pub name: T`.
  /^\s+(?:readonly\s+|public\s+|private\s+|protected\s+|pub(?:\([\w:]+\))?\s+)?([A-Za-z_$][\w$]*)\??\s*:(?!:)/,
  // Rust — pub fn|struct|enum|trait|type|const|static|mod name
  /^\s*pub(?:\([\w:]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/,
  // Python — top-level def / class / assignment.
  /^(?:async\s+)?def\s+(\w+)/,
  /^class\s+(\w+)/,
  /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/,
  // Go — func [receiver] Name, type Name.
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^type\s+([A-Za-z_]\w*)/,
];

/** `export { a, b as c }` — every exported name (the alias when present). */
const EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;

/** `+++ b/path/to/file.ts` following `--- /dev/null` — an added file. */
const ADDED_FILE = /^\+\+\+ b\/(.+)$/;

/**
 * #1323 — the identifiers a unified diff (`git diff base..HEAD`) adds. Only
 * `+` lines are read; a declaration that also appears on a `-` line of the
 * same diff is a moved or edited line and still counts (the symbol exists
 * in the producer's tree either way).
 */
export function addedSymbolsInDiff(diff: string): string[] {
  const out = new Set<string>();
  let prevWasDevNull = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      prevWasDevNull = line === "--- /dev/null";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const m = ADDED_FILE.exec(line);
      if (prevWasDevNull && m?.[1]) {
        const k = moduleBase(m[1]);
        if (k) out.add(k);
      }
      prevWasDevNull = false;
      continue;
    }
    if (!line.startsWith("+")) continue;
    const body = line.slice(1);
    const list = EXPORT_LIST.exec(body);
    if (list?.[1]) {
      for (const part of list[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop();
        const k = name ? symbolKey(name) : undefined;
        if (k) out.add(k);
      }
      continue;
    }
    for (const re of ADDED_DECL_PATTERNS) {
      const m = re.exec(body);
      const k = m?.[1] ? symbolKey(m[1]) : undefined;
      if (k) {
        out.add(k);
        break;
      }
    }
  }
  return [...out];
}

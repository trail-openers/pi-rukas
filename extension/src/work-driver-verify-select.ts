/**
 * work-driver-verify-select — #1647: which smoke tests a develop verify runs.
 *
 * The develop gate used to run the whole offline suite (826 tests, ~8 min on an
 * idle host) every round, and a load-sensitive test in it parked the cycle
 * whatever the diff touched. This module answers the narrower question: given
 * the files a cycle changed, which `smoke-tests/test-*.ts` files import them,
 * directly or through other modules?
 *
 * The graph is built from the source text, not from a bundler:
 *   - static `import` / `export … from` / side-effect `import "x"`;
 *   - a literal dynamic `import("x")` or `require("x")`;
 *   - an `src/…ts` path string literal in a smoke test, because a test that
 *     reads a source file by name has a dependency no import shows.
 * Only relative specifiers are edges; a package name cannot be a changed file.
 *
 * Every doubt selects more. The selector returns `mode: "full"` (with the
 * reason recorded) for any changed file outside the graph, any change under
 * `smoke-tests/lib/`, any changed module that selects no test, and any dynamic
 * specifier whose target cannot be read. The ALWAYS_RUN list is the other half
 * of the bargain: a test that reads repository source or config AS TEXT depends
 * on files no import graph can show, so it runs on every develop round, and
 * `test-verify-select-always-run.ts` fails when a new such test is missing.
 *
 * Paths here are relative to `extension/`, the directory the smoke tests run
 * from. Callers holding repo-relative paths strip the `extension/` prefix first.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ALWAYS_RUN } from "./work-driver-verify-always-run.ts";

export { ALWAYS_RUN };

export interface VerifySelection {
  /** `selected`: run `tests` (plus `alwaysRun`). `full`: run the whole suite. */
  mode: "selected" | "full";
  /** Test files that transitively import a changed module, sorted. */
  tests: string[];
  /** The ALWAYS_RUN list, always present in a selection. */
  alwaysRun: string[];
  /** Why the selection fell back to the full suite. Absent on `selected`. */
  fallbackReason?: string;
}

/** `smoke-tests/test-*.ts`, one level deep. */
const TEST_RE = /^smoke-tests\/test-[^/]+\.ts$/;
/**
 * Files that may be graph nodes: source modules at any depth under `src/` (a
 * nested module imported only by another nested module must still reach the
 * tests above it) and top-level smoke files.
 */
const NODE_RE = /^(?:src\/(?:[^/]+\/)*[^/]+\.ts|smoke-tests\/[^/]+\.ts)$/;

// A static import or re-export: the specifier is the last quoted string before
// the statement ends. `[\w*{}\s,$]` covers default, namespace and named lists,
// including multi-line ones.
const STATIC_RE =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"'\n]+)["']/g;
const LITERAL_DYNAMIC_RE = /\bimport\s*\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;
const LITERAL_REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;
const ANY_DYNAMIC_RE = /\bimport\s*\(/g;
const ANY_REQUIRE_RE = /\brequire\s*\(/g;
// The same two calls on masked text (see `maskStringsAndComments`), where a
// quoted specifier is the single token `S`.
const MASKED_LITERAL_DYNAMIC_RE = /\bimport\s*\(\s*S\s*\)/g;
const MASKED_LITERAL_REQUIRE_RE = /\brequire\s*\(\s*S\s*\)/g;
// `src/x.ts` (optionally `extension/`- or `../`-prefixed) as a whole string literal.
const PATH_LITERAL_RE = /["'`](?:\.{1,2}\/)*(?:extension\/)?(src\/[^"'`\s]+?\.ts)["'`]/g;

interface FileEdges {
  /** Extension-relative targets this file references. */
  deps: string[];
  /** True when a dynamic import/require names its target through a variable. */
  dynamic: boolean;
  /**
   * True when a smoke test spells a bare `"src"` segment (`path.join(ext, "src", "x.ts")`):
   * it reaches source modules through a path no specifier shows, so it depends on all of them.
   */
  touchesSrc: boolean;
}

// Comments and string literals, in one alternation: a match that starts with `/`
// is a comment (dropped), anything else is kept as written.
const COMMENT_OR_STRING_RE =
  /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** The text with comments removed, so a comment inside an import list cannot hide the specifier. */
function stripComments(text: string): string {
  return text.replace(COMMENT_OR_STRING_RE, (m) => (m.startsWith("/") ? " " : m));
}

/** Resolve a relative specifier against the importing file. Bare names are not edges. */
function resolveSpecifier(fromRel: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (joined.startsWith("..")) return undefined;
  // The repo imports `./x.ts`; a `.js` spelling names the same file.
  if (joined.endsWith(".js")) return `${joined.slice(0, -3)}.ts`;
  return joined.endsWith(".ts") ? joined : `${joined}.ts`;
}

/** Edges of one file, from its text. Exported for the selector's own tests. */
export function edgesOf(fileRel: string, raw: string): FileEdges {
  const text = stripComments(raw);
  const deps: string[] = [];
  const add = (spec: string) => {
    const target = resolveSpecifier(fileRel, spec);
    if (target !== undefined) deps.push(target);
  };
  for (const m of text.matchAll(STATIC_RE)) add(m[1] ?? "");
  for (const m of text.matchAll(LITERAL_DYNAMIC_RE)) add(m[1] ?? "");
  for (const m of text.matchAll(LITERAL_REQUIRE_RE)) add(m[1] ?? "");
  const isSmoke = fileRel.startsWith("smoke-tests/");
  if (isSmoke) {
    for (const m of text.matchAll(PATH_LITERAL_RE)) deps.push(m[1] ?? "");
  }
  const touchesSrc = isSmoke && /["'`]src["'`]/.test(text);
  // A call whose argument is not a literal is one the regexes above cannot
  // see. Counting calls against literal calls, on text with strings and
  // comments masked, is the cheapest honest test: a smoke test often generates
  // a child script whose `import(${x})` lives inside a template literal, and
  // that is not a call this file makes.
  const masked = maskStringsAndComments(text);
  const dynamicCalls = [...masked.matchAll(ANY_DYNAMIC_RE)].length;
  const literalCalls = [...masked.matchAll(MASKED_LITERAL_DYNAMIC_RE)].length;
  const requireCalls = [...masked.matchAll(ANY_REQUIRE_RE)].length;
  const literalRequires = [...masked.matchAll(MASKED_LITERAL_REQUIRE_RE)].length;
  return {
    deps,
    dynamic: dynamicCalls > literalCalls || requireCalls > literalRequires,
    touchesSrc,
  };
}

/**
 * Replace template literals with `T`, quoted strings with `S`, and drop
 * comments. What remains is code, so a call is found where it is made rather
 * than where it is quoted. A template is `T` even when it holds a plain string,
 * which makes `import(\`x\`)` count as non-literal: the conservative side.
 */
function maskStringsAndComments(text: string): string {
  return text.replace(
    /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith("`") ? "T" : m.startsWith("/") ? " " : "S"),
  );
}

/** The graph: every source module and top-level smoke file, keyed extension-relative. */
interface Graph {
  importers: Map<string, Set<string>>;
  dynamic: Set<string>;
  nodes: Set<string>;
}

function buildGraph(extensionDir: string): Graph {
  const nodes = new Set<string>();
  const importers = new Map<string, Set<string>>();
  const dynamic = new Set<string>();
  const srcTouchers: string[] = [];
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(extensionDir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (NODE_RE.test(child)) files.push(child);
    }
  };
  walk("src");
  for (const name of readdirSync(path.join(extensionDir, "smoke-tests"))) {
    const rel = `smoke-tests/${name}`;
    if (NODE_RE.test(rel)) files.push(rel);
  }
  for (const rel of files) {
    nodes.add(rel);
    const edges = edgesOf(rel, readFileSync(path.join(extensionDir, rel), "utf8"));
    if (edges.dynamic) dynamic.add(rel);
    if (edges.touchesSrc) srcTouchers.push(rel);
    for (const dep of edges.deps) {
      const set = importers.get(dep) ?? new Set<string>();
      set.add(rel);
      importers.set(dep, set);
    }
  }
  // A test that builds a src path itself is an importer of every src module.
  for (const toucher of srcTouchers) {
    for (const src of files) {
      if (!src.startsWith("src/")) continue;
      const set = importers.get(src) ?? new Set<string>();
      set.add(toucher);
      importers.set(src, set);
    }
  }
  return { importers, dynamic, nodes };
}

/**
 * Select the smoke tests for a set of changed files.
 *
 * `changed` is extension-relative (`src/x.ts`, `smoke-tests/test-y.ts`). Any
 * path that is not a graph node sends the whole selection to the full suite.
 */
export function selectVerifyTests(
  extensionDir: string,
  changed: readonly string[],
): VerifySelection {
  const full = (fallbackReason: string): VerifySelection => ({
    mode: "full",
    tests: [],
    alwaysRun: [...ALWAYS_RUN],
    fallbackReason,
  });
  if (changed.length === 0) return full("no-changed-files");
  for (const f of changed) {
    if (f.startsWith("smoke-tests/lib/")) return full(`smoke-test-helper:${f}`);
    if (!NODE_RE.test(f)) return full(`outside-graph:${f}`);
  }
  const graph = buildGraph(extensionDir);
  const selected = new Set<string>();
  const perChanged = new Map<string, Set<string>>();
  for (const start of changed) {
    // Walk up the importers. A module on this path with a dynamic specifier may
    // import something the walk cannot see, so the path is not trustworthy. A
    // test is exempt: nothing imports it, so its own unseen edges cannot hide
    // another test's dependency (see the always-selected rule below).
    const reached = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift() as string;
      if (graph.dynamic.has(node) && !TEST_RE.test(node)) {
        return full(`non-literal-specifier:${node}`);
      }
      for (const importer of graph.importers.get(node) ?? []) {
        if (reached.has(importer)) continue;
        reached.add(importer);
        queue.push(importer);
      }
    }
    // A deleted test is not a node, so it is never selected: running a missing file
    // is not a verdict on the diff. Its importers still are, so a broken import blocks.
    const tests = [...reached].filter((n) => TEST_RE.test(n) && graph.nodes.has(n));
    if (tests.length === 0) return full(`no-selected-tests:${start}`);
    perChanged.set(start, new Set(tests));
    for (const t of tests) selected.add(t);
  }
  // A test whose dynamic import target is unreadable could load anything, so it
  // is run on every selection rather than trusted to a graph that cannot see it.
  for (const d of graph.dynamic) if (TEST_RE.test(d)) selected.add(d);
  return {
    mode: "selected",
    tests: [...selected].sort(),
    alwaysRun: [...ALWAYS_RUN],
  };
}

/**
 * The develop command for a selection: the selected tests (and ALWAYS_RUN)
 * through verify-loop, after the typecheck of the smoke-test tree. The fast
 * tier (`.pi/verify-cmd-fast`: tsc of src, biome) is NOT repeated here — the
 * caller's `withFastTier` runs it ahead of this string, exactly as it runs ahead
 * of `.pi/verify-cmd`.
 *
 * Each test is spelled `"$PWD/…"`, evaluated in the tree the command runs in.
 * The loop prints the path it was given, so a failure names the test by an
 * absolute path that the attribution comparison can place under the tree it ran
 * in. The string itself is the same for every worktree, so the gate-reuse key
 * (which includes the command) does not change between them.
 */
export function selectedVerifyCommand(tests: readonly string[]): string {
  const args = [...new Set([...ALWAYS_RUN, ...tests])].sort().map((t) => `"$PWD/${t}"`);
  return `cd extension && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.smoke-tests.json && bash smoke-tests/lib/verify-loop.sh --jobs-from-host ${args.join(" ")}`;
}

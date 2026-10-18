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
 *   - static `import` / `export … from` / side-effect `import "x"`, and a
 *     literal dynamic `import("x")` or `require("x")`, all resolved relative to
 *     the importing file, with extensionless and directory forms (`./x` →
 *     `./x.ts` or `./x/index.ts`);
 *   - an `src/…ts` path string literal in a smoke test, because a test that
 *     reads a source file by name has a dependency no import shows.
 * Comments and literals are removed by one tokenizer (work-driver-verify-select-lex),
 * so an import inside a comment or a string creates no edge.
 *
 * Every doubt selects more. The selector returns `mode: "full"` (with the
 * reason recorded) for: a changed file outside the graph; any change under
 * `smoke-tests/lib/`; a changed module that selects no test; a file the
 * tokenizer cannot read; a non-literal dynamic import or an unresolvable
 * relative specifier on the walk path; and a name that is not safe to spell in
 * a shell argument. A test with a non-literal dynamic import, or one that
 * transitively imports such a module, is selected on every selection, because
 * it can load anything. The ALWAYS_RUN list is the other half of the bargain:
 * a test that reads repository source or config AS TEXT depends on files no
 * import graph can show, so it runs on every develop round.
 *
 * Paths here are relative to `extension/`, the directory the smoke tests run
 * from. Callers holding repo-relative paths strip the `extension/` prefix first.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ALWAYS_RUN } from "./work-driver-verify-always-run.ts";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";
import { SMOKE_TEST_NAME_RE, isOfflineTest } from "./work-driver-verify-shared.ts";

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

/** Any smoke test, live or not: a node nothing imports, so it can end a walk. */
const TEST_NODE_RE = /^smoke-tests\/test-[^/]+\.ts$/;
/**
 * Files that may be graph nodes: source modules at any depth under `src/` (a
 * nested module imported only by another nested module must still reach the
 * tests above it) and top-level smoke files.
 */
const NODE_RE = /^(?:src\/(?:[^/]+\/)*[^/]+\.ts|smoke-tests\/[^/]+\.ts)$/;
/** A relative specifier: `./x`, `../x`, `.`, `..`. Bare package names are not edges. */
const RELATIVE_SPEC_RE = /^\.\.?(?:\/|$)/;
/** A static import or re-export on lexed code: the specifier is the string token that ends the statement head. */
const STATIC_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?(\d+)/g;
/** A call head `import(` or `require(`, on lexed code. */
const CALL_RE = /\b(import|require)\s*\(/g;
/** A string token as the first argument of a call, the rest of the call's head. */
const LITERAL_ARG_RE = /^\s*(\d+)\s*\)/;
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

function factsOf(fileRel: string, lexed: LexedSource): FileEdges {
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

interface Graph {
  nodes: Set<string>;
  /** target → the files that reference it. */
  importers: Map<string, Set<string>>;
  /** Nodes with a non-literal dynamic import or require. */
  dynamic: Set<string>;
  /** Nodes with a relative specifier that names no graph node. */
  unresolved: Set<string>;
}

function listNodes(extensionDir: string): string[] {
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
  return files;
}

/** The graph, or the first file the tokenizer could not read. */
function buildGraph(extensionDir: string): Graph | { unreadable: string } {
  const files = listNodes(extensionDir);
  const nodes = new Set(files);
  const importers = new Map<string, Set<string>>();
  const dynamic = new Set<string>();
  const unresolved = new Set<string>();
  const addImporter = (target: string, from: string) => {
    const set = importers.get(target) ?? new Set<string>();
    set.add(from);
    importers.set(target, set);
  };
  const srcTouchers: string[] = [];
  for (const rel of files) {
    const edges = edgesOf(rel, readFileSync(path.join(extensionDir, rel), "utf8"));
    if (edges === undefined) return { unreadable: rel };
    if (edges.dynamic) dynamic.add(rel);
    if (edges.touchesSrc) srcTouchers.push(rel);
    for (const spec of edges.specifiers) {
      const target = resolveSpecifier(rel, spec, nodes);
      if (target === undefined) unresolved.add(rel);
      else addImporter(target, rel);
    }
    for (const p of edges.paths) if (nodes.has(p)) addImporter(p, rel);
  }
  // A test that builds a src path itself is an importer of every src module.
  for (const toucher of srcTouchers) {
    for (const src of files) if (src.startsWith("src/")) addImporter(src, toucher);
  }
  return { nodes, importers, dynamic, unresolved };
}

/** Every node that imports `start`, transitively, plus `start`. */
function importersClosure(graph: Graph, start: string): Set<string> {
  const reached = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const importer of graph.importers.get(node) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached;
}

/**
 * The reason a walk over `reached` cannot be trusted, or undefined. A
 * non-literal dynamic import or an unresolved relative specifier on the walk
 * path may import something the graph cannot see. A test is exempt: nothing
 * imports it, so its own unseen edges cannot hide another test's dependency.
 */
function untrustedNode(graph: Graph, reached: ReadonlySet<string>): string | undefined {
  for (const node of reached) {
    if (TEST_NODE_RE.test(node)) continue;
    if (graph.dynamic.has(node)) return `non-literal-specifier:${node}`;
    if (graph.unresolved.has(node)) return `unresolved-specifier:${node}`;
  }
  return undefined;
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
  if ("unreadable" in graph) return full(`unlexable:${graph.unreadable}`);
  const selected = new Set<string>();
  for (const start of changed) {
    const reached = importersClosure(graph, start);
    const untrusted = untrustedNode(graph, reached);
    if (untrusted !== undefined) return full(untrusted);
    // A deleted test is not a node, so it is never selected: running a missing file
    // is not a verdict on the diff. Its importers still are, so a broken import blocks.
    const tests = [...reached].filter((n) => isOfflineTest(n) && graph.nodes.has(n));
    if (tests.length === 0) return full(`no-selected-tests:${start}`);
    for (const t of tests) selected.add(t);
  }
  // A module with a non-literal dynamic import may load anything, so every test
  // that reaches it runs on every selection, whatever the diff touched.
  for (const d of graph.dynamic) {
    for (const t of importersClosure(graph, d)) if (isOfflineTest(t)) selected.add(t);
  }
  const names = [...selected, ...ALWAYS_RUN];
  if (names.some((n) => !SMOKE_TEST_NAME_RE.test(n))) return full("unsafe-test-name");
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

/**
 * work-driver-verify-select-graph — #1647: the selector's import graph, built once
 * per selection.
 *
 * The graph is the selector's whole view of the tree: every node the selector will
 * tokenize, the files that import each one, which nodes carry a non-literal dynamic
 * import, and which carry a relative specifier that resolves to no node. The walk
 * also KEEPS the lexed text of every node, because the literal-based rules
 * (`work-driver-verify-select-literals`) need to know whether the `smoke-tests/lib/`
 * subtree was readable, and asking them to walk those ~300 files a second time would
 * be a second answer to a question this walk already settled.
 *
 * A file the tokenizer cannot close is the walk's own failure: the caller falls back
 * to the full suite rather than trust a graph built without it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { changedPathRulesEnabled } from "./verify-select-changed-paths-switch.ts";
import { NODE_PATH_RE } from "./work-driver-verify-classify.ts";
import { factsOf } from "./work-driver-verify-select-edges.ts";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";
import type { Graph } from "./work-driver-verify-trust.ts";

/** The node shape, in one place with the walk that builds it. */
const NODE_RE = NODE_PATH_RE;

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

export type BuiltGraph = Graph & { lexed: Map<string, LexedSource>; libTs: string[] };

/**
 * The graph's node set — every file `selectVerifyTests` will tokenize.
 *
 * Exported for the gate that asserts every one of them lexes
 * (test-verify-select-lex-tree.ts): a whole-tree precondition asserted on a set
 * re-derived by hand can silently be narrower than the graph it protects, so the
 * gate asks the selector what its graph is.
 */
export function listNodes(extensionDir: string, withLib = changedPathRulesEnabled()): string[] {
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
  // The lib helpers join the graph only for the #2649 arm, and only where the
  // directory exists: a tree with no `smoke-tests/` at all must throw from the
  // top-level scan (the caller's try/catch turns that into a full-suite fallback),
  // not from here, and an absent lib directory is not a doubt about anything.
  if (withLib && existsSync(path.join(extensionDir, "smoke-tests", "lib"))) {
    walk("smoke-tests/lib");
  }
  return files;
}

/** The graph, or the first file the tokenizer could not read. */
export function buildGraph(
  extensionDir: string,
  rules: boolean,
): (Graph & { lexed: Map<string, LexedSource>; libTs: string[] }) | { unreadable: string } {
  // `rules` is the caller's verdict, passed in rather than read from the switch here:
  // a selection reads the switch exactly once (see `selectVerifyTests`), so the node
  // set, the lib subtree and every rule below are judged by the same answer even if
  // an operator flips the variable while a selection is running. The tests that pin
  // both arms in one bun process depend on that single read per call.
  // `libTs` is the subtree the literal rules ask about, gathered from the same walk
  // that lexes it — never a second walk of `smoke-tests/lib/`.
  const libTs: string[] = [];
  const files = listNodes(extensionDir, rules);
  const nodes = new Set(files);
  const importers = new Map<string, Set<string>>();
  const dynamic = new Set<string>();
  const unresolved = new Set<string>();
  const lib = new Set<string>();
  // The lexed text of every node, kept so the doubt over the `smoke-tests/lib/`
  // subtree is answered from this walk rather than a second walk over the same
  // ~300 files (see `libTrust` below).
  const lexed = new Map<string, LexedSource>();
  const addImporter = (target: string, from: string) => {
    const set = importers.get(target) ?? new Set<string>();
    set.add(from);
    importers.set(target, set);
  };
  const srcTouchers: string[] = [];
  for (const rel of files) {
    const l = lexSource(readFileSync(path.join(extensionDir, rel), "utf8"));
    if (l === undefined) return { unreadable: rel };
    lexed.set(rel, l);
    if (rules && rel.startsWith("smoke-tests/lib/")) libTs.push(rel);
    const edges = factsOf(rel, l);
    if (edges.dynamic) dynamic.add(rel);
    if (rel.startsWith("smoke-tests/lib/")) lib.add(rel);
    if (edges.touchesSrc && !rel.startsWith("smoke-tests/lib/")) srcTouchers.push(rel);
    for (const spec of edges.specifiers) {
      const target = resolveSpecifier(rel, spec, nodes);
      if (target === undefined) unresolved.add(rel);
      else addImporter(target, rel);
    }
    for (const p of edges.paths) if (nodes.has(p)) addImporter(p, rel);
  }
  // A test that builds a src path itself is an importer of every src module. The
  // heuristic is scoped to the top-level smoke files: it exists because a TEST can
  // open any module by a name it assembles, and applying it to the #2649 lib helpers
  // would make every fixture under `smoke-tests/lib/` an importer of every module in
  // the repo — which is a widening of the selection, not a sound one, and the
  // helpers are reached by their real importers already.
  for (const toucher of srcTouchers) {
    for (const src of files) if (src.startsWith("src/")) addImporter(src, toucher);
  }
  return { nodes, importers, dynamic, unresolved, lib, lexed, libTs };
}

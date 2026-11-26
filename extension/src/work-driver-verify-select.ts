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
 * reason recorded) for: a changed file the classification table cannot place; a
 * changed module that selects no test; a file the tokenizer cannot read; a
 * non-literal dynamic import or an unresolvable relative specifier on the walk
 * path; a changed helper whose users cannot be judged; and a name that is not
 * safe to spell in a shell argument. A test with a non-literal dynamic import, or
 * one that transitively imports such a module, is selected on every selection,
 * because it can load anything. The always-run set is the other half of the
 * bargain: a test that reads repository source or config AS TEXT depends on files
 * no import graph can show, so it runs on every develop round. It is computed from
 * the worktree's own smoke tests (`work-driver-verify-always-run`), not read from
 * a committed list, so no cycle ever has to regenerate — or claim — such a file.
 *
 * #2649 widened what the selector answers without the full suite, and closed what
 * it may answer at all. A changed path that is not a graph node goes through the
 * classification table (`work-driver-verify-classify`): a docs or prompt file
 * selects the tests that name its exact path, an ignore-like file selects the
 * always-run set alone, configuration selects nothing short of the full suite. A
 * TypeScript helper under `smoke-tests/lib/` is a graph node, so a helper change
 * selects the tests that import it; a shell or data helper has no importer, so it
 * selects the tests that quote its exact path, and falls back when that cannot be
 * judged. A selection is therefore always exactly the always-run set, the exact
 * namers, the transitive importers and the dynamic-import floor — and an empty
 * selection is a fallback, never a run of zero tests. `PI_ENSEMBLE_VERIFY_SELECT_
 * CHANGED_PATHS=0` puts every one of those rules back to the bytes that shipped
 * before #2649 (see `verify-select-changed-paths-switch`).
 *
 * Paths here are relative to `extension/`, the directory the smoke tests run
 * from. Callers holding repo-relative paths strip the `extension/` prefix first.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { changedPathRulesEnabled } from "./verify-select-changed-paths-switch.ts";
import { textReadingTests } from "./work-driver-verify-always-run.ts";
import {
  type ClassifiedPath,
  NODE_PATH_RE,
  classifyChangedPath,
} from "./work-driver-verify-classify.ts";
import { literalRulesTrustworthy } from "./work-driver-verify-literal-trust.ts";
import { type OfflineTests, readOfflineTests } from "./work-driver-verify-offline-tests.ts";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";
import { SMOKE_TEST_NAME_RE, isOfflineTest } from "./work-driver-verify-shared.ts";
import {
  type Graph,
  TEST_NODE_RE,
  TEST_SUPPORT_RE,
  untrustedNode,
} from "./work-driver-verify-trust.ts";

export interface VerifySelection {
  /** `selected`: run `tests` (plus `alwaysRun`). `full`: run the whole suite. */
  mode: "selected" | "full";
  /** Test files that transitively import a changed module, sorted. */
  tests: string[];
  /** The always-run set computed for this worktree, always present in a selection. */
  alwaysRun: string[];
  /** Why the selection fell back to the full suite. Absent on `selected`. */
  fallbackReason?: string;
}

/** Any smoke test, live or not: a node nothing imports, so it can end a walk. */
/**
 * Files that may be graph nodes: source modules at any depth under `src/` (a
 * nested module imported only by another nested module must still reach the
 * tests above it), top-level smoke files, and — since #2649 — the TypeScript
 * helpers under `smoke-tests/lib/`, so a helper change selects the tests that
 * import it instead of the whole suite. The table lives in
 * `work-driver-verify-classify.ts`: one place says what is a node and what is
 * classified, so the two cannot drift.
 */
const NODE_RE = NODE_PATH_RE;
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

/**
 * The graph's node set — every file `selectVerifyTests` will tokenize.
 *
 * Exported for the gate that asserts every one of them lexes
 * (test-verify-select-lex-tree.ts): a whole-tree precondition asserted on a set
 * re-derived by hand can silently be narrower than the graph it protects, so the
 * gate asks the selector what its graph is.
 */
export function listNodes(extensionDir: string): string[] {
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
  if (changedPathRulesEnabled() && existsSync(path.join(extensionDir, "smoke-tests", "lib"))) {
    walk("smoke-tests/lib");
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
  const lib = new Set<string>();
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
  return { nodes, importers, dynamic, unresolved, lib };
}

/** Every node that imports `start`, transitively, plus `start`. */
function importersClosure(graph: Graph, start: string): Set<string> {
  const reached = new Set<string>([start]);
  // A for-of over an array sees the entries pushed during the walk, so the
  // queue needs no shift and no cast.
  const queue = [start];
  for (const node of queue) {
    for (const importer of graph.importers.get(node) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached;
}

/** An empty roster: the off arm never asks a literal rule anything. */
const EMPTY_ROSTER: OfflineTests = { names: [], lexed: new Map(), unlexable: false };

/**
 * The offline tests that quote `rel` as an exact literal — the users of a shell or
 * data helper, which no import edge can show. `bash smoke-tests/lib/verify-loop.sh
 * …` inside a test is the shape this catches.
 */
function literalReferrers(roster: OfflineTests, rel: string): string[] {
  const out: string[] = [];
  for (const name of roster.names) {
    const lexed = roster.lexed.get(name);
    if (lexed === undefined) continue;
    if ([...lexed.strings, ...lexed.templates].includes(rel)) out.push(name);
  }
  return out;
}

/**
 * Select the smoke tests for a set of changed files.
 *
 * `changed` is extension-relative (`src/x.ts`, `smoke-tests/test-y.ts`). A path the
 * classification table places as `config` or `unknown`, or anything the walk cannot
 * trust, sends the whole selection to the full suite.
 */
export function selectVerifyTests(
  extensionDir: string,
  changed: readonly string[],
): VerifySelection {
  // Computed from the tree being verified, so the set matches the tests the
  // command is about to run. A `smoke-tests/` directory that is not there at all
  // is not a silent empty set: `textReadingTests` throws and the caller's
  // try/catch turns that into a full-suite fallback, which is the safe direction.
  const alwaysRun = textReadingTests(extensionDir);
  const full = (fallbackReason: string): VerifySelection => ({
    mode: "full",
    tests: [],
    alwaysRun: [...alwaysRun],
    fallbackReason,
  });
  if (changed.length === 0) return full("no-changed-files");
  const rules = changedPathRulesEnabled();
  // Read once per selection and shared by every rule that asks who NAMES a file —
  // the classifier and the helper-reference rule below. A tree with no smoke-test
  // directory at all is not a silent empty roster: the roster read throws, and the
  // caller's try/catch turns that into a full-suite fallback, which is the safe
  // direction. An UNREADABLE roster (a test the tokenizer could not close) cannot
  // answer either question, so nothing selects on a partial answer — `unlexable`
  // sends the two rules that need it to the full suite.
  const roster = rules ? readOfflineTests(extensionDir) : null;
  if (!rules) {
    // The off arm, verbatim from before #2649: any lib path and any non-node falls
    // back before the graph is built, in the order the old loop used.
    for (const f of changed) {
      if (f.startsWith("smoke-tests/lib/")) return full(`smoke-test-helper:${f}`);
      if (!NODE_RE.test(f)) return full(`outside-graph:${f}`);
    }
  }
  // A roster the tokenizer could not finish reading cannot answer who NAMES or
  // REFERENCES a file, so no rule that selects on a literal may run on it. The graph
  // walk still sees that file (`unreadable` below, whose reason names it directly),
  // but the graph is the wider surface: a nameable docs path needs only the roster's
  // literals, so the roster doubt is checked FIRST and its reason names the changed
  // file — the decision it blocked — while a graph-level unreadable file is the
  // sharper claim and keeps the reason that names the file itself.
  let rosterDoubt: string | undefined;
  rosterDoubt = roster?.unlexable ? `unlexable-roster:${changed[0]}` : undefined;
  // The roster doubt goes first: the graph walk can see a file the roster cannot, and
  // the weaker doubt is the one that explains the decision. Both reasons name what
  // was in doubt, so a note says which half of the tree could not be read.
  if (rosterDoubt === undefined && roster !== null) {
    const trust = literalRulesTrustworthy(extensionDir);
    if (!trust.trusted) rosterDoubt = trust.reason;
  }
  const graph = buildGraph(extensionDir);
  // A roster the tokenizer could not finish suspends every literal rule, so it
  // answers before the graph's own unreadable node: both send the same rules to the
  // full suite, and the roster reason is the one that says which rules were suspended.
  if (rosterDoubt !== undefined) return full(rosterDoubt);
  if ("unreadable" in graph) return full(`unlexable:${graph.unreadable}`);
  // The pre-check order is part of the off arm's bytes: the pre-#2649 code refused
  // every non-node BEFORE the graph was consulted, so a changed path that is not a
  // node answered `outside-graph:<path>` where the graph walk would have said
  // `no-selected-tests:<path>`. With the rules on, that same path is answered by the
  // classification table (or by the helper-reference rule), which is the point of
  // the ticket — so this pre-check is the off arm's alone.
  if (!rules) {
    for (const f of changed) {
      if (graph.nodes.has(f)) continue;
      // A path that looks like a test or a module but is not in the graph is the
      // pre-#2649 `no-selected-tests` shape — a deleted test is a node-shaped name
      // the walk finds nothing for. Anything else never looked like a node.
      return full(`${NODE_RE.test(f) ? "no-selected-tests" : "outside-graph"}:${f}`);
    }
  }
  const selected = new Set<string>();
  const walkStarts: string[] = [];
  for (const start of changed) {
    // The off arm never classifies: the two lines above already refused every
    // non-node, so what reaches the walk here is the pre-#2649 node set.
    const classified = rules
      ? classifyChangedPath(roster ?? EMPTY_ROSTER, start)
      : ({ kind: "node", namers: [] } as ClassifiedPath);
    if (classified.kind === "config") return full(`config-file:${start}`);
    if (classified.kind === "unknown") return full(`outside-graph:${start}`);
    if (classified.kind === "named") {
      if (rosterDoubt !== undefined) return full(rosterDoubt);
      for (const n of classified.namers) selected.add(n);
      continue;
    }
    if (classified.kind === "text") {
      // The always-run set is the sound answer: a test that could read this file
      // reads repository text and is already in it. Nothing else runs.
      continue;
    }
    if (classified.kind === "helper") {
      // A shell or data helper under `smoke-tests/lib/` has no importer, so its
      // users are the tests that quote its exact path; a reference no test makes
      // falls back rather than selecting nothing.
      if (rosterDoubt !== undefined) return full(rosterDoubt);
      const refs = literalReferrers(roster ?? EMPTY_ROSTER, start);
      if (refs.length === 0) return full(`helper-unreferenced:${start}`);
      for (const r of refs) selected.add(r);
      continue;
    }
    if (classified.kind === "non-code") continue;
    if (!graph.nodes.has(start)) return full(`outside-graph:${start}`);
    walkStarts.push(start);
  }
  for (const start of walkStarts) {
    const reached = importersClosure(graph, start);
    const untrusted = untrustedNode(graph, reached, start);
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
  const names = [...selected, ...alwaysRun];
  if (names.some((n) => !SMOKE_TEST_NAME_RE.test(n))) return full("unsafe-test-name");
  return {
    mode: "selected",
    tests: [...selected].sort(),
    alwaysRun: [...alwaysRun],
  };
}

/**
 * The develop command for a selection: `tests` through verify-loop, after the
 * typecheck of the smoke-test tree. The caller passes the selection's `tests`
 * already merged with its `alwaysRun` — both computed from the tree the command
 * will run in, never from the tree this module was loaded from, so a worktree's
 * command can only name tests that tree has.
 *
 * The fast tier (`.pi/verify-cmd-fast`: tsc of src, biome) is NOT repeated here —
 * the caller's `withFastTier` runs it ahead of this string, exactly as it runs
 * ahead of `.pi/verify-cmd`.
 *
 * Each test is spelled `"$PWD/…"`, evaluated in the tree the command runs in.
 * The loop prints the path it was given, so a failure names the test by an
 * absolute path that the attribution comparison can place under the tree it ran
 * in. The string itself is the same for every worktree, so the gate-reuse key
 * (which includes the command) does not change between them.
 */
export function selectedVerifyCommand(tests: readonly string[]): string {
  const args = [...new Set(tests)].sort().map((t) => `"$PWD/${t}"`);
  return `cd extension && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.smoke-tests.json && bash smoke-tests/lib/verify-loop.sh --jobs-from-host ${args.join(" ")}`;
}

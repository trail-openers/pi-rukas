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
import { rosterReaders } from "./work-driver-verify-always-run.ts";
import {
  type ChangedPathClass,
  type ClassifiedPath,
  NODE_PATH_RE,
  classifyChangedPath,
} from "./work-driver-verify-classify.ts";
import {
  listLibTsFiles,
  type LiteralTrust,
  literalTrustFromLexed,
} from "./work-driver-verify-literal-trust.ts";
import { type OfflineTests, readOfflineTests } from "./work-driver-verify-offline-tests.ts";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";
import { SMOKE_TEST_NAME_RE, isOfflineTest } from "./work-driver-verify-shared.ts";
import { isRepoPath } from "./work-driver-verify-repo-paths.ts";
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
function buildGraph(
  extensionDir: string,
): (Graph & { lexed: Map<string, LexedSource>; libTs: string[] }) | { unreadable: string } {
  // `libTsFiles` is the same subtree the node walk below covers when the rules are
  // on; computed from the node set rather than by a second walk. When the rules are
  // off the node set holds no lib file, so the subtree is listed separately — and a
  // tree with no `smoke-tests/lib/` at all lists nothing rather than throwing.
  const rules = changedPathRulesEnabled();
  const libTs = rules ? [] : listLibTsFiles(extensionDir);
  const files = listNodes(extensionDir);
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
 * data helper, which no import edge can show. Kept as the single-path entry point
 * beside `quoteExact`, which is where the rule is spelled and where the mutation
 * gate points.
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

/** A leading interpolation or relative prefix that does not change which file a literal names — the classifier's own rule. */
const NAMER_LEADING_RE = /^(?:\$\{[^}]*\}\/|\.{1,2}\/|extension\/)*/;

/**
 * Does a literal spell `rel` as an exact repository path, once its leading
 * interpolation or relative prefix is ignored? The classifier's exact-namer rule
 * and the shared spelling rules of `work-driver-verify-repo-paths` are the contract.
 */
function isExactNamerLiteral(literal: string, rel: string): boolean {
  return isRepoPath(literal) && literal.replace(NAMER_LEADING_RE, "") === rel;
}

/**
 * The offline tests whose lexed literals name each of `targets`, indexed by the
 * target they name. Roster order is sorted, so each bucket is sorted too — the same
 * answer the per-path scans produced, from one pass over the roster's literals.
 *
 * `rawMatch` picks the helper rule's spelling — the users of a shell or data helper,
 * which no import edge can show (`bash smoke-tests/lib/verify-loop.sh …` inside a
 * test is that shape) — over the classifier's, which reads the exact path after the
 * leading prefix; a bucket is therefore meaningful under exactly one of the two, and
 * the caller keeps them apart.
 */
function namersForPaths(
  roster: OfflineTests,
  targets: ReadonlySet<string>,
  rawMatch: boolean,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const push = (key: string, name: string) => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [name]);
    else if (!bucket.includes(name)) bucket.push(name);
  };
  const targetList = [...targets];
  for (const name of roster.names) {
    const lexed = roster.lexed.get(name);
    if (lexed === undefined) continue;
    if (rawMatch) {
      // One test per roster file: a helper is quoted wholly or not at all, so every
      // target is asked with the same test — the one `literalReferrers` spells.
      if (targetList.every((t) => !literalReferrers(roster, t).includes(name))) continue;
      for (const target of targetList) push(target, name);
      continue;
    }
    for (const s of [...lexed.strings, ...lexed.templates]) {
      for (const target of targetList) {
        if (isExactNamerLiteral(s, target)) push(target, name);
      }
    }
  }
  return index;
}

/** Does this classification select on what a test's code SAYS rather than imports? */
function isLiteralClass(kind: ChangedPathClass): boolean {
  return kind === "named" || kind === "text" || kind === "helper";
}

/**
 * The trust verdict over the `smoke-tests/lib/` subtree, derived from the lexing the
 * graph walk already did. A lib `.ts` file the walk never lexed (or could not
 * close) is the doubt; a tree with no lib directory lists no file and is no doubt.
 */
function libDoubtOf(graph: { lexed: Map<string, LexedSource>; libTs: string[] }): string | undefined {
  const trust = literalTrustFromLexed(graph.libTs, graph.lexed);
  return trust.trusted ? undefined : trust.reason;
}

/**
 * Select the smoke tests for a set of changed files.
 *
 * `changed` is extension-relative (`src/x.ts`, `smoke-tests/test-y.ts`). A path the
 * classification table places as `config` or `unknown`, or anything the walk cannot
 * trust, sends the whole selection to the full suite.
 *
 * Cost: one selection reads and lexes each top-level smoke test once (the roster,
 * which also answers the always-run question) and each graph node once (the walk,
 * which also answers the doubt over the lib subtree), whatever the size of `changed`.
 */
export function selectVerifyTests(
  extensionDir: string,
  changed: readonly string[],
): VerifySelection {
  // Read once per selection and shared by every rule that asks what a top-level
  // test says — the always-run set, the classifier's exact namers and the
  // helper-reference rule. A tree with no smoke-test directory at all is not a
  // silent empty roster: the roster read throws, and the caller's try/catch turns
  // that into a full-suite fallback, which is the safe direction. The off arm does
  // not read it: it never asks a literal rule anything, and a tree whose roster
  // cannot be read falls back at the graph walk instead — the same answer, one read
  // cheaper.
  const roster = changedPathRulesEnabled() ? readOfflineTests(extensionDir) : null;
  // Computed from the tree being verified, so the set matches the tests the
  // command is about to run: `rosterReaders` is `textReadingTests` over this same
  // roster. A `smoke-tests/` directory that is not there at all is not a silent
  // empty set: the roster read above throws and the caller's try/catch turns that
  // into a full-suite fallback, which is the safe direction.
  const alwaysRun = rosterReaders(roster ?? readOfflineTests(extensionDir));
  const full = (fallbackReason: string): VerifySelection => ({
    mode: "full",
    tests: [],
    alwaysRun: [...alwaysRun],
    fallbackReason,
  });
  if (changed.length === 0) return full("no-changed-files");
  const rules = roster !== null;
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
  const rosterDoubt = roster?.unlexable ? `unlexable-roster:${changed[0]}` : undefined;
  const graph = buildGraph(extensionDir);
  // A roster the tokenizer could not finish suspends every literal rule, so it
  // answers before the graph's own unreadable node: both send the same rules to the
  // full suite, and the roster reason is the one that says which rules were suspended.
  if (rosterDoubt !== undefined) return full(rosterDoubt);
  if ("unreadable" in graph) return full(`unlexable:${graph.unreadable}`);
  // The doubt over the lib subtree is the other half of the same suspension: the
  // literal rules ask about files the graph walk alone never consults. It is
  // derived from the lexing above rather than a second walk, and asked only by the
  // two classes that select on a literal — so a src-only or node-only diff never
  // pays for it. Captured eagerly on the first need, because a lazily recomputed
  // verdict could disagree with the one an earlier row of the same selection acted
  // on if the tree changed between the two.
  // The doubt over the `smoke-tests/lib/` subtree is the other half of the roster
  // suspension: the literal rules ask about files the graph walk alone never
  // consults. It is derived from the lexing the walk already did — one lex per lib
  // file per selection, not a second walk — and asked only when a `named`/`text`/
  // `helper` row is in play, so a src-only or node-only diff never pays for it.
  // A tree with no lib directory lists no file and is no doubt, which is why the
  // walk is guarded by the same existence check `listNodes` applies to the node set
  // (a fixture tree that never created the directory is a normal case, not a doubt).
  let libDoubt: string | undefined | null = null;
  const libTrustDoubt = (): string | undefined => {
    if (libDoubt === null) {
      libDoubt = existsSync(path.join(extensionDir, "smoke-tests", "lib"))
        ? libDoubtOf(graph)
        : undefined;
    }
    return libDoubt;
  };
  // One pass over the roster's lexed literals builds the namer index for every path
  // in `changed`, so a multi-path diff scans the roster once instead of once per
  // path. Only the classes that name or quote a path need it, and the classification
  // that decides between them is a table over the path alone — so classifying every
  // path first, then scanning, answers the same questions in the same order.
  const literalIndexes = {
    exact: new Map<string, string[]>(),
    raw: new Map<string, string[]>(),
  };
  const classifiedList = rules
    ? changed.map((f) => classifyChangedPath(roster ?? EMPTY_ROSTER, f))
    : changed.map(() => ({ kind: "node", namers: [] }) as ClassifiedPath);
  // Only the classes that select on what a test SAYS consult the roster's literals,
  // and a lib-subtree doubt suspends exactly those rules — so the doubt is asked
  // only when one of these classes is in play, and it is answered from the walk.
  if (roster !== null && rosterDoubt === undefined && classifiedList.some((c) => isLiteralClass(c.kind))) {
    const trust = libTrustDoubt();
    if (trust !== undefined) return full(trust);
    // The `named`/`text` rows match the leading prefix off (a test may spell
    // `./docs/x.md`), the `helper` rows match the exact path as quoted. A path is
    // one class or the other, so a bucket is never filled under both spellings.
    const exactPaths = new Set<string>();
    const rawPaths = new Set<string>();
    for (const [i, classified] of classifiedList.entries()) {
      const f = changed[i];
      if (f === undefined) continue;
      if (classified.kind === "helper") rawPaths.add(f);
      else if (isLiteralClass(classified.kind)) exactPaths.add(f);
    }
    if (exactPaths.size > 0) {
      for (const [key, names] of namersForPaths(roster, exactPaths, false)) {
        literalIndexes.exact.set(key, names);
      }
    }
    if (rawPaths.size > 0) {
      for (const [key, names] of namersForPaths(roster, rawPaths, true)) {
        literalIndexes.raw.set(key, names);
      }
    }
  }
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
  for (const [i, start] of changed.entries()) {
    const classified = classifiedList[i] ?? ({ kind: "unknown", namers: [] } as ClassifiedPath);
    if (classified.kind === "config") return full(`config-file:${start}`);
    if (classified.kind === "unknown") return full(`outside-graph:${start}`);
    if (classified.kind === "named") {
      // The classifier found namers, so the literal rules were consulted for this
      // path and their doubt (roster or lib subtree) is already answered above.
      for (const n of literalIndexes.exact.get(start) ?? []) selected.add(n);
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
      const refs = literalIndexes.raw.get(start) ?? [];
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

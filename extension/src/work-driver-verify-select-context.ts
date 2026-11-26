/**
 * work-driver-verify-select-context — #2649: one tree read, many selections.
 *
 * `selectVerifyTests` reads and lexes the tree on every call: the offline-test roster,
 * the import graph, the always-run set and the literal index. That is the right cost for
 * the develop gate, which selects once per pass, and the wrong cost for a suite that
 * asks the same question about fifty changed sets — where each selection re-reads a tree
 * that has not changed between them. A prepared context holds that single read, and the
 * selector answers from it, so the per-selection cost is the walk over `changed`.
 *
 * The context is valid for ONE tree state and ONE switch verdict. It records the verdict
 * it was built under, and the selector uses the recorded verdict rather than reading the
 * environment again — so a selection through a context answers by the rules that were in
 * force when the tree was read, even if the variable is changed afterwards. That is the
 * same single-read discipline a single selection already keeps (see `selectVerifyTests`),
 * extended across a run of selections: flipping
 * `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS` mid-run changes the next context, never a
 * selection already in flight.
 *
 * A context is a snapshot and must not outlive the tree it was read from. The develop
 * gate holds a tree for the length of a pass and calls `selectVerifyTests` with the
 * directory; the context form exists for a caller that knows it will ask many questions
 * of one tree — the selector's own suites, chiefly.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { changedPathRulesEnabled } from "./verify-select-changed-paths-switch.ts";
import { rosterReaders } from "./work-driver-verify-always-run.ts";
import { type OfflineTests, readOfflineTests } from "./work-driver-verify-offline-tests.ts";
import { type BuiltGraph, buildGraph } from "./work-driver-verify-select-graph.ts";
import type { LexedSource } from "./work-driver-verify-select-lex.ts";
import { type LiteralIndex, literalIndex } from "./work-driver-verify-select-literals.ts";

/** The graph the walk built, or the first file the tokenizer could not read. */
export type PreparedGraph = BuiltGraph | { unreadable: string };

/**
 * Everything one tree read answers, read once: the roster of offline tests, the import
 * graph over the tree's nodes, the always-run set computed from that roster, and the
 * roster's literal index.
 *
 * `rules` is the switch verdict this snapshot was read under — the node set, the lib
 * subtree and every rule the selector runs are judged by it, whatever the environment
 * says now. `unlexable` (the roster's doubt) and `unreadable` (the graph's) both suspend
 * the rules that need them, and the selector decides which reason to report, so a context
 * is built for a doubtful tree rather than refused at build time.
 */
export interface VerifySelectionContext {
  /** The tree this was read from. */
  readonly extensionDir: string;
  /** The #2649 classification verdict this snapshot was read under. */
  readonly rules: boolean;
  /** The offline-test roster, lexed once. Null on the off arm, which asks it nothing. */
  readonly roster: OfflineTests | null;
  /** The always-run set computed from that roster. */
  readonly alwaysRun: string[];
  /** The import graph, or the graph's own unreadable file. */
  readonly graph: PreparedGraph;
  /** The roster's literals, indexed for every literal question a selection asks. */
  readonly literals: LiteralIndex;
  /** The lexed text of every graph node, which is what the lib doubt is judged from. */
  readonly lexed: Map<string, LexedSource>;
  /** The `smoke-tests/lib/` TypeScript files the walk saw, which the lib doubt enumerates. */
  readonly libTs: string[];
  /** Whether the tree has a `smoke-tests/lib/` directory at all (no directory is no doubt). */
  readonly hasLibDir: boolean;
}

/**
 * Read one tree once, for as many selections as the caller means to ask of it.
 *
 * The switch is read here and never again: every selection through this context is
 * judged by the verdict in force at this moment. The roster read is not guarded — a tree
 * with no `smoke-tests/` directory throws here, exactly as it throws inside
 * `selectVerifyTests`, so a caller that wraps a selection in a try/catch for the
 * full-suite fallback wraps a context build the same way.
 */
export function prepareVerifySelection(extensionDir: string): VerifySelectionContext {
  const rules = changedPathRulesEnabled();
  // The off arm never asks a literal rule anything, so it reads no roster — the same
  // answer, one read cheaper, and a tree whose roster cannot be read falls back at the
  // graph walk instead. The always-run set still needs a roster, which it reads itself.
  const roster = rules ? readOfflineTests(extensionDir) : null;
  const alwaysRun = rosterReaders(roster ?? readOfflineTests(extensionDir));
  const graph = buildGraph(extensionDir, rules);
  const built = "unreadable" in graph ? undefined : graph;
  return {
    extensionDir,
    rules,
    roster,
    alwaysRun,
    graph,
    literals: roster === null || roster.unlexable ? { byKey: new Map() } : literalIndex(roster),
    lexed: built?.lexed ?? new Map<string, LexedSource>(),
    libTs: built?.libTs ?? [],
    hasLibDir: existsSync(path.join(extensionDir, "smoke-tests", "lib")),
  };
}

#!/usr/bin/env bun
/**
 * #2450 — every graph node the selector builds must lex.
 *
 * `selectVerifyTests` treats ONE file it cannot tokenize as a reason to run the
 * whole suite: `buildGraph` returns the first unreadable node and the selection
 * becomes `mode: "full"`, `unlexable:<file>`. That whole-graph rule is what made
 * the selector inert for a month — nine graph nodes carried a template nested
 * inside an interpolation, every one of them failed to lex, and no offline test
 * ran the selector against this repo, so the gate stayed green while the feature
 * did nothing.
 *
 * So this is the precondition the selector depends on, asserted on the real tree:
 * the node set is the selector's OWN `listNodes`, imported rather than re-derived,
 * because a gate whose scope is narrower than the graph it protects reads as
 * compliance when it is a gap (test-file-size-limit.ts's own finding).
 *
 * **Observed in both directions.** A gate never run in a failing state proves
 * nothing, so the same assertion is run against a fixture graph with an
 * unlexable file planted in it, and against the nested-template source that made
 * this repo's nine nodes unlexable — reintroduced as a real-tree mutant, in a
 * tree the selector itself will walk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lexSource } from "../src/work-driver-verify-select-lex.ts";
import { edgesOf, listNodes, selectVerifyTests } from "../src/work-driver-verify-select.ts";

const extensionDir = path.resolve(import.meta.dirname, "..");

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

// --- the real tree: every node the selector builds, lexes ---------------------
const nodes = listNodes(extensionDir);
assert(nodes.length > 1000, `the selector's own node set is non-trivial (${nodes.length} nodes)`);
// The set is what the selector sees, not a hand-typed list: if NODE_RE ever stops
// matching a directory the gate used to cover, this is where it shows.
// #2649 widened the node set with `smoke-tests/lib/**/*.ts`: a runner helper is now
// a node whose referrers are selected. The OFF arm must answer the OLD shape, so the
// set is compared to each shape under the switch that produces it rather than to one
// hand-typed pattern.
const NODE_SHAPE_OLD = /^(?:src\/(?:[^/]+\/)*[^/]+\.ts|smoke-tests\/[^/]+\.ts)$/;
// The ON shape is the pre-#2649 shape plus the lib helpers: the top-level smoke
// directory contributes every `.ts` the old pattern allowed (including the fixture
// modules a top-level test imports), and #2649 adds `smoke-tests/lib/`.
const NODE_SHAPE_NEW = /^(?:src\/(?:[^/]+\/)*[^/]+\.ts|smoke-tests\/[^/]+\.ts|smoke-tests\/lib\/(?:[^/]+\/)*[^/]+\.ts)$/;
const outside = (list: string[], shape: RegExp) => list.filter((n) => !shape.test(n));
const priorSwitch = process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = "0";
const nodesOff = listNodes(extensionDir);
if (priorSwitch === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
else process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = priorSwitch;
assert(
  outside(nodesOff, NODE_SHAPE_OLD).length === 0,
  `with the rules off every node is a src module or a top-level smoke file — the pre-#2649 NODE_RE (strays: ${outside(nodesOff, NODE_SHAPE_OLD).slice(0, 3).join(", ")})`,
);
assert(
  outside(nodes, NODE_SHAPE_NEW).length === 0,
  `every node is a src module, a top-level smoke test or a lib helper (strays: ${outside(nodes, NODE_SHAPE_NEW).slice(0, 3).join(", ")})`,
);
assert(
  nodes.filter((n) => n.startsWith("smoke-tests/lib/")).length > 100,
  `the #2649 arm made the runner helpers graph nodes (${nodes.filter((n) => n.startsWith("smoke-tests/lib/")).length} of them)`,
);
assert(
  nodesOff.filter((n) => n.startsWith("smoke-tests/lib/")).length === 0,
  "with the rules off no lib helper is a node — the pre-#2649 set exactly",
);
for (const named of [
  "src/worktree-loss.ts",
  "src/worktree-create-guard.ts",
  "src/work-driver-commit-reentry.ts",
  "src/work-driver-verify-select.ts",
  "src/work-driver-verify-select-lex.ts",
  "src/work-driver-verify-always-run.ts",
]) {
  assert(nodes.includes(named), `${named} is a graph node (one of the six the issue names)`);
}

// readFileSync, not Bun.file: lexSource takes a string, and what is under test is
// that every node's TEXT closes under the tokenizer.
const unlexable = nodes.filter(
  (n) => lexSource(readFileSync(path.join(extensionDir, n), "utf8")) === undefined,
);
assert(
  unlexable.length === 0,
  `every one of the ${nodes.length} graph nodes lexes (${unlexable.length} unlexable${
    unlexable.length > 0 ? `: ${unlexable.slice(0, 5).join(", ")}` : ""
  }) — a single unlexable file sends EVERY develop round to the full suite`,
);

// The lexer judges its own source. `lexSource` refuses any input carrying a bare
// placeholder, and this module spells the markers as escapes, so a regression
// that pastes a raw code point into it unlexes the lexer itself — which, being a
// graph node, would again make selection inert.
assert(
  lexSource(readFileSync(path.join(extensionDir, "src/work-driver-verify-select-lex.ts"), "utf8")) !==
    undefined,
  "the lexer lexes its own source (it carries no bare placeholder of its own markers)",
);

// --- and the gate CAN fail: a planted unlexable file -------------------------
{
  const root = mkdtempSync(path.join(tmpdir(), "pi-verify-lexgate-"));
  try {
    const ext = path.join(root, "extension");
    const put = (rel: string, text: string) => {
      const file = path.join(ext, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, "utf8");
    };
    put("src/a.ts", "export const a = 1;\n");
    put("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
    const clean = selectVerifyTests(ext, ["src/a.ts"]);
    assert(
      clean.mode === "selected",
      `fixture: a clean graph selects (got ${clean.mode}/${clean.fallbackReason ?? "-"})`,
    );

    // The exact shape that made this repo's nine nodes unlexable: a template whose
    // interpolation holds a nested template containing a brace.
    put("src/nested.ts", "export const f = (r: string) => `git ${JSON.stringify(`${r}^{tree}`)}`;\n");
    const nested = selectVerifyTests(ext, ["src/a.ts"]);
    // The whole point of the fix, asserted as a verdict rather than as "one of the
    // two possible answers": before the fix this file was the reason every
    // selection fell back, so `full` is the failure this gate exists to catch, and
    // a disjunction that admits it asserts nothing.
    assert(
      nested.mode === "selected",
      `the graph holding the nested-template file still selects (got ${nested.mode}/${nested.fallbackReason ?? "-"}) — a fall-back here is the #2450 defect, not an alternative outcome`,
    );
    assert(
      lexSource(readFileSync(path.join(ext, "src/nested.ts"), "utf8")) !== undefined,
      "the reintroduced nested-template case LEXES after the fix (this is the case that was red on main)",
    );

    // An unterminated construct still unlexes, and the selector still names it:
    // the fallback path is live, not merely reachable in principle.
    put("src/broken.ts", "export const s = \"never closed;\n");
    const broken = selectVerifyTests(ext, ["src/a.ts"]);
    assert(
      broken.mode === "full" && broken.fallbackReason === "unlexable:src/broken.ts",
      `a planted unlexable file reports unlexable:<file> (got ${broken.mode}/${broken.fallbackReason ?? "-"}) — the gate is observed red`,
    );
    // And the graph-wide rule is real: an unlexable file anywhere falls back the
    // selection of a file nowhere near it.
    const far = selectVerifyTests(ext, ["src/nested.ts"]);
    assert(
      far.mode === "full" && far.fallbackReason?.startsWith("unlexable:"),
      `an unlexable file falls back the selection of an UNRELATED file (got ${far.mode}/${far.fallbackReason ?? "-"})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- the tokenizer's edges-of-file path agrees with lexSource ----------------
assert(
  edgesOf("src/x.ts", "export const a = 1;\n")?.specifiers.length === 0,
  "edgesOf on a trivial module returns no edges (the per-file consumer of the same lexer)",
);
assert(
  edgesOf("src/x.ts", "export const s = \"unterminated;\n") === undefined,
  "edgesOf returns undefined for an unlexable file — the selector reads that as unreadable",
);

console.log(exit === 0 ? "\nAll real-tree lexer-coverage checks passed." : "\nFAILED");
process.exit(exit);

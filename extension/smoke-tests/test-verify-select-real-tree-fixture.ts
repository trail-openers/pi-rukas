#!/usr/bin/env bun
/**
 * #2450 (half 2) — the selector's answers on a tree this suite plants itself.
 *
 * `test-verify-select-real-tree.ts` asserts what only THIS repository can answer. This
 * file owns the other half of that gate: the shapes that exist only where a fixture puts
 * them, on a five-file tree under /tmp — a module no test imports (which must select
 * nothing), the same module once its test exists (which must select), the
 * nested-template-with-brace shape that must LEX and then select, and the planted mutant
 * that must be named. Those are the two directions the ticket demanded be observed red,
 * and neither of them is a fact about this repository: they are facts about the walker,
 * judged over a graph small enough to hold in one's head.
 *
 * The re-lex rows live here for the same reason they select here: the mutant has to sit
 * INSIDE the graph the selection walks, so `lexSource` is asked about the planted file
 * and `selectVerifyTests` is asked about the tree containing it. Both go through the
 * directory form — a fixture tree is built after any roster was read, so a context over
 * it would be a snapshot of a moving target.
 *
 * Split out of the real-tree suite by #2649: each selection over the REAL tree reads and
 * lexes ~1,900 files, and the per-file ceiling (#2449) is what a suite of that size
 * eventually trips. Nothing here reads the real tree, so nothing here pays for it.
 */
import { readFileSync } from "node:fs";
import { lexSource } from "../src/work-driver-verify-select-lex.ts";
import { selectVerifyTests } from "../src/work-driver-verify-select.ts";
import { createFixtureTree } from "./lib/verify-select-fixture-tree.ts";
import { assert, exit } from "./lib/assert-rig.ts";

// --- observed red: an unlexable file in a graph the selector walks -----------
{
  const tree = createFixtureTree();
  try {
    const ext = tree.extensionDir;
    tree.put("src/a.ts", "export const a = 1;\n");
    tree.put("src/b.ts", "export const b = 2;\n");
    tree.put("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');

    const before = selectVerifyTests(ext, ["src/b.ts"]);
    assert(
      before.mode === "full" && before.fallbackReason === "no-selected-tests:src/b.ts",
      `fixture: a module no test imports selects nothing (got ${before.mode}/${before.fallbackReason ?? "-"})`,
    );
    tree.put("smoke-tests/test-b.ts", 'import { b } from "../src/b.ts";\nvoid b;\n');
    const after = selectVerifyTests(ext, ["src/b.ts"]);
    assert(
      after.mode === "selected" && after.tests.includes("smoke-tests/test-b.ts"),
      `fixture: with its test present, src/b.ts selects (got ${after.mode}/${after.fallbackReason ?? "-"})`,
    );

    // The other direction of the same mutant: the nested-template-with-brace shape
    // that made this repo's nine nodes unlexable. The suite that owns the lexer
    // (`test-verify-select-lex-tree.ts`) asserts its verdict; this gate owns the
    // SELECTION, so the shape is asserted here as a `selected` answer — which is
    // what a fixed lexer must produce, and what it did not produce before #2450.
    tree.put(
      "src/nested-ok.ts",
      "export const f = (r: string) => `x ${JSON.stringify(`${r}^{tree}`)}`;\n",
    );
    tree.put(
      "smoke-tests/test-nested-ok.ts",
      'import { f } from "../src/nested-ok.ts";\nvoid f;\n',
    );
    assert(
      lexSource(readFileSync(tree.file("src/nested-ok.ts"), "utf8")) !== undefined,
      "the planted nested-template-with-brace file lexes",
    );
    const nestedOk = selectVerifyTests(ext, ["src/nested-ok.ts"]);
    assert(
      nestedOk.mode === "selected" && nestedOk.tests.includes("smoke-tests/test-nested-ok.ts"),
      `the nested-template-with-brace node selects (got ${nestedOk.mode}/${nestedOk.fallbackReason ?? "-"}) — on the pre-fix lexer this fell back as unlexable`,
    );
    tree.remove("src/nested-ok.ts");
    tree.remove("smoke-tests/test-nested-ok.ts");

    // The mutant: the nested-template shape from the issue, planted in the graph.
    // Before the fix this made the WHOLE selection fall back for every input; the
    // whole-graph rule is unchanged, so it must still be the reason named here —
    // and the reason must name the file, not say "unknown".
    tree.put(
      "src/nested-broken.ts",
      "export const s = 'unterminated, and this template never closes: `${`${x}^{tree}`;\n",
    );
    const mutant = selectVerifyTests(ext, ["src/b.ts"]);
    assert(
      mutant.mode === "full" && mutant.fallbackReason === "unlexable:src/nested-broken.ts",
      `a mutant with an unlexable file reports unlexable:<file> (got ${mutant.mode}/${mutant.fallbackReason ?? "-"}) — the gate is observed red`,
    );
    assert(
      mutant.tests.length === 0,
      "a fallback selects nothing, so a caller cannot run a partial suite and call it the selection",
    );
    tree.remove("src/nested-broken.ts");
    const restored = selectVerifyTests(ext, ["src/b.ts"]);
    assert(
      restored.mode === "selected",
      `removing the mutant restores the selection (got ${restored.mode}/${restored.fallbackReason ?? "-"}) — the fallback was the mutant, not the fixture`,
    );
  } finally {
    tree.dispose();
  }
}

console.log(exit === 0 ? "\nAll fixture-tree selection checks passed." : "\nFAILED");
process.exit(exit);

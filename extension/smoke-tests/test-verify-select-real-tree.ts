#!/usr/bin/env bun
/**
 * #2450 — the selector selects, on the real tree.
 *
 * The two existing selector suites build /tmp fixture trees, so between them the
 * gate covered every shape of a graph except the one the develop round actually
 * runs against: this repository. Selection was inert since the lexer landed —
 * nine graph nodes carried a template nested inside an interpolation, "unlexable"
 * is a whole-graph check, and `selectVerifyTests(dir, ["src/lean/config.ts"])`
 * answered `mode: "full", unlexable:src/worktree-loss.ts` for every input. A
 * fixture tree with a tidy little graph could not see that, because the defect
 * lived in files no fixture had.
 *
 * So this asserts the real tree answers `selected`, and — per AGENTS.md §6, a new
 * gate must be observed failing — asserts the two directions that matter:
 *   - a deliberate unlexable file planted in a fixture graph reports
 *     `unlexable:<file>` rather than selecting, and
 *   - the outside-graph and helper policies still answer `full`, so fixing the
 *     lexer did not quietly turn a doc change or a `smoke-tests/lib/` edit into a
 *     selection (both belong to #2424 item 5, and must stay full-suite runs).
 */
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lexSource } from "../src/work-driver-verify-select-lex.ts";
import { selectVerifyTests } from "../src/work-driver-verify-select.ts";

const extensionDir = path.resolve(import.meta.dirname, "..");

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

// --- the real tree: a src-only change selects --------------------------------
const sel = selectVerifyTests(extensionDir, ["src/lean/config.ts"]);
assert(
  sel.mode === "selected",
  `a real src-only change selects rather than falling back (got ${sel.mode}${
    sel.fallbackReason ? `, ${sel.fallbackReason}` : ""
  }) — on main this answered full/unlexable:src/worktree-loss.ts`,
);
assert(
  sel.mode === "selected" && sel.tests.length > 0,
  `the selection names at least one test (${sel.tests.length})`,
);
assert(
  sel.alwaysRun.length > 0,
  `the computed always-run set rides along (${sel.alwaysRun.length})`,
);
assert(
  sel.mode === "selected" && sel.fallbackReason === undefined,
  "a `selected` verdict carries no fallbackReason",
);
assert(
  sel.mode === "selected" && sel.tests.every((t) => /^smoke-tests\/test-[^/]+\.ts$/.test(t)),
  "every selected name is a top-level offline smoke test",
);
assert(
  sel.mode === "selected" && sel.tests.every((t) => !/-live\.ts$/.test(t)),
  "a real-tree selection never carries a -live.ts test",
);
// The selection must be a subset of what the full command would have run: a name
// the tree does not have would make the selected command fail on a missing file.
assert(
  sel.mode === "selected" &&
    [...sel.tests, ...sel.alwaysRun].every((t) => Bun.file(path.join(extensionDir, t)).size > 0),
  "every name a real-tree selection emits exists in that tree",
);

// A second, unrelated src file, so the assertion is not one lucky path.
const sel2 = selectVerifyTests(extensionDir, ["src/forge.ts"]);
assert(
  sel2.mode === "selected",
  `a second src-only change selects too (got ${sel2.mode}${sel2.fallbackReason ? `, ${sel2.fallbackReason}` : ""})`,
);

// --- and the policy that must NOT have moved ---------------------------------
// These are the fallbacks #2424 item 5 owns. Selection going live must not turn a
// doc change into a graph walk: an edit outside the graph still runs everything.
for (const [changed, reason] of [
  [["docs/troubleshooting.md"], "outside-graph:docs/troubleshooting.md"],
  [["agents.json"], "outside-graph:agents.json"],
  [[".github/workflows/ci.yml"], "outside-graph:.github/workflows/ci.yml"],
  [["smoke-tests/lib/verify-loop.sh"], "smoke-test-helper:smoke-tests/lib/verify-loop.sh"],
] as const) {
  const r = selectVerifyTests(extensionDir, changed);
  assert(
    r.mode === "full" && r.fallbackReason === reason,
    `${changed[0]} still falls back to the full suite with ${reason} (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
}
{
  const r = selectVerifyTests(extensionDir, []);
  assert(
    r.mode === "full" && r.fallbackReason === "no-changed-files",
    `an empty change set falls back with no-changed-files (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
}

// --- observed red: an unlexable file in a graph the selector walks -----------
{
  const root = mkdtempSync(path.join(tmpdir(), "pi-verify-select-tree-"));
  try {
    const ext = path.join(root, "extension");
    const put = (rel: string, text: string) => {
      const file = path.join(ext, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, "utf8");
    };
    put("src/a.ts", "export const a = 1;\n");
    put("src/b.ts", "export const b = 2;\n");
    put("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');

    const before = selectVerifyTests(ext, ["src/b.ts"]);
    assert(
      before.mode === "full" && before.fallbackReason === "no-selected-tests:src/b.ts",
      `fixture: a module no test imports selects nothing (got ${before.mode}/${before.fallbackReason ?? "-"})`,
    );
    put("smoke-tests/test-b.ts", 'import { b } from "../src/b.ts";\nvoid b;\n');
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
    put("src/nested-ok.ts", "export const f = (r: string) => `x ${JSON.stringify(`${r}^{tree}`)}`;\n");
    put("smoke-tests/test-nested-ok.ts", 'import { f } from "../src/nested-ok.ts";\nvoid f;\n');
    assert(
      lexSource(readFileSync(path.join(ext, "src/nested-ok.ts"), "utf8")) !== undefined,
      "the planted nested-template-with-brace file lexes",
    );
    const nestedOk = selectVerifyTests(ext, ["src/nested-ok.ts"]);
    assert(
      nestedOk.mode === "selected" && nestedOk.tests.includes("smoke-tests/test-nested-ok.ts"),
      `the nested-template-with-brace node selects (got ${nestedOk.mode}/${nestedOk.fallbackReason ?? "-"}) — on the pre-fix lexer this fell back as unlexable`,
    );
    rmSync(path.join(ext, "src", "nested-ok.ts"), { force: true });
    rmSync(path.join(ext, "smoke-tests", "test-nested-ok.ts"), { force: true });

    // The mutant: the nested-template shape from the issue, planted in the graph.
    // Before the fix this made the WHOLE selection fall back for every input; the
    // whole-graph rule is unchanged, so it must still be the reason named here —
    // and the reason must name the file, not say "unknown".
    put(
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
    rmSync(path.join(ext, "src", "nested-broken.ts"), { force: true });
    const restored = selectVerifyTests(ext, ["src/b.ts"]);
    assert(
      restored.mode === "selected",
      `removing the mutant restores the selection (got ${restored.mode}/${restored.fallbackReason ?? "-"}) — the fallback was the mutant, not the fixture`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll real-tree selection checks passed." : "\nFAILED");
process.exit(exit);

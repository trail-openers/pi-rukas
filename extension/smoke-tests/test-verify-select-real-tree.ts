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
import { readOfflineTests } from "../src/work-driver-verify-offline-tests.ts";
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

// --- and the policy the ticket DID move, row by row -------------------------
// These four rows are what #2649 exists to change. Before it, every one of them
// answered `full` and the develop round ran the whole offline suite; the ticket's
// binding decisions say a docs file, an ignore-like file and a helper each get the
// sound subset, and configuration keeps the full suite under its own reason. The
// PRE-#2649 answers are pinned too, under the switch's off arm, so the escape hatch
// is an assertion rather than a claim.
{
  const OFF: readonly [readonly string[], string][] = [
    [["docs/troubleshooting.md"], "outside-graph:docs/troubleshooting.md"],
    [["agents.json"], "outside-graph:agents.json"],
    [[".github/workflows/ci.yml"], "outside-graph:.github/workflows/ci.yml"],
    [["smoke-tests/lib/verify-loop.sh"], "smoke-test-helper:smoke-tests/lib/verify-loop.sh"],
  ];
  const prior = process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
  process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = "0";
  try {
    for (const [changed, reason] of OFF) {
      const r = selectVerifyTests(extensionDir, changed);
      assert(
        r.mode === "full" && r.fallbackReason === reason,
        `with the switch at 0 ${changed[0]} still falls back to the full suite with ${reason} (got ${r.mode}/${r.fallbackReason ?? "-"})`,
      );
    }
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
    else process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = prior;
  }

  // The ON arm: configuration still runs everything, with a reason that names it.
  for (const p of ["agents.json", ".github/workflows/ci.yml", "tsconfig.smoke-tests.json"]) {
    const r = selectVerifyTests(extensionDir, [p]);
    assert(
      r.mode === "full" && r.fallbackReason === `config-file:${p}` && r.alwaysRun.length > 0,
      `${p} runs the full suite with config-file:${p} and carries the tree's always-run set (got ${r.mode}/${r.fallbackReason ?? "-"})`,
    );
  }
  // A docs change selects, names at least one reader of THAT file, and runs no more
  // than the always-run set plus its exact namers plus the dynamic-import floor.
  const docs = selectVerifyTests(extensionDir, ["docs/troubleshooting.md"]);
  assert(
    docs.mode === "selected" && docs.tests.length > 0,
    `a docs-only change selects rather than falling back (${docs.mode}/${docs.fallbackReason ?? "-"}, ${docs.tests.length} selected)`,
  );
  {
    // The namers are the tests that hold the exact path as a literal — a strict
    // subset of the tests a directory-level membership rule would have pulled in.
    const roster = readOfflineTests(extensionDir);
    const namers = roster.names.filter((n) => {
      const l = roster.lexed.get(n);
      return l !== undefined && [...l.strings, ...l.templates].includes("docs/troubleshooting.md");
    });
    assert(
      namers.length > 0 && namers.every((n) => docs.tests.includes(n)),
      `every test that names docs/troubleshooting.md exactly is selected (${namers.length})`,
    );
    // The upper bound for any selection is the always-run set, the tests that name
    // the changed file exactly, and the selector's standing floor (non-literal
    // `import()` reachers plus tests that build a `src/` path themselves) — the last
    // measured against a change to a module nothing imports, so it is the floor alone.
    const baseline = selectVerifyTests(extensionDir, [
      "src/work-driver-verify-literal-trust.ts",
      ".gitignore",
    ]);
    assert(
      docs.alwaysRun.length > 0 &&
        docs.tests.every(
          (t) => docs.alwaysRun.includes(t) || namers.includes(t) || baseline.tests.includes(t),
        ),
      "a docs selection is always-run + the exact namers + the selector's standing floor, nothing else",
    );
  }
  // An ignore-like file cannot change what any test runs, so the selection it gets is
  // the always-run set plus whatever the standing rules select for EVERY change: the
  // tests that reach a module through a non-literal `import()` and the tests that
  // build a `src/` path themselves. Those two are the selector's conservative floor,
  // not a widening of this row, and the assertion is that nothing beyond them is
  // pulled in — the row's whole point is that a file no test reads runs no new test.
  const ign = selectVerifyTests(extensionDir, [".gitignore"]);
  const baseline = selectVerifyTests(extensionDir, ["src/work-driver-verify-literal-trust.ts"]);
  assert(
    ign.mode === "selected" && ign.alwaysRun.length > 0,
    `an ignore file selects rather than falling back (${ign.mode}/${ign.fallbackReason ?? "-"})`,
  );
  assert(
    ign.tests.every((t) => ign.alwaysRun.includes(t) || baseline.tests.includes(t)),
    `.gitignore selects no test outside the always-run set and the selector's standing floor (${ign.tests.length} selected, ${baseline.tests.length} in the floor)`,
  );
  assert(
    baseline.alwaysRun.length === ign.alwaysRun.length,
    "the always-run half of both selections is the same computed set",
  );
  // A shell helper selects the tests that quote its exact path.
  const loop = selectVerifyTests(extensionDir, ["smoke-tests/lib/verify-loop.sh"]);
  assert(
    loop.mode === "selected" && loop.tests.includes("smoke-tests/test-verify-select-hardening.ts"),
    `the verify-loop helper selects the tests that reference it (${loop.mode}/${loop.fallbackReason ?? "-"}, ${loop.tests.length} selected)`,
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

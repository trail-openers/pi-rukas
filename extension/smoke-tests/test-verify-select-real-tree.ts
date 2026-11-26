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
import {
  type VerifySelection,
  selectVerifyTests,
  selectVerifyTestsFromContext,
  prepareVerifySelection,
} from "../src/work-driver-verify-select.ts";

const extensionDir = path.resolve(import.meta.dirname, "..");

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

/**
 * The whole real tree, read ONCE for every selection this file makes on it.
 *
 * Each `selectVerifyTests(dir, …)` re-reads and re-lexes the tree — ~1,650 test files
 * and ~300 lib files — and this file asks the same question about a dozen changed sets.
 * The tree does not change between those questions (the fixture below is a separate
 * temporary tree, which the file selects on by directory as before), so the answers are
 * the same answers and the reads are the cost worth removing. The OFF-arm rows build
 * their own context inside the switch pin, since a context records the verdict it was
 * read under.
 */
const ctx = prepareVerifySelection(extensionDir);
/** A selection on the real tree, from the one read. */
const sel = (changed: readonly string[]) => selectVerifyTestsFromContext(ctx, changed);

// --- the real tree: a src-only change selects --------------------------------
const sel0 = sel(["src/lean/config.ts"]);
assert(
  sel0.mode === "selected",
  `a real src-only change selects rather than falling back (got ${sel0.mode}${
    sel0.fallbackReason ? `, ${sel0.fallbackReason}` : ""
  }) — on main this answered full/unlexable:src/worktree-loss.ts`,
);
assert(
  sel0.mode === "selected" && sel0.tests.length > 0,
  `the selection names at least one test (${sel0.tests.length})`,
);
assert(
  sel0.alwaysRun.length > 0,
  `the computed always-run set rides along (${sel0.alwaysRun.length})`,
);
assert(
  sel0.mode === "selected" && sel0.fallbackReason === undefined,
  "a `selected` verdict carries no fallbackReason",
);
assert(
  sel0.mode === "selected" && sel0.tests.every((t) => /^smoke-tests\/test-[^/]+\.ts$/.test(t)),
  "every selected name is a top-level offline smoke test",
);
assert(
  sel0.mode === "selected" && sel0.tests.every((t) => !/-live\.ts$/.test(t)),
  "a real-tree selection never carries a -live.ts test",
);
// The selection must be a subset of what the full command would have run: a name
// the tree does not have would make the selected command fail on a missing file.
assert(
  sel0.mode === "selected" &&
    [...sel0.tests, ...sel0.alwaysRun].every((t) => Bun.file(path.join(extensionDir, t)).size > 0),
  "every name a real-tree selection emits exists in that tree",
);

// A second, unrelated src file, so the assertion is not one lucky path.
const sel2 = sel(["src/forge.ts"]);
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
    // The off arm's own read: a context records the switch verdict it was built under,
    // so this one is built inside the pin and answers with the pre-#2649 rules.
    const offCtx = prepareVerifySelection(extensionDir);
    for (const [changed, reason] of OFF) {
      const r = selectVerifyTestsFromContext(offCtx, changed);
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
  // The three config paths fall back BEFORE the graph is consulted (the classifier
  // places them and the selector returns), so their answer does not depend on the
  // other paths in the set — one selection over all three answers all three rows.
  {
    const CONFIG_ROWS = ["agents.json", ".github/workflows/ci.yml", "tsconfig.smoke-tests.json"];
    const cfg = sel(CONFIG_ROWS);
    for (const p of CONFIG_ROWS) {
      // Each row's reason is the first refusal the batch walk reaches, and the
      // classifier's config answer is a table over the path, so a batch that fell
      // back at an earlier row still says nothing about the later ones: those rows
      // ask for their own selection rather than be passed on a borrowed verdict.
      const r = cfg.fallbackReason === `config-file:${p}` ? cfg : sel([p]);
      assert(
        r.mode === "full" && r.fallbackReason === `config-file:${p}` && r.alwaysRun.length > 0,
        `${p} runs the full suite with config-file:${p} and carries the tree's always-run set (got ${r.mode}/${r.fallbackReason ?? "-"})`,
      );
    }
  }
  // The three ON-arm rows this file pins (a docs file, the selector's standing
  // floor, an ignore-like file) are computed HERE, once, and read by every assertion
  // over them. Each of these selections reads and lexes the whole tree — roster and
  // graph — so re-running one per assertion buys no new observation: the answer for a
  // given changed set is fixed for a fixed tree. The floor pair is shared by the docs
  // row and the `.gitignore` row because both compare against the same standing floor.
  const docs = sel(["docs/troubleshooting.md"]);
  const baseline = sel([
    "src/work-driver-verify-literal-trust.ts",
    ".gitignore",
  ]);
  const ign = sel([".gitignore"]);
  const floor = sel(["src/work-driver-verify-literal-trust.ts"]);
  assert(
    docs.mode === "selected" && docs.tests.length > 0,
    `a docs-only change selects rather than falling back (${docs.mode}/${docs.fallbackReason ?? "-"}, ${docs.tests.length} selected)`,
  );
  {
    // The namers are the tests that hold the exact path as a literal — a strict
    // subset of the tests a directory-level membership rule would have pulled in.
    const roster = ctx.roster;
    const namers = roster.names.filter((n) => {
      const l = roster.lexed.get(n);
      return l !== undefined && [...l.strings, ...l.templates].includes("docs/troubleshooting.md");
    });
    assert(
      namers.length > 0 && namers.every((n) => docs.tests.includes(n)),
      `every test that names docs/troubleshooting.md exactly is selected (${namers.length})`,
    );
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
  assert(
    ign.mode === "selected" && ign.alwaysRun.length > 0,
    `an ignore file selects rather than falling back (${ign.mode}/${ign.fallbackReason ?? "-"})`,
  );
  assert(
    ign.tests.every((t) => ign.alwaysRun.includes(t) || floor.tests.includes(t)),
    `.gitignore selects no test outside the always-run set and the selector's standing floor (${ign.tests.length} selected, ${floor.tests.length} in the floor)`,
  );
  assert(
    floor.alwaysRun.length === ign.alwaysRun.length,
    "the always-run half of both selections is the same computed set",
  );
  // A shell helper selects the tests that quote its exact path.
  const loop = sel(["smoke-tests/lib/verify-loop.sh"]);
  assert(
    loop.mode === "selected" && loop.tests.includes("smoke-tests/test-verify-select-hardening.ts"),
    `the verify-loop helper selects the tests that reference it (${loop.mode}/${loop.fallbackReason ?? "-"}, ${loop.tests.length} selected)`,
  );
}
{
  const r = sel([]);
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

// --- a prepared context answers exactly what the directory form answers ----------
// The context is the selector's own read of this tree, so the assertion is between the
// two forms of the same question over the classes the selector answers differently: a
// docs file (literal namers), a TS helper, a src module, configuration, a path the
// table cannot place, and the empty set. A context built under the OFF switch value must
// also keep answering with the OFF rules once the environment has moved on — the
// recorded verdict, not the current one, is what a selection is judged by.
{
  const PATHS = [
    ["docs/troubleshooting.md"],
    ["smoke-tests/lib/adversarial-reviewer-harness.ts"],
    ["src/lean/config.ts"],
    ["agents.json"],
    ["weird/unplaceable.bin"],
    [],
  ];
  const shape = (r: VerifySelection) =>
    JSON.stringify({
      mode: r.mode,
      tests: r.tests,
      alwaysRun: r.alwaysRun,
      fallbackReason: r.fallbackReason ?? null,
    });
  const differ: string[] = [];
  for (const changed of PATHS) {
    const a = shape(selectVerifyTests(extensionDir, changed));
    const b = shape(selectVerifyTestsFromContext(ctx, changed));
    if (a !== b) differ.push(changed[0] ?? "(empty)");
  }
  assert(
    differ.length === 0,
    `a selection through the prepared context returns the same answer as the directory form for every class of path (${PATHS.length} rows)${differ.length ? ` — differs on ${differ.join(", ")}` : ""}`,
  );
  const prior = process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
  process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = "0";
  const offCtx = prepareVerifySelection(extensionDir);
  // Back to the ON value while the off context is still held: the point of the row is
  // that the context answers by the verdict it recorded, not the one the environment
  // carries now.
  process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = undefined;
  try {
    const r = selectVerifyTestsFromContext(offCtx, ["docs/troubleshooting.md"]);
    assert(
      r.mode === "full" && r.fallbackReason === "outside-graph:docs/troubleshooting.md",
      `a context built under the OFF switch keeps answering with the OFF rules after the environment changed (got ${r.mode}/${r.fallbackReason ?? "-"})`,
    );
    const on = selectVerifyTests(extensionDir, ["docs/troubleshooting.md"]);
    assert(
      on.mode === "selected",
      `and the same path selects on a context built under the ON value (got ${on.mode}/${on.fallbackReason ?? "-"}) — the difference is the recorded verdict, not the tree`,
    );
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS;
    else process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS = prior;
  }
}

console.log(exit === 0 ? "\nAll real-tree selection checks passed." : "\nFAILED");
process.exit(exit);

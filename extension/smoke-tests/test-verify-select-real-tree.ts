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
 *
 * The fixture-tree half of that pair — the planted shapes, whose verdict is a
 * selection over a tree this suite built — lives in
 * `test-verify-select-real-tree-fixture.ts`, and the #2649 half that compares the two
 * forms the selector offers lives in `test-verify-select-real-tree-agreement.ts` and its
 * `-b` sibling. What
 * stays here is everything only THIS repository can answer: the roster and graph read
 * from it. The split is by cost as well as by subject: each selection over the real tree
 * reads and lexes ~1,900 files, and the ceiling in #2449 is per file.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { OfflineTests } from "../src/work-driver-verify-offline-tests.ts";
import {
  selectVerifyTestsFromContext,
  prepareVerifySelection,
} from "../src/work-driver-verify-select.ts";
import { assert, exit } from "./lib/assert-rig.ts";

const extensionDir = path.resolve(import.meta.dirname, "..");
/**
 * The whole real tree, read ONCE for every selection this file makes on it.
 *
 * Each `selectVerifyTests(dir, …)` re-reads and re-lexes the tree — ~1,650 test files
 * and ~300 lib files — and this file asks the same question about a dozen changed sets.
 * The tree does not change across those questions, so the answers are the same answers
 * and the reads are the cost worth removing. The OFF-arm rows build their own context
 * inside the switch pin, since a context records the verdict it was read under.
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
    [...sel0.tests, ...sel0.alwaysRun].every((t) => existsSync(path.join(extensionDir, t))),
  "every name a real-tree selection emits exists in that tree",
);

// A second, unrelated src file, so the assertion is not one lucky path.
const sel2 = sel(["src/forge.ts"]);
assert(
  sel2.mode === "selected",
  `a second src-only change selects too (got ${sel2.mode}${sel2.fallbackReason ? `, ${sel2.fallbackReason}` : ""})`,
);

// --- and the policy the ticket DID move, row by row -------------------------
// These rows are what #2649 exists to change. Before it, every one of them
// answered `full` and the develop round ran the whole offline suite; the ticket's
// binding decisions say a docs file, an ignore-like file and a helper each get the
// sound subset, and configuration keeps the full suite under its own reason. The
// PRE-#2649 answers are pinned too, under the switch's off arm — in
// `test-verify-select-real-tree-off-arm.ts`, whose OFF-arm context is a second read of
// this tree and cannot share the one below.
{
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
    // The roster is null only on the OFF arm, which never reaches this block.
    const roster = ctx.roster as OfflineTests;
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

console.log(exit === 0 ? "\nAll real-tree selection checks passed." : "\nFAILED");
process.exit(exit);

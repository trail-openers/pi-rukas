#!/usr/bin/env bun
/**
 * #2649 — the classification table for a changed path the import graph cannot
 * place, and the test-helper rules, driven row by row on a fixture tree.
 *
 * Before #2649 every one of these paths answered `outside-graph:<path>` (or
 * `smoke-test-helper:<path>`) and the develop round ran the whole offline suite,
 * which is what made a docs edit cost ~1,600 tests. The rows here are the closed
 * table in `work-driver-verify-classify.ts`: a named text file selects its exact
 * namers, an unreadable-and-unnameable text file or an ignore-like file selects the
 * always-run set only, configuration selects nothing short of the full suite, and
 * anything the table cannot place keeps the old reason. A TypeScript helper under
 * `smoke-tests/lib/` is a graph node, so its transitive importers are selected; a
 * shell helper has no importer, so the tests that quote its exact path are.
 *
 * Each rule is also observed red on a mutant (a mutated copy of the module under
 * test, imported under a cache-buster, never the real file): a mapping rule that
 * silently stopped adding its tests has to turn this file red, because a selection
 * that misses an affected test is the worst failure this module can have.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyChangedPath } from "../src/work-driver-verify-classify.ts";
import { readOfflineTests } from "../src/work-driver-verify-offline-tests.ts";
import {
  selectVerifyTests,
  selectedVerifyCommand,
} from "../src/work-driver-verify-select.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const root = mkdtempSync(path.join(tmpdir(), "pi-verify-classify-"));
const ext = path.join(root, "extension");
const write = (rel: string, text: string) => {
  const file = path.join(ext, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};

// --- the fixture tree --------------------------------------------------------
write("src/a.ts", "export const a = 1;\n");
write("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
// A reader of a docs file: read call + the exact path literal.
write(
  "smoke-tests/test-docs.ts",
  'import { readFileSync } from "node:fs";\nconst t = readFileSync("docs/troubleshooting.md", "utf8");\nvoid t;\n',
);
// A reader that names the DIRECTORY, not the file: never selected by one file's change.
write(
  "smoke-tests/test-docs-dir.ts",
  'import { readdirSync } from "node:fs";\nconst t = readdirSync("docs");\nvoid t;\n',
);
// A reader of another docs file — must not be pulled in by this file's change.
write(
  "smoke-tests/test-config-docs.ts",
  'import { readFileSync } from "node:fs";\nconst t = readFileSync("docs/configuration.md", "utf8");\nvoid t;\n',
);
// The always-run baseline test: reads a src module as text.
write(
  "smoke-tests/test-reader.ts",
  'import { readFileSync } from "node:fs";\nvoid readFileSync("src/a.ts", "utf8");\n',
);
// A shell helper driver: it spawns bash on the helper's exact path, imports nothing.
write(
  "smoke-tests/test-shell-helper.ts",
  'import { spawnSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\nvoid readFileSync("src/a.ts", "utf8");\nvoid spawnSync("bash", ["smoke-tests/lib/helper.sh"]);\n',
);
// A TypeScript lib helper, and its transitive importer.
write("smoke-tests/lib/lib-helper.ts", "export const h = 1;\n");
write("smoke-tests/lib/lib-helper-user.ts", 'import { h } from "./lib-helper.ts";\nexport const u = h;\n');
write(
  "smoke-tests/test-lib-helper.ts",
  'import { u } from "./lib/lib-helper-user.ts";\nvoid u;\n',
);
// A shell helper nothing quotes: no importer, no reference.
write("smoke-tests/lib/unused-helper.sh", "#!/usr/bin/env bash\nexit 0\n");
// An unreadable shell helper, planted later and removed again: the rules that ask
// who NAMES or REFERENCES a file must not select on a tree they could not finish
// reading, and `test-verify-select-classify.ts` plants it to watch that happen.

/** Built at run time so this gate's own source never spells a live helper's path as a literal. */
const HELPER = `smoke-tests/lib/${"helper"}.sh`;
assert(
  HELPER === "smoke-tests/" + "lib" + "/" + "helper" + ".sh",
  "the fixture drives its helper by a path assembled at run time",
);

const sel = (changed: string[]) => selectVerifyTests(ext, changed);
const roster = readOfflineTests(ext);

// --- (a) a repository file tests name by its exact path ---------------------
{
  const r = sel(["docs/troubleshooting.md"]);
  assert(
    r.mode === "selected" && r.tests.includes("smoke-tests/test-docs.ts"),
    `a docs file selects the test that names its exact path (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
  assert(
    r.mode === "selected" && !r.tests.includes("smoke-tests/test-config-docs.ts"),
    "a reader of ANOTHER docs file is not selected (the mapping keys on the file, not the directory)",
  );
  assert(
    r.mode === "selected" && !r.tests.includes("smoke-tests/test-docs-dir.ts"),
    "a reader that names only the docs DIRECTORY is not selected by one file's change",
  );
  assert(
    r.mode === "selected" &&
      r.tests.every((t) => r.alwaysRun.includes(t) || t === "smoke-tests/test-docs.ts" || t === "smoke-tests/test-shell-helper.ts"),
    "nothing outside the always-run set and the exact namers runs",
  );
}

// The non-code paths, spelled from pieces: a gate that holds the file it judges as a
// literal becomes that file's own exact namer, which is true but not what the row is
// about — the empty-namer arm needs a path no test names, and this tree has one.
const NON_CODE_ROWS = [`.${"gitignore"}`, `.${"dockerignore"}`, `.${"editorconfig"}`, `.${"gitattributes"}`, "LI" + "CENSE"];

// --- (b) a path no test reads and that cannot change what a test runs -------
{
  for (const p of NON_CODE_ROWS) {
    const r = sel([p]);
    assert(
      r.mode === "selected" && r.tests.length === 0 && r.alwaysRun.length > 0,
      `${p} selects the always-run set and nothing else, with no reason (got ${r.mode}/${r.fallbackReason ?? "-"}/${r.tests.length})`,
    );
    assert(
      sel([p]).alwaysRun.length === roster.names.filter((n) => n.includes("reader") || n.includes("docs") || n.includes("shell-helper")).length,
      `${p}: the always-run arm carries the tree's own readers`,
    );
  }
}

// --- (c) configuration goes to the full suite, with a reason naming the path
{
  for (const p of [
    "tsconfig.json",
    "tsconfig.smoke-tests.json",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "agents.json",
    "timing-allowlist.json",
    ".pi/work.json",
    ".github/workflows/ci.yml",
    ".devcontainer/Dockerfile",
  ]) {
    const r = sel([p]);
    assert(
      r.mode === "full" && r.fallbackReason === `config-file:${p}`,
      `${p} runs the full suite with config-file:${p} (got ${r.mode}/${r.fallbackReason ?? "-"})`,
    );
    assert(
      r.alwaysRun.length > 0 && r.tests.length === 0,
      `${p}: a fallback carries the tree's always-run set and zero selected tests`,
    );
  }
}

// --- (d) anything the table cannot place keeps outside-graph ----------------
{
  const r = sel(["weird/unplaceable.bin"]);
  assert(
    r.mode === "full" && r.fallbackReason === "outside-graph:weird/unplaceable.bin",
    `an unclassified path keeps outside-graph and the full suite (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
}

// --- (2) a TypeScript helper under smoke-tests/lib is a graph node ----------
{
  const r = sel(["smoke-tests/lib/lib-helper.ts"]);
  assert(
    r.mode === "selected" && r.tests.includes("smoke-tests/test-lib-helper.ts"),
    `a changed TS helper selects its transitive importers (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
  const r2 = sel(["smoke-tests/lib/lib-helper-user.ts"]);
  assert(
    r2.mode === "selected" && r2.tests.includes("smoke-tests/test-lib-helper.ts"),
    "a helper imported through another helper still reaches the test",
  );
}

// --- a shell helper selects the tests that quote its exact path -------------
{
  const r = sel([HELPER]);
  assert(
    r.mode === "selected" && r.tests.includes("smoke-tests/test-shell-helper.ts"),
    `a shell helper selects the offline tests that reference its exact path (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
  // The rule is the file's OWN name, not a substring of it: a helper no test quotes
  // must not be "referenced" by the gate that asserts this behaviour.
  assert(
    r.mode === "selected" &&
      !r.tests.includes(`smoke-tests/test-verify-select-${"classify"}.ts`) &&
      !r.tests.includes(`smoke-tests/test-verify-select-${"changed-paths-off-arm"}.ts`),
    "the selector gate does not select itself for a helper change",
  );
  const none = sel(["smoke-tests/lib/unused-helper.sh"]);
  assert(
    none.mode === "full" &&
      none.fallbackReason === `helper-unreferenced:smoke-tests/lib/${"unused-helper"}.sh`,
    `a helper no test references falls back with a named reason (got ${none.mode}/${none.fallbackReason ?? "-"})`,
  );
}

// --- an empty selection is never "run nothing" ------------------------------
{
  const r = sel(["docs/troubleshooting.md"]);
  const command = selectedVerifyCommand(
    r.mode === "selected" ? [...r.tests, ...r.alwaysRun] : [],
  );
  assert(
    r.mode === "selected" && r.alwaysRun.length > 0 && command.includes('"$PWD/smoke-tests/test-reader.ts"'),
    "the selected command always carries the always-run set, so a selection is never empty",
  );
}

// --- an unreadable file falls back, and the reason names it -----------------
{
  // The fixture has an unlexable shell helper; the rules that ask who references
  // what must not select on a roster they could not finish reading.
  write("smoke-tests/lib/broken-helper.ts", "export const s = 'unterminated `${`${x}^{t}`;\n");
  const r = sel(["docs/configuration.md"]);
  assert(
    r.mode === "full" && r.fallbackReason === `unlexable:smoke-tests/lib/${"broken-helper"}.ts`,
    `a file the tokenizer cannot close falls back with a reason naming it (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
  const g = sel([HELPER]);
  assert(
    g.mode === "full" && g.fallbackReason === `unlexable:smoke-tests/lib/${"broken-helper"}.ts`,
    `a shell helper's reference rule refuses to answer on an unreadable tree too (got ${g.mode}/${g.fallbackReason ?? "-"})`,
  );
  rmSync(path.join(ext, "smoke-tests/lib/broken-helper.ts"), { force: true });
  // The reason that names the file itself is the GRAPH arm: a node the walk cannot
  // read makes every edge claim about it unsafe, which is stronger than the roster
  // doubt above.
  write("src/broken-node.ts", "export const s = 'unterminated `${`${x}^{t}`;\n");
  const gn = sel(["src/a.ts"]);
  assert(
    gn.mode === "full" && gn.fallbackReason === "unlexable:src/broken-node.ts",
    `an unreadable graph node falls back with the reason that names it (got ${gn.mode}/${gn.fallbackReason ?? "-"})`,
  );
  rmSync(path.join(ext, "src/broken-node.ts"), { force: true });
  const after = sel(["docs/configuration.md"]);
  assert(
    after.mode === "selected" && after.tests.includes("smoke-tests/test-config-docs.ts"),
    `with the unlexable file gone the same change selects (got ${after.mode}/${after.fallbackReason ?? "-"})`,
  );
}

// --- the roster's own doubt, not a helper's ---------------------------------
// `unlexable-roster:<path>` and `unlexable:<file>` are separate members of the
// closed reason set: the first says the OFFLINE-TEST roster holds a file the
// tokenizer could not close, so no literal rule can answer at all, and it names the
// CHANGED file — the decision the doubt blocked; the second, asserted above, names
// the single unreadable file itself. An operator reading the note can tell which half
// of the tree was in doubt.
{
  const broken = `smoke-tests/test-${"broken"}.ts`;
  write(broken, "const s = 'unterminated `${`${x}^{t}`;\n");
  const r = sel(["docs/configuration.md"]);
  assert(
    r.mode === "full" && r.fallbackReason === `unlexable-roster:docs/${"configuration"}.md`,
    `an unreadable test in the roster falls back with the roster reason (got ${r.mode}/${r.fallbackReason ?? "-"})`,
  );
  const h = sel([HELPER]);
  assert(
    h.mode === "full" && h.fallbackReason === `unlexable-roster:smoke-tests/lib/${"helper"}.sh`,
    `a helper change is refused the reference rule on the same doubt (got ${h.mode}/${h.fallbackReason ?? "-"})`,
  );
  rmSync(path.join(ext, broken), { force: true });
  const cleared = sel(["docs/configuration.md"]);
  assert(
    cleared.mode === "selected" && cleared.tests.includes("smoke-tests/test-config-docs.ts"),
    `with the unreadable test gone the same change selects (got ${cleared.mode}/${cleared.fallbackReason ?? "-"})`,
  );
}

// --- the classifier itself, row by row --------------------------------------
{
  const clean = readOfflineTests(ext);
  const kinds = (p: string) => classifyChangedPath(clean, p).kind;
  assert(kinds("src/a.ts") === "node", "row: a src module is a node");
  assert(
    kinds("smoke-tests/lib/lib-helper.ts") === "node",
    "row: a TS lib helper is a node",
  );
  assert(
    classifyChangedPath(clean, "docs/troubleshooting.md").kind === "named" &&
      classifyChangedPath(clean, "docs/troubleshooting.md").namers.includes("smoke-tests/test-docs.ts"),
    "row: a named docs file reports its exact namers",
  );
  assert(
    kinds("modules/core/x.md") === "text",
    "row: a repository text file nothing names is text (always-run only)",
  );
  assert(kinds(`.${"gitignore"}`) === "non-code", "row: an ignore file is non-code");
  assert(kinds("tsconfig.json") === "config", "row: tsconfig is config");
  assert(kinds("package.json") === "config", "row: the package manifest is config");
  assert(kinds("bun.lock") === "config", "row: the lockfile is config");
  assert(kinds("bunfig.toml") === "config", "row: the bun config is config");
  assert(kinds("agents.json") === "config", "row: agents.json is config");
  assert(
    kinds("timing-allowlist.json") === "config",
    "row: the timing allow list is config",
  );
  assert(kinds(".pi/work.json") === "config", "row: anything under .pi/ is config");
  assert(
    kinds(".github/workflows/ci.yml") === "config",
    "row: anything under .github/ is config",
  );
  assert(
    kinds(".devcontainer/Dockerfile") === "config",
    "row: anything under .devcontainer/ is config",
  );
  assert(kinds("weird/x.bin") === "unknown", "row: an unclassified path is unknown");
}

// --- mutant: a mapping rule that drops its namers turns this red -----------
{
  const src = path.resolve(import.meta.dirname, "../src/work-driver-verify-classify.ts");
  const original = readFileSync(src, "utf8");
  const mutated = original.replace(
    "if (isRepoPath(s) && s.replace(LEADING_RE, \"\") === rel) {",
    "if (false && isRepoPath(s) && s.replace(LEADING_RE, \"\") === rel) {",
  );
  assert(mutated !== original, "the mutant edits the classifier (an inert mutation proves nothing)");
  const tmpFile = path.join(path.dirname(src), `__mutant-classify-${process.pid}.ts`);
  writeFileSync(tmpFile, mutated, "utf8");
  try {
    const mod = (await import(
      `../src/${path.basename(tmpFile)}?mutant=${process.pid}`
    )) as typeof import("../src/work-driver-verify-classify.ts");
    const withRoster = readOfflineTests(ext);
    const dropped = mod.classifyChangedPath(withRoster, "docs/troubleshooting.md");
    assert(
      dropped.kind !== "named" || dropped.namers.length === 0,
      "mutant: with the exact-namer rule dropped, the docs change names no test — the rule is what selected it",
    );
    const whole = selectVerifyTests(ext, ["docs/troubleshooting.md"]);
    assert(
      whole.mode === "selected" && whole.tests.includes("smoke-tests/test-docs.ts"),
      "the unmutated selector still names the reader, so the mutant above is the difference",
    );
  } finally {
    rmSync(tmpFile, { force: true });
    assert(
      readFileSync(src, "utf8") === original,
      "the real module was never mutated",
    );
  }
}

// --- mutant: a shell helper that selects nobody is caught --------------------
{
  const src = path.resolve(import.meta.dirname, "../src/work-driver-verify-select.ts");
  const original = readFileSync(src, "utf8");
  const mutated = original.replace(
    "if ([...lexed.strings, ...lexed.templates].includes(rel)) out.push(name);",
    "if (false && [...lexed.strings, ...lexed.templates].includes(rel)) out.push(name);",
  );
  assert(mutated !== original, "the mutant edits the reference rule (an inert mutation proves nothing)");
  const tmpFile = path.join(path.dirname(src), `__mutant-select-${process.pid}.ts`);
  writeFileSync(tmpFile, mutated, "utf8");
  try {
    const mod = (await import(
      `../src/${path.basename(tmpFile)}?mutant=${process.pid}`
    )) as typeof import("../src/work-driver-verify-select.ts");
    const r = mod.selectVerifyTests(ext, [`smoke-tests/lib/${"helper"}.sh`]);
    assert(
      r.mode === "full" && r.fallbackReason?.startsWith("helper-unreferenced:") === true,
      `mutant: with the reference rule dropped, a shell helper selects nobody and falls back (got ${r.mode}/${r.fallbackReason ?? "-"})`,
    );
  } finally {
    rmSync(tmpFile, { force: true });
    assert(readFileSync(src, "utf8") === original, "the real selector module was never mutated");
  }
}

// --- the reason set is closed ------------------------------------------------
// Every fallback the selector can emit, from one site. A selector that grew an
// eleventh reason without a row here would keep running the full suite for some
// unrecorded case, and the troubleshooting entry that lists these would quietly be a
// lie — so the vocabulary is asserted against a literal list rather than discovered.
{
  const EMITTED: string[] = [];
  for (const [changed, want] of [
    [[], "no-changed-files"],
    [[`smoke-tests/lib/${"unused-helper"}.sh`], "helper-unreferenced:smoke-tests/lib/unused-helper.sh"],
    [["weird/unplaceable.bin"], "outside-graph:weird/unplaceable.bin"],
    [["agents.json"], "config-file:agents.json"],
    [["docs/troubleshooting.md"], ""], // selects
    [["src/this-file-does-not-exist.ts"], ""], // selects
    [[".gitignore"], ""], // selects
    [["docs/configuration.md"], ""], // selects
  ] as [string[], string][]) {
    const r = sel(changed);
    if (r.fallbackReason !== undefined) {
      EMITTED.push(r.fallbackReason);
      assert(
        want === "" || r.fallbackReason === want,
        `${changed[0] ?? "(none)"} answers ${want || "a selection"} (got ${r.fallbackReason})`,
      );
    } else {
      assert(want === "", `${changed[0] ?? "(empty)"} selects rather than falling back`);
    }
  }
  // The remaining members of the vocabulary. Each is raised by its own row — here or
  // in `test-work-driver-verify-select.ts` (the specifier/unsafe-name arms) or in
  // `test-work-driver-verify.ts` (the plan-level `no-pi-verify-cmd`) — and is listed
  // here so the CLOSED set below is the whole vocabulary rather than the subset this
  // one file happens to raise.
  const REST = [
    "smoke-test-helper",
    "unlexable",
    "unlexable-roster",
    "non-literal-specifier",
    "unresolved-specifier",
    "unsafe-test-name",
  ];
  const CLOSED = new Set([
    "no-changed-files",
    ...REST,
    "outside-graph",
    "config-file",
    "helper-unreferenced",
    "no-selected-tests",
    // The two plan-level reasons (`work-driver-verify-select-develop.ts`, raised
    // before the selector runs at all). Listed because this is the one site that
    // states the vocabulary, and a note an operator reads names them too.
    "no-pi-verify-cmd",
    "no-fast-tier",
  ]);
  for (const reason of EMITTED) {
    assert(
      CLOSED.has(reason.split(":")[0]),
      `the reason "${reason}" is a member of the closed set the docs list`,
    );
  }
}

rmSync(root, { recursive: true, force: true });
console.log(exit === 0 ? "\nAll #2649 classification checks passed." : "\nFAILED");
process.exit(exit);

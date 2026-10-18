#!/usr/bin/env bun
/**
 * #1647 — the develop verify's test selector (work-driver-verify-select.ts).
 *
 * Every selection rule is driven against a fixture extension tree: a changed
 * module selects the tests that reach it through static imports, re-exports,
 * literal dynamic imports and path literals; a changed test selects itself;
 * anything the graph cannot judge falls back to the full suite with the reason
 * recorded. ALWAYS_RUN is present in every selection.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CycleContext } from "../src/work-driver-context.ts";
import { ALWAYS_RUN } from "../src/work-driver-verify-always-run.ts";
import { planDevelopVerify } from "../src/work-driver-verify-select-develop.ts";
import { edgesOf, selectVerifyTests, selectedVerifyCommand } from "../src/work-driver-verify-select.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const root = mkdtempSync(path.join(tmpdir(), "pi-verify-select-"));
const ext = path.join(root, "extension");
const write = (rel: string, text: string) => {
  const file = path.join(ext, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};

write("src/a.ts", "export const a = 1;\n");
write("src/b.ts", 'import { a } from "./a.ts";\nexport const b = a;\n');
// Multi-line static import and a re-export: both are static edges.
write("src/h.ts", "export const h = 2;\n");
write("src/g.ts", 'export * from "./h.ts";\n');
write("src/c.ts", "export const c = 3;\n");
write("src/d.ts", "export const d = 4;\n");
write("src/orphan.ts", "export const o = 5;\n");
// A module with a non-literal dynamic import, and one that imports it.
write("src/loader.ts", "export async function load(spec: string) {\n  return import(spec);\n}\n");
// A multi-line static import of `leaf`, plus a template-literal dynamic import
// (non-literal), so a change to `leaf` must not trust hub2's edges.
write("src/leaf.ts", "export const leaf = 6;\n");
write(
  "src/hub2.ts",
  'import {\n  leaf,\n} from "./leaf.ts";\nexport async function hub() {\n  return [leaf, await import(`./${"x"}.ts`)];\n}\n',
);
write("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
write("smoke-tests/test-b.ts", 'import { b } from "../src/b.ts";\nvoid b;\n');
write("smoke-tests/test-reexp.ts", 'import { g } from "../src/g.ts";\nvoid g;\n');
write("smoke-tests/test-dyn.ts", 'const m = await import("../src/c.ts");\nvoid m;\n');
write("smoke-tests/test-path.ts", 'const reads = "src/d.ts";\nvoid reads;\n');
write("smoke-tests/test-nonlit.ts", "const name = process.argv[2];\nawait import(name);\n");
write("smoke-tests/test-hub2.ts", 'import { hub } from "../src/hub2.ts";\nvoid hub;\n');
write("smoke-tests/test-unrelated.ts", "export {};\n");
// A template literal that only looks like a dynamic import is a string, not a call.
write(
  "smoke-tests/test-generated.ts",
  'import { c } from "../src/c.ts";\nconst child = `const m = await import(${JSON.stringify(x)});`;\nvoid [c, child];\n',
);

write("src/k.ts", "export const k = 7;\n");
write(
  "smoke-tests/test-comment.ts",
  'import {\n  k, // a comment inside the import list\n} from "../src/k.ts";\nvoid k;\n',
);
const sel = (changed: string[]) => selectVerifyTests(ext, changed);

// --- comments, deletions and path-joined sources ------------------------------
assert(
  sel(["src/k.ts"]).tests.includes("smoke-tests/test-comment.ts"),
  "a comment inside a multi-line import list does not hide the import edge",
);
// A separate tree: a path-joined src reader depends on every src module, which
// would leave no module in the main fixture without a selected test.
const spawnRoot = mkdtempSync(path.join(tmpdir(), "pi-verify-select-spawn-"));
const spawnExt = path.join(spawnRoot, "extension");
mkdirSync(path.join(spawnExt, "src"), { recursive: true });
mkdirSync(path.join(spawnExt, "smoke-tests"), { recursive: true });
writeFileSync(path.join(spawnExt, "src", "q.ts"), "export const q = 8;\n");
writeFileSync(
  path.join(spawnExt, "smoke-tests", "test-spawn.ts"),
  'const file = path.join(ext, "src", "q.ts");\nvoid file;\n',
);
assert(
  selectVerifyTests(spawnExt, ["src/q.ts"]).tests.includes("smoke-tests/test-spawn.ts"),
  "a smoke test that builds a src path with path.join depends on every src module",
);
rmSync(spawnRoot, { recursive: true, force: true });
const deleted = sel(["smoke-tests/test-deleted.ts"]);
assert(
  deleted.mode === "full" && deleted.tests.length === 0 && deleted.fallbackReason?.startsWith("no-selected-tests") === true,
  "a deleted smoke test is not selected (it cannot run); the selection falls back rather than running a missing file",
);

// --- static, re-export, dynamic-literal and path-literal edges ---------------
const a = sel(["src/a.ts"]);
assert(a.mode === "selected", "a changed module with importers selects tests");
assert(
  a.tests.includes("smoke-tests/test-a.ts") && a.tests.includes("smoke-tests/test-b.ts"),
  "static import: the direct importer and its transitive importer are both selected",
);
assert(
  !a.tests.includes("smoke-tests/test-unrelated.ts"),
  "an unrelated test is not selected by a module it does not reach",
);
assert(
  sel(["src/h.ts"]).tests.includes("smoke-tests/test-reexp.ts"),
  "export * from: a re-exported module selects the test that imports the re-exporter",
);
assert(
  sel(["src/c.ts"]).tests.includes("smoke-tests/test-dyn.ts"),
  "literal dynamic import(): the target module selects the importing test",
);
assert(
  sel(["src/d.ts"]).tests.includes("smoke-tests/test-path.ts"),
  "a src/ path string literal in a smoke test selects it",
);
assert(
  sel(["src/c.ts"]).tests.includes("smoke-tests/test-generated.ts"),
  "a static import of a module is selected even beside a template that quotes an import",
);

// --- a changed test selects itself -----------------------------------------
const self = sel(["smoke-tests/test-unrelated.ts"]);
assert(
  self.mode === "selected" && self.tests.includes("smoke-tests/test-unrelated.ts"),
  "a changed or added test file always selects itself",
);

// --- full-suite fallbacks, each with its reason -----------------------------
const helper = sel(["smoke-tests/lib/verify-loop.sh"]);
assert(
  helper.mode === "full" && helper.fallbackReason?.startsWith("smoke-test-helper:") === true,
  "a change under smoke-tests/lib/ falls back to the full suite",
);
const manifest = sel(["agents.json"]);
assert(
  manifest.mode === "full" && manifest.fallbackReason === "outside-graph:agents.json",
  "a file that is not a graph node (agents.json) falls back to the full suite",
);
const prompt = sel(["modules/x.md"]);
assert(
  prompt.mode === "full" && prompt.fallbackReason === "outside-graph:modules/x.md",
  "a markdown module change falls back to the full suite",
);
const orphan = sel(["src/orphan.ts"]);
assert(
  orphan.mode === "full" && orphan.fallbackReason === "no-selected-tests:src/orphan.ts",
  "a module that selects zero tests falls back with no-selected-tests",
);
const loader = sel(["src/loader.ts"]);
assert(
  loader.mode === "full" && loader.fallbackReason === "non-literal-specifier:src/loader.ts",
  "a changed module with a non-literal dynamic import falls back with non-literal-specifier",
);
const hub = sel(["src/leaf.ts"]);
assert(
  hub.mode === "full" && hub.fallbackReason === "non-literal-specifier:src/hub2.ts",
  "a non-literal specifier on the path (hub2 imports leaf) falls back with non-literal-specifier",
);
assert(
  sel([]).mode === "full" && sel([]).fallbackReason === "no-changed-files",
  "an empty change set falls back to the full suite",
);

// --- a non-literal test is always selected, even when unreached -------------
const nonlit = sel(["src/d.ts"]);
assert(
  nonlit.tests.includes("smoke-tests/test-nonlit.ts"),
  "a test with a non-literal dynamic import runs on every selection (its target is unknowable)",
);

// --- ALWAYS_RUN is in every selection --------------------------------------
assert(
  a.alwaysRun.length === ALWAYS_RUN.length && a.alwaysRun.every((t) => ALWAYS_RUN.includes(t)),
  "every selection carries the full ALWAYS_RUN list",
);
const command = selectedVerifyCommand(a.tests);
assert(
  ALWAYS_RUN.every((t) => command.includes(`"$PWD/${t}"`)),
  "the selected command runs every ALWAYS_RUN test",
);
assert(
  command.includes('"$PWD/smoke-tests/test-a.ts"') &&
    command.startsWith("cd extension && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.smoke-tests.json && bash smoke-tests/lib/verify-loop.sh"),
  "the selected command typechecks the smoke tree, then runs verify-loop on the selected tests",
);

// --- edge extraction ----------------------------------------------------------
assert(
  edgesOf("src/x.ts", "// await import(spec)\nconst s = 'import(y)';\n").dynamic === false,
  "a dynamic-import call inside a comment or a string is not a non-literal call",
);
assert(
  edgesOf("src/x.ts", "await import(spec);\n").dynamic === true,
  "a dynamic import through a variable is a non-literal call",
);
assert(
  edgesOf("src/x.ts", "const t = `await import(${spec})`;\n").dynamic === false,
  "a template literal that quotes import(${…}) is a string, not a call",
);
assert(
  edgesOf("smoke-tests/t.ts", 'import x from "./y.js";\n').deps.includes("smoke-tests/y.ts"),
  "a .js specifier resolves to the .ts file it names",
);
assert(
  edgesOf("smoke-tests/t.ts", 'import chalk from "chalk";\n').deps.length === 0,
  "a bare package specifier is not an edge",
);

// --- the develop plan: selected by default, the full command under the escape hatch
const repo = mkdtempSync(path.join(tmpdir(), "pi-verify-select-plan-"));
const planFile = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text, "utf8");
};
planFile(".pi/verify-cmd", "cd extension && echo full-suite\n");
planFile(".pi/verify-cmd-fast", "cd extension && echo fast-tier\n");
planFile("extension/src/a.ts", "export const a = 1;\n");
planFile("extension/smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
// The planner needs only a repo root from the cycle context.
const ctx = { repoRoot: repo } as unknown as CycleContext;
const plan = async (env: string | undefined) => {
  const prior = process.env.PI_ENSEMBLE_VERIFY_SELECT;
  if (env === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT;
  else process.env.PI_ENSEMBLE_VERIFY_SELECT = env;
  try {
    const notes: string[] = [];
    const planned = await planDevelopVerify(
      ctx,
      ["extension/src/a.ts"],
      {},
      undefined,
      () => Promise.resolve({ stdout: "" }),
      notes,
    );
    planned.finish();
    return { cmd: planned.cmd, notes };
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT;
    else process.env.PI_ENSEMBLE_VERIFY_SELECT = prior;
  }
};
const selected = await plan(undefined);
assert(
  selected.cmd?.startsWith("cd extension && node node_modules/typescript/bin/tsc") === true &&
    selected.notes.some((n) => n.startsWith("verify selection ran")),
  "the develop plan runs the selected command for a src change, and says so in its notes",
);
const escaped = await plan("0");
assert(
  escaped.cmd === "cd extension && echo full-suite" &&
    escaped.notes.some((n) => n.includes("PI_ENSEMBLE_VERIFY_SELECT=0")),
  "PI_ENSEMBLE_VERIFY_SELECT=0 restores the full .pi/verify-cmd exactly",
);

rmSync(repo, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
process.exit(exit);

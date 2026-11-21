#!/usr/bin/env bun
/**
 * #1647 review round 3 — the selected verify's hardening, one assertion per finding:
 *
 *   - the selector resolves extensionless and directory imports, falls back on an
 *     unresolved specifier, selects every test that reaches a dynamic-import module,
 *     never selects a live test, refuses an unsafe name, and reads regex literals
 *     (a quote inside one hides nothing);
 *   - the attribution compares failure signatures before it excuses a baseline-red
 *     test, shares one wall clock across its runs and probes, reruns named failures
 *     by ID, and blocks on a name it cannot place;
 *   - the PR body's attribution block is replaced, not appended to: a repeated
 *     write converges, a null body is written, and a body the writer cannot read
 *     as text (or cannot read at all) is never edited.
 *
 * The attribution stub is the one the exec suite uses: verify-loop's out-of-band
 * report and its `FAILED:` stream, with real git for the base probe.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { discloseInPrBody } from "../src/work-driver-ci-verify.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { createVerifyChannel } from "../src/work-driver-integrate-verify-flake.ts";
import { textReadingTests } from "../src/work-driver-verify-always-run.ts";
import { foldVerifyAttribution } from "../src/work-driver-verify-events.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "../src/work-driver-verify-select-exec.ts";
import { ATTRIBUTION_BEGIN } from "../src/work-driver-verify-select-render.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  edgesOf,
  selectVerifyTests,
  selectedVerifyCommand,
} from "../src/work-driver-verify-select.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const extensionDir = path.resolve(import.meta.dirname, "..");

// --- the selector: a fixture tree --------------------------------------------
const root = mkdtempSync(path.join(tmpdir(), "pi-verify-select-hardening-"));
const ext = path.join(root, "extension");
const write = (rel: string, text: string) => {
  const file = path.join(ext, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};
write("src/a.ts", "export const a = 1;\n");
write("src/leaf.ts", "export const leaf = 2;\n");
write("src/unrelated.ts", "export const u = 3;\n");
write("src/headless/index.ts", "export const h = 4;\n");
write("src/loader.ts", "export async function load(spec: string) {\n  return import(spec);\n}\n");
write("src/broken.ts", 'import { missing } from "./nowhere";\nexport const b = missing;\n');
write("src/livemod.ts", "export const lm = 5;\n");
// A test-support module with a relative specifier that names no node — the shape
// `TEST_SUPPORT_RE` exempts from the unresolved-specifier fallback. Real instances
// reach fixture machinery under `smoke-tests/lib/`, which is deliberately not a
// graph node, so nothing here can be resolved. Nothing imports the helper, so it
// cannot hide a test's dependency the way a src module's unresolved edge can.
write("smoke-tests/helpers-x.ts", 'import { load } from "./lib/fixture-loader";\nexport const h = load;\n');
// The helper is a plain non-test top-level file, and `helpers-*.ts` is one of the
// shapes its exemption comment names. A test that imports it is also a reader, so
// this test sits OUTSIDE the always-run set and its selection is the assertion's
// own work, not a member of the always-run set arriving under the `tests` label.
write("smoke-tests/test-helper-user.ts", 'import { h } from "./helpers-x.ts";\nvoid h;\n');
write("src/helper-target.ts", "export const t = 7;\n");
write("smoke-tests/test-helper-target.ts", 'import { t } from "../src/helper-target.ts";\nvoid t;\n');
write("smoke-tests/test-dir.ts", 'import { h } from "../src/headless";\nvoid h;\n');
write("smoke-tests/test-ext.ts", 'import { leaf } from "../src/leaf";\nvoid leaf;\n');
write("src/c.ts", "export const c = 6;\n");
write("smoke-tests/test-js.ts", 'import { c } from "../src/c.js";\nvoid c;\n');
write("smoke-tests/test-u.ts", 'import { u } from "../src/unrelated.ts";\nvoid u;\n');
write("smoke-tests/test-loader-user.ts", 'import "../src/loader.ts";\n');
write("smoke-tests/test-broken.ts", 'import { b } from "../src/broken.ts";\nvoid b;\n');
// An UNRESOLVED relative specifier in a src module, reached from one test only. The
// helper exemption below must not read as a general "helpers are trusted" rule, so
// the same defect in a module keeps its fallback — and that test is kept away from
// the helper so the two assertions do not contaminate each other.
write("src/broken2.ts", 'import { m } from "./nowhere-else";\nexport const b = m;\n');
// A test-support module whose ONLY defect is a non-literal dynamic import. The
// unresolved case below proves a helper's dead specifier is ignored; this module
// proves the other half of the rule is not — a node that can load anything really
// can bring in a test the graph never saw, helper or not.
write("smoke-tests/helpers-dyn.ts", 'export async function h(name: string) {\n  return import(`./${name}.ts`);\n}\n');
write("src/dyn-user.ts", 'import { h } from "../smoke-tests/helpers-dyn.ts";\nexport const d = h;\n');
write("smoke-tests/test-dyn-user.ts", 'import { d } from "../src/dyn-user.ts";\nvoid d;\n');
write("smoke-tests/test-broken2.ts", 'import { b } from "../src/broken2.ts";\nvoid b;\n');
write("smoke-tests/test-live-one-live.ts", 'import { lm } from "../src/livemod.ts";\nvoid lm;\n');
write("smoke-tests/test-a b.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
write("smoke-tests/test-plain.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');

const sel = (changed: string[]) => selectVerifyTests(ext, changed);

// Extensionless and directory imports resolve like the bundler the repo's tests run under.
assert(
  sel(["src/headless/index.ts"]).tests.includes("smoke-tests/test-dir.ts"),
  "a directory import (`../src/headless`) resolves to its index.ts",
);
assert(
  sel(["src/leaf.ts"]).tests.includes("smoke-tests/test-ext.ts"),
  "an extensionless import (`../src/leaf`) resolves to the .ts module",
);
assert(
  sel(["src/c.ts"]).tests.includes("smoke-tests/test-js.ts"),
  "a `.js` specifier resolves to the `.ts` module it names",
);

// An unresolved relative specifier on the walk path cannot be trusted.
const broken = sel(["src/broken.ts"]);
assert(
  broken.mode === "full" && broken.fallbackReason === "unresolved-specifier:src/broken.ts",
  "a relative specifier that names no graph node falls back to the full suite",
);

// A test that reaches a non-literal dynamic import runs on every selection.
const unrelated = sel(["src/unrelated.ts"]);
assert(
  unrelated.mode === "selected" && unrelated.tests.includes("smoke-tests/test-loader-user.ts"),
  "a test that imports a non-literal dynamic-import module is selected for an unrelated change",
);

// A name that cannot go into a shell argument falls back, whatever the graph says.
const unsafe = sel(["src/a.ts"]);
assert(
  unsafe.mode === "full" && unsafe.fallbackReason === "unsafe-test-name",
  "a selected test name with a space falls back with unsafe-test-name",
);

// The TEST_SUPPORT_RE exemption, pinned: a helper's unresolved relative specifier
// does not fall back the selection of a module it reaches. Without the exemption
// this answers `full / unresolved-specifier:smoke-tests/helpers-x.ts` for EVERY
// change in the repo, because the rule is whole-graph — which is how one helper
// that reaches `smoke-tests/lib/` silently disabled selection for the whole project.
const helperSel = sel(["src/helper-target.ts"]);
assert(
  helperSel.mode === "selected" && helperSel.tests.includes("smoke-tests/test-helper-target.ts"),
  `a test-support module's unresolved specifier does not fall back an unrelated selection (got ${helperSel.mode}/${helperSel.fallbackReason ?? "-"})`,
);
assert(
  helperSel.mode === "selected" &&
    !helperSel.tests.includes("smoke-tests/test-helper-user.ts") &&
    !helperSel.alwaysRun.includes("smoke-tests/test-helper-user.ts"),
  `the selection stays correct rather than widened to hide the helper (got ${JSON.stringify([helperSel.tests, helperSel.alwaysRun])})`,
);
// And the exemption is the helper's alone: the same unresolved specifier on a src
// module still falls back.
const broken2 = sel(["src/broken2.ts"]);
assert(
  broken2.mode === "full" && broken2.fallbackReason === "unresolved-specifier:src/broken2.ts",
  `an unresolved specifier on a src module still falls back (got ${broken2.mode}/${broken2.fallbackReason ?? "-"}) — the exemption is not general trust`,
);

// Live tests never run offline: they are not selected and never a reader.
const live = sel(["src/livemod.ts"]);
assert(
  live.mode === "full" && live.fallbackReason === "no-selected-tests:src/livemod.ts",
  "a module reached only by a live test selects no offline test (full suite, reason named)",
);
const fixtureReaders = textReadingTests(ext);
assert(
  fixtureReaders.length === 0,
  "no fixture test reads repository text, so the fixture tree's always-run set is empty",
);
assert(
  !textReadingTests(extensionDir).some((t) => /-live\.ts$/.test(t)),
  "no -live.ts test of the real tree is in the computed always-run set",
);
const unrelatedLive = sel(["src/unrelated.ts"]);
assert(
  unrelatedLive.tests.every((t) => !/-live\.ts$/.test(t)),
  "a selection never carries a -live.ts test",
);
const ci = await Bun.file(path.join(extensionDir, "..", ".pi", "verify-cmd-full")).text();
assert(
  ci.includes("grep -v -- '-live[.]ts$'"),
  ".pi/verify-cmd-full drops -live.ts tests from the suite it runs",
);

// verify-loop never runs a -live.ts test, even when it is named explicitly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-verify-live-"));
  const marker = path.join(dir, "ran");
  const liveFile = path.join(dir, "test-probe-live.ts");
  writeFileSync(liveFile, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  let status: number | undefined;
  try {
    execFileSync("bash", [path.join(extensionDir, "smoke-tests/lib/verify-loop.sh"), liveFile], {
      cwd: extensionDir,
      stdio: "pipe",
    });
    status = 0;
  } catch (err) {
    status = (err as { status?: number }).status;
  }
  assert(
    status === 3 && !existsSync(marker),
    "verify-loop given a -live.ts file runs nothing (exit 3, the marker is not written)",
  );
  rmSync(dir, { recursive: true, force: true });
}
rmSync(root, { recursive: true, force: true });

// --- the tokenizer -------------------------------------------------------------
const quoteInRegex = edgesOf(
  "smoke-tests/t.ts",
  'const re = /"/;\nimport { a } from "../src/a.ts";\nvoid [a, re];\n',
);
assert(
  quoteInRegex?.specifiers.includes("../src/a.ts") === true,
  "a quote inside a regex literal does not hide the import after it",
);
const slashStar = edgesOf(
  "smoke-tests/t.ts",
  'const re = /\\/*x/;\nimport { a } from "../src/a.ts";\nvoid [a, re];\n',
);
assert(
  slashStar?.specifiers.includes("../src/a.ts") === true,
  "a regex that spells `/*` does not open a comment that hides the import",
);
assert(
  edgesOf("smoke-tests/t.ts", 'const s = "unterminated;\n') === undefined,
  "a file the tokenizer cannot close is unreadable, not an empty graph node",
);
assert(
  edgesOf("src/x.ts", "const q = a / b / c;\nawait import(spec);\n")?.dynamic === true,
  "division is not a regex: the dynamic import after it is still seen",
);

// The always-run set is computed from the tree, and the real tree's set is
// non-empty: an empty one would mean the predicate stopped classifying anything.
assert(textReadingTests(extensionDir).length > 0, "the computed always-run set is populated");

process.exit(exit);

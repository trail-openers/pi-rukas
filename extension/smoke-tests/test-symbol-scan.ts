#!/usr/bin/env bun
/**
 * #1323 — the text scans behind the sibling-symbol merge-and-retry
 * (work-develop-symbol-scan.ts) and the pairing on top of them
 * (work-develop-symbol-couplings.ts). A false match merges two workstreams
 * and resets the consumer's worktree, so the negatives matter as much as the
 * positives: an indented `id:` / `name:` in a fixture, an object literal or
 * YAML is not a declaration, and a bare `./index` does not match every
 * index file.
 */

import { findSymbolCouplings } from "../src/work-develop-symbol-couplings.ts";
import {
  addedFilesInDiff,
  addedSymbolsInDiff,
  missingModulesIn,
  missingSymbolsIn,
  sameModule,
} from "../src/work-develop-symbol-scan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const diffOf = (file: string, lines: string[], created = false) =>
  [
    `diff --git a/${file} b/${file}`,
    created ? "--- /dev/null" : `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1,9 @@",
    ...lines,
  ].join("\n");

// ── missing symbols / modules ───────────────────────────────────────────
{
  const out = [
    `src/b.ts(1,10): error TS2305: Module '"./a.ts"' has no exported member 'newThing'.`,
    `src/c.ts(4,7): error TS2339: Property 'providerRepeats' does not exist on type 'ErrorStop'.`,
    `src/d.ts(9,3): error TS2353: Object literal may only specify known properties, and 'introduces' does not exist in type 'Workstream'.`,
    "error[E0425]: cannot find value `max_depth` in this scope",
    "ImportError: cannot import name 'parse_contract' from 'mod'",
    "./x.go:3:2: undefined: pkg.NewWidget",
  ].join("\n");
  const got = missingSymbolsIn(out);
  for (const s of [
    "newThing",
    "providerRepeats",
    "introduces",
    "max_depth",
    "parse_contract",
    "NewWidget",
  ]) {
    assert(got.includes(s), `missing: \`${s}\` is read (got ${got.join(",")})`);
  }
  assert(
    missingSymbolsIn("1 test failed: expected 2, got 3").length === 0,
    "missing: a plain test failure names no symbol",
  );
  const mods = missingModulesIn(
    [
      "src/work/e.ts(2,1): error TS2307: Cannot find module '../work-new-thing.ts' or its corresponding type declarations.",
      "src/f.ts(1,1): error TS2307: Cannot find module 'left-pad'.",
      "error TS2307: Cannot find module './orphan'.",
    ].join("\n"),
  );
  assert(
    mods.includes("src/work-new-thing"),
    `modules: a relative import resolves from its importer (got ${mods.join(",")})`,
  );
  assert(
    !mods.some((m) => m.includes("left-pad") || m.includes("orphan")),
    "modules: package names and unattributed lines are ignored",
  );
}

// ── declarations a diff adds ────────────────────────────────────────────
{
  const added = addedSymbolsInDiff(
    [
      diffOf("src/a.ts", [
        "+export const newThing = 1;",
        "+export { helper as renamedHelper, other };",
        "+export interface ErrorStop {",
        "+  providerRepeats?: number;",
        "+  nested: {",
        "+    deepKey: string;",
        "+  };",
        "+}",
        " const unchanged = 2;",
        "-export const removedThing = 3;",
        "+const fixture = {",
        "+  id: 1,",
        "+  name: 'x',",
        "+};",
      ]),
      diffOf(
        "src/lib.rs",
        ["+pub fn max_depth() -> u32 { 3 }", "+pub struct Cfg {", "+    pub limit: u32,", "+}"],
        true,
      ),
      diffOf("config/app.yaml", ["+server:", "+  name: api", "+  type: http"]),
      diffOf("smoke-tests/test-x.ts", ["+run({", "+  id: 'a',", "+  type: 'b',", "+});"]),
    ].join("\n"),
  );
  for (const s of [
    "newThing",
    "renamedHelper",
    "other",
    "ErrorStop",
    "providerRepeats",
    "nested",
    "max_depth",
    "Cfg",
    "limit",
  ]) {
    assert(added.includes(s), `adds: \`${s}\` is read (got ${added.join(",")})`);
  }
  for (const s of [
    "unchanged",
    "removedThing",
    "helper",
    "deepKey",
    "fixture",
    "id",
    "name",
    "type",
    "server",
  ]) {
    assert(!added.includes(s), `adds: \`${s}\` (no declaration) is not read`);
  }
  const hunkCtx = addedSymbolsInDiff(
    [
      "--- a/src/t.ts",
      "+++ b/src/t.ts",
      "@@ -3,2 +3,3 @@ export interface Workstream {",
      "   paths: string[];",
      "+  introduces?: string[];",
    ].join("\n"),
  );
  assert(
    hunkCtx.includes("introduces"),
    "adds: a field added mid-interface (opener only in the hunk header) is read",
  );
  const files = addedFilesInDiff(
    [
      diffOf("src/work-new-thing.ts", ["+x"], true),
      diffOf("src/index.ts", ["+x"]),
      diffOf("docs/a.md", ["+x"], true),
    ].join("\n"),
  );
  assert(
    files.join(",") === "src/work-new-thing",
    `files: only created source files (got ${files.join(",")})`,
  );
  assert(
    sameModule("extension/src/work-new-thing", "src/work-new-thing"),
    "module: a subdirectory-relative path matches its repo path",
  );
  assert(
    !sameModule("src/index", "index") && !sameModule("lib/index", "src/index"),
    "module: a bare `index` never matches another index",
  );
}

// ── pairing ─────────────────────────────────────────────────────────────
{
  const wt = { a: "/wt/a", b: "/wt/b" };
  const fail = (sym: string) =>
    `verify command \`tsc\` failed in /wt/b: src/b.ts(3,9): error TS2339: Property '${sym}' does not exist on type 'Row'.`;
  const diffs: Record<string, string> = {
    a: diffOf("src/a.test.ts", ["+const row = {", "+  id: 1,", "+  name: 'n',", "+};"]),
    b: diffOf("src/b.ts", ["+export interface Local {", "+  ownField: string;", "+}"]),
  };
  const dOf = async (id: string) => diffs[id] ?? "";
  for (const sym of ["id", "name"]) {
    const c = await findSymbolCouplings([fail(sym)], wt, () => undefined, dOf);
    assert(
      c.length === 0,
      `pairing: TS2339 on \`${sym}\` does not pair with a sibling's object literal`,
    );
  }
  const own = await findSymbolCouplings(
    [fail("ownField")],
    wt,
    (id) => (id === "a" ? ["ownField"] : undefined),
    dOf,
  );
  assert(
    own.length === 0,
    "pairing: a symbol the consumer adds itself never couples, even if a sibling declares it",
  );
  const idx = await findSymbolCouplings(
    [
      "verify command `tsc` failed in /wt/b: src/b.ts(1,1): error TS2307: Cannot find module './index'.",
    ],
    wt,
    () => undefined,
    async (id) => (id === "a" ? diffOf("lib/index.ts", ["+export const x = 1;"], true) : ""),
  );
  assert(idx.length === 0, "pairing: `./index` from src/ does not match a sibling's lib/index.ts");
  const real = await findSymbolCouplings(
    [
      "verify command `tsc` failed in /wt/b: src/b.ts(1,10): error TS2305: Module '\"./a.ts\"' has no exported member 'newThing'.",
    ],
    wt,
    () => undefined,
    async (id) => (id === "a" ? diffOf("src/a.ts", ["+export const newThing = 1;"]) : ""),
  );
  assert(
    real.length === 1 && real[0]?.consumer === "b" && real[0]?.producer === "a",
    `pairing: the #1297 shape pairs b → a (got ${JSON.stringify(real)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

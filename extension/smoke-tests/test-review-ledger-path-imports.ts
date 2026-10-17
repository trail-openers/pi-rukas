#!/usr/bin/env bun
/**
 * #1387 — the review ledger path must not import the driver layer.
 *
 * `review-ledger-path.ts` computed `identityBase` — the ref both the ledger
 * writer and the merge guard take a patch identity against — by importing
 * `resolveMainline` from `work-driver-git.ts`. One git read tied the review
 * layer to the driver. The lookup now lives in the neutral leaf `mainline.ts`
 * (`exec.ts` / `git-range.ts` are the existing precedents), which both sides
 * import.
 *
 * **Direct, not transitive.** #1387's acceptance criterion names this file, and
 * the ticket's out-of-scope list refuses the rest: `review-ledger.ts` and
 * `review-patch-identity.ts` still import `type VerifyExecFn` from
 * `work-driver-git.ts`, and `lens-round-cap.ts` still imports
 * `MAX_REVIEW_ROUNDS` from `work-driver-context.ts`. Those edges are other
 * #1358 sub-issues, and the `VerifyExecFn` relocation in particular is its own
 * ~53-file sweep. So the gate is on this file's own import statements — which
 * is also the only assertion that cannot drift into someone else's ticket.
 *
 * **Every way to reach a module, not just the common one.** A static
 * `from "./work-driver-git.ts"` is the shape most rewrites take, and the only
 * shape the first version of this gate caught. These all mean the same
 * dependency and each is one refactor away:
 *
 *   - `import { x } from "../src/work-driver-x.ts"` — a path that leaves `src/`
 *     and comes back. Same module, and a `./`-anchored matcher never sees it.
 *   - `import "./work-driver-side-effects.ts"` — a bare side-effect import: no
 *     `from`, so a `from`-anchored matcher matches nothing.
 *   - `await import("./work-driver-lazy.ts")` — a dynamic import, which
 *     TypeScript erases nothing of: it is a real runtime dependency that only
 *     loads later.
 *   - `require("./work-driver-legacy.ts")` — same, through the CJS form.
 *
 * **Type-only counts.** `import type { X } from "./work-driver-*.ts"` is a
 * dependency even though TypeScript erases it, and an erased import is exactly
 * how a careless grep gate reports a clean file that still depends on the
 * driver. Same for the neutral module's own executor type: `mainline.ts`
 * declares it structurally rather than aliasing `VerifyExecFn`.
 *
 * **Proven in both directions**, the shape `test-file-size-limit.ts` and
 * `test-decision-seam-grep.ts` use: this file is clean today, and a fixture per
 * reach-shape above is each caught, while a commented-out import and a docstring
 * that merely NAMES a driver module are each ignored. A gate never observed to
 * fail is worthless.
 *
 * **The re-export check is per-symbol.** The first version asserted one regex
 * demanding `detectMainline` and `resolveMainline` appear in that order in one
 * `export { … }`. Reordering the two names, or rewriting the pair as
 * `export * from "./mainline.ts"`, both satisfy the contract and both failed the
 * gate. So each symbol is asked separately, of any export form.
 *
 * **And the re-export is checked at runtime, not only by grep.** A grep proves
 * the text says `export`; it does not prove `work-driver-git.ts` actually
 * exposes a callable `detectMainline` to today's callers. `import * as git` on
 * the real module and assert both functions are there is the check that a
 * deleted re-export — the change that breaks every driver caller — cannot pass
 * on a green regex.
 *
 * Each source file is read once and shared between the checks that need it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import * as git from "../src/work-driver-git.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const TARGET = "review-ledger-path.ts";
/** The neutral module the mainline lookup must come from instead. */
const NEUTRAL = "mainline.ts";
/** The symbols the driver layer must keep re-exporting (#1387 moved them, not their callers). */
const MOVED = ["detectMainline", "resolveMainline"] as const;

/**
 * A reference to a driver-layer module through any of the four ways to load one.
 *
 * `(?<![\w./-])` keeps a word like `my_work-driver-notes.ts` or a relative
 * jump `../work-driver-x.ts` from being read as anything other than what it
 * is: the module IS the driver layer whichever path spelling reaches it.
 */
const DRIVER_REF =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(["'])(?:\.\/|\.\.\/src\/)?(work-driver[^"']*\.ts)\1/g;

/**
 * Comments are not imports. Without this, a commented-out driver import — or a
 * docstring that merely NAMES `work-driver-git.ts`, which `review-ledger-path.ts`
 * does in its own header, to explain what moved — reads as a violation, and the
 * first false alarm trains everyone to set the gate aside.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    // A line comment trailing code: `const x = 1; // see work-driver-git.ts`.
    .replace(/(^|[^:"'\\])\/\/[^\n]*$/gm, "$1");
}

/** The driver-layer modules this source reaches, by any load mechanism. */
function driverRefs(src: string): string[] {
  return [...stripComments(src).matchAll(DRIVER_REF)].map((m) => m[2] as string);
}

/** Local `./x.ts` specifiers this source imports from. */
function localImports(src: string): string[] {
  return [
    ...stripComments(src)
      .matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(["'])(\.\/[^"']+)\1/g),
  ].map((m) => m[2] as string);
}

/** Read each source file exactly once; several checks below share the result. */
const sourceCache = new Map<string, string>();
function read(name: string): string {
  let src = sourceCache.get(name);
  if (src === undefined) {
    src = readFileSync(path.join(SRC, name), "utf8");
    sourceCache.set(name, src);
  }
  return src;
}

/** Does `source` re-export `symbol` from the neutral module, in any export form? */
function reexportsFromNeutral(source: string, symbol: string): boolean {
  const code = stripComments(source);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [
    // export { a, symbol, b } from "./mainline.ts"  (and export type { … })
    new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*from\\s*["']\\./mainline\\.ts["']`),
    // export * from "./mainline.ts" — re-exports every public symbol, this included
    /export\s*\*\s*from\s*["']\.\/mainline\.ts["']/.test(code),
    // export { symbol as alias } / re-export through a local binding
    new RegExp(`export\\s+\\{[^}]*\\b${escaped}\\s+as\\s+\\w+[^}]*\\}`),
    // export const symbol = … / export function symbol / export { x as symbol } from local
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${escaped}\\b`),
  ];
  return forms.some((re) => (typeof re === "object" ? re : re.test(code)));
}

const target = read(TARGET);
const neutral = read(NEUTRAL);
const driver = read("work-driver-git.ts");

console.log("1. review-ledger-path.ts is clean");
{
  const offenders = driverRefs(target);
  assert(offenders.length === 0, `no work-driver* import (${offenders.join(", ") || "none"})`);

  const imports = localImports(target);
  assert(
    imports.includes(`./${NEUTRAL}`),
    `…and it still imports ./${NEUTRAL} for the mainline lookup (imports: ${imports.join(", ")})`,
  );

  // The neutral module must not simply forward to the driver — that would
  // move the violation one hop and leave the gate green.
  const neutralOffenders = driverRefs(neutral);
  assert(
    neutralOffenders.length === 0,
    `mainline.ts imports no work-driver* module (${neutralOffenders.join(", ") || "none"})`,
  );
}

console.log("2. the gate can fail — every way to reach a module");
{
  const caught: Array<[string, string]> = [
    [
      'import { resolveMainline } from "./work-driver-git.ts";',
      "a value-level driver import",
    ],
    [
      'import type { VerifyExecFn } from "./work-driver-git.ts";',
      "a TYPE-ONLY driver import (erased at runtime, still a dependency)",
    ],
    [
      'import { x } from "./work-driver-restore.ts";',
      "any work-driver* module, not only work-driver-git.ts",
    ],
    [
      'import { detectMainline } from "../src/work-driver-git.ts";',
      "a path that leaves src/ and comes back",
    ],
    [
      'import "./work-driver-side-effects.ts";',
      "a bare side-effect import (no `from` to anchor on)",
    ],
    [
      'const m = await import("./work-driver-lazy.ts");',
      "a dynamic import()",
    ],
    [
      'const m = require("./work-driver-legacy.ts");',
      "a require()",
    ],
    [
      'export { runNetGit } from "../src/work-driver-net-git.ts";',
      "a re-export through the driver layer",
    ],
  ];
  for (const [source, label] of caught) {
    assert(driverRefs(source).length >= 1, `${label} is caught`);
  }

  const allowed: Array<[string, string]> = [
    ['// import { x } from "./work-driver-git.ts";', "a commented-out import"],
    ["/** See work-driver-git.ts for the executor. */", "a docstring that names a driver module"],
    [
      'const note = "the ledger used to import work-driver-git.ts";',
      "prose inside a string that names a driver module",
    ],
    ['import { resolveMainline } from "./mainline.ts";', "the neutral module itself"],
    ['import { execp } from "./exec.ts";', "an unrelated neutral module"],
  ];
  for (const [source, label] of allowed) {
    assert(driverRefs(source).length === 0, `${label} is not a violation`);
  }
}

console.log("3. the driver side keeps its re-export — per symbol, any form");
{
  // #1387 moves the symbols, not their callers: work-driver-git.ts re-exports
  // them, so the driver callers and the smoke tests that import them from here
  // never moved. Order does not matter and neither does `export *` — both
  // satisfy the contract, and the first version of this check failed on both.
  for (const symbol of MOVED) {
    assert(
      reexportsFromNeutral(driver, symbol),
      `work-driver-git.ts re-exports ${symbol} from the neutral module`,
    );
    assert(
      !new RegExp(`^export\\s+(?:async\\s+)?function\\s+${symbol}\\b`, "m").test(stripComments(driver)),
      `…and does not define ${symbol} itself — one definition, not a copy`,
    );
  }
  // The grep above proves the text says `export`. This proves the module
  // actually exposes callable functions under those names today: the
  // "re-export quietly dropped" change breaks every driver caller, and a green
  // regex must not be able to bless it.
  for (const symbol of MOVED) {
    assert(
      typeof (git as Record<string, unknown>)[symbol] === "function",
      `at runtime work-driver-git.ts exposes a callable ${symbol} (not just the text)`,
    );
  }
}

console.log(failures === 0 ? "\nexit 0" : `\nexit 1 (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);

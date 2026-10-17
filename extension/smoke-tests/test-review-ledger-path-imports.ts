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
  // Failures go to STDERR. The verify-loop's digest mode (`lib/ci-log-digest.sh`
  // / `verify-loop.sh --digest`) reads stderr for the failure lines, so a gate
  // that prints its `✗` lines to stdout reports a green suite with a red body.
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
/**
 * Every review-layer file that must reach the mainline through the neutral
 * leaf rather than the driver. `review-ledger-path.ts` is #1387's own move;
 * `review-delta-hunks.ts` came in round 3 of #1444 — it resolved the delta base
 * with `detectMainline` from `work-driver-git.ts` for the same single git read,
 * and a gate that names one file blesses the other's edge by omission.
 */
const TARGETS = ["review-ledger-path.ts", "review-delta-hunks.ts"];
/** The neutral module the mainline lookup must come from instead. */
const NEUTRAL = "mainline.ts";
/**
 * The sanitiser leaf `mainline.ts` delegates its failure text to (#1444 r4 —
 * it moved out when the probe's cause rules grew past the file-size cap). It
 * is one hop further along the same edge, so the same rule applies to it: a
 * leaf that forwards to the driver would move the violation one hop and leave
 * this gate green.
 */
const NEUTRAL_LEAF = "probe-cause.ts";
/** The symbols the driver layer must keep re-exporting (#1387 moved them, not their callers). */
const MOVED = ["detectMainline", "resolveMainline"] as const;

/**
 * A reference to a driver-layer module through any of the four ways to load one.
 *
 * **Anchored on the basename, not on a known prefix.** The first version
 * matched `(?:\.\/|\.\.\/src\/)?` before `work-driver` — which caught `./` and
 * `../src/` and MISSED a plain `"../work-driver-git.ts"`, the spelling any
 * relative rewrite reaches for. Anchoring instead on the last path separator
 * before the basename (`(?:[^"']*\/)?` inside the quotes) makes every prefix
 * spelling the same violation: `./`, `../`, `../src/`, `../../src/` and a bare
 * `work-driver-x.ts` all match, and a name that merely ENDS in the basename
 * (`./my-work-driver-git.ts`) still does not, because the separator (or the
 * opening quote) sits immediately before `work-driver`.
 */
const DRIVER_REF =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(["'])(?:[^"']*\/)?work-driver[^"']*\.ts\1/g;

/**
 * Comments are not imports. Without this, a commented-out driver import — or a
 * docstring that merely NAMES `work-driver-git.ts`, which `review-ledger-path.ts`
 * does in its own header, to explain what moved — reads as a violation, and the
 * first false alarm trains everyone to set the gate aside.
 */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ")
      // A line comment trailing code: `const x = 1; // see work-driver-git.ts`.
      .replace(/(^|[^:"'\\])\/\/[^\n]*$/gm, "$1")
  );
}

/** The driver-layer modules this source reaches, by any load mechanism. */
const driverRefs = (src: string): string[] =>
  [...stripComments(src).matchAll(DRIVER_REF)].map(
    (m) => (m[1] as string).split("/").pop() as string,
  );

/** Local `./x.ts` specifiers this source imports from. */
function localImports(src: string): string[] {
  return [
    ...stripComments(src).matchAll(
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(["'])(\.\/[^"']+)\1/g,
    ),
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
    new RegExp(
      `export\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*from\\s*["']\\./mainline\\.ts["']`,
    ),
    // export * from "./mainline.ts" — re-exports every public symbol, this included
    /export\s*\*\s*from\s*["']\.\/mainline\.ts["']/.test(code),
    // export { symbol as alias } / re-export through a local binding
    new RegExp(`export\\s+\\{[^}]*\\b${escaped}\\s+as\\s+\\w+[^}]*\\}`),
    // export const symbol = … / export function symbol / export { x as symbol } from local
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${escaped}\\b`),
  ];
  return forms.some((re) => (typeof re === "object" ? re : re.test(code)));
}

const neutral = read(NEUTRAL);
const driver = read("work-driver-git.ts");

console.log("1. the review-layer targets are clean");
{
  // The mainline lookup every review-layer file takes must come from the
  // neutral leaf. Each target is checked for both halves of the contract: no
  // driver reference at all, and a positive import of `./mainline.ts` — a file
  // that simply dropped the driver import and got its mainline from somewhere
  // else would otherwise pass on absence alone.
  const expectedImport = `./${NEUTRAL}`;
  for (const target of TARGETS) {
    const src = read(target);
    const offenders = driverRefs(src);
    assert(
      offenders.length === 0,
      `${target}: no work-driver* import (${offenders.join(", ") || "none"})`,
    );
    const imports = localImports(src);
    assert(
      imports.includes(expectedImport),
      `…${target} still imports ${expectedImport} for the mainline lookup (imports: ${imports.join(", ")})`,
    );
  }

  // The neutral module must not simply forward to the driver — that would
  // move the violation one hop and leave the gate green. Same for the leaf it
  // delegates the failure text to, which is one hop further out.
  const neutralOffenders = driverRefs(neutral);
  assert(
    neutralOffenders.length === 0,
    `mainline.ts imports no work-driver* module (${neutralOffenders.join(", ") || "none"})`,
  );
  const leafOffenders = driverRefs(read(NEUTRAL_LEAF));
  assert(
    leafOffenders.length === 0,
    `${NEUTRAL_LEAF} imports no work-driver* module (${leafOffenders.join(", ") || "none"})`,
  );
  // …and `mainline.ts` must reach it, not reimplement the sanitiser in place:
  // the executor type and the cause text both live in the leaf now, and a
  // second copy of either is the drift this split exists to prevent.
  assert(
    localImports(neutral).includes(`./${NEUTRAL_LEAF}`),
    `mainline.ts imports ./${NEUTRAL_LEAF} for the probe cause and executor type`,
  );
}

console.log("2. the gate can fail — every way to reach a module");
{
  const caught: Array<[string, string]> = [
    ['import { resolveMainline } from "./work-driver-git.ts";', "a value-level driver import"],
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
    // #1444 round 3: the old pattern's prefix group matched only `./` and
    // `../src/`, so a plain `../work-driver-git.ts` — the spelling a file in a
    // subdirectory or a sibling-layer rewrite reaches for — slipped through.
    // The rule is anchored on the basename now, which makes every `…/` prefix
    // the same violation.
    ['import { x } from "../work-driver-git.ts";', "a bare ../ path with no src/ segment"],
    [
      'import { x } from "../../src/work-driver-git.ts";',
      "a ../../src/ path from one level deeper",
    ],
    [
      'import "./work-driver-side-effects.ts";',
      "a bare side-effect import (no `from` to anchor on)",
    ],
    ['const m = await import("./work-driver-lazy.ts");', "a dynamic import()"],
    ['const m = require("./work-driver-legacy.ts");', "a require()"],
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
    // Adjacent-name hygiene: the basename anchor must not sweep in a module
    // whose name merely ends with the driver's.
    ['import { x } from "./my-work-driver-git.ts";', "a non-driver module ending in the basename"],
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
      !new RegExp(`^export\\s+(?:async\\s+)?function\\s+${symbol}\\b`, "m").test(
        stripComments(driver),
      ),
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

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
 * **Type-only counts.** `import type { X } from "./work-driver-*.ts"` is a
 * dependency even though TypeScript erases it, and an erased import is exactly
 * how a careless grep gate reports a clean file that still depends on the
 * driver. Same for the neutral module's own executor type: `mainline.ts`
 * declares it structurally rather than aliasing `VerifyExecFn`.
 *
 * **Proven in both directions**, the shape `test-file-size-limit.ts` and
 * `test-decision-seam-grep.ts` use: this file is clean today, and fixtures
 * carrying a value-level import, a type-only import and a commented-out
 * import are each handled — caught, caught, ignored. A gate never observed to
 * fail is worthless.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

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
/** Any import statement whose local specifier names the driver layer. */
const DRIVER_IMPORT = /from\s+["']\.\/(work-driver[^"']*\.ts)["']/g;

/**
 * Comments are not imports. Without this, a commented-out driver import — or a
 * docstring that merely NAMES `work-driver-git.ts`, which `review-ledger-path.ts`
 * does in its own header, to explain what moved — reads as a violation, and the
 * first false alarm trains everyone to set the gate aside.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The driver-layer modules this source imports, value-level or type-only. */
function driverImports(src: string): string[] {
  return [...stripComments(src).matchAll(DRIVER_IMPORT)].map((m) => m[1] as string);
}

const read = (name: string) => readFileSync(path.join(SRC, name), "utf8");

console.log("1. review-ledger-path.ts is clean");
{
  const offenders = driverImports(read(TARGET));
  assert(offenders.length === 0, `no work-driver* import (${offenders.join(", ") || "none"})`);

  const imports = [...stripComments(read(TARGET)).matchAll(/from\s+["'](\.\/[^"']+)["']/g)].map(
    (m) => m[1] as string,
  );
  assert(
    imports.includes(`./${NEUTRAL}`),
    `…and it still imports ./${NEUTRAL} for the mainline lookup (imports: ${imports.join(", ")})`,
  );

  // The neutral module must not simply forward to the driver — that would
  // move the violation one hop and leave the gate green.
  const neutral = driverImports(read(NEUTRAL));
  assert(neutral.length === 0, `mainline.ts imports no work-driver* module (${neutral.join(", ") || "none"})`);
}

console.log("2. the gate can fail");
{
  assert(
    driverImports(`import { resolveMainline } from "./work-driver-git.ts";`).length === 1,
    "a value-level driver import is caught",
  );
  assert(
    driverImports(`import type { VerifyExecFn } from "./work-driver-git.ts";`).length === 1,
    "a TYPE-ONLY driver import is caught too (erased at runtime, still a dependency)",
  );
  assert(
    driverImports(`import { x } from "./work-driver-restore.ts";`).length === 1,
    "any work-driver* module is caught, not only work-driver-git.ts",
  );
  assert(
    driverImports(`// import { x } from "./work-driver-git.ts";`).length === 0,
    "a commented-out import is not a violation",
  );
  assert(
    driverImports(`/** See work-driver-git.ts for the executor. */`).length === 0,
    "a docstring that names a driver module is not a violation",
  );
  assert(
    driverImports(`import { resolveMainline } from "./mainline.ts";`).length === 0,
    "the neutral module is not itself a violation",
  );
}

console.log("3. the driver side keeps its imports unchanged");
{
  // #1387 moves the symbols, not their callers: work-driver-git.ts re-exports
  // them, so the driver callers and the smoke tests that import them from here
  // never moved. If the re-export is dropped, every one of them breaks — and
  // this fails first, naming why.
  const driver = stripComments(read("work-driver-git.ts"));
  assert(
    /export\s+\{[^}]*detectMainline[^}]*resolveMainline[^}]*\}\s+from\s+["']\.\/mainline\.ts["']/.test(
      driver,
    ),
    "work-driver-git.ts re-exports both symbols from the neutral module",
  );
  assert(
    !/^export async function (detectMainline|resolveMainline)/m.test(driver),
    "…and does not define them itself — one definition, not a copy",
  );
}

console.log(failures === 0 ? "\nexit 0" : `\nexit 1 (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);

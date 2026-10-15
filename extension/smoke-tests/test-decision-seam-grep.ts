#!/usr/bin/env bun
/**
 * Only the decision backends call a model for a decision (#1308, operator
 * decision 9). A seam module that called `classify` / `streamSimple` /
 * `complete` itself would bypass the composition policies, the evidence check
 * and the decision log — every guarantee `decide()` exists to provide.
 *
 * The gate asserts both directions: no file outside `ALLOWED` calls these
 * APIs, and the allowed file really does (so the patterns cannot silently
 * stop matching).
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { makeAssert } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const SRC = path.resolve(import.meta.dirname, "..", "src");
const ALLOWED = new Set(["decision-backends.ts"]);
/** Any receiver: these names exist only on Pi's model registry / runtime. */
const MODEL_CALLS = /\.\s*(classify|streamSimple)\s*\(/g;
/** Generic names, so only on a model-registry receiver. */
const REGISTRY_CALLS = /(modelRegistry|modelRuntime)\s*\.\s*(complete|stream)\s*\(/g;

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const offenders: string[] = [];
let allowedHits = 0;
for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
  const text = strip(readFileSync(path.join(SRC, f), "utf8"));
  for (const m of [...text.matchAll(MODEL_CALLS), ...text.matchAll(REGISTRY_CALLS)]) {
    if (ALLOWED.has(f)) allowedHits++;
    else offenders.push(`${f}: ${m[0].replace(/\s+/g, "")}`);
  }
}
assert(
  offenders.length === 0,
  `no module outside ${[...ALLOWED].join(", ")} calls a model API${offenders.length ? ` — ${offenders.join(", ")}` : ""}`,
);
assert(
  allowedHits >= 2,
  `the backend file is matched by the pattern (${allowedHits} calls), so the gate can fail`,
);

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);

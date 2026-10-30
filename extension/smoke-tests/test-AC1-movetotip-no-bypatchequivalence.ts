#!/usr/bin/env bun
/**
 * #1908 — guards the removal of `moveToTip`'s dead `byPatchEquivalence`
 * parameter (and the `movedByPatchEquivalence` field it fed).
 *
 * What it guards: nothing under `extension/src` or `extension/smoke-tests`
 * may reference the identifier again. The parameter and its derived field are
 * deleted outright, so a re-introduction — a caller passing it, a reader
 * destructuring it, a stale test asserting on it — is a regression of this
 * change, and this file is the gate that catches it.
 *
 * Deliberately one assertion over repository text: the arity of the real call
 * is exercised against the real entry point by
 * `test-work-driver-lens-fix-reposition-lagging-ref.ts`, which a 1-arg-short
 * call would fail loudly. Asserting arity by calling `moveToTip` with a
 * hand-counted argument list here would be vacuous — the old 9-parameter
 * signature accepts the same 8-argument call.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const TEST = "test-AC1-movetotip-no-bypatchequivalence.ts";
/** Built so this file cannot match itself. */
const NEEDLE = ["byPatch", "Equivalence"].join("");
const MIN_FILES_SCANNED = 100;

async function main() {
  const extensionDir = path.join(import.meta.dirname, "..");
  const self = import.meta.filename;
  const offenders: string[] = [];
  let scanned = 0;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        if (full === self) continue;
        scanned++;
        if (readFileSync(full, "utf8").includes(NEEDLE)) {
          offenders.push(path.relative(extensionDir, full));
        }
      }
    }
  };

  walk(path.join(extensionDir, "src"));
  walk(import.meta.dirname);

  if (scanned < MIN_FILES_SCANNED) {
    console.error(
      `FAIL ${TEST}: scanned only ${scanned} .ts files (< ${MIN_FILES_SCANNED}) — the walk found no tree, so a clean result would prove nothing`,
    );
    process.exit(1);
  }
  if (offenders.length > 0) {
    console.error(`FAIL ${TEST}: ${NEEDLE} still referenced in ${offenders.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ ${NEEDLE} absent from all ${scanned} .ts files under src/ and smoke-tests/`);
}

main().catch((e) => {
  console.error(`FAIL ${TEST}: ${(e as Error)?.stack ?? e}`);
  process.exit(1);
});

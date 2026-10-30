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

const TEST = path.basename(import.meta.filename);
/** Built so this file cannot match itself. */
const NEEDLE = ["byPatch", "Equivalence"].join("");

async function main() {
  const extensionDir = path.join(import.meta.dirname, "..");
  const self = import.meta.filename;
  const offenders: string[] = [];
  const scanned = { src: 0, "smoke-tests": 0 } as Record<"src" | "smoke-tests", number>;

  const walk = (root: string, key: "src" | "smoke-tests") => {
    let count = 0;
    const walkDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          if (full === self) continue;
          count++;
          if (readFileSync(full, "utf8").includes(NEEDLE)) {
            offenders.push(path.relative(extensionDir, full));
          }
        }
      }
    };
    walkDir(root);
    scanned[key] = count;
  };

  const srcDir = path.join(extensionDir, "src");
  const smokeDir = import.meta.dirname;
  walk(srcDir, "src");
  walk(smokeDir, "smoke-tests");

  // A walk that found no tree is not a clean scan, so each root is checked
  // before the offender list is believed. The src floor is generous: this
  // repo has several hundred .ts files there, so a low count means the walk
  // pointed at the wrong directory.
  for (const [name, dir] of [
    ["src", srcDir],
    ["smoke-tests", smokeDir],
  ] as const) {
    const floor = name === "src" ? 500 : 1;
    if (scanned[name] < floor) {
      console.error(
        `FAIL ${TEST}: root ${dir} scanned ${scanned[name]} .ts files (< ${floor}) — the walk found no tree, so a clean result would prove nothing`,
      );
      process.exit(1);
    }
  }
  if (offenders.length > 0) {
    console.error(
      `FAIL ${TEST}: needle still referenced in ${offenders.length} file(s): ${offenders.join(", ")}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ ${NEEDLE} absent from all ${scanned.src + scanned["smoke-tests"]} .ts files under src/ and smoke-tests/ (src ${scanned.src}, smoke-tests ${scanned["smoke-tests"]})`,
  );
}

main().catch((e: unknown) => {
  console.error(`FAIL ${TEST}: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});

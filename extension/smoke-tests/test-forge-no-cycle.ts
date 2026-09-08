#!/usr/bin/env bun
/**
 * Import-cycle canary: forge-ci.ts must hold no VALUE import from forge.ts.
 *
 * The forge-ci.ts split introduced a runtime cycle: forge.ts imports
 * `ciRun` / `ciWatch` (values) from forge-ci.ts, and forge-ci.ts imported
 * `terminalCiFor` (a value) back from forge.ts. Latent today only because
 * `terminalCiFor` is a top-level pure function — it becomes a TDZ crash the
 * moment anything touches the Forge object at module-eval.
 *
 * The fix breaks it at the leaf: the terminal-status table
 * (`GH_TERMINAL_CI` / `GL_TERMINAL_CI` / `terminalCiFor`) lives in a leaf
 * module (forge-ci-terminal.ts) that both import one-way
 * (forge.ts → forge-ci.ts → forge-ci-terminal.ts), with no edge back.
 *
 * Grep-based source assertion (precedent: test-file-size-limit.ts): type-only
 * imports are fine — they erase at compile time and create no runtime edge.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const src = readFileSync(join(import.meta.dirname, "..", "src", "forge-ci.ts"), "utf8");

// Every import statement that mentions forge.ts (relative or absolute form).
const importLines = src
  .split("\n")
  .filter((l) => /^\s*import\b/.test(l) && l.includes("/forge.ts"));

const valueImports = importLines.filter(
  (l) => !/import\s+type\b/.test(l) && !/^\s*import\s+type\b/.test(l),
);

assert(
  valueImports.length === 0,
  "forge-ci.ts holds no VALUE import from forge.ts (the split must stay one-way)",
);
if (valueImports.length > 0) {
  for (const l of valueImports) console.error(`  offending line: ${l}`);
}

// The leaf module must exist and carry the terminal-status table + selector.
const leaf = readFileSync(join(import.meta.dirname, "..", "src", "forge-ci-terminal.ts"), "utf8");
assert(
  leaf.includes("GH_TERMINAL_CI") &&
    leaf.includes("GL_TERMINAL_CI") &&
    leaf.includes("terminalCiFor"),
  "forge-ci-terminal.ts is the leaf holding GH_TERMINAL_CI / GL_TERMINAL_CI / terminalCiFor",
);

console.log(`\nexit ${exit}`);
process.exit(exit);

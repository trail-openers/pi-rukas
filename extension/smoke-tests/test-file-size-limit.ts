#!/usr/bin/env bun
/**
 * File-size ratchet — AGENTS.md §12 hard limit (500 lines/file). Mirrors the
 * shape AGENTS.md itself calls for ("same shape as the #277 skip-ratchet"):
 * a gate that runs in the same offline pre-push/CI loop as every other
 * smoke test (`smoke-tests/test-*.ts`), zero extra wiring required.
 *
 * Unlike the #277 skip-ratchet (which only fails on a NET INCREASE against
 * a per-diff baseline, because it was introduced against an existing
 * backlog), this gate is a flat cap: after #171's sweep, every TypeScript
 * file under extension/src and extension/smoke-tests is compliant, so
 * there is no grandfathered backlog left to track — any file over the
 * limit, old or new, is a regression. Escape hatch: PI_ENSEMBLE_SIZE_RATCHET=0
 * (matches the naming convention of PI_ENSEMBLE_SKIP_RATCHET /
 * PI_ENSEMBLE_SMOKE).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const HARD_LIMIT = 500;
const ROOT = path.join(import.meta.dirname, "..");
const SCAN_DIRS = ["src", "smoke-tests"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  // Count newlines; a trailing-newline-terminated file of N lines has N
  // newline characters, which matches `wc -l`'s convention exactly.
  return (text.match(/\n/g) ?? []).length;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

if (process.env.PI_ENSEMBLE_SIZE_RATCHET === "0") {
  console.log("PI_ENSEMBLE_SIZE_RATCHET=0 — file-size gate skipped.");
  process.exit(0);
}

const violations: { file: string; lines: number }[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of listTsFiles(path.join(ROOT, dir))) {
    const lines = lineCount(file);
    if (lines > HARD_LIMIT) {
      violations.push({ file: path.relative(ROOT, file), lines });
    }
  }
}

if (violations.length === 0) {
  assert(true, `every .ts file under ${SCAN_DIRS.join("/, ")}/ is ≤ ${HARD_LIMIT} lines`);
} else {
  for (const v of violations.sort((a, b) => b.lines - a.lines)) {
    assert(false, `${v.file}: ${v.lines} lines (exceeds ${HARD_LIMIT}-line hard limit)`);
  }
}

console.log(exit === 0 ? "\nAll file-size checks passed." : "\nFAILED");
process.exit(exit);

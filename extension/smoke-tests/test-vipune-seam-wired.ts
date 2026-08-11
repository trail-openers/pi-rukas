#!/usr/bin/env bun
/**
 * The memory seam must not be dead code, and its dead parts must be countable.
 *
 * `extension/src/vipune.ts` has now shipped twice — calibrated, documented and
 * fully tested — while being imported by **nothing but its own smoke tests**.
 * Every measurement that made it correct was real; none of it ever ran in
 * production. Tests of a module in isolation cannot detect that, because they
 * are themselves the only caller.
 *
 * So this file asserts the one thing those tests structurally cannot: that the
 * seam is reachable from the driver, and that every export either has a
 * production caller or is on a written-down list of things not yet wired, each
 * naming the issue that will wire it.
 *
 * The allowlist is the point. It converts "this is dead" from something nobody
 * notices into a number that has to shrink, and shipping a new export without
 * either wiring it or declaring it becomes a test failure rather than a habit.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const SEAM = "vipune.ts";

/**
 * Exports with no production caller yet, each with the issue that will wire it.
 *
 * Shrinking this to empty is the definition of done for the memory work. Adding
 * to it is allowed — leaving something out of it is not.
 */
const PENDING_WIRING: Record<string, string> = {
  selectResults: "#422 — used by the read leg",
  readDoctrineFromDisk:
    "#407 — superseded by readDoctrineAtBase; kept for callers outside the driver",
  // Consumed inside the seam by functions that are themselves unwired, so these
  // reach production only once those do.
  SIM_FLOOR: "#422 — read by selectResults",
  looksLikeSecret: "#422 — called by vipuneAdd inside the seam",
  searchArgv: "#422 — called by vipuneSearch (and by the offline argv gate)",
};

const seamSource = readFileSync(path.join(SRC, SEAM), "utf8");

/** Every `export function|const` name the seam publishes. */
const exported = [
  ...seamSource.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_]\w*)/gm),
].map((m) => m[1] as string);

assert(exported.length > 5, `the seam publishes ${exported.length} functions/consts`);

/** Production sources: everything under src/ except the seam itself. */
const productionFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts") && f !== SEAM)
  .map((f) => ({ name: f, text: stripComments(readFileSync(path.join(SRC, f), "utf8")) }));

/**
 * Comments are not callers.
 *
 * Without this, a docstring that merely NAMES an export counts as wiring it —
 * which is exactly how this test first reported `renderBrief` as live when the
 * only mention of it was a sentence explaining what it does.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const importers = productionFiles.filter((f) => /from "\.\/vipune\.ts"/.test(f.text));

assert(
  importers.length > 0,
  `the seam has ${importers.length} production importer(s): ${importers.map((i) => i.name).join(", ") || "NONE"}`,
);

// ------------------------------------------------ every export is accounted for

{
  const unwired: string[] = [];
  for (const name of exported) {
    const used = productionFiles.some((f) => new RegExp(`\\b${name}\\b`).test(f.text));
    if (used) continue;
    if (name in PENDING_WIRING) continue;
    unwired.push(name);
  }
  assert(
    unwired.length === 0,
    `every seam export is either wired or declared pending${
      unwired.length ? ` — undeclared: ${unwired.join(", ")}` : ""
    }`,
  );

  // The allowlist must not rot: an entry that HAS acquired a caller should be
  // removed, or the list stops meaning anything.
  const staleEntries = Object.keys(PENDING_WIRING).filter(
    (name) =>
      exported.includes(name) &&
      productionFiles.some((f) => new RegExp(`\\b${name}\\b`).test(f.text)),
  );
  assert(
    staleEntries.length === 0,
    `PENDING_WIRING has no stale entries${staleEntries.length ? ` — now wired, remove: ${staleEntries.join(", ")}` : ""}`,
  );

  const pendingCount = Object.keys(PENDING_WIRING).filter((n) => exported.includes(n)).length;
  console.log(`  … ${pendingCount} export(s) still awaiting a production caller (see #422)`);
}

// ----------------------------------- the canary: what this would have caught

{
  // `vipuneChildEnv` IS wired, at spawn.ts. If that import is ever removed the
  // seam loses its only production reachability, which is precisely the state
  // this file exists to make visible.
  const spawn = productionFiles.find((f) => f.name === "spawn.ts");
  assert(
    spawn !== undefined && /vipuneChildEnv/.test(spawn.text),
    "canary: spawn.ts still imports vipuneChildEnv — the seam's only live reachability today",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #1764 — the fixture source both halves of the review-findings suites cite.
 *
 * This lives in lib/ as a pure module (no asserts, no process.exit) on purpose:
 * the identity suite ends with process.exit, so importing SRC straight from
 * that file ran the whole identity suite and then killed the importing module
 * before its own body executed — the store suite's assertions never printed.
 */

// The fixture source the identity assertions cite, and the same lines the
// store half commits as `src/a.ts` — one copy, exported, so the two files
// cannot disagree about what line 4 of the fixture is.
export const SRC = [
  "// header", // 1
  "export function alpha(x: number) {", // 2
  "  const a = x + 1;", // 3
  "  return a * 2;", // 4
  "}", // 5
  "", // 6
  "export class Beta {", // 7
  "  run() {", // 8
  "    return 1;", // 9
  "  }", // 10
  "}", // 11
];


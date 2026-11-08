#!/usr/bin/env bun
/**
 * lens-diff-fixtures — a lens-local unified-diff builder (#2127, D6).
 *
 * The per-lens turn ceiling is computed from CHANGED LINES, which is added plus
 * removed, so a builder that only ever emitted `+` lines could not tell a
 * ceiling that counts both from one that counts only additions — every case
 * would pass for the wrong reason. Each file here therefore carries BOTH:
 * `perFile` removed lines and `perFile` added ones, so `changedLines` of the
 * result is exactly `files * perFile * 2`.
 *
 * Deliberately NOT the adversarial fixtures' `syntheticDiff` (D6): that builder
 * emits added lines only, and the adversarial gate is a different concern whose
 * fixtures this change must not couple to.
 */

/** A diff over `paths` with `perFile` removed and `perFile` added lines each. */
export function lensSyntheticDiffWithPaths(paths: string[], perFile: number): string {
  const lines: string[] = [];
  paths.forEach((p, f) => {
    lines.push(`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`);
    lines.push(`@@ -1,${perFile} +1,${perFile} @@`);
    for (let l = 0; l < perFile; l++) lines.push(`-const old${f}_${l} = 0;`);
    for (let l = 0; l < perFile; l++) lines.push(`+const value${f}_${l} = "${f}";`);
  });
  return lines.join("\n");
}

/** The default module-path shape, for size-driven cases. */
export function lensSyntheticDiff(files: number, perFile: number): string {
  return lensSyntheticDiffWithPaths(
    Array.from({ length: files }, (_unused, f) => `src/module-${f}/file-${f}.ts`),
    perFile,
  );
}

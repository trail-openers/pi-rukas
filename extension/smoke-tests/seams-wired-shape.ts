#!/usr/bin/env bun
/**
 * seams-wired-shape — the `Seam` record type shared by test-seams-wired.ts and
 * seams-wired-declared.ts, split out so neither file has to restate it and the
 * registry can sit under AGENTS.md §12's 500-line cap in two files.
 */

export interface Seam {
  file: string;
  /** Exports with no production caller yet, each naming the issue that will wire it. */
  pending: Record<string, string>;
  /**
   * Exports that exist for testability: called from inside their own module,
   * exported so the pure core can be asserted directly. Legitimate, but only
   * while a test actually calls them — an entry here whose test disappears is
   * dead code wearing a label, so each one is checked against the suite.
   */
  testOnly?: Record<string, string>;
  /**
   * A symbol known to be wired today. If this stops being imported the seam has
   * lost its production reachability — exactly the state this file exists to
   * make visible.
   */
  canary: { symbol: string; importer: string };
}

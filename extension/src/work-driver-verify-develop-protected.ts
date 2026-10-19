/**
 * work-driver-verify-develop-protected — the develop step's protected-path
 * gate (#406), extracted from `work-driver-verify-develop.ts`.
 *
 * Why this seam: `verifyDevelopOutcome` had grown to 510 lines, past the
 * 500-line cap AGENTS.md §12 enforces. This file already follows a per-gate
 * extraction pattern — the falsily-green check lives in
 * `work-driver-falsily-green.ts` (#679), the scope/fanout gate in
 * `work-driver-scope-fanout.ts` (#285), the skip-ratchet and smoke gates in
 * `work-driver-verify-develop-gates.ts` (#451) — and the protected-path gate
 * is the same shape: one self-contained check over the diff's path set,
 * reading six values and writing only into the caller's `failures` and `notes`
 * arrays. No control flow crosses the boundary, so the extraction is a move,
 * not a rewrite: the jsdoc and every inline comment travel with the code.
 *
 * What the gate is: a cycle must not edit the files that decide whether its
 * own work passes. Policy prose (AGENTS.md, CLAUDE.md) is deliberately NOT
 * halted here — it is neutralised instead, by reading doctrine at baseSha in
 * the merge gate — so that this repo's own "docs ship with the PR" rule keeps
 * working.
 *
 * Import chain: work-driver-verify-develop.ts → this file →
 * work-driver-doctrine.ts + work-driver-protected-grant.ts (acyclic; the same
 * two modules the caller already imports, so extraction moves no dependency
 * edge). This file does NOT import work-driver-verify-develop.ts.
 */

import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { ungrantedProtectedPaths } from "./work-driver-protected-grant.ts";

/**
 * Run the protected-path gate over the develop step's changed paths.
 *
 * @param protectedGateOn `PI_ENSEMBLE_PROTECTED_PATHS` is not `0`; the caller
 *   reads the knob (it also decides whether the path sets are computed at all).
 * @param touchedPaths Paths the workstreams changed.
 * @param protectedOnlyPaths Rename SOURCES — paths that vanished rather than
 *   changed, which the plain touched-set does not carry (#1378).
 * @param protectedGrant The operator's per-cycle `--allow-protected` grant.
 *   Read from the invocation context only, NEVER the state file (#1090): a
 *   cycle that could write its own grant would grant itself.
 * @param issues Every issue in the group, so the explanation names all of them.
 * @returns The ungranted protected paths the gate failed on: the scope gate
 *   must not repeat a failure for any of them (#1676). Empty when none, or off.
 */
export function runProtectedPathGate(args: {
  protectedGateOn: boolean;
  touchedPaths: string[];
  protectedOnlyPaths: string[];
  protectedGrant: readonly string[] | undefined;
  issues: number[];
  failures: string[];
  notes: string[];
}): string[] {
  const {
    protectedGateOn,
    touchedPaths,
    protectedOnlyPaths,
    protectedGrant,
    issues,
    failures,
    notes,
  } = args;
  if (!protectedGateOn) {
    notes.push("PI_ENSEMBLE_PROTECTED_PATHS=0 — protected-path gate disabled");
    return [];
  }
  // #1378 — the union carries the rename sources; the #285/#1012/#679 gates in
  // the caller consumed `touchedPaths` alone and are byte-identical to before
  // this extraction.
  const protectedHits = protectedPathsIn([...touchedPaths, ...protectedOnlyPaths]);
  // #1090 — only the operator's invocation grant, never the state file.
  const ungranted = ungrantedProtectedPaths(protectedHits, protectedGrant);
  if (ungranted.length > 0) {
    failures.push(explainProtectedPaths(ungranted, protectedHits, issues));
  }
  const granted = protectedHits.filter((p) => !ungranted.includes(p));
  if (granted.length > 0) {
    notes.push(`operator grant (--allow-protected) admitted ${granted.join(", ")}`);
  }
  const prose = doctrineProsePathsIn([...touchedPaths, ...protectedOnlyPaths]);
  if (prose.length > 0) {
    notes.push(
      `develop changed policy prose (${prose.join(", ")}) — allowed, and inert for this cycle: merge authority is read at the base commit, so a grant added here cannot take effect until an operator merges it`,
    );
  }
  return ungranted;
}

/**
 * seams-registry-spawn-config — the #2019 operator-config entry of the seam
 * table `test-seams-wired.ts` enforces.
 *
 * Split out of `seams-registry.ts` for the 500-line gate (AGENTS.md §12), the
 * same way the merge-ledger and #1454 groups were: `seams-registry.ts` spreads
 * this back into `SEAMS`, so `test-seams-wired.ts` sees one identical table
 * whichever file an entry was added to.
 */

import type { Seam } from "./seams-registry.ts";

export const SEAMS_SPAWN_CONFIG: Seam[] = [
  {
    // #2019 — the operator-config guard: snapshot / verify / restore around a
    // child's lifetime for the four files that carry the operator's git identity
    // and gh credentials. `withOperatorConfigGuard` has two production callers
    // (spawn.ts and work-driver-resume-reattach.ts); `protectedPaths` is exported
    // only so a test can point the guard at a sentinel home — the real home must
    // never be the fixture, since writing it IS the bug this module fixes.
    file: "spawn-operator-config.ts",
    pending: {},
    testOnly: {
      protectedPaths:
        "the path resolver, read from the env it is handed; test-operator-config-guard.ts drives every case against a mkdtemp sentinel home through it",
      __openInPlaceForTest:
        "the in-place open, so the entry-hardening case can put a symlink at the target at the moment of the open (a swap raced against the guard would prove nothing); lib/opcfg-entry-cases.ts drives it, and restoreOne is its only production caller",
    },
    canary: { symbol: "withOperatorConfigGuard", importer: "spawn.ts" },
  },
];

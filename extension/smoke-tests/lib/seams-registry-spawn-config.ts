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
  {
    // The adversarial verdict re-ask, loop side: it turns an unreadable round
    // into a recovered verdict or leaves the round exactly as it was. Both of
    // its production callers are `adversarial.ts` — the ask itself, and the
    // switch its reviewer brief reads.
    file: "adversarial-verdict-reask.ts",
    pending: {},
    canary: { symbol: "reaskRoundVerdict", importer: "adversarial.ts" },
  },
  {
    // The re-ask's child plumbing: argv, env, stdin, bound, RPC stream. Only
    // the loop-side module spawns it, which is what keeps a second reviewer
    // child from appearing anywhere else in the harness.
    file: "adversarial-verdict-reask-child.ts",
    pending: {},
    testOnly: {
      // The child's argv and the RPC reply extraction: the shapes a real `pi`
      // child is judged by, asserted without spawning one (a live spawn is
      // refused offline by `assertLiveSpawnAllowed`).
      reaskChildArgs:
        "the re-ask child's argv; test-adversarial-verdict-reask.ts pins the resume flags and the no-fence ask",
      reaskReplyText:
        "the RPC-stream reply extractor; test-adversarial-verdict-reask.ts pins that a partial stream is not a verdict",
      // The temp-file write behind the child's `--append-system-prompt`; split
      // out of `writeReviewerPromptFile` so the mode and name are assertable
      // without a role's prompt file on disk.
      writeReaskPromptFile:
        "the prompt-file write (0700 dir, 0600 file, role-named); test-adversarial-verdict-reask.ts drives it against a mkdtemp root",
    },
    canary: { symbol: "spawnVerdictReaskChild", importer: "adversarial-verdict-reask.ts" },
  },
  {
    // The re-ask's shared vocabulary — tag, label, prompt, result clause, bound.
    // Read by the loop side AND the child side, so it sits below both: neither
    // half imports the other across the seam.
    file: "adversarial-verdict-reask-constants.ts",
    pending: {},
    canary: { symbol: "VERDICT_REASK_PROMPT", importer: "adversarial-verdict-reask.ts" },
  },
];

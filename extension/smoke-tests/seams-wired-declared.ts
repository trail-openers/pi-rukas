#!/usr/bin/env bun
/**
 * seams-wired-declared — the second half of the seam registry asserted by
 * test-seams-wired.ts, split out for AGENTS.md §12's 500-line cap.
 *
 * Same `Seam` shape, same assertions; the consumer spreads this array into its
 * own `SEAMS` so the gate reads one registry. Split at the natural seam: the
 * decision/prompt-layer entries stay in the test, and the ledger, forge and
 * Pi-binary-probe layer lives here.
 */

import type { Seam } from "./seams-wired-shape.ts";

export const DECLARED_SEAMS: Seam[] = [
  {
    // #729 — the dispatch deck's single composite widget factory. Replaces
    // the pre-#729 deck-prompt-label.ts + aboveEditor DECK_PROMPT_KEY widget
    // with a belowEditor composite that renders ONE widget key. The pure
    // builders are wired into renderNow by dispatch-deck.ts; declared
    // test-only so a regression that unwires the composite is visible at
    // the gate.
    file: "dispatch-deck-composite.ts",
    pending: {},
    testOnly: {
      buildSteerPrompt: "steer prompt builder; exercised by test-dispatch-deck-interactive.ts",
      buildJobRows:
        "row builder with the #835 key-fragment disambiguator; exercised by test-dispatch-deck.ts block 14",
    },
    canary: {
      symbol: "buildCompositeFactory",
      importer: "dispatch-deck-confirm-row.ts",
    },
  },
  {
    // #912 — the per-clone review ledger. The writer calls live in
    // adversarial.ts (runAdversarialLoop) and lens-review.ts
    // (runLensReview); the guard (merge-guard.ts) is the reader. The shared
    // predicates + review-patch-identity.ts are the seam the guard trusts.
    file: "review-ledger.ts",
    pending: {},
    testOnly: {
      readLedgerFile: "the raw file reader; exercised by test-review-ledger.ts",
      validEntries: "the row validator; exercised by test-review-ledger.ts",
      dedupeLatest: "the bounded-file dedup; exercised by test-review-ledger.ts",
      readLedgerAt: "the never-throwing reader; exercised by test-merge-guard.ts",
      lensBlockedByThreshold:
        "the driver-side threshold predicate; exercised by test-review-ledger.ts",
      bumpLensRound:
        "the #973 round counter; wired in appendLedgerEntry (review-ledger.ts) and exercised by test-review-ledger.ts",
    },
    canary: { symbol: "appendLedgerEntry", importer: "adversarial-ledger.ts" },
  },
  {
    // #1071 — the per-clone review-ledger lock (O_EXCL lockfile colocated
    // with the ledger file). Wired into appendLedgerEntry (review-ledger.ts)
    // so the read → transform → rename window is serialised across
    // concurrent writers on the same clone.
    file: "review-ledger-lock.ts",
    pending: {},
    testOnly: {
      LEDGER_LOCK_WAIT_MS:
        "the default bounded wait (≈5 s); exercised by test-review-ledger-lock.ts",
      LEDGER_LOCK_STALE_MS:
        "the default stale window (≈30 s); exercised by test-review-ledger-lock.ts",
      ledgerLockPath:
        "the lockfile path (colocated with the ledger file); exercised by test-review-ledger-lock.ts",
      runLedgerCriticalSectionHook:
        "ACCEPTED, PERMANENT test seam: a no-op await in appendLedgerEntry (undefined in production) that lets the two-process race test widen the read→rename window deterministically; chosen over an env-var read in the write path (#1071 review); exercised by test-review-ledger-lock.ts",
      setLedgerCriticalSectionHookForTests:
        "ACCEPTED, PERMANENT test seam (same hook's setter): never set in production; exercised by test-review-ledger-lock.ts (its child script)",
    },
    canary: { symbol: "acquireLedgerLock", importer: "review-ledger.ts" },
  },
  {
    // #912 — the merge target reader (gh/glab) + carve-out predicate.
    // Wired into merge-guard.ts (the guard's decision path).
    file: "merge-target.ts",
    pending: {},
    testOnly: {
      resolvePrNumber: "the no-number PR resolution; exercised by test-merge-guard.ts",
    },
    canary: { symbol: "readMergeTarget", importer: "merge-guard.ts" },
  },
  {
    // #1019 — the pi binary version probe. The probe half (getPiResolutionInfo)
    // used to ship with no production caller, so its PATH-source / older-than-
    // verified warnings never fired. spawn.ts now kicks it fire-and-forget on
    // the first child spawn in a process; this canary pins that wiring so it
    // cannot silently ship unwired again.
    file: "pi-binary-resolve.ts",
    pending: {},
    testOnly: {
      // Pure/low-level helpers asserted directly by test-pi-binary-resolve.ts
      // or used by the wired exports above. resolvePackageBin's injected-path
      // overload is called directly by tests (unmemoized by design); the
      // default-package branch is wired through resolvePiBinarySync.
      looksLikePiCli: "shared Pi CLI path predicate; exercised by test-pi-binary-resolve.ts",
      parsePiVersion: "the --version output parser; exercised by test-pi-binary-resolve.ts",
      resolvePackageBin:
        "the injected-path overload is test-asserted; the default branch is wired via resolvePiBinarySync",
      resolvePiBinarySync:
        "the sync resolver; wired via getPiInvocation; also directly test-asserted",
    },
    canary: {
      symbol: "getPiInvocation",
      importer: "work-driver-resume-reattach.ts",
    },
  },
  {
    // #1038 — the version probe split out of pi-binary-resolve.ts. The fire-and-
    // forget kick stays wired from spawn.ts (first spawn in a process).
    file: "pi-version-probe.ts",
    pending: {},
    testOnly: {
      probePiVersion: "the async probe; wired via getPiResolutionInfo; also directly test-asserted",
      getPiResolutionInfo: "the full resolution + probe; also directly test-asserted",
      isVersionOlder: "the version comparator; exercised by test-pi-binary-resolve.ts",
      _resetPiVersionProbe:
        "composed test-only reset (probe + binary cache); exercised by test-pi-binary-hardening.ts",
      getVerifiedVersion:
        "the doc-derived verified version; exercised by test-pi-binary-resolve.ts",
    },
    canary: { symbol: "kickPiResolutionProbe", importer: "spawn.ts" },
  },
  {
    // The shared verified-line parser, imported by the version probe and the drift gate.
    file: "pi-doc-parsing.ts",
    pending: {},
    testOnly: {
      parseVerifiedLine: "the shared verified-line parser; exercised by test-pi-version-drift.ts",
    },
    canary: { symbol: "parseVerifiedLine", importer: "pi-version-probe.ts" },
  },
];

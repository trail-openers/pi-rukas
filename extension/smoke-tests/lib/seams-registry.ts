/**
 * seams-registry — the seam table `test-seams-wired.ts` enforces, split out of
 * it for the 500-line gate (AGENTS.md §12).
 *
 * One entry per module that shipped as a wired seam: which exports are declared
 * test-only or pending, and the canary symbol whose import proves the seam is
 * still reachable from production. Adding a module to this list is the whole
 * of registering it; the assertions live in the test.
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

export const SEAMS: Seam[] = [
  {
    // #1308 — the generic decision seam. The policy judge (S2) is its first
    // production caller; the shadow seams (S3/S4) reach it via decision-shadow.ts.
    file: "decision-seam.ts",
    pending: {},
    canary: { symbol: "decide", importer: "work-driver-policy.ts" },
  },
  {
    // #1308 S3 — fire-and-forget decisions for the shadow seam. The
    // failure-cause owner is its caller; index.ts attaches the session model.
    // (#1187 removed the S4 security-open-point seam.)
    file: "decision-shadow.ts",
    pending: {},
    canary: { symbol: "shadowDecide", importer: "work-driver-failure-taxonomy.ts" },
  },
  {
    // #1020 — the host seam. piSessionHost is the only Pi-touching driver
    // surface; commands.ts is its production caller.
    file: "work-driver-host.ts",
    pending: {},
    canary: { symbol: "piSessionHost", importer: "commands.ts" },
  },
  {
    // #1247 — the process-level origin trackers; index.ts is the production caller.
    file: "exit-cause.ts",
    pending: {},
    testOnly: {
      // The suite shares one module instance, and a signal / stdin EOF cannot be
      // injected into it from inside a test.
      resetExitCauseForTesting: "#1247 — test-exit-cause.ts, test-work-driver-session-shutdown.ts",
      recordExitCauseForTesting: "#1247 — first-writer-wins case; test-exit-cause.ts",
    },
    canary: { symbol: "armExitCause", importer: "index.ts" },
  },
  {
    // S4a (#1162) — the workflow-state persistence seam. markInterrupted is
    // called by the headless runner (headless/run.ts, #1024).
    file: "workflow-state.ts",
    pending: {
      requestInterrupt: "#1024 \u2014 set by markInterrupted; has no caller of its own",
    },
    testOnly: {
      writeState:
        "the write primitive behind persistCycle; driver code persists through persistCycle",
    },
    canary: { symbol: "persistCycle", importer: "work-driver-resume.ts" },
  },
  {
    file: "vipune.ts",
    pending: {
      // NOT planned for a caller. #394 calibrated `selectResults` as floor AND
      // agreement, and a later 940-observation sweep showed the floor costs
      // recall for nothing on this corpus (files-hit 22/24 -> 8/24, zero false
      // positives removed). The develop read applies the agreement bit directly.
      // Kept because the rule is correct for the question it was calibrated on.
      SIM_FLOOR: "superseded for the develop leg — read only by selectResults",
      readDoctrineFromDisk:
        "#407 — superseded by readDoctrineAtBase; kept for callers outside the driver",
      // Consumed inside the seam by functions that are themselves unwired, so
      // these reach production only once those do.
      searchArgv: "#422 — called by vipuneSearch (and by the offline argv gate)",
    },
    canary: { symbol: "vipuneChildEnv", importer: "spawn.ts" },
  },
  {
    // Shipped in v0.12.32 with no caller at all. `/audit` is now that caller
    // (memory-panel.ts), so it is enforced from here on.
    file: "memory-stats.ts",
    pending: {},
    testOnly: {
      renderMemoryStats: "the /audit panel renders its own framing; this is the raw dump",
      defaultDbPath: "resolved inside readMemoryStats; asserted directly",
    },
    canary: { symbol: "readMemoryStats", importer: "memory-panel.ts" },
  },
  {
    file: "retry-config-check.ts",
    pending: {},
    testOnly: {
      judgeRetryConfig: "the pure verdict, called by checkRetryConfig; asserted directly",
      checkRetryConfig: "file-reading wrapper, called by warnIfRetryConfigTooLow",
      PI_DEFAULT_MAX_RETRY_DELAY_MS: "asserted equal to the threshold, so it cannot drift",
      SAFE_MAX_RETRY_DELAY_MS: "asserted equal to Pi's default, so it cannot drift",
    },
    canary: { symbol: "warnIfRetryConfigTooLow", importer: "index.ts" },
  },
  {
    // #524 shipped the whole src/agents-md/ core wired by nothing — the prose
    // command body told PM to shell out to a host-relative path that does not
    // exist outside this repo. #526's agents-md-tool.ts is the in-process
    // delivery; this canary pins the shared import line so the core cannot
    // ship unwired a third time.
    file: "agents-md/agents-md.ts",
    pending: {},
    testOnly: {
      fileState: "the pure state classifier, asserted directly",
      runAgentsMd: "script-mode CLI entry (process.exit); the tool calls the verbs directly",
      runWrap: "the no-markers wrap I/O shell, called only by updateAgent within this module",
    },
    canary: { symbol: "createAgent", importer: "agents-md-tool.ts" },
  },
  {
    // #543 F3a — the crash-resume re-attach seam ships as default-off
    // infrastructure. `resolveReattach` / `reattachArgs` / `reattachPrompt`
    // have no production caller yet (the resume step does not record
    // `transcriptPath` on `dispatch-started`); they are wired when the
    // resume path learns to re-attach a surviving session instead of
    // re-dispatching. Flag default-off (PI_ENSEMBLE_SESSION_REATTACH=0),
    // so the seam is inert on every real cycle until then.
    file: "work-driver-resume.ts",
    pending: {
      reattachArgs: "#543 F3a — the crash-resume path will call it",
    },
    testOnly: {
      // #543 F3a — the re-attach floor + fan-out guard + the write-ahead
      // dispatch markers ship with no production caller yet (the crash-resume
      // path re-dispatches for now); exercised by test-session-reattach.ts /
      // test-resume.ts.
      sessionReattachEnabled: "#543 F3a — flag reader; test-asserted only",
      FAN_OUT_STEPS: "#543 F3a — re-attach exclusion set; test-asserted only",
      REATTACH_GRANT_FLOOR_MS: "#543 F3a — re-attach grant floor; test-asserted only",
      mintJobId: "resume plumbing — jobId minting; exercised by test-resume.ts",
      markDispatchStarted:
        "resume plumbing — write-ahead dispatch-started; exercised by test-resume.ts",
    },
    canary: {
      symbol: "beginDispatch",
      importer: "work-driver-explore-dispatch.ts",
    },
  },
  {
    // #594 — spec artifact validation, precedence, and file operations.
    // Wired into runExplore by work-driver-explore.ts. The pure validator
    // and precedence function are exercised by test-work-driver-pr12.ts.
    file: "work-driver-intent-artifact.ts",
    pending: {
      specArtifactDir: "#594 — test helper for the raw artifact path; no caller yet",
    },
    testOnly: {
      parseNormalisedSpecArtifact:
        "#594 — strict JSON spec artifact validator; called by test-work-driver-pr12.ts",
      exploreSpecArtifactPath:
        "#594 — artifact path helper; called by test-work-driver-pr12.ts and internally by readSpecArtifact/deleteSpecArtifact",
      // #1187 — the version the writer stamps and the reader requires. Read by the tests
      // that build an artifact's bytes; production reaches it only through persistSpecArtifact.
      SPEC_ARTIFACT_GATE_VERSION:
        "#1187 — gate-version constant; written by persistSpecArtifact, asserted by test-work-driver-pr12.ts and the open-point gate tests",
    },
    canary: {
      symbol: "resolveIntentVerdict",
      importer: "work-driver-explore-dispatch.ts",
    },
  },
  {
    // #750 — the shared verified-restore helper for consolidation abort
    // paths. The old per-site restore claimed "repoRoot restored" without
    // verifying the porcelain; this one preserves the discarded state,
    // resets, restores the checkout, and reports success only when the
    // post-condition read confirms the root is clean.
    file: "work-driver-restore.ts",
    pending: {},
    canary: {
      symbol: "verifiedRestoreRoot",
      importer: "work-driver-integrate.ts",
    },
  },
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
    // #1360 — the tool-path binding decision. `decideToolPathRow` and
    // `toolPathFields` are called by the writer (adversarial-ledger.ts) and
    // `captureBinding` by the loop's capture (adversarial-ledger-capture.ts);
    // the two entries below have no production caller by design — the range
    // check runs inside `decideToolPathRow`, and the prefix list is the shared
    // vocabulary the spec and the guard's quoted detail are asserted against.
    file: "adversarial-ledger-binding.ts",
    pending: {},
    testOnly: {
      reviewRangeDecision:
        "the range half of the decision, exercised through decideToolPathRow and asserted directly by test-adversarial-ledger-range.ts",
      BINDING_REFUSAL_PREFIXES:
        "the refusal vocabulary; asserted verbatim by test-adversarial-ledger-range.ts",
    },
    canary: { symbol: "decideToolPathRow", importer: "adversarial-ledger.ts" },
  },
  {
    // #1360 — the loop-side capture, split from adversarial.ts for the file-size
    // gate. Both halves are called by the loop.
    file: "adversarial-ledger-capture.ts",
    pending: {},
    canary: { symbol: "captureRound", importer: "adversarial.ts" },
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

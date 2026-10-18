/**
 * seams-registry-merge-ledger — the review-ledger / merge-guard group of the
 * seam table `test-seams-wired.ts` enforces.
 *
 * Split out of `seams-registry.ts` for the 500-line gate (AGENTS.md §12): the
 * two PRs that pushed the table over the cap both added entries here, so the
 * group sharing the merge-target trust path — the #912 ledger and its lock, the
 * #1360 binding + capture, and the #1417 merge-guard split — lives in its own
 * file. Entries moved verbatim; nothing is reworded. `seams-registry.ts` spreads
 * this back into `SEAMS`, so `test-seams-wired.ts` sees one identical table.
 */

import type { Seam } from "./seams-registry.ts";

export const SEAMS_MERGE_LEDGER: Seam[] = [
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
    // gate. Both halves are called by the loop. #1449 round 1 removed the
    // `LEDGER_WRITER` box: the loop now calls `writeAdversarialLedgerEntry`
    // directly, and the return-shape tolerance is a pure helper
    // (`normaliseLedgerWriteReturn`) tested on its shapes directly, so nothing
    // here is injectable on the #912 trust path.
    file: "adversarial-ledger-capture.ts",
    pending: {},
    testOnly: {
      // #1449 round 1 — the shape arm of the call site's tolerance. Exported so
      // every off-contract return can be fed to it DIRECTLY (undefined, null, a
      // bare object, an empty object, a string, a number, an array) instead of
      // only through a mocked writer; production reaches it only via
      // `makeLedgerWrite`. Exercised by test-adversarial-ledger-writer-shapes.ts.
      normaliseLedgerWriteReturn:
        "#1449 — the pure return-shape arm; called by makeLedgerWrite, asserted directly by test-adversarial-ledger-writer-shapes.ts",
    },
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
    // #912/#1417 — the merge guard's refusal PROSE. `renderHold` +
    // `holdReasonText` (every HELD command) and `GLAB_AUTO_MERGE_REFUSAL` are
    // called by merge-guard.ts. The MERGE half lost its production caller when
    // #1417 split hold text from merge refusals: declared test-only rather than
    // deleted, because docs/troubleshooting.md quotes its wording as the
    // documented refusal shape and the hold-text suite pins it survives.
    file: "merge-refusals.ts",
    pending: {},
    testOnly: {
      ACCEPTED_MERGE_FORM:
        "#1417 — the one accepted shape, inlined into HOLD_FORM_TEXT and MERGE_FORM_REFUSAL; the hold-text suite pins the sentence",
      MERGE_FORM_REFUSAL:
        "#1417 — MERGE-half prose, no production caller since holds got their own text; docs quote it, test-merge-guard-hold-text-1417.ts pins it",
      mergeFormRefusal:
        "#1417 — composes MERGE_FORM_REFUSAL with a reason code; same status, exercised by the hold-text and allowlist suites",
    },
    canary: { symbol: "renderHold", importer: "merge-guard.ts" },
  },
  {
    // #1417 — the guard's size bound (#955). The module-graph import check
    // cannot protect it: merge-allowlist.ts imports `lexedWhy` from
    // merge-refusals.ts on the same line block, so deleting the bound's CALL
    // outright — the mutation four lenses confirmed by live experiment — left
    // every importer assertion green. The canary is therefore pinned to the
    // CALL SITE's own text, not the module graph.
    file: "merge-size.ts",
    pending: {},
    testOnly: {
      // The NUMBER the bound documents, pinned equal to 8000 so a silent
      // widening cannot move it out from under the troubleshooting entry.
      MERGE_COMMAND_SIZE_BOUND:
        "asserted equal to the documented bound by test-merge-size-bound.ts",
      // The MATCHER's predicate (fail-closed: length + forge word, nothing
      // else). `readMergeCommand` consults only the classifier's, so the pair
      // differ on one axis the classifier cannot see — pinned at test-merge-
      // size-bound.ts's own seam. No production caller today because #1357
      // deleted the walking matcher; it is the predicate a revived one imports.
      exceedsAnalysisBound:
        "the fail-closed predicate; pinned by test-merge-size-bound.ts against the classifier's",
      // The CLASSIFIER's predicate — reached in production only through
      // `analysisBound`, and asserted directly so a clause cannot move between
      // it and the matcher's predicate unnoticed.
      exceedsClassifierBound:
        "the classifier predicate; reached via analysisBound and asserted directly by test-merge-size-bound.ts",
    },
    canary: { symbol: "analysisBound", importer: "merge-allowlist.ts" },
  },
  {
    // #1417 — step 1 of the classifier (the trigger). Same reasoning: the
    // module graph stays satisfied by merge-size.ts's import while
    // `readMergeCommand` quietly stops asking the trigger anything.
    file: "merge-trigger.ts",
    pending: {},
    canary: { symbol: "triggerCode", importer: "merge-allowlist.ts" },
  },
  {
    // #1417 — the command-text views and their patterns. The classifier reaches
    // this module through the trigger, so that is the call site the canary
    // pins; the bound's own path runs through `triggerCode` instead.
    file: "merge-lex-views.ts",
    pending: {},
    testOnly: {
      // The `g`-flagged tokeniser `ansiC` replaces with — shared with a
      // `.test()` caller it would carry `lastIndex` between calls, which is
      // why it is exported at all rather than being a module constant.
      ANSI_ESCAPE_PATTERN:
        "the tokeniser behind ansiC (its only consumer); pinned exported by the lastIndex comment and exercised through ansiC's suite",
    },
    canary: { symbol: "hasComplexCommandWord", importer: "merge-trigger.ts" },
  },
  {
    // #1417 — the bound's refusal wording. Called by exactly one function, so
    // the canary names that function's module; if the wording stops being
    // reachable the bound has no refusal left to emit.
    file: "merge-too-large.ts",
    pending: {},
    canary: { symbol: "refuseTooLarge", importer: "merge-size.ts" },
  },
];

/**
 * lens-review-options — the `runLensReview` parameter object, as its own module.
 *
 * Pure move: every field and every doc comment below is the text the inline
 * parameter list in `lens-review.ts` carried, verbatim. It is the largest single
 * block in that orchestrator (60 lines of contract around one function) and the
 * most stable, so it is the seam that takes the orchestrator back under the
 * 500-line cap without moving any logic.
 *
 * `lensChildFn` is the test seam the offline smoke tests drive (an all-fail or
 * all-silent round is drivable without spawning a child), which is why it is
 * part of the contract rather than an internal.
 */

import type { LensLedgerOutcome } from "./lens-ledger.ts";
import type { Severity } from "./lens-review-format.ts";
import type { Finding } from "./lens-review-types.ts";

export interface LensReviewOptions {
  diff?: string;
  context?: string;
  cwd?: string;
  /** #859 — base ref for the tool-computed `git diff <base>...<head>` (with head). */
  base?: string;
  /** #859 — head ref for the tool-computed diff (with base). */
  head?: string;
  signal?: AbortSignal;
  processGroup?: boolean;
  /** #1666 — a headless /work cycle's lens children run under trust. */
  workCycleTrust?: boolean;
  /** #1242 — each lens child's run bound (default: lensChildBoundMs). */
  childBoundMs?: number;
  /** #973 — the delta base (see resolveReviewDiff for the full contract). */
  since?: string;
  /** #973 — force a full review (the automatic delta base is not consulted; an explicit `since` still wins when given). */
  full?: boolean;
  /**
   * #966 — the per-lens spawner (the real `runLensChild` by default;
   * tests inject a stub so an all-fail run is drivable offline, the issue's
   * "start a lens job with stub children" acceptance criterion).
   */
  lensChildFn?: typeof import("./lens-review-child.ts").runLensChild;
  /**
   * Post-change content of files the diff touches, rendered for the prompt.
   * Supplied by the caller because only it knows the branch ref; see
   * `readFileAtBranch`.
   */
  evidence?: string;
  /**
   * Deterministic findings produced without a model — currently `claim-scan`.
   * They join the lens findings before dedup and verdict, so they reach both
   * `/work` and `/review` through this one path.
   */
  extraFindings?: Finding[];
  /** #799 — the parent pi for the inner children's slow-run watch (the PM
   * notice half; the watch site has no pi of its own). */
  pi?: import("./async-jobs-lifecycle.ts").DispatchHost;
  /** Blocking bar; defaults to MEDIUM. See `DEFAULT_REVIEW_THRESHOLD`. */
  threshold?: Severity;
  /**
   * #912 — caller-supplied branch for the review-ledger write (the driver
   * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
   * recover it). When absent the writer recovers the branch from `HEAD`
   * and skips (traces) on a detached head.
   */
  branch?: string;
  /** #973 — the PR/MR number for the residual-findings disclosure post. */
  pr?: number;
  /** #1127 — the operator bypassed the tool-side round budget; recorded on the ledger entry. */
  overrideCap?: boolean;
  /** #1127 — receives the run's ledger-write promise once the run has finished;
   * the caller holds its round reservation until it settles. */
  onLedgerWrite?: (ledgerWrite: Promise<LensLedgerOutcome>) => void;
  /** #1127 — the round-budget key the tool admitted this run under (lens-budget-key.ts);
   * keys the ledger entry when no branch resolves. */
  ledgerKey?: string;
}

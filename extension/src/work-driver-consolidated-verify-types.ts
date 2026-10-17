/**
 * #1421 — the result shape of the consolidated develop-time verify, split out
 * of `work-driver-consolidated-verify.ts` (which had reached the 500-line cap).
 *
 * It lives here alone because the shape is the module's public contract: the
 * outcome reporter (`work-driver-consolidated-verify-report.ts`) and the smoke
 * tests both import it, and `kind` is what lets them distinguish a genuine
 * cherry-pick conflict from a dirty-root refusal from a build-residue
 * decline — see the field comments for why each distinction exists.
 */

import type { ConsolidatedVerifyRetryDecision } from "./work-driver-consolidated-verify.ts";
import type { DirtReason } from "./work-driver-dirty-root-classify.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

export type ConsolidatedVerifyResult =
  | {
      status: "passed";
      applied: string[];
      /**
       * #1240 — the verify command was NOT run because the cherry-picked
       * probe is byte-identical to the tree that just passed the per-worktree
       * verify. Set to the `{treeHash, worktree}` the caller supplied; the
       * caller renders the visible note from it. Absent on every real run.
       */
      skipped?: AlreadyVerifiedTree;
      recovered?: boolean;
      retryDecision?: ConsolidatedVerifyRetryDecision;
      /**
       * #841 — the absolute path of the run1 log (the consolidated first
       * run that failed and was recovered by the flake re-run). Present only
       * on `recovered: true` results; the caller surfaces it in the recovery
       * note. Absent on a passing run that never failed and on a failed
       * result (where `logPath` on the failed shape carries the run that
       * ended the run).
       */
      logPath?: string;
    }
  | {
      status: "failed";
      detail: string;
      retried?: boolean;
      recovered?: boolean;
      retryDecision?: ConsolidatedVerifyRetryDecision;
      /**
       * #841 — the absolute path of the LAST consolidated-verify run's raw
       * log (the run2 log when `retried === true`, the run1 log otherwise).
       * `undefined` when the write failed (unwritable scratch dir, etc.) —
       * the caller then says the log is unavailable in the evidence string.
       * The ticket asks the path to appear in the cap-hit evidence, so it
       * is threaded here rather than regexed out of `detail`.
       */
      logPath?: string;
      /**
       * #841 — the RAW failure stream of the run that ended the run (the
       * run2 raw stream when `retried === true`, the run1 raw stream
       * otherwise), carried structurally so the caller's classifier reads
       * the same shape a single-run failure reads — without parsing the
       * log path / restore claim back out of `detail` prose.
       */
      rawFailure?: string;
      /**
       * True when the run that ended the run was KILLED at `timeoutMs`
       * rather than exiting non-zero. Its stream stops wherever the kill
       * landed, so it carries no verdict about the code: the caller reports
       * the bound, not an assertion extracted from a truncated stream.
       */
      timedOut?: boolean;
    }
  // #725 — the caller distinguishes a genuine cherry-pick / patch-apply
  // conflict from a dirty-repoRoot preflight refusal via `kind`, not by
  // regexing the `detail` prose (a reworded message used to silently
  // re-route the refusal to the conflict cap). The unlocked body below
  // returns this same shape in both cases.
  // `host` — the consolidation was never attempted because the host could
  // not fork (`/bin/sh: 1: Cannot fork`, `spawn … EAGAIN`). It rides on the
  // refusal shape because nothing was combined or verified, but it is NOT a
  // conflict: a single-workstream cycle was told "two workstreams edited the
  // same lines" when the only thing that failed was `git status`.
  // #1421 — `build-residue`: the gate DECLINED to refuse. The root carried
  // only untracked paths git itself declares ignored (cargo's `target/`, a
  // bundler's `dist/`, the driver's own scratch) — build output, not content a
  // checkout can move or a staging read can sweep. The consolidated run went
  // ahead, and the outcome is reported so the caller can give the cycle an
  // environment cap rather than `verify-failed:develop`. Distinct from
  // `dirty-root` (real dirt — the batch is still refused) and from `host`.
  | {
      status: "conflict";
      detail: string;
      kind: "conflict" | "dirty-root" | "host" | "build-residue";
      /** The residue paths, unquoted. Present on `build-residue` only. */
      residuePaths?: string[];
      /** Why each path is not this cycle's problem, same order. */
      residueReasons?: DirtReason[];
      /**
       * #1421 fix round — TRUE only when the root held NOTHING but residue:
       * every non-residue line the gate considered had already been dropped as
       * driver-managed or configured-exempt, so the residue alone is why the
       * batch was declined. A decline sitting beside dirt the gate charged, or
       * one unblocked by an exemption, does NOT carry the environment cap —
       * which is why the caller reads THIS field instead of matching a
       * substring out of `detail` (an operator path named
       * `build/[build-residue].log` is prose the router must never route on).
       */
      buildResidueOnly?: boolean;
    };

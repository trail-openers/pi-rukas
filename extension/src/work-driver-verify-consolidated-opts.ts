/**
 * work-driver-verify-consolidated-opts — builds the consolidated verify
 * probe's options, split out of `work-driver-verify-verify-cmd.ts`.
 *
 * Why this seam: `runVerifyCommandGate` had grown past the 500-line cap
 * AGENTS.md §12 enforces, and the single largest block in it was this typed
 * options literal plus its conditional-field spread. It is the right thing to
 * move: it starts no process, decides nothing about ordering, and its whole
 * job is to name each `ConsolidatedVerifyOpts` field once. The two execution
 * legs (per-worktree, consolidated) and the #782 flake-retry precondition stay
 * in the gate, where their ordering and the #1427 hang-report sink are
 * load-bearing and were not what overflowed the cap.
 *
 * The literal stays TYPED. That is the point of #1427's fix and the reason
 * this builder takes a parameter object rather than spreading a bag: a key that
 * does not exist on `ConsolidatedVerifyOpts` is a compile error in both files,
 * not a silently dropped option. The original defect was exactly that —
 * `{ onWalk: … }` named a field that existed nowhere, the probe fell back to
 * the real `ps`, and the hang report described whatever else was on the host.
 *
 * Import chain: work-driver-verify-verify-cmd.ts → this file →
 * work-driver-consolidated-verify-types.ts (a type-only import; no runtime
 * edge, so no cycle with the module that runs the probe).
 */

import type {
  ConsolidatedVerifyOpts,
  ConsolidatedVerifyResult,
} from "./work-driver-consolidated-verify-types.ts";
import { sharesAssertion } from "./work-driver-consolidation-classify.ts";
import type { HangProcess } from "./work-driver-gate-hang.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

/** Everything the options literal is assembled from, all resolved by the gate. */
export interface ConsolidatedOptsInput {
  repoRoot: string;
  baseSha: string;
  /** The `pipelineState.worktrees` map the probe cherry-picks from; forwarded
   *  to the probe's `worktrees` field, which is where it belongs. */
  stateWorktrees: Record<string, string>;
  workstreamBaseShas: Record<string, string> | undefined;
  scratchDir: string;
  verifyCmd: string;
  /** The suite tier's bound, resolved ONCE by the caller and threaded here. */
  timeoutMs: number;
  /** #1509 — the knob a consolidated timeout failure names. */
  suiteTimeoutKnob?: string;
  /** #1509 — the fast tier's own bound, when the caller resolved one. */
  fastTierTimeoutMs?: number;
  /** #1240 — the N=1 tree that already passed, when there is one. */
  alreadyVerifiedTree?: AlreadyVerifiedTree;
  /** #1362 — the project's dirty-root exemption list. `readonly` to match
   *  `ConsolidatedVerifyOpts`, which declares it so. */
  dirtyRootExempt?: readonly string[];
  /** #1427 — injectable walker; production omits it and the real `ps` runs. */
  walkProcessTree?: (leaderPid: number) => {
    processes: HangProcess[];
    treeUnavailable?: string;
  };
  /** The two-phase flake-retry gate, computed by the caller (#782/#807/#826). */
  retry: ConsolidatedVerifyOpts["retry"];
  /** Unused here; carried so the caller's spread stays a single object. */
  fenceViolations?: FenceViolationRecord[];
}

/**
 * The two-phase flake-retry gate (#782/#807/#826), built from the ONE
 * per-worktree assertion the caller extracted.
 *
 * (1) a length-only precondition admits the FIRST consolidated run — it fires
 * when this is a genuine consolidation (N>1) AND the per-worktree failures are
 * at most one (zero = the #782 shape; one = a possible flake, the #798 shape
 * where a timing-flaky test failed in a worktree AND on the combined tree —
 * one unstable test, not two independent defects). The consolidated assertion
 * is not known before the run, so nothing more can be checked up front.
 *
 * (2) the RE-RUN is decided by onFirstFailure against the RAW first-run
 * failure (deliberately raw: the elided detail can drop the ✗ line — see #827
 * — while the classifier compares the elided detail): a KNOWN per-worktree
 * assertion that the first run does NOT share is suppressed (a single
 * per-worktree failure with a different assertion is a genuine defect — the
 * re-run would burn a full verify run and could mask it, the #821 defect); a
 * SHARED assertion or an UNKNOWN (unextractable) one ALLOWS the re-run
 * (pre-#826 behaviour for the unknown case). The decision is computed ONCE in
 * onFirstFailure and reported on the result as `retryDecision` — the post-run
 * notes are rendered from it, not from a second comparator call.
 *
 * `singlePerAssertion` is three-state on purpose (#807): `undefined` = no
 * per-worktree failure to compare against, `null` = a failure whose assertion
 * could not be extracted (honest absence, treated as unknown, NOT as a
 * mismatch), a string = a known assertion. Collapsing `null` into `undefined`
 * would suppress re-runs the gate is meant to allow.
 */
export function buildConsolidatedRetry(args: {
  /** Phase-1 precondition, computed by the caller from failure/worktree counts. */
  canRetry: boolean;
  singlePerAssertion: string | null | undefined;
  /** Fires the caller's own note plus its `onVerifyFlakeRecovered` callback. */
  onRecover: (evidenceTail?: string) => void;
}): ConsolidatedVerifyOpts["retry"] {
  const { canRetry, singlePerAssertion, onRecover } = args;
  return {
    canRetry,
    onFirstFailure: (raw: string) => {
      if (singlePerAssertion === undefined) {
        return { allowed: true, decision: "allowed-no-per-worktree-failure" };
      }
      if (singlePerAssertion === null) {
        return { allowed: true, decision: "allowed-unknown" };
      }
      return sharesAssertion(raw, singlePerAssertion)
        ? { allowed: true, decision: "allowed-shared" }
        : { allowed: false, decision: "suppressed-mismatch" };
    },
    // #841 — onRecover fires BEFORE the run result is available, so the log
    // path is not in scope here. The post-run pass in the gate (the
    // `cons.recovered === true` branch) surfaces the run1 log path in its own
    // note, which is the one the operator actually reads when the gate
    // proceeds after recovery. The decision note likewise rides on the
    // recorded `retryDecision` AFTER the consolidated run, where the same
    // value also drives the failed-path notes — one read, no closure cell.
    onRecover,
  };
}

/**
 * Assemble the probe's options. Conditional fields are spread rather than set
 * to `undefined`, so an absent option is ABSENT — the probe distinguishes
 * "the caller resolved a fast-tier bound" from "the caller passed one that is
 * undefined", and a `: undefined` field would collapse the two.
 */
export function buildConsolidatedVerifyOpts(input: ConsolidatedOptsInput): ConsolidatedVerifyOpts {
  const {
    repoRoot,
    baseSha,
    stateWorktrees,
    workstreamBaseShas,
    scratchDir,
    verifyCmd,
    timeoutMs,
    suiteTimeoutKnob,
    fastTierTimeoutMs,
    alreadyVerifiedTree,
    dirtyRootExempt,
    walkProcessTree,
    retry,
  } = input;
  return {
    repoRoot,
    baseSha,
    worktrees: stateWorktrees,
    // #794 — own-range selection: a stacked workstream's range is measured
    // against its dependency's tip, so its ancestor commits are not re-picked
    // on top of their content (the #775 replay).
    workstreamBaseShas,
    scratchDir,
    verifyCmd,
    timeoutMs,
    // #1509 — the reporter renders the consolidated timeout string and must
    // name the knob that governed THIS run, not re-read one from the tier map.
    ...(suiteTimeoutKnob !== undefined ? { suiteTimeoutKnob } : {}),
    // #1509 — the fast tier's bound reaches the executor through the wrapper
    // the caller built, so the reporter needs nothing more than the knob above.
    ...(fastTierTimeoutMs === undefined ? {} : { fastTierTimeoutMs }),
    // #1240 — the N=1 duplicate run: same tree, same verdict.
    ...(alreadyVerifiedTree !== undefined ? { alreadyVerifiedTree } : {}),
    // #1362 — the repoRoot dirty-root preflight inside honours the project's
    // exemption list, so a tool's local file no longer refuses the batch.
    dirtyRootExempt,
    // #1427 fix round — the walker is forwarded under the field
    // `ConsolidatedVerifyOpts` actually declares. It used to be spread onto the
    // REPORTING call under a name that exists nowhere (`onWalk`), so the probe
    // silently fell back to the real `ps` and the report described whatever
    // else was on the host.
    ...(walkProcessTree !== undefined ? { walkProcessTree } : {}),
    retry,
  };
}

/** Re-exported so the gate's reporting call keeps naming the result type from
 *  one place rather than importing it from two modules. */
export type { ConsolidatedVerifyResult };

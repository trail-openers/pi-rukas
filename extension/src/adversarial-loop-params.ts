/**
 * adversarial-loop-params — the parameter shape of `runAdversarialLoop`, split
 * out of `adversarial.ts` for the 500-line gate (AGENTS.md §12).
 *
 * The loop's contract with its two callers — the `adversarial_loop` tool and the
 * /work driver — is load-bearing and mostly PROVENANCE: several fields are set
 * only at one boundary and must never be inferred from the shape of the others.
 * Each such field says so here, at the declaration, because the distinction is
 * what the #912 merge guard and #1360's ledger bindings rest on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FixFence } from "./adversarial-fix-guard.ts";
import type { ReportPolicy } from "./adversarial-policy.ts";
import type { SiblingScope } from "./adversarial-prompts.ts";
import type { VerdictReaskFn } from "./adversarial-verdict-reask.ts";
import type { RunningState } from "./progress.ts";
import type { OnSlowCallback } from "./slow-notice.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The provenance type behind `AdversarialLoopParams.toolPath`.
 *
 * `string` rather than `true` is the point: a literal `true` widens to `boolean`
 * through an untyped spread, so a caller passing `toolPath: false` in its raw
 * args could clear the marker and take the row off the bindings. A string the
 * runtime never produces anywhere else cannot be forged by a caller that has
 * not read this source — which is what makes the marker a provenance claim
 * rather than a suggestion.
 *
 * The value is minted by `TOOL_PATH_PROVENANCE` in `adversarial-tool.ts` and
 * nothing else; `isToolPathProvenance` is the only reader.
 */
export type ToolPathProvenance = "adversarial-loop-tool";

/** Narrow an unknown provenance marker. The ONLY way to satisfy `toolPath` for
 * a caller that cannot import the mint site. */
export function isToolPathProvenance(value: unknown): value is ToolPathProvenance {
  return value === ("adversarial-loop-tool" as const satisfies ToolPathProvenance);
}

/**
 * The loop's parameters. `ReportPolicy` is a discriminated union (the reportOnly
 * shape must be mutually exclusive with the routed-round shape), so it is
 * intersected rather than extended.
 */
export type AdversarialLoopParams = ReportPolicy & {
  /** Optional when `base` + `head` are present (computed from the ref
   * range). When both `diff` and base/head are given, the string wins. */
  diff?: string;
  /** #1040 — git timeout for the comment-loss check (the driver passes verifyTimeoutMs()). */
  commentTimeoutMs?: number;
  /** #1040 — injected git seam for the comment-loss check (the driver passes its verify exec). */
  commentExecFn?: ExecFn;
  /** #859 — the base ref the tool computes the diff from (with head). */
  base?: string;
  /** #859 — the head ref the tool computes the diff from (with base). */
  head?: string;
  context: string;
  workCwd?: string;
  /** Recompute the diff before each review. Without it rounds 2+ see pre-fix material. */
  getDiff?: () => Promise<string>;
  /** What the fix pass before this review changed (fix-delta.ts); first round only. */
  fixDelta?: string;
  /** The issue this diff is meant to satisfy (#278). Optional: older state files have none. */
  issueBody?: string;
  /**
   * The issue's acceptance criteria, rendered by the lean review step's spec
   * split so they reach the reviewer in their own section — the bounded
   * `issueBody` is the issue's prose with its `pi-spec` block stripped, and one
   * bound over both used to cut whichever arrived second. Set ONLY by lean's
   * review step (`lean/review-deps.ts`); the /work driver and the tool path
   * leave it absent and their prompts stay byte-identical.
   */
  reviewCriteria?: string;
  /** The gate the driver already ran green on this tree; the reviewer is told not to re-run it. */
  gateCmd?: string;
  /** #799 — the slow-run recorder for this loop's inner children (each
   * threshold crossing of a review / fix round appends dispatch-slow), and
   * the parent pi for their slow-run watch (the PM notice half). */
  onSlow?: OnSlowCallback;
  pi?: ExtensionAPI;
  processGroup?: boolean;
  /** #1666 — a headless /work cycle's review and fix children run under trust. */
  workCycleTrust?: boolean;
  /** #912 — caller-supplied branch for the review-ledger write (the driver
   * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
   * recover it). When absent the writer recovers the branch from `HEAD`
   * and skips (traces) on a detached head. */
  branch?: string;
  /** #1114 — the round number a reportOnly review carries (prompt + record). Default 1. */
  reportRound?: number;
  /**
   * #1137 — the workstream scope the review is judged within. Present only
   * on the per-workstream driver path (N>1 fan-out); absent on N=1 and on
   * the `adversarial_loop` tool path, where the whole issue is the scope
   * and the prompt is byte-identical to the pre-#1137 one.
   */
  scope?: { own?: SiblingScope; siblings: readonly SiblingScope[] };
  /**
   * #1104 — the tool path's caller-repo fence. Set ONLY at the tool boundary
   * (`adversarial-tool.ts`) with the calling process's cwd; the /work driver
   * leaves it unset, because its caller is the integration checkout it
   * mutates itself. A fix round needs `workCwd` on every path.
   */
  fixFence?: FixFence;
  /**
   * #1161 — set ONLY by the adversarial_loop tool when the caller pasted a
   * `diff` string. Such a review is recorded in the review ledger as
   * "<outcome> (caller-supplied diff)" and never counts as a passing adversarial review.
   */
  callerSuppliedDiff?: boolean;
  /**
   * #1360 — set ONLY by the adversarial_loop tool, after the raw params
   * spread (so a caller cannot spoof it). It is the provenance discriminator
   * for the ledger's range/head/tree bindings: only a tool-path row may be
   * refused by them, so the /work driver's `diff` + `getDiff` reviews keep
   * their identity and keep recording passing rows. Provenance is never
   * inferred from the presence of a `diff` string.
   *
   * Branded (see `ToolPathProvenance`): the mint site is
   * `TOOL_PATH_PROVENANCE` in `adversarial-tool.ts`, so a raw arg carrying
   * `toolPath: false` cannot widen into this field and clear the marker.
   * The driver path never sets it and runs no capture at all.
   */
  toolPath?: ToolPathProvenance;
  /**
   * The REVIEWER's wall clock in ms. Set ONLY by lean's review step (the
   * `adversarial` seam in `lean/review-deps.ts`), which is what makes `budgets
   * .review.minutes` real for the reviewer child; the other two callers — the
   * `adversarial_loop` tool and the /work driver — never set it and keep the
   * reviewer's own `PI_ENSEMBLE_ADVERSARIAL_BOUND_MS` knob untouched. It can
   * only ever TIGHTEN that knob: the phase takes the smaller of the two.
   * Asserted on the value the child received in
   * `test-adversarial-reviewer-budget.ts` (and `test-adversarial-reviewer-bound.ts`).
   */
  childBoundMs?: number;
  /**
   * #2644 — the caller's armed hung-request window, in whole minutes. Set ONLY by lean's review
   * step, beside {@link AdversarialLoopParams.childBoundMs}, and for the same reason: the phase
   * builds the reviewer's spawn options itself, so an arm the caller armed has to arrive as data.
   * Reviewer-only, like `childBoundMs`. Unlike the bound it does not clamp — there is no reviewer
   * knob for a hung request, so the step's value is the child's value.
   */
  stallWindowMinutes?: number;
  /**
   * #2660 — the caller's deadline-derived CHILD-BOUND GRACE, in ms, beside
   * {@link AdversarialLoopParams.childBoundMs}. Reviewer-only like the bound, read ONLY by the
   * reviewer branch, and it can only TIGHTEN the configured grace. Set in ms rather than whole
   * minutes because `lean-step-bound.ts` floors a deadline-derived grace at `MIN_KILL_GRACE_MS`
   * (30 s) — a value minutes cannot carry, and one the bound was PLACED against: the bound is
   * derived as `room − grace`, so a grace rounded elsewhere moves the wrap-up steer off the
   * position that bound was computed for. `childBoundSchedule` still clamps `bound + grace`
   * against the cycle clock exactly once, whatever this says.
   */
  childBoundGraceMs?: number;
  /**
   * An extra abort for the reviewer child. Set ONLY by lean's review step, so
   * `budgets.review.turns` / `tokens` can stop a runaway reviewer at a turn
   * boundary. Reviewer-only, like {@link AdversarialLoopParams.childBoundMs}:
   * the fix-pass arm keeps no budget arms, which is what
   * `test-adversarial-reviewer-bound.ts` asserts.
   */
  signal?: AbortSignal;
  /**
   * A progress hook composed with (never replacing) the deck / slow-run feed
   * the phase already installs. Set ONLY by lean's review step — it is what
   * measures the turns / tokens levers and aborts the child through
   * {@link AdversarialLoopParams.signal}. Both arms are asserted on what the
   * child received in `test-adversarial-reviewer-budget.ts`.
   */
  onProgress?: (s: RunningState) => void;
  /**
   * The re-ask seam: how a round whose reviewer signed no readable verdict asks
   * its own session for the verdict line. Set ONLY by the offline tests; every
   * production caller leaves it absent and gets {@link spawnVerdictReaskChild}
   * — a real `pi` child on the reviewer's session file. It exists as a param
   * rather than a module mock because `assertLiveSpawnAllowed` refuses a real
   * adversarial spawn, and the re-ask is the one dispatch of the round a smoke
   * test must be able to script without scripting the reviewer too. Because it
   * is a FUNCTION, the `adversarial_loop` tool strips it from raw args (the tool
   * schema has no such property) so no caller can install its own reader at the
   * seam a verdict is decided on — the same treatment the budget arms get.
   */
  verdictReask?: VerdictReaskFn;
};

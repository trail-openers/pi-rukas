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
};

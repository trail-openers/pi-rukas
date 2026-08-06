/**
 * work-queue — the multi-issue `/work` queue and what happens when a group fails.
 *
 * Extracted from commands.ts (#368; also keeps that file under the 500-line
 * cap and gives #289's bounded pool somewhere to live).
 *
 * Pre-#368 the loop returned on any non-`merged` status, so one issue's
 * failure stopped every unrelated issue behind it. Observed on this machine:
 * `/work` over 13 issues died on #279 and left **11 groups unstarted**; a
 * three-issue batch halted on its second item while the third was unrelated
 * and independently ready. Since 69% of the failures that trigger this are
 * provider infrastructure (#366), the queue was usually being stopped by
 * something with no bearing on the remaining work.
 *
 * The replacement is dead-letter-queue semantics — three destinations, not
 * two — and the whole design rests on one question: *is the next group likely
 * to fail for the same reason?*
 *
 *   merged  → continue
 *   parked  → issue-scoped failure; record why, continue
 *   halted  → systemic; continuing would burn every remaining issue against
 *             the same wall (spend cap, quota window, driver throw)
 */

import { trace } from "./trace.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";
import type { GroupingResult } from "./work-driver-grouping.ts";

/** One entry of `groupIssues()`'s result — the unit the queue iterates. */
export type IssueGroup = GroupingResult["groups"][string];
import { type WorkState, readState } from "./workflow-state.ts";

/** #368 escape hatch: PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE=1 restores halt-on-first-failure. */
export function queueHaltOnFailure(): boolean {
  const v = process.env.PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE;
  return v === "1" || v === "true";
}

export interface QueueEntry {
  groupId: string;
  issues: number[];
  outcome: "merged" | "parked" | "halted";
  /** Operator-facing why, for parked/halted. */
  reason?: string;
  /** The step the cycle died on, when known — enough to re-drive it. */
  failedStep?: string;
  /** What the operator has to do. Never "it failed"; always an action. */
  humanAction?: string;
}

export interface QueueSummary {
  entries: QueueEntry[];
  merged: number;
  parked: number;
  /** Groups never started because the queue halted. */
  notStarted: string[];
}

/**
 * Decide whether a finished group's failure is systemic.
 *
 * Systemic means "the next group will hit this too": a spend cap, or a quota
 * window that nothing will get past until it resets. Everything else — a
 * review cap, an adversarial rejection, a dirty tree, a transport blip that
 * exhausted its retries — is this issue's problem, not the queue's.
 */
export function isSystemicFailure(state: WorkState | undefined): {
  systemic: boolean;
  reason?: string;
} {
  if (!state) return { systemic: false };
  const lastFailure = [...state.eventLog]
    .reverse()
    .find((e) => e.kind === "dispatch-failed-provider" || e.kind === "dispatch-failed");
  if (!lastFailure) return { systemic: false };
  const cls = classifyFailureCause(lastFailure as Parameters<typeof classifyFailureCause>[0]);
  if (cls.cause === "rate-limited:quota-terminal") {
    return {
      systemic: true,
      reason: "provider spend cap reached — every remaining group would fail the same way",
    };
  }
  if (cls.cause === "rate-limited:quota-window") {
    const hours = Math.round((cls.waitMs ?? 0) / 3_600_000);
    return {
      systemic: true,
      reason: `provider quota window — nothing will succeed for roughly ${hours}h, so the rest of the queue would only burn attempts`,
    };
  }
  return { systemic: false };
}

/** The reason a non-merged cycle stopped, read back off its state file. */
function parkReason(state: WorkState | undefined): { reason: string; failedStep?: string } {
  if (!state) return { reason: "cycle produced no state file" };
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const step = state.pipelineState.lastCompletedStep ?? state.pipelineState.currentStep;
  if (cap?.kind === "cap-hit") return { reason: `cap ${cap.cap}`, failedStep: step };
  return { reason: `cycle ended as ${state.pipelineState.status}`, failedStep: step };
}

/**
 * Human action for a parked group. The SRE rule is that a notification must
 * name what the human should do that the system cannot do itself; "it failed"
 * is not that. If we cannot name an action, we say so plainly rather than
 * inventing one.
 */
export function humanActionFor(reason: string, primary: number): string {
  if (/existing-pr-detected/.test(reason)) {
    return `decide whether to resume, retarget or close the open PR for #${primary}`;
  }
  if (/explore-needs-clarification|step-back-revise-spec/.test(reason)) {
    return `revise the body of #${primary} — the spec is underspecified`;
  }
  if (/explore-already-complete/.test(reason)) return `confirm and close #${primary}`;
  if (/explore-bodies-empty/.test(reason))
    return "fix the gh setup (`gh auth status`), then re-run";
  if (/round-cap|adversarial-loop|wall-clock/.test(reason)) {
    return `review the findings on #${primary}'s PR — the fix loop did not converge`;
  }
  if (/verify-failed/.test(reason))
    return `inspect #${primary}'s diff — the outcome gate rejected it`;
  return `inspect .pi/work-state/${primary}.json and re-run \`/work ${primary} --restart\``;
}

/** Render the end-of-queue report. One entry per group; no per-step noise. */
export function renderQueueSummary(s: QueueSummary): string {
  const lines = [
    `pi-ensemble: /work queue finished — ${s.merged} merged, ${s.parked} parked${
      s.notStarted.length > 0 ? `, ${s.notStarted.length} not started` : ""
    }`,
  ];
  for (const e of s.entries) {
    const issues = `#${e.issues.join(", #")}`;
    if (e.outcome === "merged") {
      lines.push(`  ✓ ${e.groupId} (${issues}) — merged`);
    } else if (e.outcome === "parked") {
      lines.push(
        `  ⏸ ${e.groupId} (${issues}) — ${e.reason}${e.failedStep ? ` at ${e.failedStep}` : ""}`,
      );
      if (e.humanAction) lines.push(`      → ${e.humanAction}`);
    } else {
      lines.push(`  ✗ ${e.groupId} (${issues}) — ${e.reason} · queue halted here`);
    }
  }
  if (s.notStarted.length > 0) {
    lines.push(`  Not started: ${s.notStarted.join(", ")}`);
  }
  return lines.join("\n");
}

export interface RunQueueOpts {
  repoRoot: string;
  groups: IssueGroup[];
  restart: boolean;
  /** Runs one group's cycle. Injected so the offline suite never spawns Pi. */
  runGroup: (primary: number, issues: number[] | undefined) => Promise<void>;
  /** Groups to run at once. Defaults to 1 (strictly sequential). */
  concurrency?: number;
  readStateFn?: (repoRoot: string, issue: number) => Promise<WorkState | undefined>;
}

/**
 * Run every group, parking failures instead of halting on them.
 *
 * A driver throw still halts: an unknown-shape failure is not safe to
 * continue past, because we cannot tell whether it left the repo in a state
 * the next group depends on.
 */
export async function runWorkQueue(opts: RunQueueOpts): Promise<QueueSummary> {
  const read = opts.readStateFn ?? readState;
  const groups = opts.groups;
  // Keyed by original index so the summary is deterministic regardless of the
  // order groups actually finish in.
  const entries = new Map<number, QueueEntry>();
  const claimed = new Set<string>();
  let cursor = 0;
  let halted = false;

  const cap = Math.max(1, Math.min(opts.concurrency ?? 1, groups.length || 1));

  /**
   * One worker: claim the next unclaimed group, run it to completion, repeat.
   * `cursor++` is atomic because JS is single-threaded — the claim happens
   * between awaits, never across one.
   */
  async function worker(): Promise<void> {
    for (;;) {
      if (halted) return;
      const gi = cursor;
      cursor += 1;
      if (gi >= groups.length) return;
      const g = groups[gi];
      if (!g) continue;
      const primary = g.issues[0];
      if (primary === undefined) continue;
      claimed.add(g.id);

      let threw: Error | undefined;
      try {
        await opts.runGroup(primary, g.issues.length > 1 ? g.issues : undefined);
      } catch (err) {
        threw = err as Error;
      }

      if (threw) {
        // A driver throw is an unknown-shape failure: we cannot tell whether
        // it left the repo in a state the next group depends on.
        halted = true;
        entries.set(gi, {
          groupId: g.id,
          issues: g.issues,
          outcome: "halted",
          reason: `driver crashed: ${threw.message?.slice(0, 200)}`,
          humanAction: `inspect .pi/work-state/${primary}.json, or re-run with PI_ENSEMBLE_WORK_DRIVER=0`,
        });
        // Return from THIS worker only. Siblings already mid-cycle drain to
        // completion — abandoning a group halfway through commit-pr would
        // leave exactly the debris the halt exists to avoid.
        return;
      }

      const state = await read(opts.repoRoot, primary).catch(() => undefined);
      if (state?.pipelineState.status === "merged") {
        entries.set(gi, { groupId: g.id, issues: g.issues, outcome: "merged" });
        continue;
      }

      const { reason, failedStep } = parkReason(state);
      const systemic = isSystemicFailure(state);
      if (systemic.systemic || queueHaltOnFailure()) {
        halted = true;
        entries.set(gi, {
          groupId: g.id,
          issues: g.issues,
          outcome: "halted",
          reason: systemic.reason ?? reason,
          failedStep,
          humanAction: humanActionFor(reason, primary),
        });
        return;
      }

      trace(`work-queue: parking ${g.id} (${reason}) and continuing`);
      entries.set(gi, {
        groupId: g.id,
        issues: g.issues,
        outcome: "parked",
        reason,
        failedStep,
        humanAction: humanActionFor(reason, primary),
      });
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return finish(entries, groups, claimed);
}

function finish(
  entries: Map<number, QueueEntry>,
  groups: IssueGroup[],
  claimed: Set<string>,
): QueueSummary {
  // Never-claimed, not "everything after the last index". With K workers
  // groups complete out of order, so a positional slice would report groups
  // that actually ran as skipped — and miss ones that genuinely were.
  const notStarted = groups
    .filter((g) => !claimed.has(g.id))
    .map((r) => `${r.id} (#${r.issues.join(", #")})`);
  // Ordered by original group index so the report reads the same every run.
  const ordered = [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  // A systemic fault hits every in-flight group at once, so K workers can each
  // record a halt for the same cause. Tell the operator once.
  const halts = ordered.filter((e) => e.outcome === "halted");
  const deduped =
    halts.length > 1 ? ordered.filter((e) => e.outcome !== "halted" || e === halts[0]) : ordered;
  return {
    entries: deduped,
    merged: deduped.filter((e) => e.outcome === "merged").length,
    parked: deduped.filter((e) => e.outcome === "parked").length,
    notStarted,
  };
}

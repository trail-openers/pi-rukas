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

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";
import type { GroupingResult } from "./work-driver-grouping.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import { notify } from "./work-notify.ts";

/** One entry of `groupIssues()`'s result — the unit the queue iterates. */
export type IssueGroup = GroupingResult["groups"][string];
import { type WorkState, readState, workStateDir } from "./workflow-state.ts";

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
  // #386 — the failure that matters is the one that ENDED the cycle, not the
  // most recent one of its kind. The driver retries transient faults, so a
  // cycle can hit a quota window at `explore`, recover, run for another
  // twenty minutes, and then park for an unrelated semantic reason. Reading
  // the last failure unconditionally found the recovered quota event and
  // halted every remaining group — the exact outcome #368 exists to prevent,
  // arriving by a different route. A failure followed by a successful
  // `dispatch-completed` was recovered and does not count.
  let lastFailure: WorkState["eventLog"][number] | undefined;
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (!e) continue;
    if (e.kind === "dispatch-completed") break;
    if (e.kind === "dispatch-failed-provider" || e.kind === "dispatch-failed") {
      lastFailure = e;
      break;
    }
  }
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
  if (cap?.kind === "cap-hit") {
    // Carry the intent park's specific reason, so humanActionFor and the
    // summary can be specific rather than saying "cap intent-park".
    let suffix = "";
    if (cap.cap === "intent-park" && state.pipelineState.normalisedSpec?.parkReason) {
      suffix = `:${state.pipelineState.normalisedSpec.parkReason}`;
    } else if (cap.cap === "awaiting-human-merge") {
      // #380 — carry the PR number and whether authority was the blocker, so
      // the action can name the PR instead of pointing at a state file.
      const granted = state.pipelineState.mergeHold?.authorityGranted ? "granted" : "no-authority";
      suffix = `:${granted}:pr${state.pipelineState.prNumber ?? 0}`;
    }
    return { reason: `cap ${cap.cap}${suffix}`, failedStep: step };
  }
  return { reason: `cycle ended as ${state.pipelineState.status}`, failedStep: step };
}

/**
 * Human action for a parked group. The SRE rule is that a notification must
 * name what the human should do that the system cannot do itself; "it failed"
 * is not that. If we cannot name an action, we say so plainly rather than
 * inventing one.
 */
export function humanActionFor(reason: string, primary: number): string {
  // #378 — intent parks carry their own specific action; the generic
  // "inspect the state file and --restart" fallback is useless here, because
  // re-running an unresolvable issue unchanged produces the same park.
  const intentPark = reason.match(/intent-park(?::([a-z-]+))?/);
  if (intentPark) {
    return parkAction((intentPark[1] ?? "underspecified") as ParkReason, primary);
  }
  // #380 — the PR is open, green and pushed; the only thing missing is a human
  // decision. Telling the operator to `--restart` here would rebuild work that
  // is already done and open a duplicate PR.
  const heldMerge = reason.match(/awaiting-human-merge:(granted|no-authority):pr(\d+)/);
  if (heldMerge) {
    const pr = Number(heldMerge[2]) > 0 ? `#${heldMerge[2]}` : `the PR for #${primary}`;
    return heldMerge[1] === "granted"
      ? `check the incomplete required checks on ${pr}, then merge`
      : `review and merge ${pr} yourself — agent merging is not permitted in this project (grant it in AGENTS.md or re-run with --merge)`;
  }
  // #380 — `--restart` after a failed merge wipes the state file but NOT the
  // open PR, so the re-run halts immediately on the pre-flight (#362). The
  // work is committed and pushed; the merge is the only thing left.
  if (/step-failed:merged/.test(reason)) {
    return `merge #${primary}'s PR by hand — the branch is pushed and the work is done (do NOT --restart: the open PR would halt the re-run)`;
  }
  if (/lens-diff-unreadable/.test(reason)) {
    return `check that #${primary}'s branch is pushed and \`git fetch origin --prune\` is current — the review could not read the diff`;
  }
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
        const crashAction = `inspect .pi/work-state/${primary}.json, or re-run with PI_ENSEMBLE_WORK_DRIVER=0`;
        entries.set(gi, {
          groupId: g.id,
          issues: g.issues,
          outcome: "halted",
          reason: `driver crashed: ${threw.message?.slice(0, 200)}`,
          humanAction: crashAction,
        });
        await notify({
          kind: "crashed",
          issues: g.issues,
          reason: threw.message?.slice(0, 160) ?? "driver threw",
          action: crashAction,
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
        await notify({
          kind: "halted",
          issues: g.issues,
          reason: systemic.reason ?? reason,
          action: humanActionFor(reason, primary),
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
      // #388 — one notification per parked group, carrying the action rather
      // than the event. A merged group is never notified: nothing is asked
      // of the operator, and a hook that fires on success is noise.
      await notify({
        // #380's hold is not a failure — the work is done and only the merge
        // is waiting, so it reads differently on a lock screen.
        kind: /awaiting-human-merge/.test(reason) ? "awaiting-merge" : "parked",
        issues: g.issues,
        reason,
        action: humanActionFor(reason, primary),
      });
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  const summary = finish(entries, groups, claimed);
  // #382 — the summary is the most actionable state the run produces: which
  // groups parked, why, and what a human has to do about each. It used to
  // exist only in the scrollback of the session that produced it, so walking
  // away and coming back meant it was gone. Best-effort: a failed write must
  // not turn a completed queue into an error.
  await writeQueueSummary(opts.repoRoot, summary);
  return summary;
}

/** Where the last queue run's outcome is kept, for `/work-status` and `/start`. */
export function queueSummaryPath(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), "queue-summary.json");
}

/** Persist the queue outcome so it survives the session that produced it. */
export async function writeQueueSummary(
  repoRoot: string,
  summary: QueueSummary,
  at = Date.now(),
): Promise<void> {
  const file = queueSummaryPath(repoRoot);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // tmp+rename so a crash mid-write cannot leave a half-parsed summary
    // where a whole one is expected.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ at, ...summary }, null, 2));
    await fs.rename(tmp, file);
  } catch (err) {
    trace(`work-queue: could not persist queue summary: ${(err as Error).message?.slice(0, 160)}`);
  }
}

/** Read back the last queue run's outcome, or undefined if there is none. */
export async function readQueueSummary(
  repoRoot: string,
): Promise<(QueueSummary & { at: number }) | undefined> {
  try {
    const raw = await fs.readFile(queueSummaryPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as QueueSummary & { at: number };
    return Array.isArray(parsed.entries) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

/**
 * work-driver-adversarial-fix — #1114: the adversarial gate reviews, the
 * develop step fixes.
 *
 * The adversarial step no longer edits anything. Each driver round is one
 * reportOnly review per workstream (adversarial.ts `reportOnly`). A parsed
 * ISSUES_FOUND / CRITICAL_ISSUES_FOUND at a non-terminal round routes that
 * workstream back to develop as a FIX PASS: the findings travel into the
 * developer prompt as data, the pass reuses the workstream's worktree, and
 * every develop gate runs on the result exactly as on a first pass. Then the
 * workstream returns to adversarial for a re-review. Approved workstreams are
 * neither re-developed nor re-reviewed.
 *
 * This module owns the event-log reading (round counts, pending fixes), the
 * per-round interpretation of a reportOnly result, and the fix pass itself.
 * Leaf for the adversarial step: it imports develop's topological core but
 * never the adversarial handlers, so there is no import cycle.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { decideLoopAction } from "./adversarial-verdict.ts";
import { MAX_ROUNDS } from "./adversarial.ts";
import { roundComments } from "./comment-evidence.ts";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { runDevelopTopological } from "./work-develop-topological.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchDiff } from "./work-driver-diff.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import { beginDispatch } from "./work-driver-resume.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { execp as argvExecp } from "./work-driver-verify.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);
type FixExec = NonNullable<DriverContext["verifyExecFn"]> | typeof execp;

/** Bound on the findings carried in an event / the fix prompt (state-file hygiene). */
export const FIX_FINDINGS_MAX = 4000;

/** A workstream id as the event log keys it (N=1 rounds carry no workstreamId). */
const keyOf = (workstreamId: string | undefined): string => workstreamId ?? "default";

export interface PendingFix {
  workstreamId: string;
  round: number;
  findings: string;
}

/**
 * The review track of one workstream, read from the cycle's event log:
 * `rounds` counts PARSED reviews only (an infra-failed round never counts
 * toward the cap). `needsReview` is true before the first parsed review, and
 * after a fix pass has been applied since the last review.
 */
export function reviewTrack(
  eventLog: readonly WorkEvent[],
  workstreamId: string,
): { rounds: number; needsReview: boolean } {
  let rounds = 0;
  let lastRound = -1;
  let lastApplied = -1;
  eventLog.forEach((e, i) => {
    if (e.kind === "adversarial-round" && keyOf(e.workstreamId) === workstreamId) {
      if (e.verdictParsed) {
        rounds++;
        lastRound = i;
      }
    } else if (e.kind === "adversarial-fix-applied" && e.workstreamId === workstreamId) {
      lastApplied = i;
    }
  });
  return { rounds, needsReview: rounds === 0 || lastApplied > lastRound };
}

/**
 * The workstreams this adversarial invocation reviews. A lens-fix re-review
 * reviews everything (the lens-fix changed the diff), and carries the final
 * round so the gate is decided rather than routed back into a fix loop.
 */
export function workstreamsToReview(state: WorkState, ids: readonly string[]): string[] {
  if (state.pipelineState.lastCompletedStep === "lens-fix") return [...ids];
  return ids.filter((id) => reviewTrack(state.eventLog, id).needsReview);
}

/** The round a workstream's next reportOnly review carries. */
export function reviewRoundFor(state: WorkState, workstreamId: string): number {
  if (state.pipelineState.lastCompletedStep === "lens-fix") return MAX_ROUNDS;
  return reviewTrack(state.eventLog, workstreamId).rounds + 1;
}

/** Fix requests not yet followed by an applied fix pass, in log order. */
export function pendingFixes(eventLog: readonly WorkEvent[]): PendingFix[] {
  const pending = new Map<string, PendingFix>();
  for (const e of eventLog) {
    if (e.kind === "adversarial-fix-requested") {
      pending.set(e.workstreamId, {
        workstreamId: e.workstreamId,
        round: e.round,
        findings: e.findings,
      });
    } else if (e.kind === "adversarial-fix-applied") {
      pending.delete(e.workstreamId);
    }
  }
  return [...pending.values()];
}

export interface ReviewReading {
  /** Whether this workstream's review produced a usable outcome (infra and rejections are not). */
  ok: boolean;
  /** The reviewer dispatch died or produced no readable verdict. */
  infra: boolean;
  /** A parsed non-terminal verdict: route this workstream to a fix pass. */
  fixRequested: boolean;
  /** Non-blocking findings this passing review carries forward. */
  passFindings?: string;
}

/**
 * Interpret one reportOnly review (or a legacy full-loop result, which has no
 * round record and keeps its own `ok`). The decision is `decideLoopAction` —
 * the same table the in-gate loop used — so the thresholds cannot drift.
 */
export function interpretReview(result: DispatchResult, reviewRound: number): ReviewReading {
  const ok = result.ok && !result.errorStop;
  const rec = result.adversarialRounds?.[0];
  if (!rec || !ok) {
    return {
      ok,
      infra: false,
      fixRequested: false,
      passFindings: ok && result.text?.includes("PASSED WITH FINDINGS") ? result.text : undefined,
    };
  }
  if (!rec.verdictParsed) return { ok: false, infra: true, fixRequested: false };
  const action = decideLoopAction(rec.status, reviewRound, MAX_ROUNDS, true);
  if (action === "fix") return { ok: true, infra: false, fixRequested: true };
  if (action === "reject") return { ok: false, infra: false, fixRequested: false };
  return {
    ok: true,
    infra: false,
    fixRequested: false,
    passFindings: rec.status === "APPROVED" ? undefined : result.text,
  };
}

/** The fix-requested events for the workstreams a review round routed back. */
export function fixRequestEvents(
  outcomes: ReadonlyArray<{
    id: string;
    fixRequested?: boolean;
    fixFindings?: string;
    records: Array<{ round: number }>;
  }>,
  at: number,
): WorkEvent[] {
  return outcomes
    .filter((o) => o.fixRequested)
    .map((o) => ({
      kind: "adversarial-fix-requested" as const,
      at,
      workstreamId: o.id,
      round: o.records[0]?.round ?? 0,
      findings: (o.fixFindings ?? "").slice(0, FIX_FINDINGS_MAX),
    }));
}

/**
 * Workstreams that keep a FINAL verdict from an earlier invocation: not run
 * again, their outcome re-emitted so the log stays complete. A single-workstream
 * cycle keeps no per-workstream outcome event, so its approval is recovered
 * from the rounds it already ran.
 */
export function survivorsOf(
  state: WorkState,
  ids: readonly string[],
  runSet: readonly string[],
  priorOutcomes: ReadonlyMap<string, string>,
): AdversarialOutcome[] {
  return ids
    .filter((id) => !runSet.includes(id))
    .flatMap((id) => {
      const prev =
        priorOutcomes.get(id) ??
        (ids.length === 1 ? lastReviewVerdict(state.eventLog, id) : undefined);
      if (prev !== "approved" && prev !== "rejected" && prev !== "skipped-empty-diff") return [];
      const findings = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
            e.kind === "adversarial-workstream-outcome" && e.workstreamId === id,
        )?.findings;
      return [
        {
          id,
          ok: prev === "approved" || prev === "skipped-empty-diff",
          rounds: 0,
          records: [],
          infra: false,
          threw: false,
          skipped: prev === "skipped-empty-diff",
          priorInfra: false,
          priorVerdict: prev,
          ...(prev === "approved" && findings ? { passFindings: findings } : {}),
        },
      ];
    });
}

/**
 * Named paths: tracked at base, outside the protected set, and named in a
 * finding as a whole path token (`data.txt` does not name `a.txt`).
 */
export function namedPaths(findings: string, tracked: readonly string[]): string[] {
  return tracked.filter((p) => protectedPathsIn([p]).length === 0 && pathTokenIn(findings, p));
}

function pathTokenIn(text: string, p: string): boolean {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`).test(text);
}

/**
 * The verdict a single-workstream cycle's last parsed review reached. Such a
 * cycle keeps no per-workstream outcome event, so the log is the only record.
 */
function lastReviewVerdict(
  eventLog: readonly WorkEvent[],
  workstreamId: string,
): "approved" | "rejected" | undefined {
  const last = [...eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "adversarial-round" }> =>
        e.kind === "adversarial-round" && e.verdictParsed && keyOf(e.workstreamId) === workstreamId,
    );
  if (!last) return undefined;
  const action = decideLoopAction(last.status, last.round, MAX_ROUNDS, true);
  if (action === "pass") return "approved";
  if (action === "reject") return "rejected";
  return undefined;
}

async function trackedPaths(
  execFn: NonNullable<DriverContext["verifyExecFn"]> | typeof execp,
  repoRoot: string,
  baseSha: string | undefined,
): Promise<string[]> {
  if (!baseSha || !/^[0-9a-f]{40}$/.test(baseSha)) return [];
  try {
    const { stdout } = await execFn(`git ls-tree -r --name-only ${baseSha}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function headOf(execFn: FixExec, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git rev-parse HEAD", { cwd, maxBuffer: 64 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files this fix pass changed (commits since its pre-pass HEAD) that fall
 * outside the workstream's allowed paths. A path is allowed when it equals a
 * declared/named path or sits under a declared directory.
 */
async function outOfScopeSince(
  execFn: FixExec,
  cwd: string,
  headBefore: string | undefined,
  allowed: readonly string[],
): Promise<string[]> {
  if (!headBefore) return [];
  let changed: string[] = [];
  try {
    const { stdout } = await execFn(`git diff --name-only ${headBefore}..HEAD`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    changed = stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const cleaned = allowed.map((a) => a.replace(/\s+\([^)]*\)$/, "").trim());
  return changed.filter(
    (f) => !cleaned.some((a) => f === a || (a.endsWith("/") && f.startsWith(a))),
  );
}

/** Records the handoff report naming the rounds, the reason and the findings. */
function withFixPassReport(
  state: WorkState,
  pending: PendingFix[],
  reason: string,
  now: number,
): WorkState {
  const rounds = pending.map((p) => `${p.workstreamId} round ${p.round}`).join(", ");
  const findings = pending
    .map((p) => p.findings)
    .join("\n---\n")
    .slice(0, FIX_FINDINGS_MAX);
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        {
          step: "develop",
          role: "driver",
          body: `adversarial fix pass (${rounds}) parked: ${reason}. The findings that triggered it:\n${findings}`,
          at: now,
        },
      ],
    },
  };
}

function parkFixPass(
  state: WorkState,
  pending: PendingFix[],
  reason: string,
  now: number,
): WorkState {
  return appendEvent(withFixPassReport(state, pending, reason, now), {
    kind: "cap-hit",
    at: Date.now(),
    cap: "verify-failed:develop",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `adversarial fix pass: ${reason}`,
  });
}

/**
 * The develop fix pass for the pending workstreams. Reuses their worktrees;
 * named finding paths widen the scope fence (only where the workstream
 * declares paths, so an N=1 workstream with no fence stays fenceless); all
 * develop gates run unchanged. Parks like a first develop failure on: a
 * failed gate or dispatch (router handles), a no-op pass, or a removed
 * origin/main comment.
 */
export async function runAdversarialFixPass(
  ctx: DriverContext,
  state: WorkState,
  pending: PendingFix[],
  now: number,
): Promise<WorkState> {
  const ps: PipelineState = state.pipelineState;
  const execFn = ctx.verifyExecFn ?? execp;
  const ids = pending.map((p) => p.workstreamId);
  const originals = ps.workstreams;
  const tracked = await trackedPaths(execFn, ctx.repoRoot, ps.baseSha);
  const passWorkstreams: NonNullable<PipelineState["workstreams"]> = { ...originals };
  for (const p of pending) {
    const orig = originals?.[p.workstreamId];
    const declared = orig?.paths ?? [];
    const named =
      declared.length > 0
        ? namedPaths(p.findings, tracked).filter((x) => !declared.includes(x))
        : [];
    const base = orig
      ? { ...orig, paths: [...declared, ...named] }
      : { id: p.workstreamId, scope: "", paths: [], outOfScope: [] };
    passWorkstreams[p.workstreamId] = { ...base, fixFindings: p.findings } as NonNullable<
      PipelineState["workstreams"]
    >[string];
    if (named.length > 0)
      trace(`work-driver: fix pass ${p.workstreamId} widened by ${named.join(", ")}`);
  }
  const wtOf = (id: string): string => ps.worktrees?.[id] ?? ctx.repoRoot;
  const before = await Promise.all(ids.map((id) => fetchDiff(wtOf(id), ps.baseSha)));
  const heads = await Promise.all(ids.map((id) => headOf(execFn, wtOf(id))));

  const startLen = state.eventLog.length;
  const stepped = appendEvent(
    { ...state, pipelineState: { ...ps, currentStep: "develop", workstreams: passWorkstreams } },
    { kind: "step-started", step: "develop", at: now },
  );
  const begun = await beginDispatch(
    ctx.repoRoot,
    stepped,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  const passed = await runDevelopTopological(
    ctx,
    begun.state,
    ids,
    passWorkstreams,
    activeIssuesOf(state),
    ctx.dispatchFn ?? dispatchCore,
    // Develop's git checks pass argv: the shell-string executor drops it.
    ctx.verifyExecFn ?? argvExecp,
    now,
    begun.jobId,
  );
  // The widened scope and the findings are for this pass only.
  const restored: WorkState = {
    ...passed,
    pipelineState: { ...passed.pipelineState, workstreams: originals },
  };
  const failed = restored.eventLog
    .slice(startLen)
    .some(
      (e) =>
        e.kind === "cap-hit" ||
        e.kind === "dispatch-failed" ||
        (e.kind === "branch-completed" && !e.ok) ||
        (e.kind === "branches-converged" && e.verdicts.some((v) => !v.ok)),
    );
  // A failed gate that already recorded its own cap routes through that cap.
  // Any other failed tail (a bare branches-converged verdict, say) would fall
  // through nextStep to the linear table, so it parks explicitly here.
  if (failed) {
    const tail = restored.eventLog[restored.eventLog.length - 1];
    if (tail?.kind === "cap-hit")
      return withFixPassReport(restored, pending, "a develop gate failed on the fix pass", now);
    return parkFixPass(restored, pending, "a develop gate failed on the fix pass", now);
  }

  const after = await Promise.all(ids.map((id) => fetchDiff(wtOf(id), ps.baseSha)));
  const unchanged = ids.filter((_, i) => after[i] === before[i]);
  if (unchanged.length > 0) {
    return parkFixPass(
      restored,
      pending,
      `the diff of ${unchanged.join(", ")} is byte-identical to its pre-pass state — nothing was fixed`,
      now,
    );
  }
  for (const [i, id] of ids.entries()) {
    const allowed = passWorkstreams[id]?.paths ?? [];
    // A declared fence holds for the pass: only the widened paths may change.
    const strays =
      allowed.length > 0 ? await outOfScopeSince(execFn, wtOf(id), heads[i], allowed) : [];
    if (strays.length > 0) {
      return parkFixPass(
        restored,
        pending,
        `${id} changed ${strays.join(", ")} — outside its declared paths and the files the findings name`,
        now,
      );
    }
  }
  for (const id of ids) {
    const lost = await roundComments(
      after[ids.indexOf(id)] ?? "",
      undefined,
      wtOf(id),
      verifyTimeoutMs(),
      ctx.verifyExecFn,
    );
    // A check that could not run reads NOT CHECKED, never silence (AGENTS.md §7).
    if (!lost.ok) {
      return parkFixPass(
        restored,
        pending,
        `comment retention could not be checked for ${id} (NOT CHECKED) — the fix pass is not cleared`,
        now,
      );
    }
    if (lost.lost.length > 0) {
      return parkFixPass(
        restored,
        pending,
        `the fix pass removed ${lost.lost.length} origin/main comment line(s) in ${id}`,
        now,
      );
    }
  }
  const applied: WorkEvent[] = pending.map((p) => ({
    kind: "adversarial-fix-applied" as const,
    at: Date.now(),
    workstreamId: p.workstreamId,
    round: p.round,
  }));
  return appendEvent(restored, ...applied);
}

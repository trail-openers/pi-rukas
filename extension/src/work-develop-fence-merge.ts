/**
 * work-develop-fence-merge — #1005: the merge-and-retry's MERGE half (the
 * workstream map, the rebase, and the re-dispatch).
 *
 * Split out of work-develop-fence-merge-retry.ts (500-line gate) along the
 * natural seam: this module owns everything up to and including the merged
 * workstreams' re-dispatch; work-develop-fence-merge-retry.ts owns the gate
 * re-run and the honest verdict/restore decision. A pure move: no behaviour
 * change.
 *
 * The flow (called from runDevelopTopological when the develop gate records a
 * `sibling-declared` fence violation):
 *   1. For each (violator, owner) pair, merge the two workstreams (owner
 *      keeps its id; violator is absorbed) — the same shape as the
 *      MAX_WORKSTREAMS fold and the plan-time coupling merge (the shared
 *      fold in workstream-fold.ts).
 *   2. Rebase the violator's worktree to the owner's post-commit tip (the
 *      #849 reset). A git failure parks with the `fence-violation:develop`
 *      cap, naming the merge (ZERO re-dispatch).
 *   3. Re-dispatch ONLY the merged workstreams, once each, with the
 *      merge-retry prompt (the prompt names the merge and tells the
 *      developer both halves are now their scope).
 *
 * The owner's ORIGINAL worktree is deliberately left in place (the merged
 * workstream reuses the VIOLATOR's worktree, rebased to the owner's tip —
 * the owner's tree is only read, never written). This is intentional: the
 * owner's tree is the base the merged work builds on, and moving or deleting
 * it would break the owner's own committed work. The merged workstream's
 * effective base is the owner's post-commit SHA (the `workstreamBaseShas`
 * update below records it).
 */
import { siblingDeclaredViolators } from "./work-develop-fence-recovery.ts";
import { FENCE_VIOLATION_CAP } from "./work-develop-fence-recovery.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";
import { foldWorkstream } from "./workstream-fold.ts";
import { gitErrorDetail } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

type WSMap = Record<string, Workstream>;

/**
 * #1005 — the re-dispatch prompt for the MERGED workstream. Names the merge
 * (both halves, the merged id, the violated files) and tells the developer
 * both halves are now their scope: the worktree now CONTAINS the owner's
 * commit (rebased to O's tip), so the producer's work is already in the tree
 * and the consumer builds on top of it.
 */
export function mergeRetryPrompt(
  mergedId: string,
  halves: string[],
  violated: FenceViolationRecord[],
): string {
  const files = violated
    .filter((v): v is Extract<FenceViolationRecord, { kind: "sibling-declared" }> => {
      if (v.kind !== "sibling-declared") return false;
      return halves.includes(v.workstreamId) || halves.includes(v.declaredById);
    })
    .map((v) => {
      const sib = v as Extract<FenceViolationRecord, { kind: "sibling-declared" }>;
      return `${sib.file} (declared by ${sib.declaredById})`;
    })
    .join(", ");
  return [
    `FENCE MERGE-AND-RETRY — workstream ${mergedId} (merged from: ${halves.join(", ")}).`,
    "",
    `Your first attempt was split across ${halves.length} workstreams (${halves.join(", ")}), and the develop scope fence recorded a sibling-declared violation: ${files || "(the halves edited each other's files)"}. The two halves are COUPLED — one cannot pass its own quality gates without the other's commit — so the driver MERGED them into a single workstream: ${mergedId}.`,
    "",
    `This is your ONLY re-dispatch. The merged workstream's scope is the UNION of both halves' declared paths. The worktree now contains the owner's commit (the producer's work is already in the tree) — build the consumer's work ON TOP of it, do NOT re-implement the producer's files, and do NOT touch any file outside the merged scope. Both halves are now YOUR scope.`,
  ].join("\n");
}

/** #1005 — the outcome of the merge half: either a park (a git failure or a
 * non-merge-able shape — nothing was re-dispatched) or the re-dispatched
 * merged ids plus the merge pairs (owner → absorbed violator) and the
 * discarded SHAs (the handoff evidence names both halves of every merge).
 * `absorbed` is the original violator id (its entry is gone from the
 * post-merge map, so it cannot be recovered from state). */
export type MergePrepOutcome =
  | { parked: true }
  | {
      parked: false;
      mergedIds: string[];
      merges: Array<{ into: string; from: string }>;
      discardedShas: string[];
    };

/**
 * #1005 — the full merge-prep flow. `runMergePrep` is called from
 * runMergeRetryFlow when the gate records a `sibling-declared` fence
 * violation (and no `issue-fenced` one, which still blocks as today).
 *
 * The flow:
 *   1. For each (violator, owner) pair, merge the two workstreams (owner
 *      keeps its id; violator is absorbed).
 *   2. Rebase the violator's worktree to the owner's post-commit tip (the
 *      #849 reset). A git failure parks with the fence cap, naming the merge.
 *   3. Re-dispatch ONLY the merged workstreams, once each, with the
 *      merge-retry prompt.
 *
 * On the non-park outcome the caller re-runs the fence + verify gates and
 * decides the verdict/restore (work-develop-fence-merge-retry.ts).
 */
export async function runMergePrep(
  ctx: DriverContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<{ state: WorkState; outcome: MergePrepOutcome }> {
  const wsIn = stateIn.pipelineState.workstreams ?? {};
  const fenceViolations = stateIn.pipelineState.verifyEvidence?.fenceViolations ?? [];
  const violators = siblingDeclaredViolators(fenceViolations);
  if (violators.length === 0) {
    return {
      state: stateIn,
      outcome: { parked: false, mergedIds: [], merges: [], discardedShas: [] },
    };
  }
  // Merge each (violator, owner) pair. The owner is the declaring sibling
  // (from the fence records). Multiple violators may share an owner; each
  // pair is merged independently.
  let workstreams: WSMap = { ...wsIn };
  const worktrees = { ...stateIn.pipelineState.worktrees };
  const workstreamBaseShas = { ...(stateIn.pipelineState.workstreamBaseShas ?? {}) };
  const discardedShas: string[] = [];
  const mergedIds: string[] = []; // the post-merge ids (owner ids)
  const merges: Array<{ into: string; from: string }> = [];
  let next = stateIn;
  // #1005 — park builds from `next`, which is kept in sync with
  // `stateRef.current` after every successful iteration. The pre-#1005
  // code persisted to `next`/`stateRef.current` only after the loop, so a
  // mid-loop park lost every merge recorded up to that point.
  const park = (evidence: string): { state: WorkState; outcome: MergePrepOutcome } => {
    const st = appendEvent(next, fenceCapHit(next, evidence));
    stateRef.current = st;
    return { state: st, outcome: { parked: true } };
  };
  for (const violator of violators) {
    // The declaring owner(s) for this violator.
    const owners = new Set<string>();
    for (const v of fenceViolations) {
      if (v.kind === "sibling-declared" && v.workstreamId === violator) owners.add(v.declaredById);
    }
    const owner = [...owners][0];
    if (!owner || !wsIn[owner]) {
      // No owner workstream exists — the violator touched a file no sibling
      // declared. This is not a merge-able shape; park.
      return park(
        `merge-and-retry refused — violator ${violator} has no declaring owner workstream (owners: ${[...owners].join(", ") || "none"})`,
      );
    }
    if (violator === owner) {
      // Self-fence — the violator touched its own file. Not a merge shape.
      return park(
        `merge-and-retry refused — ${violator} touched its own declared file (self-fence, not a sibling-declared merge shape)`,
      );
    }
    // Merge the pair (owner keeps its id). The shared fold (workstream-fold.ts)
    // reads the absorbed workstream from the CURRENT map (the violator is
    // still there at this point in the loop — it is deleted by the fold
    // itself), and the merge is recorded on a fence-recovery-started event
    // BEFORE the rebase, so a mid-loop park preserves the merge.
    workstreams = foldWorkstream(workstreams, owner, violator, workstreams[violator] as Workstream);
    merges.push({ into: owner, from: violator });
    mergedIds.push(owner);
    // Rebase the violator's worktree to the owner's post-commit tip.
    const violatorWt = worktrees[violator];
    const ownerWt = worktrees[owner];
    if (typeof violatorWt !== "string" || typeof ownerWt !== "string") {
      // The missing path is the VIOLATOR's worktree (the violator's tree is
      // the merged workstream's tree after the merge; the owner's tree is
      // only needed to read its tip). Name the violator, not the owner.
      return park(
        `merge-and-retry aborted — no worktree recorded for violator ${violator} (the merged workstream's worktree cannot be prepared)`,
      );
    }
    let ownerSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", { cwd: ownerWt, maxBuffer: 64 * 1024 });
      ownerSha = stdout.trim();
    } catch (err) {
      return park(
        `merge-and-retry aborted — owner ${owner}'s SHA unreadable (git rev-parse in ${ownerWt}): ${gitErrorDetail(err)}`,
      );
    }
    if (!ownerSha) {
      return park(
        `merge-and-retry aborted — owner ${owner}'s SHA read empty (rev-parse in ${ownerWt})`,
      );
    }
    let violatorSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: violatorWt,
        maxBuffer: 64 * 1024,
      });
      violatorSha = stdout.trim();
    } catch (err) {
      return park(
        `merge-and-retry aborted — violator ${violator}'s HEAD unreadable: ${gitErrorDetail(err)}`,
      );
    }
    const resetCmd = `git reset --hard ${JSON.stringify(ownerSha)}`;
    try {
      await execFn(resetCmd, { cwd: violatorWt, maxBuffer: 64 * 1024 });
    } catch (err) {
      return park(
        `merge-and-retry aborted — ${resetCmd} failed in ${violatorWt}: ${gitErrorDetail(err)}; the merge ${owner}+${violator} was not applied`,
      );
    }
    if (violatorSha) discardedShas.push(violatorSha);
    // The violator's worktree is now the merged workstream's worktree.
    // The merged id is the owner; the violator's worktree path is reused
    // (the owner's own worktree is untouched — the merged work builds on
    // the owner's commit, which is now the violator's tree base).
    worktrees[owner] = violatorWt;
    workstreamBaseShas[owner] = ownerSha;
    // Record the merge on a fence-recovery-started event (the durable
    // record; the shape is reused from #849 so the handoff renderer's
    // existing fence-cap explanation still reads the discarded SHA).
    next = appendEvent(next, {
      kind: "fence-recovery-started",
      at: Date.now(),
      workstreamId: owner,
      owners: [violator],
      ...(violatorSha ? { discardedSha: violatorSha } : {}),
    });
    // Drop the absorbed workstream from the worktrees map (its id is gone).
    delete worktrees[violator];
    delete workstreamBaseShas[violator];
    // Persist the merged workstreams + updated maps after EACH successful
    // iteration (the pre-#1005 code persisted only after the loop, so a
    // mid-loop park lost earlier merges). `next` and `stateRef.current`
    // are kept in sync so a park in the next iteration sees this merge.
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        worktrees: { ...worktrees },
        workstreamBaseShas: { ...workstreamBaseShas },
        workstreams: workstreams,
      },
    };
    stateRef.current = next;
  }
  // Re-dispatch ONLY the merged workstreams, once each, with the merge-retry
  // prompt. The new ids are the owner ids (the absorbed violators are gone).
  for (const mergedId of mergedIds) {
    const ws = workstreams[mergedId];
    if (!ws) continue;
    const wt = worktrees[mergedId];
    if (typeof wt !== "string") continue;
    // The violated records for this merged workstream (both halves).
    const violatedRecords = fenceViolations.filter(
      (v) =>
        v.kind === "sibling-declared" &&
        (v.workstreamId === mergedId ||
          merges.some((m) => m.from === v.workstreamId && m.into === mergedId)),
    );
    const halves = [mergedId, ...merges.filter((m) => m.into === mergedId).map((m) => m.from)];
    const prompt = mergeRetryPrompt(mergedId, halves, violatedRecords);
    const startedAt = Date.now();
    try {
      // #1005 — the re-dispatch is pinned to the merged workstream's worktree
      // (the violator's tree, rebased to the owner's tip — the same path the
      // merge rebased). Without the explicit cwd the child falls back to the
      // Pi process directory (repoRoot) and writes the merged work to the main
      // checkout — the live #1005 incident (a killed developer's files blocked
      // the next cycle's branch step).
      const res = await dispatch(
        ctx.pi,
        { role: "developer", prompt, cwd: wt },
        { label: `developer[${mergedId}] (merge-retry)` },
      );
      const ok = res.ok && !res.errorStop;
      const completionEvent = await buildCompletionEvent(
        ctx,
        "develop",
        "developer",
        `developer[${mergedId}]`,
        res,
      );
      // #1005 — the re-dispatch's completion event is appended to `next`
      // (the local variable that `park` builds from) as well as
      // `stateRef.current`, so a park in a later re-dispatch iteration
      // sees this re-dispatch's events.
      next = appendEvent(next, completionEvent);
      stateRef.current = next;
      if (ids.length > 1) {
        next = appendEvent(next, {
          kind: "branch-completed",
          step: "develop",
          workstreamId: mergedId,
          ok,
          ms: Date.now() - startedAt,
          at: Date.now(),
        });
        stateRef.current = next;
      }
    } catch (err) {
      const errMsg = (err as Error).message?.slice(0, 200) ?? "unknown error";
      return park(
        `merge-and-retry re-dispatch for ${mergedId} failed: ${errMsg} (first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"})`,
      );
    }
  }
  return {
    state: stateRef.current,
    outcome: { parked: false, mergedIds, merges, discardedShas },
  };
}

/** #1005 — the cap-hit for a merge-and-retry park/handoff (same cap as #849;
 * the evidence names the merge, per the #1005 acceptance criterion). */
export function fenceCapHit(
  state: WorkState,
  evidence: string,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap: FENCE_VIOLATION_CAP,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
  };
}

/** #1005 — the merge evidence string, shared by the re-run's cap hits. */
export function mergeEvidence(
  merges: Array<{ into: string; from: string }>,
  discardedShas: string[],
): string {
  return `the merge was ${merges.map((m) => `${m.into}+${m.from}`).join(", ")}; first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"}`;
}

/** #1005 — the violated (sibling-declared) records that name a merged
 * workstream, for the re-run's second-failure evidence. */
export function secondViolationProse(fenceViolations: FenceViolationRecord[]): string {
  return fenceViolations
    .filter(
      (v): v is FenceViolationRecord & { kind: "sibling-declared" } =>
        v.kind === "sibling-declared",
    )
    .map((v) => `workstream ${v.workstreamId} touched ${v.file} (declared by ${v.declaredById})`)
    .join("; ");
}

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
 *      MAX_WORKSTREAMS fold and the plan-time coupling merge.
 *   2. Rebase the violator's worktree to the owner's post-commit tip (the
 *      #849 reset). A git failure parks with the `fence-violation:develop`
 *      cap, naming the merge (ZERO re-dispatch).
 *   3. Re-dispatch ONLY the merged workstreams, once each, with the
 *      merge-retry prompt (the prompt names the merge and tells the
 *      developer both halves are now their scope).
 */
import { siblingDeclaredViolators } from "./work-develop-fence-recovery.ts";
import { FENCE_VIOLATION_CAP } from "./work-develop-fence-recovery.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import { gitErrorDetail } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

type WS = NonNullable<WorkState["pipelineState"]["workstreams"]>[string];

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
      const sib = v as Extract<FenceViolationRecord, { kind: "sibling-declared" }>;
      return halves.includes(sib.workstreamId) || halves.includes(sib.declaredById);
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
  let workstreams: Record<string, WS | undefined> = { ...wsIn };
  const worktrees = { ...stateIn.pipelineState.worktrees };
  const workstreamBaseShas = { ...(stateIn.pipelineState.workstreamBaseShas ?? {}) };
  const discardedShas: string[] = [];
  const mergedIds: string[] = []; // the post-merge ids (owner ids)
  const merges: Array<{ into: string; from: string }> = [];
  let next = stateIn;
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
    // Merge the pair (owner keeps its id).
    workstreams = mergeWorkstreams(workstreams, owner, violator);
    merges.push({ into: owner, from: violator });
    mergedIds.push(owner);
    // Rebase the violator's worktree to the owner's post-commit tip.
    const violatorWt = worktrees[violator];
    const ownerWt = worktrees[owner];
    if (typeof violatorWt !== "string" || typeof ownerWt !== "string") {
      return park(
        `merge-and-retry aborted — no worktree recorded for ${typeof violatorWt === "string" ? owner : violator} (the merge cannot be applied)`,
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
  }
  // Drop the absorbed workstreams from the worktrees map (their id is gone).
  for (const m of merges) {
    delete worktrees[m.from];
    delete workstreamBaseShas[m.from];
  }
  // Persist the merged workstreams + updated maps.
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      worktrees,
      workstreamBaseShas,
      workstreams: workstreams as NonNullable<WorkState["pipelineState"]["workstreams"]>,
    },
  };
  stateRef.current = next;
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
      stateRef.current = appendEvent(stateRef.current, completionEvent);
      if (ids.length > 1) {
        stateRef.current = appendEvent(stateRef.current, {
          kind: "branch-completed",
          step: "develop",
          workstreamId: mergedId,
          ok,
          ms: Date.now() - startedAt,
          at: Date.now(),
        });
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

/**
 * #1005 — merge two coupled workstreams into one (same shape as the MAX_WORKSTREAMS
 * fold and the plan-time coupling merge). Returns the merged map with `from`
 * absorbed into `into` (the owner is the declaring sibling — the producer
 * keeps its id; the consumer is folded into it). `dependsOn` edges that
 * pointed at the absorbed id are re-pointed. The absorbed workstream's
 * `dependsOn` (minus the two merged ids) is preserved on the merged one.
 */
export function mergeWorkstreams(
  workstreams: Record<string, WS | undefined>,
  into: string,
  from: string,
): Record<string, WS | undefined> {
  const merged: Record<string, WS | undefined> = { ...workstreams };
  const a = merged[into];
  const b = merged[from];
  if (!a || !b) return merged;
  const mergedDeps = new Set<string>();
  for (const d of a.dependsOn ?? []) if (d !== from && d !== into) mergedDeps.add(d);
  for (const d of b.dependsOn ?? []) if (d !== from && d !== into) mergedDeps.add(d);
  // Re-point edges pointing at the absorbed id.
  for (const [otherId, otherWs] of Object.entries(merged)) {
    if (otherId === into) continue;
    if (!otherWs) continue;
    const deps = otherWs.dependsOn;
    if (deps?.includes(from)) {
      const updated = [...new Set([...deps].map((d) => (d === from ? into : d)))];
      const otherCopy: WS = {
        id: otherWs.id,
        scope: otherWs.scope,
        paths: otherWs.paths,
        outOfScope: otherWs.outOfScope,
      };
      if (otherWs.dependsOn) otherCopy.dependsOn = updated;
      if (otherWs.integrationTest) otherCopy.integrationTest = otherWs.integrationTest;
      merged[otherId] = otherCopy;
    }
  }
  const mergedWs: WS = {
    id: a.id,
    scope: `${a.scope} (+merged: ${from})`,
    paths: [...new Set([...a.paths, ...b.paths])],
    outOfScope: [...new Set([...a.outOfScope, ...b.outOfScope])],
  };
  if (mergedDeps.size > 0) mergedWs.dependsOn = [...mergedDeps];
  const it = a.integrationTest ?? b.integrationTest;
  if (it) mergedWs.integrationTest = it;
  merged[into] = mergedWs;
  delete merged[from];
  return merged;
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

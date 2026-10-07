/**
 * work-develop-fence-merge-retry — #1005: the develop step's fence merge-and-retry.
 *
 * Replaces the #849 fence-recovery flow (work-develop-fence-recovery-run.ts),
 * which re-ran the SAME split (discard the violator's commit, re-dispatch the
 * violator against the owner's files) — the exact failure #1005 measured:
 * re-running the split fails the same way every time, because the two
 * workstreams are coupled and no re-division of the same work makes each
 * half pass its own gate.
 *
 * #1005's response to a `sibling-declared` fence violation is to MERGE the
 * two coupled workstreams and re-run develop ONCE on the merged one:
 *
 *   1. The violating workstream V and its declaring owner O are merged into
 *      a single workstream (same shape as the MAX_WORKSTREAMS fold in
 *      work-driver-plan-workstreams.ts:116-124 and the plan-time coupling
 *      merge in work-driver-plan-coupling.ts: union of paths/outOfScope,
 *      scope annotated, dependsOn re-pointed).
 *   2. The merged workstream's worktree is V's worktree, rebased to O's
 *      post-commit tip (the #849 reset: O's commit is the base the merged
 *      work builds on).
 *   3. The merged workstream is re-dispatched ONCE with a prompt that names
 *      the merge and tells the developer both halves are now their scope.
 *   4. The fence + verify gates re-run. A clean re-run proceeds through the
 *      converge gate. A SECOND failure (fence or verify) hands off, and the
 *      handoff evidence NAMES THE MERGE (both the first and second attempt,
 *      plus the merge itself).
 *
 * Parking rules (the #849 cycle check is subsumed: a violator↔owner cycle is
 * itself the merge — there is no "injected edge" to form a cycle with, so the
 * cycle check has no work to do here):
 *   - a git failure rebasing V to O's tip parks with the `fence-violation:develop`
 *     cap, naming the merge and the failing command (ZERO re-dispatch).
 *   - a second failure after the merge hands off (the #1005 acceptance
 *     criterion: "A second failure after merging hands off, and the handoff
 *     names the merge").
 *   - at most one merge-and-retry round per cycle (the gate re-runs at most
 *     twice; only the first pass may merge).
 *
 * The discriminator is the record KIND from the gate's `fenceViolations` —
 * `sibling-declared` only (same as #849). `issue-fenced` violations still
 * block exactly as today (no recovery), and `undeclared` records (warn-only)
 * never trigger the merge.
 */
import { trace } from "./trace.ts";
import { siblingDeclaredViolators } from "./work-develop-fence-recovery.ts";
import { FENCE_VIOLATION_CAP } from "./work-develop-fence-recovery.ts";
import {
  applyFenceVerdicts,
  replaceDevelopConvergedVerdicts,
} from "./work-develop-fence-verdicts.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { applySafetyNet } from "./work-driver-safety-net.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import { gitErrorDetail } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

type WS = NonNullable<WorkState["pipelineState"]["workstreams"]>[string];

/** #1005 — the merge-and-retry outcome (see the module header for the shapes). */
export type MergeRetryOutcome =
  | { parked: true }
  | {
      parked: false;
      worktrees: Record<string, string>;
      workstreamBaseShas: Record<string, string>;
      workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>;
      firstAttemptEvidence: string;
    };

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

/**
 * #1005 — merge two coupled workstreams into one (same shape as the MAX_WORKSTREAMS
 * fold and the plan-time coupling merge). Returns the merged map with V
 * absorbed into O (O is the declaring owner — the producer keeps its id; the
 * consumer is folded into it). `dependsOn` edges that pointed at V are
 * re-pointed to O. V's `dependsOn` (minus O, the merge) is preserved on O.
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

/**
 * #1005 — the full merge-and-retry flow. `runMergeRetryFlow` is the entry
 * point called from runDevelopTopological when the gate records a
 * `sibling-declared` fence violation (and no `issue-fenced` one, which still
 * blocks as today).
 *
 * The flow:
 *   1. For each (violator, owner) pair, merge the two workstreams (owner
 *      keeps its id; violator is absorbed).
 *   2. Rebase the violator's worktree to the owner's post-commit tip (the
 *      #849 reset). A git failure parks with the fence cap, naming the merge.
 *   3. Re-dispatch ONLY the merged workstreams, once each, with the
 *      merge-retry prompt.
 *   4. Re-run the fence + verify gates. A clean re-run proceeds through the
 *      converge gate. A second failure (fence or verify) hands off — the
 *      cap-hit evidence names the MERGE (both halves, both attempts).
 */
export async function runMergeRetryFlow(
  ctx: DriverContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState> {
  const wsIn = stateIn.pipelineState.workstreams ?? {};
  const fenceViolations = stateIn.pipelineState.verifyEvidence?.fenceViolations ?? [];
  const violators = siblingDeclaredViolators(fenceViolations);
  if (violators.length === 0) {
    return stateIn; // no sibling-declared violation — nothing to merge
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
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry refused — violator ${violator} has no declaring owner workstream (owners: ${[...owners].join(", ") || "none"})`,
        ),
      );
      stateRef.current = next;
      return next;
    }
    if (violator === owner) {
      // Self-fence — the violator touched its own file. Not a merge shape.
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry refused — ${violator} touched its own declared file (self-fence, not a sibling-declared merge shape)`,
        ),
      );
      stateRef.current = next;
      return next;
    }
    // Merge the pair (owner keeps its id).
    workstreams = mergeWorkstreams(workstreams, owner, violator);
    merges.push({ into: owner, from: violator });
    mergedIds.push(owner);
    // Rebase the violator's worktree to the owner's post-commit tip.
    const violatorWt = worktrees[violator];
    const ownerWt = worktrees[owner];
    if (typeof violatorWt !== "string" || typeof ownerWt !== "string") {
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry aborted — no worktree recorded for ${typeof violatorWt === "string" ? owner : violator} (the merge cannot be applied)`,
        ),
      );
      stateRef.current = next;
      return next;
    }
    let ownerSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", { cwd: ownerWt, maxBuffer: 64 * 1024 });
      ownerSha = stdout.trim();
    } catch (err) {
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry aborted — owner ${owner}'s SHA unreadable (git rev-parse in ${ownerWt}): ${gitErrorDetail(err)}`,
        ),
      );
      stateRef.current = next;
      return next;
    }
    if (!ownerSha) {
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry aborted — owner ${owner}'s SHA read empty (rev-parse in ${ownerWt})`,
        ),
      );
      stateRef.current = next;
      return next;
    }
    let violatorSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: violatorWt,
        maxBuffer: 64 * 1024,
      });
      violatorSha = stdout.trim();
    } catch (err) {
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry aborted — violator ${violator}'s HEAD unreadable: ${gitErrorDetail(err)}`,
        ),
      );
      stateRef.current = next;
      return next;
    }
    const resetCmd = `git reset --hard ${JSON.stringify(ownerSha)}`;
    try {
      await execFn(resetCmd, { cwd: violatorWt, maxBuffer: 64 * 1024 });
    } catch (err) {
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry aborted — ${resetCmd} failed in ${violatorWt}: ${gitErrorDetail(err)}; the merge ${owner}+${violator} was not applied`,
        ),
      );
      stateRef.current = next;
      return next;
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
  const newIds = mergedIds;
  for (const mergedId of newIds) {
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
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `merge-and-retry re-dispatch for ${mergedId} failed: ${errMsg} (first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"})`,
        ),
      );
      stateRef.current = next;
      return next;
    }
  }
  // The re-run always gates: the merge produced evidence (the re-dispatch
  // committed work, or the rebase reset the worktree to the owner's tip).
  {
    next = {
      ...stateRef.current,
      pipelineState: {
        ...stateRef.current.pipelineState,
        worktrees: { ...stateRef.current.pipelineState.worktrees, ...worktrees },
        workstreamBaseShas: {
          ...stateRef.current.pipelineState.workstreamBaseShas,
          ...workstreamBaseShas,
        },
        workstreams: workstreams as NonNullable<WorkState["pipelineState"]["workstreams"]>,
      },
    };
    stateRef.current = next;
    next = await applySafetyNet(ctx, next);
    const gate2 = await verifyStepOutcome(ctx, next, "develop");
    const rereRunRecords = gate2.fenceViolations ?? [];
    const blockingSecond = rereRunRecords.filter(
      (f) => f.kind === "sibling-declared" || f.kind === "issue-fenced",
    );
    // The RESTORE is honest: a merged workstream returns to ok:true ONLY when
    // the re-run gate ran, gate2.ok is true, AND no blocking fence record
    // names it; otherwise it stays ok:false.
    const mergedSet = new Set(newIds);
    const reRanClean = gate2.ok && blockingSecond.every((r) => !mergedSet.has(r.workstreamId));
    if (reRanClean) {
      for (let i = 0; i < verdicts.length; i++) {
        const v = verdicts[i];
        if (!v) continue;
        if (mergedSet.has(v.id) && v.ok === false) {
          verdicts[i] = { id: v.id, ok: true };
        }
      }
    } else {
      for (let i = 0; i < verdicts.length; i++) {
        const v = verdicts[i];
        if (!v) continue;
        if (mergedSet.has(v.id) && v.ok !== false) {
          verdicts[i] = { id: v.id, ok: false };
        }
      }
    }
    if (blockingSecond.length > 0 && ids.length > 1) {
      const flipped2 = applyFenceVerdicts(
        verdicts.map((v) => ({ ...v })),
        rereRunRecords,
      );
      const changed2 = flipped2.some((v, i) => {
        const o = verdicts[i];
        return o === undefined || o.ok !== v.ok || o.reason !== v.reason;
      });
      if (changed2) {
        next = replaceDevelopConvergedVerdicts(next, flipped2);
        for (let i = 0; i < verdicts.length; i++) {
          const f = flipped2[i];
          if (f) verdicts[i] = { ...f };
        }
      }
    }
    next = replaceDevelopConvergedVerdicts(
      next,
      verdicts.map((v) => ({ ...v })),
    );
    // The PARK decision keys on the re-run's fence RECORDS. A second
    // violation (or a verify failure) after the merge hands off — the
    // #1005 acceptance criterion: the handoff names the MERGE.
    if (blockingSecond.length > 0) {
      const secondProse = (gate2.fenceViolations ?? [])
        .filter(
          (v): v is FenceViolationRecord & { kind: "sibling-declared" } =>
            v.kind === "sibling-declared",
        )
        .map(
          (v) => `workstream ${v.workstreamId} touched ${v.file} (declared by ${v.declaredById})`,
        )
        .join("; ");
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: {
            step: "develop",
            failures: gate2.failures,
            at: Date.now(),
            fenceViolations: gate2.fenceViolations ?? [],
          },
        },
      };
      next = appendEvent(
        next,
        fenceCapHit(
          next,
          `fence violated again AFTER the merge-and-retry (the merge was ${merges.map((m) => `${m.into}+${m.from}`).join(", ")}; first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"}; second: ${secondProse}) — a second failure after merging hands off; re-running the same split will not converge`,
        ),
      );
      return next;
    }
    if (gate2.ok) {
      next = await runConvergeGateHandler(ctx, next, dispatch);
      return next;
    }
    // The re-run failed without a blocking fence record: a genuine verify
    // failure after the merge. Hand off — the #1005 criterion (a second
    // failure after merging hands off, naming the merge).
    const failureEvidence =
      gate2.failures.length > 0 ? gate2.failures.join(" | ") : "(no failure string)";
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        verifyEvidence: {
          step: "develop",
          failures: gate2.failures,
          at: Date.now(),
          ...(gate2.fenceViolations ? { fenceViolations: gate2.fenceViolations } : {}),
        },
      },
    };
    next = appendEvent(
      next,
      fenceCapHit(
        next,
        `verify failed AFTER the merge-and-retry (the merge was ${merges.map((m) => `${m.into}+${m.from}`).join(", ")}; first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"}) — ${failureEvidence}; a second failure after merging hands off`,
      ),
    );
    return next;
  }
}

/** #1005 — the cap-hit for a merge-and-retry park/handoff (same cap as #849;
 * the evidence names the merge, per the #1005 acceptance criterion). */
function fenceCapHit(state: WorkState, evidence: string): Extract<WorkEvent, { kind: "cap-hit" }> {
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap: FENCE_VIOLATION_CAP,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
  };
}

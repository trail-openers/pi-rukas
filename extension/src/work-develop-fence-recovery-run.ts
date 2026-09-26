import { trace } from "./trace.ts";
import {
  fenceRecoveryCycles,
  fenceRecoveryPrompt,
  fenceViolationCapHit,
  injectFenceDependsOn,
  siblingDeclaredViolators,
} from "./work-develop-fence-recovery.ts";
import {
  applyFenceVerdicts,
  replaceDevelopConvergedVerdicts,
} from "./work-develop-fence-verdicts.ts";
/**
 * work-develop-fence-recovery-run — #849: the fence recovery's git + dispatch
 * orchestration. Split from work-develop-topological.ts (500-line gate).
 *
 * The record-level helpers (siblingDeclaredViolators, fenceRecoveryCycles,
 * injectFenceDependsOn, fenceRecoveryPrompt, fenceViolationCapHit) live in
 * work-develop-fence-recovery.ts; this module owns the flow:
 *
 *   1. the cycle check (a cycle parks with zero re-dispatch),
 *   2. the dependsOn injection (V → each declaring owner),
 *   3. the discard (the violator's worktree reset to the owner's post-commit
 *      SHA; the discarded SHA recorded on a fence-recovery-started event),
 *   4. the single re-dispatch of ONLY the violators, with the recovery
 *      prompt (names the violated files, tells the developer to use the
 *      owners' versions rather than re-implement them).
 *
 * Every precondition of the discard is collected BEFORE any reset happens
 * (all violators' preconditions first, then the resets): a missing
 * workstream/worktree, missing owners, a missing owner worktree, an
 * unreadable or empty owner SHA, an unreadable violator HEAD — or a reset
 * failure — is the SAME terminal park (the `fence-violation:develop` cap
 * with the violator, the owner(s) and the reason): never a silent skip,
 * ZERO re-dispatches of ANY violator.
 *
 * `runFenceRecoveryFlow` (below) then re-runs the fence + verify gates on
 * the recovered tree itself: a second violation parks with the fence cap
 * (the evidence names BOTH attempts), a clean re-run proceeds through the
 * converge gate.
 */
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import { gitErrorDetail } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

/** #849 — the recovery outcome (see the module header for the shapes). */
export type FenceRecoveryOutcome =
  | { parked: true }
  | {
      parked: false;
      worktrees: Record<string, string>;
      workstreamBaseShas: Record<string, string>;
      workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>;
      firstAttemptEvidence: string;
    };
import type { Workstream } from "./workflow-state-schema.ts";

type WS = Workstream;

/**
 * #849 — run the fence recovery for every sibling-declared violator (the
 * cycle check, the discard, the single re-dispatch). `stateRef` is the
 * caller's shared state ref: events (fence-recovery-started, the re-dispatch
 * completion, any park cap-hit) are appended to it, so the caller reads
 * `stateRef.current` after this returns.
 */
export async function recoverFenceViolations(
  ctx: DriverContext,
  stateRef: { current: WorkState },
  stateIn: WorkState,
  ids: string[],
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<FenceRecoveryOutcome> {
  const wsIn = stateIn.pipelineState.workstreams ?? {};
  const fenceViolations = stateIn.pipelineState.verifyEvidence?.fenceViolations ?? [];
  const violators = siblingDeclaredViolators(fenceViolations);
  if (violators.length === 0) {
    return {
      parked: false,
      worktrees: stateIn.pipelineState.worktrees,
      workstreamBaseShas: stateIn.pipelineState.workstreamBaseShas ?? {},
      workstreams: wsIn,
      firstAttemptEvidence: "(no fence record)",
    };
  }
  // #849 — the cycle check runs BEFORE any recovery machinery (a cycle
  // parks with zero re-dispatch).
  const cycles = fenceRecoveryCycles(wsIn, fenceViolations);
  if (cycles.size > 0) {
    const reasons = [...cycles.entries()]
      .map(([violator, reason]) => `${violator}: ${reason}`)
      .join("; ");
    stateRef.current = appendEvent(
      stateRef.current,
      fenceViolationCapHit(
        stateIn.pipelineState.reviewRound,
        `fence recovery refused before any re-dispatch — violator↔owner cycle detected: ${reasons} (first attempt: workstream(s) ${violators.join(", ")})`,
      ),
    );
    return { parked: true };
  }
  // #849 — inject the dependsOn edges (V → each declaring owner).
  const injected = injectFenceDependsOn(wsIn, fenceViolations) as NonNullable<
    WorkState["pipelineState"]["workstreams"]
  >;
  const worktrees = { ...stateIn.pipelineState.worktrees };
  const workstreamBaseShas = { ...(stateIn.pipelineState.workstreamBaseShas ?? {}) };
  const discardedShas: string[] = [];
  let next = stateIn;
  // #849 — the discard is all-or-nothing: EVERY precondition of EVERY
  // violator is resolved BEFORE any reset; a failure parks. No silent skips.
  const parkPrecondition = (
    violator: string,
    owners: string[],
    reason: string,
  ): FenceRecoveryOutcome => {
    trace(`work-develop: fence recovery: ${violator} precondition failed — ${reason}`);
    stateRef.current = appendEvent(
      stateRef.current,
      fenceViolationCapHit(
        stateRef.current.pipelineState.reviewRound,
        `fence recovery aborted — violator ${violator} cannot be discarded (owner(s): ${owners.join(", ") || "none"}) — ${reason.slice(0, 200)}; first attempt: workstream(s) ${violators.join(", ")} could not be discarded, so no re-dispatch was attempted`,
      ),
    );
    return { parked: true };
  };
  const prepared: Array<{
    violator: string;
    owners: string[];
    violatorWt: string;
    ownerSha: string;
    violatorSha: string;
  }> = [];
  for (const violator of violators) {
    const vWs = injected[violator];
    if (!vWs) {
      return parkPrecondition(violator, [], `the workstreams map has no entry for ${violator}`);
    }
    const owners = (vWs.dependsOn ?? []).filter((o) => wsIn[o]);
    if (owners.length === 0) {
      return parkPrecondition(
        violator,
        vWs.dependsOn ?? [],
        `no owner workstreams exist (dependsOn: ${(vWs.dependsOn ?? []).join(", ") || "none"})`,
      );
    }
    const violatorWt = worktrees[violator];
    if (typeof violatorWt !== "string") {
      return parkPrecondition(
        violator,
        owners,
        `no worktree recorded for violator ${violator} (worktrees map has no entry)`,
      );
    }
    const primaryOwner = owners[0];
    if (primaryOwner === undefined) {
      return parkPrecondition(violator, owners, `no owner workstream resolved for ${violator}`);
    }
    const ownerWt = worktrees[primaryOwner];
    if (typeof ownerWt !== "string") {
      return parkPrecondition(
        violator,
        owners,
        `no worktree recorded for owner ${primaryOwner} (worktrees map has no entry)`,
      );
    }
    let ownerSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: ownerWt,
        maxBuffer: 64 * 1024,
      });
      ownerSha = stdout.trim();
    } catch (err) {
      return parkPrecondition(
        violator,
        owners,
        `owner ${primaryOwner}'s SHA unreadable (git rev-parse in ${ownerWt}): ${gitErrorDetail(err)}`,
      );
    }
    if (!ownerSha) {
      return parkPrecondition(
        violator,
        owners,
        `owner ${primaryOwner}'s SHA read empty (rev-parse in ${ownerWt})`,
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
      return parkPrecondition(
        violator,
        owners,
        `violator ${violator}'s HEAD unreadable (git rev-parse in ${violatorWt}): ${gitErrorDetail(err)}`,
      );
    }
    prepared.push({ violator, owners, violatorWt, ownerSha, violatorSha });
  }
  // #849 — every precondition resolved for every violator; now the resets
  // (a reset failure is the same terminal park: the discard is
  // all-or-nothing).
  for (const p of prepared) {
    const resetCmd = `git reset --hard ${JSON.stringify(p.ownerSha)}`;
    try {
      await execFn(resetCmd, { cwd: p.violatorWt, maxBuffer: 64 * 1024 });
    } catch (err) {
      return parkPrecondition(
        p.violator,
        p.owners,
        `${resetCmd} failed in ${p.violatorWt}: ${gitErrorDetail(err)}`,
      );
    }
    if (p.violatorSha) discardedShas.push(p.violatorSha);
    // #849 — record the discard on a fence-recovery-started event.
    next = appendEvent(next, {
      kind: "fence-recovery-started",
      at: Date.now(),
      workstreamId: p.violator,
      owners: p.owners,
      ...(p.violatorSha ? { discardedSha: p.violatorSha } : {}),
    });
    // #849 — the violator's effective base is now the owner's tip (the fence
    // re-run's #725 carve-out and the verify gate's per-workstream diff
    // measure against the owner's tip, not the global baseSha).
    workstreamBaseShas[p.violator] = p.ownerSha;
  }
  // #849 — persist the injected workstreams + updated base map through the
  // state ref (the caller reads stateRef.current after this returns).
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      worktrees,
      workstreamBaseShas,
      workstreams: injected,
    },
  };
  stateRef.current = next;
  // #849 — re-dispatch ONLY the violators, once each, with the recovery
  // prompt (the worktrees are already reset to the owners' tips). Every
  // precondition was resolved in the pass above; the guards below are
  // type-narrowing only and cannot fire.
  for (const violator of violators) {
    const vWs = injected[violator];
    if (!vWs) continue;
    const owners = (vWs.dependsOn ?? []).filter((o) => wsIn[o]);
    const violatorWt = worktrees[violator];
    if (typeof violatorWt !== "string") continue;
    const violatedRecords = fenceViolations.filter(
      (v) => v.workstreamId === violator && v.kind === "sibling-declared",
    );
    const prompt = fenceRecoveryPrompt(violator, violatedRecords, owners);
    const startedAt = Date.now();
    try {
      const res = await dispatch(
        ctx.pi,
        {
          role: "developer",
          prompt,
          cwd: violatorWt,
        },
        { label: `developer[${violator}] (fence-recovery)` },
      );
      const ok = res.ok && !res.errorStop;
      const completionEvent = await buildCompletionEvent(
        ctx,
        "develop",
        "developer",
        `developer[${violator}]`,
        res,
      );
      stateRef.current = appendEvent(stateRef.current, completionEvent);
      if (ids.length > 1) {
        stateRef.current = appendEvent(stateRef.current, {
          kind: "branch-completed",
          step: "develop",
          workstreamId: violator,
          ok,
          ms: Date.now() - startedAt,
          at: Date.now(),
        });
      }
    } catch (err) {
      // #849 — the re-dispatch threw: park with the fence cap (the
      // evidence names the first attempt's discarded SHA).
      const errMsg = (err as Error).message?.slice(0, 200) ?? "unknown error";
      stateRef.current = appendEvent(
        stateRef.current,
        fenceViolationCapHit(
          stateRef.current.pipelineState.reviewRound,
          `fence recovery re-dispatch for ${violator} failed: ${errMsg} (first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"})`,
        ),
      );
      return { parked: true };
    }
  }
  return {
    parked: false,
    worktrees,
    workstreamBaseShas,
    workstreams: injected,
    firstAttemptEvidence: discardedShas.join(", ") || "(no commit ahead of base)",
  };
}

/**
 * #849 — the full fence recovery flow: `recoverFenceViolations` (the cycle
 * check, the discard, the single re-dispatch) followed by the fence + verify
 * gate re-run on the recovered tree. A clean re-run proceeds through the
 * converge gate; a second violation parks with the fence cap (evidence names
 * BOTH attempts); a non-fence failure parks with the verify-failed cap.
 * The caller (runDevelopTopological) returns the result as the step's state.
 */
export async function runFenceRecoveryFlow(
  ctx: DriverContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState> {
  // #849 — the gate runs on `stateRef.current` (the flip wrote the verdicts
  // there), not the `stateIn` the caller passed in.
  const recovery = await recoverFenceViolations(
    ctx,
    stateRef,
    stateRef.current,
    ids,
    execFn,
    dispatch,
  );
  if (recovery.parked) {
    return stateRef.current;
  }
  // #849 — the recovery's violator list is the source of truth for the
  // re-run's verdict restore; captured before the re-run's result overwrites
  // the stashed `verifyEvidence`.
  const recoveredIds = new Set(
    siblingDeclaredViolators(stateRef.current.pipelineState.verifyEvidence?.fenceViolations ?? []),
  );
  // #849 round 3 — worktrees/workstreamBaseShas come from a FRESH read of
  // `stateRef.current` (after `recoverFenceViolations` returned) merged with
  // the recovery's reset-derived maps — not from the captured pre-dispatch
  // map (the re-dispatch and completion events operate on `stateRef.current`
  // in the window between the discard and this read). The recovery wrote the
  // merged maps into `stateRef.current` itself (no aliasing); merge idempotent.
  const afterRecovery = stateRef.current;
  let next: WorkState = {
    ...afterRecovery,
    pipelineState: {
      ...afterRecovery.pipelineState,
      worktrees: { ...afterRecovery.pipelineState.worktrees, ...recovery.worktrees },
      // #849 — merge (not replace) the base maps: the recovery re-based the
      // RECOVERED workstream to the owner's post-commit SHA; the OTHER
      // workstreams keep their original base (a replaced map would drop the
      // others' bases and their diffs would measure from the wrong point).
      workstreamBaseShas: {
        ...afterRecovery.pipelineState.workstreamBaseShas,
        ...recovery.workstreamBaseShas,
      },
      // #849 — the injected dependsOn edges persist so the gate's #725
      // carve-out and the commit-pr consolidation see the new dependency graph.
      workstreams: recovery.workstreams,
    },
  };
  stateRef.current = next;
  // #849 — re-run the fence + verify gates on the recovered tree (the fence
  // re-runs over the same workstreams map with the injected edges; the
  // safety net re-fires if the re-dispatch left uncommitted work).
  const hasRecoveryEvidence = await hasAnyWorktreeEvidence(ctx, next);
  if (hasRecoveryEvidence) {
    next = await applySafetyNet(ctx, next);
    const gate2 = await verifyStepOutcome(ctx, next, "develop");
    const rereRunRecords = gate2.fenceViolations ?? [];
    const blockingSecond = rereRunRecords.filter(
      (f) => f.kind === "sibling-declared" || f.kind === "issue-fenced",
    );
    // #849 round 3 — the RESTORE is honest: a recovered violator returns
    // to ok:true ONLY when the re-run gate ran (hasRecoveryEvidence),
    // gate2.ok is true, AND no blocking fence record names it in the
    // re-run; otherwise it stays ok:false.
    const reRanClean = gate2.ok && blockingSecond.every((r) => !recoveredIds.has(r.workstreamId));
    if (reRanClean) {
      for (let i = 0; i < verdicts.length; i++) {
        const v = verdicts[i];
        if (!v) continue;
        if (recoveredIds.has(v.id) && v.ok === false) {
          verdicts[i] = { id: v.id, ok: true };
        }
      }
    }
    // #849 round 3 — whenever the re-run produced ANY blocking record
    // (sibling-declared OR issue-fenced), apply the flip BEFORE any park
    // return, so the converged verdicts reflect the re-run.
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
    // Force the (honest) verdict state into the event log.
    next = replaceDevelopConvergedVerdicts(
      next,
      verdicts.map((v) => ({ ...v })),
    );
    // #849 round 2 — the PARK decision keys on the re-run's fence RECORDS,
    // not on gate2.ok (a re-violation that passes the verify command still
    // yields a blocking record and parks; only non-blocking warn-only
    // records never park).
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
        fenceViolationCapHit(
          next.pipelineState.reviewRound,
          `fence violated again after the recovery re-dispatch (both attempts) — first: ${recovery.firstAttemptEvidence}; second: ${secondProse}`,
        ),
      );
      return next;
    }
    if (gate2.ok) {
      // #849 round 2 — the re-run passed every gate with no blocking fence
      // record: proceed through the converge gate (the second-violation /
      // git-failure / cycle parks are above or in recoverFenceViolations).
      next = await runConvergeGateHandler(ctx, next, dispatch);
      return next;
    }
    // #849 — the re-run failed without a blocking fence record: a genuine
    // verify failure falls through to the verify-failed cap.
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
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "verify-failed:develop",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence: failureEvidence,
    });
    return next;
  }
  return next;
}

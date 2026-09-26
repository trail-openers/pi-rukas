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
 *      SHA; the discarded SHA recorded on a fence-recovery-started event —
 *      the object stays reachable in the store, so the discard cannot
 *      destroy evidence),
 *   4. the single re-dispatch of ONLY the violators, with the recovery
 *      prompt (names the violated files, tells the developer to use the
 *      owners' versions rather than re-implement them).
 *
 * The caller (runDevelopTopological) re-runs the fence + verify gates on the
 * recovered tree after this returns; a second violation parks with the
 * fence cap (the evidence names BOTH attempts), a clean re-run proceeds
 * through the converge gate.
 */
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

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

// #849 — `Workstream` extends `{ id: string; dependsOn?: string[] }`, so
// `injectFenceDependsOn<Workstream>` is safe; the alias keeps the call site
// readable without a cast.
// (The generic is invoked at the call site as `injectFenceDependsOn<WS>`; this
// type alias is for the outcome shape only.)
import type { Workstream } from "./workflow-state-schema.ts";

type WS = Workstream;

/**
 * #849 — run the fence recovery for every sibling-declared violator (the
 * cycle check, the discard, the single re-dispatch). `stateRef` is the
 * caller's shared state ref: events (fence-recovery-started, the re-dispatch
 * completion, any park cap-hit) are appended to it, so the caller reads
 * `stateRef.current` after this returns. A parked outcome carries the cap-hit
 * already appended; the caller returns `stateRef.current` without re-running
 * the gates.
 */
export async function recoverFenceViolations(
  ctx: DriverContext,
  stateRef: { current: WorkState },
  stateIn: WorkState,
  ids: string[],
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
  activeIssues: number[],
  scratchAbs: string,
): Promise<FenceRecoveryOutcome> {
  void activeIssues;
  void scratchAbs;
  const wsIn = stateIn.pipelineState.workstreams ?? {};
  // #849 — the gate's fence records live on the gate's result, not on
  // `pipelineState.verifyEvidence` (which the develop step only writes on a
  // FAILURE path, and only AFTER the gate returns). The caller (the
  // runFenceRecoveryFlow re-run below) passes the gate's records via the
  // state's `verifyEvidence` AFTER the re-dispatch; for the FIRST pass (this
  // function's input) the records arrive on `stateIn`'s `verifyEvidence` set
  // by the caller just before the call. To keep this self-contained, the
  // records are read from a field the caller stashes on the state: the
  // caller sets `pipelineState.verifyEvidence` right before invoking this
  // function (the gate's result, carried structurally).
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
  // #849 — the cycle check runs BEFORE any recovery machinery (a cycle parks
  // with zero re-dispatch). Nothing has been discarded yet, so the first
  // attempt's evidence is the violators' ids (their commits are still on the
  // worktrees).
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
  // #849 — inject the dependsOn edges (V → each declaring owner). The
  // injected map keeps the `Record<string, Workstream>` shape (a workstream
  // entry is only replaced, never removed).
  const injected = injectFenceDependsOn(wsIn, fenceViolations) as NonNullable<
    WorkState["pipelineState"]["workstreams"]
  >;
  const worktrees = { ...stateIn.pipelineState.worktrees };
  const workstreamBaseShas = { ...(stateIn.pipelineState.workstreamBaseShas ?? {}) };
  const discardedShas: string[] = [];
  let next = stateIn;
  for (const violator of violators) {
    const vWs = injected[violator];
    if (!vWs) continue;
    const owners = (vWs.dependsOn ?? []).filter((o) => wsIn[o]);
    if (owners.length === 0) continue;
    const violatorWt = worktrees[violator];
    if (typeof violatorWt !== "string") continue;
    // #849 — the owner's post-commit tree = the owner's worktree HEAD (the
    // stack tip, the same shape `resolveDependentBase` resolves for a
    // dependent workstream from its dependency's post-commit SHA).
    const primaryOwner = owners[0];
    if (primaryOwner === undefined) continue;
    const ownerWt = worktrees[primaryOwner];
    if (typeof ownerWt !== "string") continue;
    let ownerSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: ownerWt,
        maxBuffer: 64 * 1024,
      });
      ownerSha = stdout.trim();
    } catch {
      continue; // owner's SHA unreadable — cannot reset; leave as-is
    }
    if (!ownerSha) continue;
    // #849 — read the violator's current HEAD (the commit to discard).
    let violatorSha = "";
    try {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: violatorWt,
        maxBuffer: 64 * 1024,
      });
      violatorSha = stdout.trim();
    } catch {
      // no readable HEAD — nothing to discard
    }
    // #849 — discard the violator's commit: reset its worktree to the owner's
    // post-commit SHA. The object stays reachable in the store; the SHA is
    // recorded on the event (the discard cannot destroy evidence).
    try {
      await execFn(`git reset --hard ${JSON.stringify(ownerSha)}`, {
        cwd: violatorWt,
        maxBuffer: 64 * 1024,
      });
    } catch {
      continue; // reset failed — cannot recover; leave as-is
    }
    if (violatorSha) discardedShas.push(violatorSha);
    // #849 — record the discard on a fence-recovery-started event.
    next = appendEvent(next, {
      kind: "fence-recovery-started",
      at: Date.now(),
      workstreamId: violator,
      owners,
      ...(violatorSha ? { discardedSha: violatorSha } : {}),
    });
    // #849 — the violator's effective base is now the owner's tip (the
    // fence re-run's #725 carve-out and the verify gate's per-workstream
    // diff measure against the owner's tip, not the global baseSha).
    workstreamBaseShas[violator] = ownerSha;
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
  // prompt (it names the violated files and tells the developer to use the
  // owners' versions rather than re-implement them). The worktrees are
  // already reset to the owners' tips, so no deferred worktree creation is
  // needed.
  for (const violator of violators) {
    const vWs = injected[violator];
    if (!vWs) continue;
    const owners = (vWs.dependsOn ?? []).filter((o) => wsIn[o]);
    const violatorWt = worktrees[violator];
    if (typeof violatorWt !== "string" || owners.length === 0) continue;
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
      // #849 — the re-dispatch threw: park with the fence cap (the recovery
      // failed; the evidence names the first attempt's discarded SHA).
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
 * converge gate; a second violation parks with the fence cap (the evidence
 * names BOTH attempts); a non-fence failure parks with the verify-failed cap
 * and the re-run's evidence. The caller (runDevelopTopological) returns the
 * returned state as the step's result.
 */
export async function runFenceRecoveryFlow(
  ctx: DriverContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
  activeIssues: number[],
  scratchAbs: string,
): Promise<WorkState> {
  // #849 — the gate runs on `stateRef.current` (the flip wrote the verdicts
  // there), not the `stateIn` the caller passed in — the flip's replacement
  // is what the recovery's fence re-run must see.
  const recovery = await recoverFenceViolations(
    ctx,
    stateRef,
    stateRef.current,
    ids,
    execFn,
    dispatch,
    activeIssues,
    scratchAbs,
  );
  if (recovery.parked) {
    return stateRef.current;
  }
  // #849 — the recovery's violator list is the source of truth for the
  // re-run's verdict restore (the workstreams map is the FULL map, so a
  // membership check on it is always true). Captured before the gate's
  // stashed `verifyEvidence` is overwritten by the re-run's result.
  const recoveredIds = new Set(
    siblingDeclaredViolators(stateRef.current.pipelineState.verifyEvidence?.fenceViolations ?? []),
  );
  let next = stateRef.current;
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      worktrees: recovery.worktrees,
      // #849 — the recovery re-based the RECOVERED workstream's base to the
      // owner's post-commit SHA (so the re-dispatch's diff is measured from
      // there). The OTHER workstreams keep their original base — merging the
      // maps (rather than replacing) preserves them, which keeps the fence
      // re-run's changed-paths diff correct for every workstream (a replaced
      // map with only the recovered id would drop the others' bases and make
      // their diffs measure from the wrong point).
      workstreamBaseShas: {
        ...stateRef.current.pipelineState.workstreamBaseShas,
        ...recovery.workstreamBaseShas,
      },
      // #849 — the injected dependsOn edges persist so the gate's #725
      // carve-out and the commit-pr consolidation see the new dependency graph.
      workstreams: recovery.workstreams,
    },
  };
  // #849 — re-run the fence + verify gates on the recovered tree (the
  // re-dispatch's work is now committed; the fence re-runs over the same
  // workstreams map with the injected edges, and the safety net re-fires on
  // the recovered worktree if its re-dispatch left uncommitted work).
  const hasRecoveryEvidence = await hasAnyWorktreeEvidence(ctx, next);
  if (hasRecoveryEvidence) {
    next = await applySafetyNet(ctx, next);
    const gate2 = await verifyStepOutcome(ctx, next, "develop");
    // #849 — the re-run's flip must be able to RESTORE a violator's verdict
    // to ok:true when the recovery re-run is clean. `applyFenceVerdicts` only
    // flips entries that were ok:true, so a violator left at ok:false by the
    // first flip would never be restored. The recovery's violator list
    // (`recoveredIds`, captured above) is the source of truth: a clean re-run
    // (the re-dispatch committed only its own file) restores the verdict; a
    // re-violation is detected by the re-run's own fence records (the
    // `fenceBlocked` branch below). This code is reached only when recovery
    // actually happened (runFenceRecoveryFlow), so the restore is safe here.
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i];
      if (!v) continue;
      if (recoveredIds.has(v.id) && v.ok === false && v.reason?.startsWith("fence violation")) {
        verdicts[i] = { id: v.id, ok: true };
      }
    }
    // Force the restore into the event log (the flip below only runs when the
    // re-run's fence records are non-empty; a clean re-run yields an empty
    // record set, so the restore must be applied unconditionally).
    next = replaceDevelopConvergedVerdicts(
      next,
      verdicts.map((v) => ({ ...v })),
    );
    if (gate2.fenceViolations && ids.length > 1) {
      const flipped2 = applyFenceVerdicts(
        verdicts.map((v) => ({ ...v })),
        gate2.fenceViolations,
      );
      const changed2 = flipped2.some((v, i) => {
        const o = verdicts[i];
        return o === undefined || o.ok !== v.ok || o.reason !== v.reason;
      });
      if (changed2) {
        next = replaceDevelopConvergedVerdicts(next, flipped2);
        // #849 — the local `verdicts` array is the source the caller's later
        // reads compare against; sync it so the re-flip's changed-detection
        // compares against the latest state.
        for (let i = 0; i < verdicts.length; i++) {
          const f = flipped2[i];
          if (f) verdicts[i] = { ...f };
        }
      }
    }
    if (gate2.ok) {
      // #849 — the recovery passed the re-run: proceed through the converge
      // gate (the fence re-violation / cycle / genuine verify failure parks
      // below).
      next = await runConvergeGateHandler(ctx, next, dispatch);
      return next;
    }
    // #849 — the re-run failed. Any fence-blocking record (sibling-declared
    // or issue-fenced) parks with the fence cap (the evidence names BOTH
    // attempts — the first via the discarded SHA, the second via the
    // re-run's record); a non-fence failure (genuine verify failure) falls
    // through to the verify-failed cap.
    const fenceBlocked = (gate2.fenceViolations ?? []).some(
      (f) => f.kind === "sibling-declared" || f.kind === "issue-fenced",
    );
    if (fenceBlocked) {
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

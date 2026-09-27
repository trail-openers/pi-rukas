/**
 * work-develop-fence-recovery — #849: the develop step's fence recovery.
 *
 * When the develop verify gate records a BLOCKING sibling-declared fence
 * violation, the driver recovers instead of parking (the #814 park was
 * terminal: a fence record went straight to cap-hit → handoff). For each
 * violating workstream V:
 *
 *   - a dependsOn edge is injected from V to each declaring owner,
 *   - V's commit is discarded (its worktree reset to the stack tip of the
 *     declaring owner(s) — the same shape `runDependentWorkstreams` builds
 *     for a dependent workstream from a dependency's post-commit SHA), the
 *     discarded SHA recorded on a `fence-recovery-started` event (the
 *     discard cannot destroy evidence: the object stays reachable in the
 *     store, and the event names it),
 *   - ONLY V is re-dispatched, once, with a prompt that names the violated
 *     files and tells the developer to use the owners' versions rather than
 *     re-implement them.
 *
 * Parking rules:
 *   - a SECOND violation (the fence re-run after the re-dispatch) parks with
 *     the `fence-violation:develop` cap; the evidence names BOTH attempts.
 *   - a violator↔owner cycle (V's owner also depends on V, or V declared a
 *     file the owner violated) parks with the same cap and NO re-dispatch.
 *   - a git failure discarding a violator's commit parks with the same cap
 *     and NO re-dispatch (a violator that was not discarded cannot be
 *     re-dispatched — re-running it on top of its own violating commit is a
 *     re-violation by construction, with no evidence anything changed).
 *   - at most one recovery round per cycle (the flow runs the fence gate at
 *     most twice; only the first pass may recover).
 *
 * The discriminator is the record KIND from the gate's `fenceViolations` —
 * `sibling-declared` only. `issue-fenced` violations still block exactly as
 * today (no recovery), and `undeclared` records (warn-only) never trigger
 * recovery.
 */
import { trace } from "./trace.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { appendEvent } from "./workflow-state.ts";

type ParkStateRef = { current: import("./workflow-state.ts").WorkState };

// #849 — typed from the `cap` literal union (workflow-state-events-caps.ts) so
// the cap name has one source: a rename there breaks here, not silently.
export const FENCE_VIOLATION_CAP = "fence-violation:develop" as const satisfies WorkCapLiteral;

/**
 * #849 — the workstream ids with a BLOCKING sibling-declared fence record
 * (the recovery candidates). `issue-fenced` and `undeclared` records are
 * excluded: they block/warn exactly as before, never recover.
 */
export function siblingDeclaredViolators(fenceViolations: FenceViolationRecord[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of fenceViolations) {
    if (v.kind !== "sibling-declared") continue;
    if (seen.has(v.workstreamId)) continue;
    seen.add(v.workstreamId);
    ids.push(v.workstreamId);
  }
  return ids;
}

/**
 * #849 — the violator↔owner cycle check, run BEFORE any recovery machinery
 * (the acceptance criterion: a cycle parks with zero re-dispatches). A cycle
 * exists when a violator's owner depends on the violator (the injected
 * V→owner edge would form a loop) or when the violator declared a file that
 * one of its owners VIOLATED (the "owner" is itself a violator of the
 * violator's declared scope — recovery would just re-route the same
 * collision).
 *
 * Returns a per-violator map of cycle reasons (empty map = no cycles).
 */
export function fenceRecoveryCycles(
  workstreams: Record<string, { id: string; paths: string[]; dependsOn?: string[] } | undefined>,
  fenceViolations: FenceViolationRecord[],
): Map<string, string> {
  const cycles = new Map<string, string>();
  if (fenceViolations.length === 0) return cycles;
  // The declaring owner(s) per violating workstream (from the records).
  const ownersOf = new Map<string, Set<string>>();
  for (const v of fenceViolations) {
    if (v.kind !== "sibling-declared") continue;
    const s = ownersOf.get(v.workstreamId) ?? new Set<string>();
    s.add(v.declaredById);
    ownersOf.set(v.workstreamId, s);
  }
  // The file → declaring workstream map (for rule 2).
  const declaredBy = new Map<string, string>();
  for (const [id, ws] of Object.entries(workstreams)) {
    if (!ws) continue;
    for (const p of ws.paths) {
      const n = p.trim();
      if (n.length > 0) declaredBy.set(n, id);
    }
  }
  for (const [violator, owners] of ownersOf) {
    for (const owner of owners) {
      // Rule 1 — the owner depends on the violator: the injected V→owner
      // edge would make the graph cyclic.
      const ownerDeps = workstreams[owner]?.dependsOn ?? [];
      if (ownerDeps.includes(violator)) {
        cycles.set(
          violator,
          `${owner} depends on ${violator} — the injected ${violator}→${owner} edge would form a dependency cycle`,
        );
        continue;
      }
      // Rule 2 — the violator declared a file the owner violated (mutual
      // ownership: the owner is itself a sibling-declared violator of a file
      // the violator declared).
      for (const ov of fenceViolations) {
        if (ov.kind !== "sibling-declared" || ov.workstreamId !== owner) continue;
        if (declaredBy.get(ov.file) === violator) {
          cycles.set(
            violator,
            `${owner} violated ${ov.file}, which ${violator} declared — the ownership is mutual (a violator↔owner cycle)`,
          );
        }
      }
    }
  }
  return cycles;
}

/**
 * #849 — the dependsOn injection: V → each declaring owner. Returns a COPY of
 * the workstreams map with the edges added; the caller uses the injected map
 * for both the re-dispatch (the topological order) and the fence re-run (the
 * re-run's #725 dependsOn carve-out then sees the new edges, so the owner's
 * files are legitimately the violator's dependency, not a re-violation).
 */
export function injectFenceDependsOn(
  workstreams: Record<string, { id: string; dependsOn?: string[] } | undefined>,
  fenceViolations: FenceViolationRecord[],
): Record<string, { id: string; dependsOn?: string[] } | undefined> {
  const injected: Record<string, { id: string; dependsOn?: string[] } | undefined> = {
    ...workstreams,
  };
  for (const v of fenceViolations) {
    if (v.kind !== "sibling-declared") continue;
    const ws = injected[v.workstreamId];
    if (ws === undefined) continue;
    const existing = ws.dependsOn ?? [];
    if (!existing.includes(v.declaredById)) {
      injected[v.workstreamId] = { ...ws, dependsOn: [...existing, v.declaredById] };
    }
  }
  return injected;
}

/**
 * #849 — the re-dispatch prompt for one violating workstream. Names the
 * violated files (with the declaring owner per file) and tells the developer
 * to use the owners' versions rather than re-implement them: the worktree now
 * CONTAINS the owners' commits (reset to their stack tip), so re-implementing
 * a sibling's file is exactly the violation that just fired.
 */
export function fenceRecoveryPrompt(
  workstreamId: string,
  violated: FenceViolationRecord[],
  owners: string[],
): string {
  const files = violated
    .filter(
      (v): v is Extract<FenceViolationRecord, { kind: "sibling-declared" }> =>
        v.workstreamId === workstreamId && v.kind === "sibling-declared",
    )
    .map((v) => `${v.file} (declared by ${v.declaredById})`)
    .join(", ");
  return [
    `FENCE RECOVERY RE-DISPATCH — workstream ${workstreamId}.`,
    "",
    `Your first attempt at this workstream was REJECTED by the develop scope fence: it touched ${files}. That commit was DISCARDED and your worktree was reset to the post-commit tree of its declaring owner(s): ${owners.join(", ")}.`,
    "",
    `This is your ONLY re-dispatch. Implement the workstream's scope on top of the owners' versions of those files — do NOT re-implement the owners' work, do NOT recreate their files with your own content, and do NOT touch any file a sibling workstream declared. Build against what is already in the tree.`,
  ].join("\n");
}

/**
 * #849 — the cap-hit event for a fence park (second violation after the
 * recovery re-dispatch, or a violator↔owner cycle before any re-dispatch).
 * The caller composes `evidence` to name BOTH attempts (the first via the
 * `fence-recovery-started` event's discarded SHA, the second via the
 * re-run's fence record).
 */
export function fenceViolationCapHit(
  reviewRound: number,
  evidence: string,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap: FENCE_VIOLATION_CAP,
    reviewRound,
    nextStep: "handoff",
    evidence,
  };
}

/** #849 — the discard precondition park (moved here from
 * work-develop-fence-recovery-run.ts to stay under the 500-line gate):
 * a failed precondition parks with the fence cap naming the violator and
 * the owner(s), ZERO re-dispatches of ANY violator.
 */
export function makeParkPrecondition(
  stateRef: ParkStateRef,
  stateIn: import("./workflow-state.ts").WorkState,
  violators: string[],
) {
  return (violator: string, owners: string[], reason: string): { parked: true } => {
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
}

/**
 * work-driver-path-claims-gate — the plan-time claim gate: check this cycle's
 * declared paths against what siblings hold, then register ours.
 *
 * Split out of `work-driver-path-claims.ts` for the 500-line gate (AGENTS.md
 * §12) along the seam the module already had: the registry file (read, prune,
 * register, release, the lock) stayed there, and the two things the PLAN step
 * calls moved here — the conflict park and the registration that follows it.
 * The registry re-exports both, so `work-driver-plan.ts` keeps one import site
 * and the gate cannot be reached around by a caller that reads the registry
 * directly.
 *
 * #1454 r3 — the registration half fails CLOSED, and the failure is a NAMED
 * park rather than a crash. `withClaimsLock` throws when the lockfile cannot be
 * created (a read-only `.pi/work-state`, ENOSPC) or a sibling held it past the
 * wait window, because writing a claim outside the lock is the exact lost
 * update the lock removes. An escaping throw from a step handler used to become
 * `driver-crash:plan` — "an unhandled error in the step handler" — which sends
 * the operator to debug the driver when the filesystem is what is broken. Both
 * refusals now land as `claims-lock-unavailable` with the refusal text as
 * evidence, the same shape the conflict park two lines above already used.
 */

import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { claimsFilePath, readRawClaims, writeClaims } from "./work-driver-path-claims-file.ts";
import {
  CLAIMS_LOCK_REFUSAL,
  CLAIMS_RMW_WINDOW_MS,
  withClaimsLock,
  withClaimsLockBestEffort,
} from "./work-driver-path-claims-lock.ts";
import { type PathClaimEntry, claimDeletionReason } from "./work-driver-path-claims-staleness.ts";
import { checkCrossGroupClaimsSync, readClaims } from "./work-driver-path-claims.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const PID = process.pid;

/**
 * What the plan step's claim gate decided, so its caller branches on the gate's
 * OWN answer rather than sniffing the event tail (#1756).
 *
 * `parked` is true exactly when this call appended a `cap-hit` and moved the
 * step to a plan handoff — the conflict park, the claims-lock refusal, or a
 * conflict whose first entry was missing (the degenerate branch below, which
 * still leaves the state parked by construction). Reading
 * `eventLog.at(-1)?.kind === "cap-hit"` instead asked the tail who had appended
 * it, so any unrelated trailing event — a completion appended after a conflict
 * park — became a park, and the gate's own park could be hidden under a tail
 * that is not a cap-hit. One discriminant, no guessing.
 */
export type ClaimsGateOutcome = { state: WorkState; parked: boolean };

/**
 * The plan step's claim gate: park on a sibling overlap, else register ours.
 *
 * `now` is injectable so the suite can age a claim without sleeping.
 */
export async function checkAndRegisterClaims(
  ctx: CycleContext,
  state: WorkState,
  workstreams: Record<string, { paths?: string[]; outOfScope?: string[] }>,
  now: number = Date.now(),
): Promise<ClaimsGateOutcome> {
  const allPaths = Object.values(workstreams).flatMap((ws) => ws.paths ?? []);
  if (allPaths.length === 0) return { state, parked: false }; // nothing to claim

  const claims = await readClaims(ctx.repoRoot, now);
  const conflicts = checkCrossGroupClaimsSync(ctx.issue, workstreams, claims);

  if (conflicts.length > 0) {
    const sibling = conflicts[0];
    // Degenerate shape (a truthy list whose first slot is absent): there is no
    // sibling to name, so nothing to register against and no claim to write.
    // Reported as a park — the gate stopped the step either way, and a caller
    // that read `false` here would develop a plan whose paths nobody reserved.
    if (!sibling) return { state, parked: true };
    const overlap = allPaths.map(normaliseDeclaredPath).filter((p) => sibling.paths.includes(p));
    const park = appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "cross-group-conflict" as const,
      // `claimant<N>` is the machine-readable carrier humanActionFor and
      // explainCap read — prose is not a stable interface.
      evidence: `claimant${sibling.issue} issue #${sibling.issue} claims: ${sibling.paths.join(", ")}; overlapping: ${overlap.join(", ")}`,
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff" as const,
    });
    return {
      state: {
        ...park,
        pipelineState: {
          ...park.pipelineState,
          status: "handoff",
          currentStep: "plan",
        },
      },
      parked: true,
    };
  }
  // No conflicts — register so siblings see our claim.
  try {
    await registerClaim(ctx.repoRoot, ctx.issue, allPaths);
  } catch (err) {
    // Discriminated on the lock module's own marker prefix, never on prose: a
    // reworded refusal must not silently turn the named park back into a crash.
    const message = (err as Error).message ?? "";
    if (!message.startsWith(CLAIMS_LOCK_REFUSAL)) throw err;
    trace(
      `work-driver-path-claims: the claims lock refused a registration for #${ctx.issue} — parking at plan`,
    );
    return {
      state: {
        ...appendEvent(state, {
          kind: "cap-hit",
          at: Date.now(),
          cap: "claims-lock-unavailable" as const,
          evidence: message.slice(0, 400),
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff" as const,
        }),
        pipelineState: {
          ...state.pipelineState,
          status: "handoff",
          currentStep: "plan",
        },
      },
      parked: true,
    };
  }
  return { state, parked: false };
}

/**
 * Register a claim for the given paths. Atomic write + rename.
 * Returns the registry state after the write (for verification).
 */
export async function registerClaim(
  repoRoot: string,
  issue: number,
  paths: string[],
): Promise<PathClaimEntry[]> {
  const normalised = [...new Set(paths.map(normaliseDeclaredPath).filter(Boolean))];
  if (normalised.length === 0) return [];

  // r2 — the whole read-modify-write is under the lock, not just the write:
  // reading outside it means the snapshot the write is derived from is already
  // stale by the time the lock is held, which is the lost update unchanged.
  // Unlike the prune and the release, this THROWS when the lock cannot be had
  // — registering unlocked is the exact lost update the lock removes, and a
  // silently-dropped claim is two cycles editing one file.
  return withClaimsLock(repoRoot, async () => {
    // r2 — the RAW file (not the liveness-filtered read) because a writer must
    // never lose an entry it did not set out to remove; corpses are what the
    // READER prunes (`readClaims`). Peers are filtered by `claimDeletionReason`
    // — the writer's CONSERVATIVE rule — and deliberately not by
    // `claimStaleReason`, the reader's rule. The reader may drop an entry it
    // cannot verify (a false "stale" costs one spurious park); a writer may not,
    // because a false "stale" here deletes a live sibling's reservation. That
    // mix-up lost seven of eight concurrent claims: a peer process that has just
    // started has no state file yet, and the reader's rule reads "no state file"
    // as no owner. `releaseClaim` used to rebuild the file from a filtered read
    // and silently erased a live sibling's ownership — same class, other door.
    const all = await readRawClaims(repoRoot);
    // #1454 r2 — test-only widening of the window this lock exists to close:
    // the interval a sibling's rename can land in. 0 unless the test forced the
    // lock off, so production never waits. See `resolveClaimsWindowMs`.
    if (CLAIMS_RMW_WINDOW_MS > 0) await new Promise((r) => setTimeout(r, CLAIMS_RMW_WINDOW_MS));
    const live: PathClaimEntry[] = [];
    for (const entry of all) {
      if (entry.pid !== PID) {
        const doomed = await claimDeletionReason(repoRoot, entry);
        if (doomed) {
          trace(`work-driver-path-claims: writer dropped a stale entry #${entry.issue}: ${doomed}`);
          continue;
        }
      }
      live.push(entry);
    }
    // Remove our own previous claim (same issue, possibly re-registered).
    const withoutSelf = live.filter((c) => c.issue !== issue);
    // Add our new claim.
    const entry: PathClaimEntry = {
      issue,
      pid: PID,
      paths: normalised,
      startedAt: Date.now(),
    };
    const updated = [...withoutSelf, entry];

    await writeClaims(claimsFilePath(repoRoot), updated);
    return updated;
  });
}

/**
 * Release (unregister) a cycle's claims. Returns the remaining claims.
 *
 * One issue, or the whole group: a grouped cycle (`/work 10 11`) claims EVERY
 * issue in the group (that is what work-driver-registry.claimCycle does), so
 * clearing only the primary leaves a sibling entry behind to park the next
 * cycle — the same zombie, one issue short. Callers that know the group pass
 * every number; `releaseClaim(repoRoot, 1421)` is the single-issue form.
 *
 * #1454 — this writes the raw registry minus the released issues rather than
 * `readClaims()` minus them. The old shape rebuilt the file from a
 * liveness-FILTERED read, so releasing one issue silently erased every other
 * entry the read could not verify — a live sibling's ownership could evaporate
 * as a side effect of an unrelated release. A release now removes exactly what
 * it is told to and nothing else.
 */
export async function releaseClaim(
  repoRoot: string,
  issue: number | number[],
): Promise<PathClaimEntry[]> {
  const file = claimsFilePath(repoRoot);
  // Best-effort by contract: a release that cannot get the lock leaves its own
  // entry behind, which the next reader ages out through `claimStaleReason`.
  // Failing closed here would cost a cycle its teardown.
  return withClaimsLockBestEffort(
    repoRoot,
    async () => {
      const all = await readRawClaims(repoRoot);
      const mine = new Set(Array.isArray(issue) ? issue : [issue]);
      const remaining = all.filter((c) => !mine.has(c.issue));
      // Write the empty array rather than deleting the file, so consumers that
      // read it always get a consistent shape.
      await writeClaims(file, remaining);
      return remaining;
    },
    [],
  );
}

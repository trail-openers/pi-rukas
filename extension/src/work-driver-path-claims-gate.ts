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
 * ACCEPTED test seam (the shape `setClaimsLockWriteFaultForTests` is): replace
 * the conflict list the gate judges with one the suite supplies. `undefined`
 * — the value in production, and what the setter's own `undefined` restores —
 * means "read the registry", which is every real call.
 *
 * It exists so the degenerate branch below is ASSERTABLE rather than merely
 * present. That branch is a fail-closed guard against a truthy conflict list
 * whose first slot is absent, and the empirical finding of this round is that
 * NO production route reaches it: `readRawClaims` only yields rows
 * `validClaimEntry` accepted, `checkCrossGroupClaimsSync` only pushes entries it
 * was handed, and #1101's sibling filter drops rows from `fresh` BEFORE the
 * conflict check runs — so it cannot produce a non-empty list missing its head
 * either. A guard for an unreachable shape is still the right code (fail closed
 * rather than crash), but an assertion that has to forge the registry to fire
 * would be testing the forgery. This seam lets the suite hand the gate the list
 * directly and pin what a park owes, which is the invariant that broke.
 */
let conflictsOverride: PathClaimEntry[] | undefined;

/** Permanent test seam (accepted): set/clear the injected conflict list. */
export function setClaimsConflictsForTests(conflicts?: PathClaimEntry[]): void {
  conflictsOverride = conflicts;
}

/**
 * What the plan step's claim gate decided, so its caller branches on the gate's
 * OWN answer rather than sniffing the event tail (#1756).
 *
 * `parked` is true exactly when this call appended a `cap-hit` and moved the
 * step to a plan handoff — the conflict park, the claims-lock refusal, and the
 * conflict whose first entry was missing (#1756 r2: that branch used to report
 * a park it had not made — no cap-hit, no handoff — and the caller halted on an
 * un-parked state; it now appends the same cap and sets the same handoff fields
 * as the conflict park above it, so the discriminant and the state agree). Reading
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
  const conflicts = conflictsOverride ?? checkCrossGroupClaimsSync(ctx.issue, workstreams, claims);

  if (conflicts.length > 0) {
    const sibling = conflicts[0];
    // Degenerate shape (a truthy list whose first slot is absent): there is no
    // sibling to name, so nothing to register against and no claim to write.
    // #1756 r2 — this parks HONESTLY, i.e. it does what `parked: true` claims:
    // the same cap, the same handoff fields and an evidence line saying the
    // conflicting claim could not be read. The old shape returned `parked: true`
    // with an UNCHANGED state, so the caller halted on a cycle still sitting at
    // `running`/`plan` with no cap-hit — the fail-open half of the bug this
    // branch was written to close. A reachability note, measured this round:
    // `checkCrossGroupClaimsSync` only ever pushes a `PathClaimEntry` it was
    // handed and `readRawClaims` only yields rows `validClaimEntry` accepted, so
    // no production read produces this list — it is a fail-closed guard, and the
    // direct assertion in test-work-driver-claims-gate-parks.ts drives it through
    // the accepted `setClaimsConflictsForTests` seam rather than by forging the
    // registry file.
    if (!sibling) {
      return parkClaimsGate(state, {
        cap: "cross-group-conflict" as const,
        evidence:
          "a conflicting path claim could not be read (the conflict list's first entry was absent), so no claim could be checked or registered — the cycle cannot develop paths it cannot reserve",
      });
    }
    const overlap = allPaths.map(normaliseDeclaredPath).filter((p) => sibling.paths.includes(p));
    return parkClaimsGate(state, {
      // `claimant<N>` is the machine-readable carrier humanActionFor and
      // explainCap read — prose is not a stable interface.
      cap: "cross-group-conflict" as const,
      evidence: `claimant${sibling.issue} issue #${sibling.issue} claims: ${sibling.paths.join(", ")}; overlapping: ${overlap.join(", ")}`,
    });
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
    return parkClaimsGate(state, {
      cap: "claims-lock-unavailable" as const,
      evidence: message.slice(0, 400),
    });
  }
  return { state, parked: false };
}

/**
 * The one shape every claim-gate park takes: append the named `cap-hit` and
 * move the cycle to a plan handoff, so `parked: true` and the state the caller
 * receives can never disagree (#1756 r2 — three parks, one writer, so a fourth
 * cannot forget a field).
 */
function parkClaimsGate(
  state: WorkState,
  cap: { cap: "cross-group-conflict" | "claims-lock-unavailable"; evidence: string },
): ClaimsGateOutcome {
  const parked = appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: cap.cap,
    evidence: cap.evidence,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff" as const,
  });
  return {
    state: {
      ...parked,
      pipelineState: { ...parked.pipelineState, status: "handoff", currentStep: "plan" },
    },
    parked: true,
  };
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

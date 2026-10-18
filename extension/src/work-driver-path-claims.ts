/**
 * work-driver-path-claims — cross-group path-claim registry.
 *
 * When two /work groups declare paths[] that overlap, the second cycle must
 * park at plan with a named reason rather than colliding at integration.
 *
 * Registry lives at `.pi/work-state/path-claims.json`. Each entry records:
 *   - issue number
 *   - process PID (for liveness)
 *   - normalised paths claimed
 *   - cycle start timestamp
 *
 * A claim is only honoured while its owner is a cycle that could still write.
 * #1454 — that was `process.kill(pid, 0)` in a private helper, which disagreed
 * with the driver's own liveness primitive in BOTH directions (it read pid 1 /
 * EPERM as dead and pid 0 — "signal my whole process group" — as alive), and
 * it honoured a claim left behind by a cycle that had already reached a
 * terminal status. Six observed parks were of that shape: the claimant had
 * exited or parked, never released, and every later cycle touching the same
 * files parked against it while the claims file an operator was told to
 * inspect read `[]`.
 *
 * So staleness is now one predicate — `claimStaleReason` — that reads:
 *   - `processAlive` from work-driver-resume.ts, the SAME primitive
 *     classifyRunningState uses for state-file owners. There is deliberately
 *     no module-local kill(pid,0) here: two liveness notions in one harness
 *     diverge, and they did.
 *   - the claimant's OWN state file: a terminal status means finished, and a
 *     finished cycle holds nothing (this is what catches the live-but-dead
 *     owner a pid probe cannot).
 *   - `CLAIM_STALE_MS` as the last resort, for an entry whose state file
 *     cannot be read at all — bounded so a corrupt entry eventually stops
 *     parking cycles, generous so it cannot race a legitimately long develop
 *     dispatch.
 *
 * Stale entries are dropped on read AND pruned from the file by the next
 * writer, so the footprint does not survive a crash indefinitely.
 *
 * r2 — two things that read now need, because the reader writes:
 *   - **Every read-modify-write of the registry is serialised** by the O_EXCL
 *     lock in `work-driver-path-claims-lock.ts`. Prune-on-read made every
 *     reader a writer, and two readers rebuilding the file from their own
 *     snapshot dropped whichever claim was registered in between.
 *   - **Every entry is shape-validated at the read boundary**
 *     (`validClaimEntry`). The registry is plain JSON on disk that an operator
 *     edits, and `claimStaleReason`/`checkCrossGroupClaimsSync` dereference
 *     `entry.pid`, `entry.startedAt` and `entry.paths` unguarded. A malformed
 *     entry is treated as stale and pruned, not trusted.
 *
 * Escape hatch: PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0 disables the check.
 *
 * #1101 — `claimWaitsForIssues` is the boundary between the two kinds of
 * sibling this registry sees, and `setSiblingClaimWait` is what opens that
 * boundary: the queue declares the issue set it coordinates before any group
 * starts (see `runGroupedIssues` in work-entry.ts) and clears it on every exit
 * path. A claim held by ANOTHER process is a genuinely uncoordinated second
 * opinion: nothing in this invocation can wait it down, so
 * today's immediate `cross-group-conflict` park is correct and unchanged. A
 * claim held by THIS process belongs to a sibling group of the same queue, which
 * the queue can hold back until that sibling settles — parking it here is the
 * bug, because the loss arrives after explore+plan have already been paid for.
 */

import { trace } from "./trace.ts";
import {
  claimsFilePath,
  readRawClaims,
  readRawRows,
  writeClaims,
} from "./work-driver-path-claims-file.ts";
import {
  CLAIMS_RMW_WINDOW_MS,
  withClaimsLock,
  withClaimsLockBestEffort,
} from "./work-driver-path-claims-lock.ts";
import {
  type PathClaimEntry,
  claimDeletionReason,
  claimStaleReason,
  validClaimEntry,
} from "./work-driver-path-claims-staleness.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

// Re-exported so every existing caller (`work-queue.ts`, the driver's plan step,
// the smoke suites) keeps one import site for the registry, and so the seam
// cannot be reached around. The predicates live in
// `work-driver-path-claims-staleness.ts` for the 500-line gate; the distinction
// between them is what #1454 r2 turned on.
export {
  CLAIM_STALE_MIN_FLOOR_MS,
  CLAIM_STALE_MS,
  type PathClaimEntry,
  claimDeletionReason,
  claimStaleReason,
  resolveClaimStaleMs,
  validClaimEntry,
} from "./work-driver-path-claims-staleness.ts";

const PID = process.pid;

// #1101 — the sibling-wait seam lives in `work-driver-path-claims-siblings.ts`
// (500-line gate, AGENTS.md §12) and is re-exported here so the registry stays
// the ONE import site for everything claim-related, and so the sibling filter
// cannot be reached around by a caller that reads the registry directly.
// Its own module holds the state these three read.
export {
  claimWaitsForIssues,
  setSiblingClaimWait,
  siblingClaimWaitSnapshot,
} from "./work-driver-path-claims-siblings.ts";
import { claimWaitsForIssues } from "./work-driver-path-claims-siblings.ts";

/**
 * Whether the cross-group conflict check is enabled.
 * Override: `PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0`.
 *
 * #1101 fix-round — this is the check that reads the registry, so it is also
 * the switch that makes the sibling filter load-bearing. When it is disabled
 * there is nothing to wait down: the caller does not park on a conflict at all,
 * so hiding a sibling's claim from it changes nothing except what `readClaims`
 * reports. `readClaims` stays on this switch for that reason.
 */
export function crossGroupConflictsEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS;
  return v !== "0" && v !== "false";
}

/**
 * Read the path-claims registry from disk.
 *
 * Returns the entries that still reserve their paths. Stale ones are skipped
 * AND pruned from the file (best-effort — a prune failure only means the next
 * reader repeats the work). The prune is what makes a re-run start from a
 * clean claim set instead of inheriting a crashed cycle's footprint.
 *
 * r2 — the prune is a read-modify-write of a file siblings write, so it runs
 * under the claims lock (`work-driver-path-claims-lock.ts`). Without it two
 * readers each rebuilt the file from their own snapshot and the later rename
 * dropped whichever claim was registered in between.
 *
 * r2 — entries that are not well-formed claims (`validClaimEntry`) never
 * reach a caller. They are reported stale here and pruned with the rest.
 *
 * A caller that ALREADY holds the lock must call `readClaimsUnlocked` — the
 * lock is not reentrant and `registerClaim` holds it across exactly this read.
 */
export async function readClaims(
  repoRoot: string,
  now: number = Date.now(),
): Promise<PathClaimEntry[]> {
  const { fresh, stale } = await classifyClaims(repoRoot, now);
  // #1101 — the sibling filter is consulted FIRST, on the whole registry, and
  // what it claims is removed from BOTH lists before anything else happens.
  //
  // Those are the claims that used to park a runnable cycle at plan; the queue
  // holds the dependent back instead, so the reactive check is left to what only
  // it can see (a claim no queue in this process is tracking).
  //
  // And it must be consulted before the prune, not only on the fresh path: a
  // sibling of THIS queue whose group has just settled is legitimately terminal
  // (`merged`/`handoff`), so `claimStaleReason` calls it stale — and `readClaims`
  // would then DELETE the entry as a side effect of some other group reading the
  // registry. That is #1454's own bug, reopened from the queue side: a release
  // that silently erases a claim it was not told to release. The queue owns its
  // siblings' claims — it registered them and it releases them — so this reader
  // never prunes one, stale or not.
  const isSibling = (e: PathClaimEntry) => claimWaitsForIssues(e.issue, e.pid);
  // #1101 — a sibling the queue is coordinating is dropped from `fresh`, so the
  // gate never parks a runnable cycle against a claim this very invocation is
  // waiting down. That is the expensive park #1101 replaces with a cheap wait.
  const gateable = fresh.filter((e) => !isSibling(e));
  // #1101 + #1454 — and the same siblings are dropped from the PRUNE.
  //
  // Being stale answers "may this claim park a cycle?" — it does not license a
  // DELETE. `readClaims` became a writer when prune-on-read landed, which made
  // every read of the registry a read-modify-write, and that is how a queue
  // loses a claim it still owns: #1101's queue registers a sibling's claim up
  // front and releases it from the cycle's TERMINAL step, while #1454's
  // predicate reads the claimant's OWN state file — so a sibling group that has
  // just settled is legitimately terminal, its entry reads stale, and an
  // unrelated sibling's routine read deleted it before the release ever ran.
  // That is #1454's own defect reopened from the queue side: an unrelated read
  // erasing someone else's reservation. `test-work-entry-queue-wiring.ts` pins
  // it — the claim must still be in the file after the queue, so the release
  // has something to release.
  //
  // Scoped to the declared sibling set (pid-checked inside
  // `claimWaitsForIssues`), deliberately NOT to `pid === PID`. A blanket
  // self-skip would make this process's claims immortal, and a claim left
  // behind by a process that died holding one is precisely the corpse #1454
  // set out to reap — `test-work-driver-stale-path-claims.ts` seeds such an
  // entry with this process's own pid and asserts the next read clears it.
  // The set is bounded and cleared: `setSiblingClaimWait` runs at the top of
  // one queue invocation and `null` in its `finally`, so this extends the life
  // of a claim only while a live coordinator is standing behind it.
  const prunable = stale.filter((e) => !isSibling(e));
  if (prunable.length > 0) await pruneClaims(repoRoot, prunable);
  return gateable;
}

/**
 * The staleness pass WITHOUT the prune. Kept as one expression so the reader
 * and the writer cannot drift into two different staleness rules — the split
 * that let one path prune a claim another path honoured.
 */
async function classifyClaims(
  repoRoot: string,
  now: number,
): Promise<{ fresh: PathClaimEntry[]; stale: PathClaimEntry[] }> {
  // Anything the read could not validate joins the stale list, which is what
  // gets it PRUNED. A malformed entry has no owner to honour and nothing to
  // reserve, and leaving it in place is a `TypeError` waiting in the next
  // caller plus a registry an operator cannot read.
  const malformed: unknown[] = [];
  const all = await readRawClaims(repoRoot, malformed);
  const fresh: PathClaimEntry[] = [];
  const stale: PathClaimEntry[] = [];
  for (const entry of all) {
    if (await claimStaleReason(repoRoot, entry, now)) stale.push(entry);
    else fresh.push(entry);
  }
  // #1454 r2 — `classifyClaims` is now the pure classifier: it decides staleness
  // and returns BOTH lists. The prune is `readClaims`'s job (the reader), not
  // this function's — `readClaimsUnlocked` calls the same classifier from inside
  // the claims lock and must not try to take it a second time.
  //
  // #1101 — the same-process sibling filter is NOT applied here either. A
  // sibling the queue is coordinating is neither fresh nor stale: it must not
  // join the prune (the queue's own cycle still holds it) and it must not be
  // reported as reserving paths to the gate. That filtering is `readClaims`'
  // alone — the only caller that answers "what may park a cycle right now?".
  if (malformed.length > 0) stale.push(...(malformed as PathClaimEntry[]));
  return { fresh, stale };
}

/**
 * The staleness-filtered read for a caller that already holds the claims lock:
 * the same predicate, no prune (the caller is the writer). Calling `readClaims`
 * from inside the lock would wait on a lock this very process holds.
 */
async function readClaimsUnlocked(
  repoRoot: string,
  now: number = Date.now(),
): Promise<PathClaimEntry[]> {
  return (await classifyClaims(repoRoot, now)).fresh;
}

/**
 * Remove specific entries from the file, leaving every other entry alone.
 *
 * #1454 — matching is by issue AND pid, not by issue alone: two entries for
 * one issue can coexist (a re-run after a crash), and pruning by issue would
 * delete the live one with the corpse.
 *
 * #1454 r2 — a MALFORMED entry is matched on its whole JSON form, not on
 * issue+pid. It has no trustworthy `pid` to key on (it may have none at all),
 * and matching on a field we could not validate is how one bad row could take a
 * live sibling's row with it. Serialising the whole entry is exact: two rows
 * match only if they are the same row.
 *
 * Deliberately NOT a rewrite from `readClaims()`: that filtered read drops
 * entries it merely failed to verify, so releasing one issue used to silently
 * erase an unrelated sibling's ownership.
 */
function staleKey(s: PathClaimEntry): string {
  return JSON.stringify(s);
}

async function pruneClaims(repoRoot: string, stale: PathClaimEntry[]): Promise<void> {
  const file = claimsFilePath(repoRoot);
  try {
    // Best-effort: the entries are already skipped on read, so a cycle that
    // cannot get the lock loses nothing but a repeated prune next time.
    await withClaimsLockBestEffort(
      repoRoot,
      async () => {
        const current = await readRawRows(repoRoot);
        // Keyed by JSON form so a malformed row matches only itself, and by
        // issue+pid for well-formed rows (whose identity those two fields do
        // determine, and which the caller re-reads into fresh objects).
        const staleKeys = new Set(stale.map(staleKey));
        const isStale = (c: unknown) =>
          staleKeys.has(JSON.stringify(c)) ||
          (validClaimEntry(c) &&
            stale.some(
              (s) =>
                validClaimEntry(s) &&
                (s as PathClaimEntry).issue === c.issue &&
                (s as PathClaimEntry).pid === c.pid,
            ));
        const remaining = current.filter((c) => !isStale(c)) as PathClaimEntry[];
        if (remaining.length === current.length) return;
        await writeClaims(file, remaining);
        trace(
          `work-driver-path-claims: pruned ${stale.length} stale claim(s): ${stale.map((s) => `#${s.issue}@${s.pid}`).join(", ")}`,
        );
      },
      undefined,
    );
  } catch (err) {
    // A failed prune must not cost a cycle whose claim check is otherwise
    // sound: the entries are already skipped on read, so the only cost of a
    // failed prune is that the next reader repeats it.
    trace(`work-driver-path-claims: prune failed: ${(err as Error).message?.slice(0, 200)}`);
  }
}

/**
 * Check declared paths against claims held by sibling cycles. Pure: it takes
 * the registry entries the caller already read (`readClaims` is the reader),
 * so a caller that checks several workstreams batches one disk read.
 *
 * #1454 — the pre-#1454 shape was a `checkCrossGroupClaims` async wrapper that
 * read the file itself and delegated here. It had no caller (the gate reads via
 * `checkAndRegisterClaims`) and it silently skipped the staleness pass the
 * reader owns, so keeping it around was a way to get the old always-park
 * behaviour back by accident. It is gone; the sync core is the one entry.
 */
export function checkCrossGroupClaimsSync(
  ourIssue: number,
  workstreams: Record<string, { paths?: string[]; outOfScope?: string[] }>,
  claims: PathClaimEntry[] = [],
): PathClaimEntry[] {
  // Collect and normalise our own paths.
  // #1101 — `normaliseDeclaredPath` is the shared normaliser on BOTH sides of
  // this comparison (here for our declarations, in `registerClaim` for theirs).
  // It trims a trailing ` (new)` annotation, backticks, leading `./` and a
  // trailing slash, which is what makes a planner's `src/foo.ts (new)` match a
  // sibling's registered `src/foo.ts`. Changing it changes the conflict set,
  // so it is deliberately one function and not two that could drift.
  const ourPaths = new Set<string>();
  for (const ws of Object.values(workstreams)) {
    if (!ws.paths) continue;
    for (const p of ws.paths) {
      const normalised = normaliseDeclaredPath(p);
      if (normalised) ourPaths.add(normalised);
    }
  }
  if (ourPaths.size === 0) return [];

  const conflicts: PathClaimEntry[] = [];
  for (const claim of claims) {
    if (claim.issue === ourIssue) continue; // same cycle, not cross-group
    for (const claimedPath of claim.paths) {
      if (ourPaths.has(claimedPath)) {
        if (!conflicts.some((c) => c.issue === claim.issue)) {
          conflicts.push(claim);
        }
      }
    }
  }
  return conflicts;
}

import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { appendEvent } from "./workflow-state.ts";

export async function checkAndRegisterClaims(
  ctx: CycleContext,
  state: WorkState,
  workstreams: Record<string, { paths?: string[]; outOfScope?: string[] }>,
  /** Injectable clock, threaded to `readClaims` so the suite can age a claim without sleeping. */
  now: number = Date.now(),
): Promise<WorkState> {
  const allPaths = Object.values(workstreams).flatMap((ws) => ws.paths ?? []);
  if (allPaths.length === 0) return state; // nothing to claim

  const claims = await readClaims(ctx.repoRoot, now);
  const conflicts = checkCrossGroupClaimsSync(ctx.issue, workstreams, claims);

  if (conflicts.length > 0) {
    const sibling = conflicts[0];
    if (!sibling) return state;
    const overlap = allPaths.map(normaliseDeclaredPath).filter((p) => sibling.paths.includes(p));
    let next = state;
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "cross-group-conflict" as const,
      // `claimant<N>` is the machine-readable carrier humanActionFor and
      // explainCap read — prose is not a stable interface.
      evidence: `claimant${sibling.issue} issue #${sibling.issue} claims: ${sibling.paths.join(", ")}; overlapping: ${overlap.join(", ")}`,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff" as const,
    });
    return {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        status: "handoff",
        currentStep: "plan",
      },
    };
  }
  // No conflicts — register so siblings see our claim.
  await registerClaim(ctx.repoRoot, ctx.issue, allPaths);
  return state;
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

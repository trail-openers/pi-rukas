/**
 * work-driver-path-claims-staleness — when a path claim stops counting, and
 * the shape a claim must have to count at all.
 *
 * Split out of `work-driver-path-claims.ts` for the 500-line gate (AGENTS.md
 * §12). The seam is the one the code already had: the registry module owns the
 * file (read, prune, register, release, the lock), and this one owns the two
 * *predicates* a caller applies to an entry — plus the age bound they share and
 * the entry shape check they both start from.
 *
 * #1454 r2 — there are TWO predicates, not one, because a reader and a writer
 * ask different questions and the safe answer runs opposite ways:
 *
 *   - `claimStaleReason` — "may I park a cycle on this claim?" Answers NO when
 *     the owner cannot be verified. A false "stale" costs one spurious park,
 *     which is the cheap direction, and the whole point of #1454 was that an
 *     unverifiable claimant must stop parking cycles forever.
 *   - `claimDeletionReason` — "may I DELETE this entry from the file?" Needs
 *     positive proof of death, or age past the bound. A false "stale" here
 *     destroys a live sibling's reservation and lets two workstreams edit one
 *     file, which is the failure the registry exists to prevent.
 *
 * They used to be one function, and `registerClaim` used the reader's rule.
 * Eight concurrent claim writers lost seven of their claims to it.
 */

import { NO_ID_FIELD, judgeStateOwner, selfIdentity, validHost } from "./process-liveness.ts";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";
import { isTerminalState, readState } from "./workflow-state.ts";

/** A single path claim entry in the registry. */
export interface PathClaimEntry {
  issue: number;
  pid: number;
  /**
   * #1871 — where the claim was written. OPTIONAL as a GROUP: a claim written
   * before this change carries NONE of them and keeps the last release's
   * pid-only verdict (Decision D3). When present they must be present TOGETHER
   * and each must validate — a record carrying SOME but not all is `foreign`
   * through `judgeStateOwner` and is never routed to the pid probe (D4), which
   * is what stops a half-written identity smuggling a foreign holder into the
   * legacy pid branch.
   */
  host?: string;
  pidns?: string;
  startTime?: string;
  paths: string[];
  startedAt: number;
}

/**
 * #1454 — how long an UNREADABLE-claimant entry may still park a cycle.
 *
 * The bound applies ONLY when the claimant's state file cannot be read (a
 * fresh claim whose branch step has not run, or a state file that is corrupt).
 * A claim whose state file is terminal, or whose owner pid has exited, is
 * stale at any age — no clock involved.
 *
 * Generous on purpose: a single develop dispatch can legitimately run tens of
 * minutes without the claimant's state file being readable by a sibling, and
 * pruning a live claim is exactly the false-positive that lets two cycles edit
 * one file. An earlier revision carried this constant as `_STALE_MS` and read
 * it nowhere — a stale rule that exists on paper is indistinguishable from no
 * rule, which is the bug this file had.
 *
 * FLOORED at 5 minutes. The bound is the only thing standing between a
 * hand-edited `PI_ENSEMBLE_CLAIM_STALE_MS=1` and every claim expiring the
 * instant it is written — two cycles then claim the same file and collide at
 * integration under `git apply`, which is the failure this whole registry
 * exists to prevent. A sub-5-minute bound is never what an operator means, and
 * the cost of ignoring it is a lost claim, so the value is clamped rather than
 * trusted.
 * Override: `PI_ENSEMBLE_CLAIM_STALE_MS`.
 */
export const CLAIM_STALE_MIN_FLOOR_MS = 300_000;

/** Default age bound when nothing is configured. */
const CLAIM_STALE_DEFAULT_MS = 3_600_000;

/**
 * #1454 r2 — the age-bound rule as a pure function of the raw env string, so
 * the suite can pin the behaviour (default, clamp, garbage, unset) by calling
 * it instead of pattern-matching this file's source. A source-text assertion
 * passes when the rule is deleted and the test is renamed.
 */
export function resolveClaimStaleMs(raw: string | undefined): number {
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : CLAIM_STALE_DEFAULT_MS;
  return Math.max(value, CLAIM_STALE_MIN_FLOOR_MS);
}

export const CLAIM_STALE_MS: number = resolveClaimStaleMs(process.env.PI_ENSEMBLE_CLAIM_STALE_MS);

/**
 * How long a claim whose holder belongs to ANOTHER namespace may sit in the
 * file before a writer is allowed to drop it, as a multiple of `CLAIM_STALE_MS`.
 *
 * A foreign claim is never proof of anything: the pid belongs to a namespace
 * this process cannot see into, so neither the probe nor the claimant's state
 * file can disprove the holder. Without a bound the registry only ever grows —
 * every container that dies mid-cycle leaves an immortal row. The reader
 * already ignores a foreign claim past the age bound, so an aged foreign row
 * reserves nothing; deleting it at 24 × the bound makes the file match what
 * the reader already does. Generous on purpose: a container that is merely
 * slow, or briefly unreachable, keeps its reservation for a day.
 */
export const FOREIGN_CLAIM_DELETE_FACTOR = 24;

/**
 * An identity field is a decimal id or the "-" sentinel — never free text.
 *
 * #1871 — the sentinel is a VALID value, not a malformed one: `selfIdentity()`
 * emits `NO_ID_FIELD` for `pidns` and `startTime` on any host with no `/proc`
 * (macOS) or a hidepid procfs, so refusing it here would call every claim from
 * such a host `malformed-entry` and prune it on read. The comparison rule lives
 * in `process-liveness.ts` (`sameIdField`), which treats "-" as "cannot tell
 * two holders apart"; the shape rule here has to accept the same value.
 */
function validIdField(value: unknown): boolean {
  return typeof value === "string" && (value === NO_ID_FIELD || /^\d+$/.test(value));
}

/**
 * #1871 F2 — how far in the future a claim's `startedAt` may sit before the
 * record is a lie rather than a claim. A small allowance is kept because two
 * container clocks on one host are never perfectly synchronised; anything past
 * it means the writer's clock (or an editor) moved the timestamp ahead, and an
 * entry that has not started yet can never satisfy "younger than the bound",
 * so it reserves its paths for as long as the skew is carried.
 */
export const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * The two halves of the identity predicate, shared by `validClaimEntry`.
 * A record carries EITHER all three identity fields OR none of them: a half
 * identity is not a claim (D4) — `judgeStateOwner` would answer `foreign` for
 * it, and reading it as "no identity" instead would hand a foreign holder the
 * pid-only verdict this change removes.
 */
export function identityShapeOk(rec: Record<string, unknown>): boolean {
  if (rec.host !== undefined && (typeof rec.host !== "string" || !validHost(rec.host)))
    return false;
  if (rec.pidns !== undefined && !validIdField(rec.pidns)) return false;
  if (rec.startTime !== undefined && !validIdField(rec.startTime)) return false;
  const present = [rec.host, rec.pidns, rec.startTime].filter((v) => v !== undefined).length;
  return present === 0 || present === 3;
}

/**
 * #1454 r2 — is this a claim we may act on?
 *
 * The registry is operator-editable JSON, and the code downstream of the read
 * assumes `pid` is killable, `startedAt` is comparable, and `paths` is an array
 * it can `.includes()`. An entry failing any of those is not a claim — there is
 * no reservation to honour because there is nothing well-formed to honour — so
 * it is reported stale at the read boundary and pruned by whoever got the read.
 * A half-written entry that survives is a `TypeError` in someone else's plan
 * step.
 *
 * #1871 F2 — `now` is optional because the shape checks are pure and every
 * other caller wants them that way; the two staleness predicates pass it, and
 * with it a `startedAt` in the future (which no clock skew explains) is
 * malformed rather than immortal.
 */
export function validClaimEntry(entry: unknown, now?: number): entry is PathClaimEntry {
  if (entry === null || typeof entry !== "object") return false;
  const rec = entry as Record<string, unknown>;
  if (typeof rec.issue !== "number" || !Number.isInteger(rec.issue)) return false;
  // #1871 — the identity fields are optional as a GROUP, but each one that IS
  // present must have the right shape, and they must all be present together:
  // a record that names a host no identity could belong to, or a pidns that is
  // not a decimal inode, cannot be judged, and silently reading it as "no
  // identity" would hand a foreign holder the pid-only verdict — the exact
  // cross-container reap this change removes.
  if (!identityShapeOk(rec)) return false;
  // pid 0 means "signal my whole process group" and a negative pid means a
  // process GROUP — neither is ever a claim holder, and the pre-#1454 liveness
  // helper read both as proof of life in the wrong direction. The bound is
  // `<= 0`, deliberately NOT `< 2`:
  //
  // The canonical predicate `processAlive` treats EPERM as ALIVE ("the pid
  // exists but belongs to another user"), and pid 1 is exactly that case — so
  // rejecting it here would have the registry call dead an owner the rest of
  // the harness calls alive, which is the two-notions-of-liveness bug #1454
  // exists to remove. `test-work-driver-cross-group-conflicts.ts` §2 pins the
  // two helpers to the SAME verdict for pid 1 and is explicit that pid 1 counts
  // as alive while pid 0 is rejected outright. Non-integers, NaN, zero and
  // negatives all fail here AND in `processAlive`, so no shape is honoured by
  // one and refused by the other.
  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return false;
  if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) return false;
  // #1871 F2 — a future `startedAt` is malformed WHEN the caller supplies the
  // clock. The age rules below all read `now - startedAt`, so an entry stamped
  // ahead of the present reads younger than it is forever: it cannot expire and
  // cannot be deleted, and its paths stay reserved for the whole of the skew.
  if (now !== undefined && rec.startedAt > now + FUTURE_SKEW_MS) return false;
  if (!Array.isArray(rec.paths)) return false;
  return rec.paths.every((p) => typeof p === "string");
}

/**
 * Why a claim is not honoured, or null when it still reserves its paths.
 *
 * `now` and `stateReader` are injectable so the offline suite can pin the age
 * rule and the terminal-status rule without sleeping or writing real state
 * files. Production callers pass neither.
 */
export async function claimStaleReason(
  repoRoot: string,
  entry: PathClaimEntry,
  now: number = Date.now(),
  stateReader: (repoRoot: string, issue: number) => Promise<WorkState | undefined> = readState,
): Promise<string | null> {
  if (!validClaimEntry(entry, now)) return "malformed-entry";
  // #1871 — the READER: only a holder this process can positively call dead
  // stops reserving its paths. `foreign` (other host, other pid namespace) is
  // NOT stale — pruning a live sibling container's reservation is the failure
  // the registry exists to prevent. A foreign entry past the age bound falls
  // through to the age rules below, which is what stops an orphan from parking
  // a cycle forever; the writer deletes it at 24 × the bound.
  const verdict = judgeStateOwner(entry, selfIdentity());
  // #1871 F1 — a holder this process has VERIFIED alive reserves its paths no
  // matter how old the row is. The age bound exists to stop an *unverifiable*
  // claim parking cycles forever; once the identity probe has answered, the
  // clock is judging a holder the probe just proved is running, and the answer
  // the clock would give is wrong. `startTime` is the one field that marks a
  // full identity (a legacy row carries none, and a half one fails
  // `validClaimEntry`), so a pre-#1871 entry keeps today's age rules.
  if (verdict === "alive" && entry.startTime !== undefined) return null;
  if (verdict === "dead") return "owner-exited";
  let claimant: WorkState | undefined;
  let stateUnreadable = false;
  try {
    claimant = await stateReader(repoRoot, entry.issue);
  } catch (err) {
    stateUnreadable = true;
    trace(
      `work-driver-path-claims: claimant #${entry.issue} state is unreadable — the age bound decides: ${(err as Error).message?.slice(0, 200)}`,
    );
    claimant = undefined;
  }
  if (claimant !== undefined && isTerminalState(claimant)) {
    return `claimant-${claimant.pipelineState.status}`;
  }
  const startedAt = entry.startedAt;
  if (!Number.isFinite(startedAt) || now - startedAt > CLAIM_STALE_MS) {
    return stateUnreadable ? "unreadable-state" : "unverifiable-age";
  }
  return null;
}

/**
 * The conservative staleness rule a WRITER applies. Positive proof of death,
 * OR an entry past the age bound; anything short of that is "keep".
 *
 * #1454 r2 — this is the fix for the bug the lock did not cause. `registerClaim`
 * filtered peers through `claimStaleReason`, the READER's rule, and lost seven
 * of eight concurrent claims.
 *
 * The concrete failure: eight `bun` processes raced on the registry. Each had
 * written its claim and exited milliseconds later (a smoke-test child, and in
 * production any cycle between steps). A sibling entering `registerClaim` read
 * that entry, found the pid gone, and deleted it — a claim written a moment ago
 * by a process the reader never saw alive. `owner-exited` is the ONLY reason the
 * reader may answer from a pid probe, and a pid probe says nothing about a
 * process that had not started yet when the probe's subject was created.
 *
 * So the writer prunes on:
 *   - a malformed entry (never a claim at all);
 *   - a state file that reads as a terminal status — positive proof the cycle
 *     finished and simply never released;
 *   - an owner pid that is gone AND an entry older than the age bound, the same
 *     bound the reader applies. Age is what makes a dead-owner delete safe: the
 *     entry has outlived any process that could still be working on it;
 *   - a FOREIGN holder past 24 × the age bound (#1871 D7). A foreign entry
 *     proves nothing either way, so it needs a much longer bound than a corpse
 *     — but it cannot be immortal, or the registry grows without limit with
 *     every container that dies mid-cycle. The reader already ignores it past
 *     the ordinary bound, so the delete costs no reservation.
 *
 * A dead owner YOUNG enough to still be a live claim is kept. That is the
 * asymmetry: keeping it costs nothing (the reader already ignores it, so it
 * parks nobody), deleting it can collide two workstreams.
 */
export async function claimDeletionReason(
  repoRoot: string,
  entry: PathClaimEntry,
  now: number = Date.now(),
  stateReader: (repoRoot: string, issue: number) => Promise<WorkState | undefined> = readState,
): Promise<string | null> {
  if (!validClaimEntry(entry, now)) return "malformed-entry";
  const aged = now - entry.startedAt > CLAIM_STALE_MS;
  const verdict = judgeStateOwner(entry, selfIdentity());
  if (verdict === "foreign") {
    // #1871 D7 — a foreign holder is NOT proof of death, so it is not deleted
    // on the ordinary bound. It is deleted once it has been foreign and silent
    // for 24 × the bound: the reader already ignores it at one bound, so this
    // only reclaims space the file has been carrying for a day.
    return now - entry.startedAt > CLAIM_STALE_MS * FOREIGN_CLAIM_DELETE_FACTOR
      ? "foreign-expired"
      : null;
  }
  if (verdict === "dead") {
    // A corpse is only deletable once it has been a corpse long enough that no
    // plausible owner is still mid-step. Young and unverified is kept.
    return aged ? "owner-exited" : null;
  }
  let claimant: WorkState | undefined;
  try {
    claimant = await stateReader(repoRoot, entry.issue);
  } catch (err) {
    // An unreadable state file is not evidence anyone is dead.
    trace(
      `work-driver-path-claims: claimant #${entry.issue} state is unreadable — the writer keeps the entry: ${(err as Error).message?.slice(0, 200)}`,
    );
    return null;
  }
  if (claimant !== undefined && isTerminalState(claimant)) {
    return `claimant-${claimant.pipelineState.status}`;
  }
  return null;
}

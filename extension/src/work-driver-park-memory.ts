/**
 * work-driver-park-memory — remember a park, and refuse to re-park a third time.
 *
 * `/work N --restart` starts from `initialState`, so nothing remembered that
 * the previous cycle parked this issue. A factory that passes `--restart` on
 * every cycle re-resolved example-owner/orchard#85 and #88 minutes after they parked,
 * reached the same verdict, and posted a second near-identical "Cap hit"
 * comment. The fix added a per-issue record of the reported intent park — but
 * the record only existed when a comment URL came back with it, so the
 * host-channel cycle (`PI_ENSEMBLE_HANDOFF_CHANNEL=host`, where a factory
 * always passes `--restart`) wrote nothing and every headless re-run reported
 * the same park again as if it were the first.
 *
 * Now the record exists whether or not a comment was ever posted, and it
 * covers the other two parks a cycle can reach twice: `intent-park`,
 * `plan-spec-mismatch` and `existing-pr-detected`. One record per (issue, cap)
 * at `.pi/work-state/<N>/park-<cap>.json` holds the reason it fired for, a
 * fingerprint of the issue text it was judged against, how many cycles have
 * parked for exactly that, when the first one did, and the handoff marker the
 * last one published.
 *
 * The headless result carries that repeat count (`handoff.repeat`). Once two
 * cycles haveparked an identical park AND actually reported it, the third is
 * REFUSED before any step is dispatched (`refuseRepeatPark` in
 * work-driver-state-guards.ts) — a third identical report says nothing the
 * second did not.
 *
 * What the guard REFUSES on is deliberately narrower than what it REMEMBERS.
 * Only the two parks whose verdict is deterministic — `intent-park` against an
 * unchanged issue text, and `existing-pr-detected` while that same PR is still
 * open — can be refused. `plan-spec-mismatch` is still counted (so the handoff
 * can say "this is the Nth time the plan gate refused") but never refused: the
 * planner is a model, and re-running it may well succeed. And a park nobody
 * ever saw does not count: `deliveredCount`, not `count`, is what the refusal
 * threshold is compared against, so two cycles whose forge post both failed do
 * not arm a refusal for a park that was never reported.
 *
 * Deliberately NOT remembered: `--restart` still re-resolves (an intent verdict
 * is a model's judgement, not a computation), and a park for a DIFFERENT
 * reason, against an edited issue body, or on a build with the feature off
 * posts and reports exactly as before. An unreadable issue body is never
 * treated as "unchanged" — the guard fails open, the record is left alone.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { ISSUE_BODY_TIMEOUT_MS, fetchIssueBodyViaGh } from "./work-driver-explore.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { handoffMarker } from "./work-driver-handoff-channel.ts";
import {
  COVERED_PARK_CAPS,
  type CoveredParkCap,
  type ParkRecord,
  parkRecordExpired,
  readParkRecord,
  writeParkRecord,
} from "./work-driver-park-record.ts";
import { type ExistingPr, findOpenPrForIssue } from "./work-driver-pr-preflight.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

// The record's SHAPE, PATH and LIFETIME live in `work-driver-park-record.ts` —
// that module is the only code allowed to name, read, write, expire or delete
// `park-<cap>.json`. They are re-exported here so the guard, the handoff, the
// sweep and the tests all reach the park memory through one door.
export {
  type CoveredParkCap,
  COVERED_PARK_CAPS,
  clearParkRecords,
  type ParkRecord,
  parkRecordExpired,
  parkRecordFileName,
  parkRecordPath,
  readParkRecord,
} from "./work-driver-park-record.ts";

/** How many identical parks are tolerated before the next start is refused. */
export const REPEAT_PARK_REFUSAL_COUNT = 2;

/**
 * The parks the guard may REFUSE a start on. `plan-spec-mismatch` is
 * deliberately absent: the plan gate's verdict is a model's judgement, so a
 * re-run can genuinely come back different and the refusal would be the driver
 * claiming a nondeterministic outcome was settled.
 */
export const REFUSABLE_PARK_CAPS: readonly CoveredParkCap[] = [
  "intent-park",
  "existing-pr-detected",
];

/**
 * Is this cap one the guard may refuse on? Takes a plain string because the
 * callers reach it with a value read out of a `cap-hit` event, where the cap is
 * the whole `WorkCap` union, not a covered one.
 */
export function isRefusableParkCap(cap: string | undefined): boolean {
  return cap !== undefined && REFUSABLE_PARK_CAPS.some((refusable) => refusable === cap);
}

/**
 * The reason sentence the pre-loop guard returns for a verdict, without the
 * `repeat-park: ` marker. ONE builder for the guard's reason and for the
 * headless projector's detail text, so the projector never has to read the
 * verdict back out of prose it did not write.
 */
export function repeatParkVerdictReason(verdict: RepeatParkVerdict): string {
  return `#${verdict.issue} ${verdict.cap} (${verdict.reason}) already parked ${verdict.count} times for this issue body`;
}

/** `PI_ENSEMBLE_REPEAT_PARK=0` — the guard stops consulting records; the records themselves stay. */
export function repeatParkEnabled(): boolean {
  return process.env.PI_ENSEMBLE_REPEAT_PARK !== "0";
}

/** The earlier park this cycle's handoff repeats: when it first fired, and its comment. */
export interface RepeatOf {
  at: number;
  /** Absent on a host-channel park, which posts no comment at all. */
  commentUrl?: string;
}

/** What this cycle's park was judged against, and the earlier park it repeats. */
export interface ParkMemory {
  /** Set only for a covered cap whose fingerprint could be read. */
  key?: {
    cap: CoveredParkCap;
    reason: string;
    fingerprint: string;
    marker: string;
    cycleId: number;
  };
  /** The on-disk record that matched this cycle's park, when one existed. */
  prior?: ParkRecord;
  repeatOf?: RepeatOf;
}

/**
 * The one helper both record time and guard time use: the raw issue title +
 * body, hashed. `undefined` when the body cannot be read — half a fingerprint
 * would call an unreadable issue "unchanged", and the guard fails open on that
 * rather than refusing a run it could not judge.
 */
export async function parkFingerprint(
  ctx: DriverContext,
  issue: number,
  /** The cycle's own cached issue body, when it has one (see below). */
  localArtifact?: string,
): Promise<string | undefined> {
  // The local artifact is what THIS cycle fetched (Step 1 writes it verbatim
  // from the same fetch), so hashing it is the same hash for free and is
  // immune to a mid-cycle edit landing between explore and handoff. Absent —
  // or unreadable — the gh fetch is the fallback, never a silent "no record".
  if (localArtifact) {
    const file = path.resolve(ctx.repoRoot, localArtifact);
    try {
      const text = await fs.readFile(file, "utf8");
      if (text.trim()) return createHash("sha256").update(text).digest("hex");
    } catch (err) {
      trace(
        `work-driver: park fingerprint artifact ${file} unreadable, falling back to gh: ${(err as Error).message}`,
      );
    }
  }
  const fetchBody = ctx.issueBodyFetcherFn ?? fetchIssueBodyViaGh;
  try {
    const { stdout } = await fetchBody(issue, ctx.repoRoot);
    if (!stdout.trim()) return undefined;
    return createHash("sha256").update(stdout).digest("hex");
  } catch (err) {
    trace(`work-driver: park fingerprint for #${issue} unreadable: ${(err as Error).message}`);
    return undefined;
  }
}

/** The last cap-hit of the cycle, if any. */
function lastCapHit(state: WorkState): Extract<WorkEvent, { kind: "cap-hit" }> | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "cap-hit") return e;
  }
  return undefined;
}

/**
 * The (cap, reason) pair this cycle parks for, when it parks for one of the
 * covered caps. The reason is what distinguishes two parks of one cap: a
 * different `parkReason`, a different plan verdict, a different open PR.
 */
export function coveredParkOf(
  state: WorkState,
): { cap: CoveredParkCap; reason: string } | undefined {
  const hit = lastCapHit(state);
  if (!hit) return undefined;
  switch (hit.cap) {
    case "intent-park": {
      // A park reason the parser SUBSTITUTED is not a diagnosis. #404: a
      // reason the driver made up is a guess wearing one, and recording it
      // would make every unstated park look identical to every other unstated
      // park — then refuse the third on a comparison the resolver never made.
      // So: no stated reason, nothing recorded (the park is still reported in
      // full). A reason the driver COMPUTED from a real condition
      // (`blank-issue-body`, `unresolved-critical-open-point`) keeps its
      // provenance-marked row and is still recordable.
      const reason = hit.parkReason ?? state.pipelineState.normalisedSpec?.parkReason;
      if (reason === undefined) return undefined;
      if (
        reason === "underspecified" &&
        state.pipelineState.normalisedSpec?.parkReasonSource === "default"
      ) {
        return undefined;
      }
      return { cap: "intent-park", reason };
    }
    case "plan-spec-mismatch":
      return { cap: "plan-spec-mismatch", reason: hit.planVerdict ?? "unspecified" };
    case "existing-pr-detected": {
      // The PR number is the reason: two parks at two different open PRs are
      // two different parks. Without one there is nothing to distinguish them,
      // so no record — the park is reported as it was before #1743.
      const pr = state.pipelineState.existingPr?.number;
      return pr === undefined ? undefined : { cap: "existing-pr-detected", reason: String(pr) };
    }
    default:
      return undefined;
  }
}

/**
 * Called at the start of the handoff step. Never throws: a missing record is
 * the normal case and a malformed one is treated as absent.
 *
 * `repeatOf` is what suppresses a duplicate forge comment, so it is only set
 * when there is something to reuse: a host-channel park posts nothing anyway,
 * and a forge repeat needs the earlier comment's URL. A record with no URL
 * (a host park later re-run on the forge channel) therefore still posts.
 */
export async function readParkMemory(
  ctx: DriverContext,
  state: WorkState,
  host: boolean,
): Promise<ParkMemory> {
  const key = await parkKey(ctx, state);
  if (!key) return {};
  let prior = await readParkRecord(ctx.repoRoot, ctx.issue, key.cap);
  // An expired record is not trusted as a repeat either: it is older than the
  // clock under which the driver deletes it.
  if (prior && parkRecordExpired(prior)) prior = undefined;
  if (!prior || prior.fingerprint !== key.fingerprint || prior.reason !== key.reason) {
    return { key };
  }
  const repeatOf: RepeatOf = { at: prior.firstAt };
  if (prior.commentUrl) repeatOf.commentUrl = prior.commentUrl;
  if (!host && !prior.commentUrl) return { key, prior };
  return { key, prior, repeatOf };
}

/** The key this cycle's park would record, or `undefined` (uncovered cap / unreadable body). */
async function parkKey(ctx: DriverContext, state: WorkState): Promise<ParkMemory["key"]> {
  if (!repeatParkEnabled()) return undefined;
  const covered = coveredParkOf(state);
  if (!covered) return undefined;
  const fingerprint = await parkFingerprint(ctx, ctx.issue, state.pipelineState.issueBodyArtifact);
  if (!fingerprint) return undefined;
  return {
    cap: covered.cap,
    reason: covered.reason,
    fingerprint,
    marker: handoffMarker(ctx.issue, covered.cap),
    cycleId: state.startedAt,
  };
}

/**
 * Called once the handoff has delivered (or declined to deliver), BEFORE the
 * handoff-emitted event is built, so the repeat count the event carries is the
 * count this write produced. Returns the record as stored, or `undefined` when
 * nothing was written. Best-effort: a record problem never costs a handoff.
 *
 * Mutation rules: an exact match on (cap, reason, fingerprint) increments;
 * anything else replaces with count 1; and a write from the SAME cycle changes
 * nothing, so a resumed cycle that re-enters the handoff does not inflate the
 * count.
 */
export async function recordPark(
  ctx: DriverContext,
  memory: ParkMemory,
  commentUrl: string | undefined,
  /** Did this cycle actually REPORT the park? See `ParkRecord.deliveredCount`. */
  delivered: boolean,
): Promise<ParkRecord | undefined> {
  const key = memory.key;
  if (!key) return undefined;
  try {
    // Re-read immediately before writing. Two cycles of the same issue can be
    // in flight (a fan-out, a re-run after a crash); reading `prior` at the
    // handoff's start and writing it back at the end would silently discard a
    // count the sibling wrote in between. `max(...) + 1` is the cheap
    // lost-update guard — not a lock, and it does not need to be one.
    const onDisk = await readParkRecord(ctx.repoRoot, ctx.issue, key.cap);
    const prior = memory.prior;
    if (prior && prior.fingerprint === key.fingerprint && prior.reason === key.reason) {
      // A repeat keeps its own first-report time and its comment; only the
      // counters, the stamp, the marker and the cycle id move — unless this
      // same cycle already wrote it (a resume re-entering the handoff).
      if (prior.lastCycleId === key.cycleId) return prior;
      const count = Math.max(onDisk?.count ?? 0, prior.count) + 1;
      const deliveredCount =
        Math.max(onDisk?.deliveredCount ?? 0, prior.deliveredCount) + (delivered ? 1 : 0);
      const updated: ParkRecord = {
        ...prior,
        count,
        deliveredCount,
        lastAt: Date.now(),
        lastMarker: key.marker,
        lastCycleId: key.cycleId,
        commentUrl: prior.commentUrl ?? commentUrl,
      };
      await writeParkRecord(ctx.repoRoot, ctx.issue, updated);
      return updated;
    }
    const fresh: ParkRecord = {
      cap: key.cap,
      reason: key.reason,
      fingerprint: key.fingerprint,
      count: 1,
      deliveredCount: delivered ? 1 : 0,
      firstAt: Date.now(),
      lastAt: Date.now(),
      lastMarker: key.marker,
      lastCycleId: key.cycleId,
      ...(commentUrl ? { commentUrl } : {}),
    };
    await writeParkRecord(ctx.repoRoot, ctx.issue, fresh);
    return fresh;
  } catch (err) {
    trace(`work-driver: could not update park record: ${(err as Error).message}`);
    return undefined;
  }
}

/** What the pre-loop guard refuses on: which park, for what, and how often. */
export interface RepeatParkVerdict {
  /** The issue in the group whose record armed the refusal. */
  issue: number;
  cap: CoveredParkCap;
  reason: string;
  count: number;
  deliveredCount: number;
  firstAt: number;
}

/**
 * The pre-loop read `refuseRepeatPark` makes: the covered park one of this
 * cycle's issues has already parked — and REPORTED — twice against THIS issue
 * text.
 *
 * PURE: it reads and never writes. A record whose fingerprint no longer matches
 * describes a park of a DIFFERENT issue body, so it simply does not count.
 * Zeroing it here was a write on the read path — an unreadable body could
 * leave a half-reset record, and a start that is about to be refused should not
 * mutate the thing it is judging. The reset happens where it belongs: in
 * `recordPark`, which replaces the record with a count of 1 the next time this
 * issue actually parks.
 *
 * Fails open in every direction: an unreadable issue body, an expired record,
 * a cap whose verdict is a model's judgement (see REFUSABLE_PARK_CAPS), or an
 * `existing-pr-detected` whose PR the forge no longer shows as open — each
 * returns `undefined` with a trace and the run proceeds.
 */
export async function repeatParkVerdict(
  ctx: DriverContext,
  /** Every issue in the group, like the attention gate. Defaults to the primary. */
  issues: number[] = [ctx.issue],
): Promise<RepeatParkVerdict | undefined> {
  if (!repeatParkEnabled()) return undefined;
  const now = Date.now();
  for (const issue of [...new Set([ctx.issue, ...issues])]) {
    // Cheap path first: with nothing recorded there is nothing to refuse, and a
    // start on a fresh issue costs no `gh` call. Only a present record earns a
    // fetch — the guard must not become a second issue-body fetch per cycle.
    const recorded: ParkRecord[] = [];
    for (const cap of COVERED_PARK_CAPS) {
      const rec = await readParkRecord(ctx.repoRoot, issue, cap);
      if (rec && !parkRecordExpired(rec, now)) recorded.push(rec);
    }
    if (recorded.length === 0) continue;
    const fingerprint = await parkFingerprint(ctx, issue);
    if (!fingerprint) {
      trace(`work-driver: repeat-park guard did not run for #${issue} — issue body unreadable`);
      continue;
    }
    for (const rec of recorded) {
      if (rec.fingerprint !== fingerprint) continue;
      if (!isRefusableParkCap(rec.cap)) continue;
      if (rec.deliveredCount < REPEAT_PARK_REFUSAL_COUNT) continue;
      if (rec.cap === "existing-pr-detected") {
        // The reason IS the PR number. A record whose reason is not one (a
        // hand-edited file, an older writer) cannot be re-checked against the
        // forge, and refusing on a GitHub state the driver could not confirm is
        // exactly what the re-check exists to prevent — so it fails open.
        // `^[1-9]\d*$` rather than `Number()`: the coercion accepts `" 77 "`,
        // `"0x11"` (17) and `"1e2"` (100), each of which would have the guard
        // re-check — and refuse on — a PR number nobody recorded.
        if (!/^[1-9]\d*$/.test(rec.reason)) {
          trace(
            `work-driver: repeat-park guard could not read a PR number from the #${issue} existing-pr-detected record (reason ${JSON.stringify(rec.reason)}) — not refusing`,
          );
          continue;
        }
        if (!(await prStillOpen(ctx, issue, Number(rec.reason)))) continue;
      }
      return {
        issue,
        cap: rec.cap,
        reason: rec.reason,
        count: rec.count,
        deliveredCount: rec.deliveredCount,
        firstAt: rec.firstAt,
      };
    }
  }
  return undefined;
}

/**
 * The forge re-check an `existing-pr-detected` refusal has to pass. The record
 * remembers a PR that was open when the branch step looked; a person may have
 * closed it, merged it, or retargeted it since — and refusing on that would be
 * the driver enforcing a GitHub state it has not read.
 *
 * Fails OPEN: any lookup failure returns false (run the cycle) with a trace.
 * The whole point of the re-check is that the driver does not get to refuse on
 * a state it could not confirm. A timeout and an abort are failures too, so
 * they take the same path — and the cycle being interrupted is never a reason
 * to refuse a start, since nothing is about to run either way.
 *
 * The lookup catches its own exec and parse failures, but it is not the whole
 * call: `matchPrForIssue` walks rows the forge emitted and a malformed row is
 * reachable. Nothing in a pre-flight gate may throw, so the call itself is
 * guarded too — an exception here is just another state the driver could not
 * read.
 */
async function prStillOpen(ctx: DriverContext, issue: number, prNumber: number): Promise<boolean> {
  if (ctx.signal?.aborted) {
    trace(
      `work-driver: repeat-park guard did not confirm PR #${prNumber} for #${issue} — the cycle is being interrupted — not refusing`,
    );
    return false;
  }
  let existing: ExistingPr | undefined;
  try {
    existing = await findOpenPrForIssue(
      boundedForgeExec(ctx.verifyExecFn ?? execp),
      ctx.repoRoot,
      issue,
    );
  } catch (err) {
    trace(
      `work-driver: repeat-park guard could not ask the forge about PR #${prNumber} for #${issue}: ${(err as Error)?.message?.slice(0, 200) ?? "unknown error"} — not refusing`,
    );
    return false;
  }
  if (existing === undefined) {
    trace(
      `work-driver: repeat-park guard did not confirm PR #${prNumber} for #${issue} (closed, or the lookup said nothing) — not refusing`,
    );
    return false;
  }
  if (existing.number !== prNumber) {
    trace(
      `work-driver: repeat-park guard found PR #${existing.number} open for #${issue}, not #${prNumber} — not refusing`,
    );
    return false;
  }
  return true;
}

/**
 * The guard's executor: the shared seam plus the deadline it must not exceed.
 *
 * The re-check runs BEFORE any step is dispatched, so an unbounded `gh pr list`
 * here holds up a start for as long as the network hangs — while nothing is
 * recorded the whole guard costs a fraction of a second. The deadline is the
 * issue-body fetch's own per-attempt bound (`ISSUE_BODY_TIMEOUT_MS`), carried in
 * the options so `execp` enforces it by killing the child, as every other timed
 * seam in the driver does. The rejection is what `findOpenPrForIssue` already
 * catches, so a timeout fails open on the traces above rather than a new one.
 */
function boundedForgeExec(execFn: VerifyExecFn): VerifyExecFn {
  return (cmd, opts) => execFn(cmd, { ...opts, timeout: ISSUE_BODY_TIMEOUT_MS });
}

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
 * cycles have parked an identical park, the third is REFUSED before any step
 * is dispatched (`refuseRepeatPark` in work-driver-state-guards.ts) — a third
 * identical report says nothing the second did not.
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
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchIssueBodyViaGh } from "./work-driver-explore.ts";
import { handoffMarker } from "./work-driver-handoff-channel.ts";
import { type WorkEvent, type WorkState, workStateDir } from "./workflow-state.ts";

/** The parks this module remembers. Every other cap leaves records untouched. */
export const COVERED_PARK_CAPS = [
  "intent-park",
  "plan-spec-mismatch",
  "existing-pr-detected",
] as const;
export type CoveredParkCap = (typeof COVERED_PARK_CAPS)[number];

/** How many identical parks are tolerated before the next start is refused. */
export const REPEAT_PARK_REFUSAL_COUNT = 2;

/** `PI_ENSEMBLE_REPEAT_PARK=0` — the guard stops consulting records; the records themselves stay. */
export function repeatParkEnabled(): boolean {
  return process.env.PI_ENSEMBLE_REPEAT_PARK !== "0";
}

/**
 * One (issue, cap) park record. `reason` is what the park fired for — the
 * intent park's `parkReason`, the plan verdict, or the PR number — so a park
 * for a different cause is a NEW record rather than an increment.
 */
export interface ParkRecord {
  cap: CoveredParkCap;
  reason: string;
  /** sha256 of the raw issue title + body this park was judged against. */
  fingerprint: string;
  /** Cycles that have parked this (issue, cap, reason, fingerprint). */
  count: number;
  firstAt: number;
  lastAt: number;
  /** The handoff marker the last park published, republished verbatim. */
  lastMarker: string;
  /** The cycle that wrote this record (`state.startedAt`) — the idempotency key. */
  lastCycleId: number;
  /** The forge comment URL, when one was ever posted for this park. */
  commentUrl?: string;
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

/** The record's path. Shared with the guard and the tests. */
export function parkRecordPath(repoRoot: string, issue: number, cap: CoveredParkCap): string {
  return path.join(workStateDir(repoRoot), String(issue), `park-${cap}.json`);
}

/** The legacy record name (`<N>/intent-park.txt`), unlinked on the next covered write. */
function legacyParkPath(repoRoot: string, issue: number): string {
  return path.join(workStateDir(repoRoot), String(issue), "intent-park.txt");
}

/** Read one record. A missing or malformed record is `undefined`, never a throw. */
export async function readParkRecord(
  repoRoot: string,
  issue: number,
  cap: CoveredParkCap,
): Promise<ParkRecord | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(parkRecordPath(repoRoot, issue, cap), "utf8"),
    );
    if (raw === null || typeof raw !== "object") return undefined;
    const rec = raw as Record<string, unknown>;
    if (
      rec.cap === cap &&
      typeof rec.reason === "string" &&
      typeof rec.fingerprint === "string" &&
      typeof rec.count === "number" &&
      typeof rec.firstAt === "number" &&
      typeof rec.lastAt === "number" &&
      typeof rec.lastMarker === "string" &&
      typeof rec.lastCycleId === "number"
    ) {
      return {
        cap,
        reason: rec.reason,
        fingerprint: rec.fingerprint,
        count: rec.count,
        firstAt: rec.firstAt,
        lastAt: rec.lastAt,
        lastMarker: rec.lastMarker,
        lastCycleId: rec.lastCycleId,
        commentUrl:
          typeof rec.commentUrl === "string" && rec.commentUrl ? rec.commentUrl : undefined,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeParkRecord(repoRoot: string, issue: number, rec: ParkRecord): Promise<void> {
  const file = parkRecordPath(repoRoot, issue, rec.cap);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(rec, null, 2), "utf8");
  // The `.txt` record this module wrote before #1743. Nothing reads it now;
  // it is removed the first time the covered-cap write runs, not on sight.
  await fs.rm(legacyParkPath(repoRoot, issue), { force: true });
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
): Promise<string | undefined> {
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
    case "intent-park":
      return {
        cap: "intent-park",
        reason:
          hit.parkReason ?? state.pipelineState.normalisedSpec?.parkReason ?? "underspecified",
      };
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
  const prior = await readParkRecord(ctx.repoRoot, ctx.issue, key.cap);
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
  const fingerprint = await parkFingerprint(ctx, ctx.issue);
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
): Promise<ParkRecord | undefined> {
  const key = memory.key;
  if (!key) return undefined;
  try {
    const prior = memory.prior;
    if (prior && prior.fingerprint === key.fingerprint && prior.reason === key.reason) {
      // A repeat keeps its own first-report time and its comment; only the
      // counter, the stamp, the marker and the cycle id move — unless this
      // same cycle already wrote it (a resume re-entering the handoff).
      if (prior.lastCycleId === key.cycleId) return prior;
      const updated: ParkRecord = {
        ...prior,
        count: prior.count + 1,
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
  cap: CoveredParkCap;
  reason: string;
  count: number;
  firstAt: number;
}

/**
 * The pre-loop read `refuseRepeatPark` makes: the covered park this issue has
 * already parked twice against THIS issue text.
 *
 * Side effect, deliberately here rather than at record time: a record whose
 * fingerprint no longer matches describes a park of a DIFFERENT issue body, so
 * its count is zeroed (the reason is kept, it may still be the live one). A
 * park of the current body then starts its count again at 1.
 *
 * Fails open: an unreadable issue body returns `undefined` with a trace — the
 * run proceeds, and no count is zeroed on a comparison that never happened.
 */
export async function repeatParkVerdict(
  ctx: DriverContext,
): Promise<RepeatParkVerdict | undefined> {
  if (!repeatParkEnabled()) return undefined;
  // Cheap path first: with nothing recorded there is nothing to refuse, and a
  // start on a fresh issue costs no `gh` call. Only a present record earns a
  // fetch — the guard must not become a second issue-body fetch per cycle.
  const recorded: ParkRecord[] = [];
  for (const cap of COVERED_PARK_CAPS) {
    const rec = await readParkRecord(ctx.repoRoot, ctx.issue, cap);
    if (rec) recorded.push(rec);
  }
  if (recorded.length === 0) return undefined;
  const fingerprint = await parkFingerprint(ctx, ctx.issue);
  if (!fingerprint) {
    trace(`work-driver: repeat-park guard did not run for #${ctx.issue} — issue body unreadable`);
    return undefined;
  }
  let refusal: RepeatParkVerdict | undefined;
  for (const rec of recorded) {
    if (rec.fingerprint !== fingerprint) {
      if (rec.count !== 0) await zeroParkCount(ctx.repoRoot, ctx.issue, rec);
      continue;
    }
    if (rec.count >= REPEAT_PARK_REFUSAL_COUNT && !refusal) {
      refusal = { cap: rec.cap, reason: rec.reason, count: rec.count, firstAt: rec.firstAt };
    }
  }
  return refusal;
}

/** Zero a stale record's count, keeping its reason. Best-effort. */
async function zeroParkCount(repoRoot: string, issue: number, rec: ParkRecord): Promise<void> {
  try {
    await writeParkRecord(repoRoot, issue, { ...rec, count: 0 });
    trace(`work-driver: park record #${issue} ${rec.cap} count reset — the issue text changed`);
  } catch (err) {
    trace(
      `work-driver: could not reset park record #${issue} ${rec.cap}: ${(err as Error).message}`,
    );
  }
}

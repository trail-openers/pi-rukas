/**
 * work-driver-park-record — the on-disk half of #1743's park memory.
 *
 * One JSON file per (issue, cap) at `.pi/work-state/<N>/park-<cap>.json`, and
 * the only code allowed to name, read, write, expire or delete it. The
 * judgement half (`work-driver-park-memory.ts`) decides *whether* a park is a
 * repeat; this module decides only what a record IS and how it survives a
 * crash, a hand edit, or a `cat > file` from a terminal.
 *
 * Three rules the readers here are the only place they exist:
 *
 *  - **A record nobody can believe is ABSENT, not trusted.** The refusal it
 *    feeds is a hard stop, so a `count` that is not a non-negative integer or
 *    a `firstAt` from 1970 yields `undefined` rather than a verdict — with a
 *    trace, so "nothing recorded" and "could not read it" stay distinguishable.
 *  - **Writes are atomic** (tmp file in the same directory, then rename). A
 *    crash between the two leaves the PREVIOUS record intact instead of a
 *    half-written file the reader would reject — which would silently forget a
 *    park the operator had already been told about.
 *  - **Expiry is the sweep's clock.** `PARK_RECORD_MAX_AGE_MS` (declared here,
 *    not imported) is the age at which the record stops being believed AND the
 *    age at which the artifact sweep deletes the directory holding it. The
 *    guard must not refuse on an older record and the sweep must not keep a
 *    directory alive for one, so both sides ask THIS module — the dependency
 *    runs record → nothing, never record → sweep → record.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { workStateDir } from "./workflow-state.ts";

/**
 * How long a park record is believed, and the age at which the artifact sweep
 * deletes the directory holding it. ONE number for both clocks on purpose: a
 * record the guard would still refuse on must never be deleted from under it,
 * and a record past this age must never arm a refusal. Owned here (the leaf of
 * this pair) so `work-driver-artifact-sweep.ts` imports it rather than the
 * other way round — a cycle between the judge and the thing it judges.
 */
export const PARK_RECORD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The parks the driver remembers. Every other cap leaves records untouched. */
export const COVERED_PARK_CAPS = [
  "intent-park",
  "plan-spec-mismatch",
  "existing-pr-detected",
] as const;
export type CoveredParkCap = (typeof COVERED_PARK_CAPS)[number];

/**
 * How many identical parks (or, on the host channel, identical published
 * handoffs) are tolerated before the next start is refused. ONE number for
 * both memories: the covered guard in `work-driver-park-memory.ts` and the
 * host signal in `work-driver-park-memory-host.ts` refuse on the same bar, and
 * two constants with the same job is two chances for one guard to move alone.
 */
export const REPEAT_PARK_REFUSAL_COUNT = 2;

/**
 * Does this build consult either park memory? `PI_ENSEMBLE_REPEAT_PARK=0`
 * turns the whole repeat guard off, records and the host signal included.
 * Declared here — the leaf BOTH memories import — so the switch cannot be set
 * in one and missed in the other. Read from the environment at call time, not
 * captured at module load, so a test that flips it mid-run still works.
 */
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
  /**
   * Of those, how many actually REPORTED the park — a forge comment posted or
   * the label applied, or (host channel) the handoff body handed to the host.
   * The refusal threshold compares against THIS, not `count`: two cycles whose
   * posts both failed must not arm a refusal for a park nobody ever read.
   */
  deliveredCount: number;
  firstAt: number;
  lastAt: number;
  /** The handoff marker the last park published, republished verbatim. */
  lastMarker: string;
  /** The cycle that wrote this record (`state.startedAt`) — the idempotency key. */
  lastCycleId: number;
  /** The forge comment URL, when one was ever posted for this park. */
  commentUrl?: string;
}

/** The record's file NAME. The one owner of `park-<cap>.json` — the sweep imports it. */
export function parkRecordFileName(cap: CoveredParkCap): string {
  return `park-${cap}.json`;
}

/** The record's path. Shared with the guard, the sweep and the tests. */
export function parkRecordPath(repoRoot: string, issue: number, cap: CoveredParkCap): string {
  return path.join(workStateDir(repoRoot), String(issue), parkRecordFileName(cap));
}

/**
 * True when a record describes a park so old it should no longer be believed.
 * Shares the sweep's age floor on purpose: the directory holding it is swept on
 * exactly this clock, so the guard must not refuse on a record the sweep is
 * about to delete, and the sweep must not keep a directory alive for a record
 * the guard already ignores.
 */
export function parkRecordExpired(rec: ParkRecord, now = Date.now()): boolean {
  return now - rec.lastAt > PARK_RECORD_MAX_AGE_MS;
}

/** The legacy record name (`<N>/intent-park.txt`), unlinked on the next covered write. */
function legacyParkPath(repoRoot: string, issue: number): string {
  return path.join(workStateDir(repoRoot), String(issue), "intent-park.txt");
}

/**
 * A timestamp the driver could plausibly have written: finite, after 2020, not
 * in the future. `Number.isFinite` is the load-bearing clause — `JSON.parse`
 * turns `1e999` into `Infinity`, and `new Date(Infinity).toISOString()` in the
 * refusal sentence THROWS, which would take the guard down mid-start. A record
 * that cannot produce a date is absent, not trusted.
 */
function plausibleTimestamp(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= Date.UTC(2020, 0, 1) &&
    v <= Date.now() + 60_000
  );
}

/** A counter the driver could have written: a non-negative safe integer. */
function plausibleCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** The cycle id (`state.startedAt`, a ms epoch): a plausible finite number. */
function plausibleCycleId(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Read one record. A missing or malformed record is `undefined`, never a throw.
 *
 * A missing file is silent (it is the normal case); any other read error is
 * traced, so a permissions problem does not look like "nothing recorded".
 */
export async function readParkRecord(
  repoRoot: string,
  issue: number,
  cap: CoveredParkCap,
): Promise<ParkRecord | undefined> {
  const file = parkRecordPath(repoRoot, issue, cap);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      trace(
        `work-driver: park record ${file} unreadable (${code ?? "error"}): ${(err as Error).message}`,
      );
    }
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    trace(`work-driver: park record ${file} is not JSON: ${(err as Error).message}`);
    return undefined;
  }
  if (raw === null || typeof raw !== "object") {
    trace(`work-driver: park record ${file} is not an object — treated as absent`);
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  if (
    rec.cap === cap &&
    typeof rec.reason === "string" &&
    typeof rec.fingerprint === "string" &&
    plausibleCount(rec.count) &&
    // Absent on a record written before #1743's delivery tracking: never
    // delivered, which is the honest reading and can never arm a refusal.
    (rec.deliveredCount === undefined || plausibleCount(rec.deliveredCount)) &&
    plausibleTimestamp(rec.firstAt) &&
    plausibleTimestamp(rec.lastAt) &&
    typeof rec.lastMarker === "string" &&
    plausibleCycleId(rec.lastCycleId) &&
    // Delivered is a subset of attempted: `3 parks, 5 reported` is not a state
    // the writer can produce, so a record claiming it was edited or corrupted.
    (rec.deliveredCount === undefined || rec.deliveredCount <= rec.count)
  ) {
    return {
      cap,
      reason: rec.reason,
      fingerprint: rec.fingerprint,
      count: rec.count,
      deliveredCount: rec.deliveredCount === undefined ? 0 : rec.deliveredCount,
      firstAt: rec.firstAt,
      lastAt: rec.lastAt,
      lastMarker: rec.lastMarker,
      lastCycleId: rec.lastCycleId,
      commentUrl: typeof rec.commentUrl === "string" && rec.commentUrl ? rec.commentUrl : undefined,
    };
  }
  trace(`work-driver: park record ${file} carries an implausible field — treated as absent`);
  return undefined;
}

/**
 * Write one record ATOMICALLY: a tmp file in the same directory, then a rename.
 * A crash between the two leaves the PREVIOUS record intact rather than a
 * half-written JSON file the reader would (correctly) treat as absent.
 */
export async function writeParkRecord(
  repoRoot: string,
  issue: number,
  rec: ParkRecord,
): Promise<void> {
  const file = parkRecordPath(repoRoot, issue, rec.cap);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  // The pid alone collides when two writers in one process race (and leaves a
  // sibling's tmp file for a later rename to adopt), so the name is unique.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), "utf8");
  await fs.rename(tmp, file);
  // The `.txt` record this module wrote before #1743. Nothing reads it now;
  // it is removed the first time the covered-cap write runs, not on sight.
  await fs.rm(legacyParkPath(repoRoot, issue), { force: true });
}

/**
 * Forget this issue's park records. Called when a cycle for the issue MERGED:
 * the work landed, so a park recorded against the issue before it was done
 * describes a state of the world that no longer exists, and refusing a later
 * start on it would be the guard holding up work the operator can see is fine.
 * Best-effort — a failure is traced and never costs the merge.
 */
export async function clearParkRecords(repoRoot: string, issues: number[]): Promise<void> {
  for (const issue of issues) {
    for (const cap of COVERED_PARK_CAPS) {
      try {
        await fs.rm(parkRecordPath(repoRoot, issue, cap), { force: true });
      } catch (err) {
        trace(
          `work-driver: could not clear the park record for #${issue} ${cap}: ${(err as Error).message}`,
        );
      }
    }
  }
}

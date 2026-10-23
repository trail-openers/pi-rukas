/**
 * work-driver-park-memory-host — the HOST channel's memory of a park the
 * covered records do not cover (#1696).
 *
 * `work-driver-park-record.ts` remembers a park for three caps only
 * (`COVERED_PARK_CAPS`). Every other park — a lens round cap, a
 * `verify-failed:develop`, a `step-failed:explore` — leaves nothing on disk,
 * and on the `host` channel it leaves nothing ANYWHERE: pi-rukas posts no
 * comment and applies no `needs-human-attention` label there, by contract
 * (docs/headless.md, `test-headless-handoff-channel.ts`), and a factory such
 * as orchard passes `--restart` on every cycle, which wipes the state file. So
 * the same park was re-run and re-reported three to nine times on an unchanged
 * issue with no signal that anyone had ever been told about it.
 *
 * One signal file per issue at `.pi/work-state/<N>/host-parks.json` — the
 * directory the covered records already live in, which is what survives a
 * `--restart` (only `<N>.json` is wiped) and what the artifact sweep already
 * keeps alive while a park is still believed. It holds one row per
 * (cap, reason, issue-text fingerprint) a host handoff actually PUBLISHED, and
 * how many times. "Published" is the handoff step's own rule: a non-empty body
 * reached the host in the result. An empty body counted nothing, because nobody
 * received anything.
 *
 * What it does NOT do: it is not a label (the host owns that channel and this
 * module never touches a forge), it does not replace the covered records (the
 * covered caps keep theirs, with their delivery counting and their forge
 * re-checks), and it never refines a verdict. The refusal it feeds is written
 * by `refuseRepeatPark` in `work-driver-state-guards.ts` in the same shape as
 * the #1743 one: cap `repeat-park`, no step dispatched, no state file written.
 *
 * Fails open in every direction the guard cannot honestly judge — an unreadable
 * issue body, an unreadable or malformed file, an expired row — because a start
 * the signal wrongly refuses is a start nothing can get back.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { handoffChannel } from "./work-driver-handoff-channel.ts";
import {
  REPEAT_PARK_REFUSAL_COUNT,
  type RepeatParkVerdict,
  parkFingerprint,
  repeatParkEnabled,
} from "./work-driver-park-memory.ts";
import {
  COVERED_PARK_CAPS,
  PARK_RECORD_MAX_AGE_MS,
  parkRecordExpired,
  readParkRecord,
} from "./work-driver-park-record.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

/** The signal file's NAME — the one place that spells it. */
export const HOST_PARK_SIGNAL_FILE = "host-parks.json";

/** How many published parks of one identical shape arm the next refusal. */
export const HOST_PARK_REFUSAL_COUNT = REPEAT_PARK_REFUSAL_COUNT;

/** The signal's path — the sweep's exemption and the tests both ask for it. */
export function hostParkSignalPath(repoRoot: string, issue: number): string {
  return path.join(workStateDir(repoRoot), String(issue), HOST_PARK_SIGNAL_FILE);
}

/** One published park: what fired, why, against which issue text, how often. */
export interface HostParkRow {
  cap: string;
  reason: string;
  /** sha256 of the raw issue title + body this park was published against. */
  fingerprint: string;
  /** Host handoffs that PUBLISHED this (cap, reason, fingerprint). */
  deliveredCount: number;
  firstAt: number;
  lastAt: number;
  /** The cycle that last wrote it (`state.startedAt`) — the idempotency key. */
  lastCycleId: number;
}

/** A counter the writer could have produced: a non-negative safe integer. */
function plausibleCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** A timestamp the writer could have produced: finite, after 2020, not ahead of us. */
function plausibleTimestamp(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= Date.UTC(2020, 0, 1) &&
    v <= Date.now() + 60_000
  );
}

/** A cycle id (`state.startedAt`): a finite non-negative number. */
function plausibleCycleId(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Read the signal rows. A missing file is silent and empty (the normal case);
 * anything else a reader could not believe is EMPTY, never trusted, with a
 * trace — the refusal this feeds is a hard stop, so a `deliveredCount` that is
 * not a plausible integer or a `lastAt` from 1970 must not arm it.
 */
export async function readHostParkSignals(
  repoRoot: string,
  issue: number,
  /** The host that asked, so an empty result says WHO found nothing. */
  reader = "guard",
): Promise<HostParkRow[]> {
  const file = hostParkSignalPath(repoRoot, issue);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      trace(
        `work-driver: host park signal ${file} unreadable by the ${reader} (${code ?? "error"}): ${(err as Error).message}`,
      );
    }
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    trace(
      `work-driver: host park signal ${file} read by the ${reader} is not JSON: ${(err as Error).message}`,
    );
    return [];
  }
  if (!Array.isArray(raw)) {
    trace(
      `work-driver: host park signal ${file} read by the ${reader} is not an array — treated as absent`,
    );
    return [];
  }
  const now = Date.now();
  const rows: HostParkRow[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    if (
      r !== null &&
      typeof r === "object" &&
      typeof r.cap === "string" &&
      r.cap &&
      typeof r.reason === "string" &&
      typeof r.fingerprint === "string" &&
      plausibleCount(r.deliveredCount) &&
      plausibleTimestamp(r.firstAt) &&
      plausibleTimestamp(r.lastAt) &&
      plausibleCycleId(r.lastCycleId) &&
      // One clock with the covered record: past the age the sweep deletes its
      // directory under, a row arms nothing.
      now - r.lastAt <= PARK_RECORD_MAX_AGE_MS
    ) {
      rows.push({
        cap: r.cap,
        reason: r.reason,
        fingerprint: r.fingerprint,
        deliveredCount: r.deliveredCount,
        firstAt: r.firstAt,
        lastAt: r.lastAt,
        lastCycleId: r.lastCycleId,
      });
    } else {
      trace(
        `work-driver: host park signal ${file} read by the ${reader} carries an implausible row — dropped`,
      );
    }
  }
  return rows;
}

/**
 * The (cap, reason) this cycle publishes, when no covered record covers it.
 * `undefined` for a covered cap — that park has its own record, with delivery
 * counting and the forge re-checks, and two memories of one park is two chances
 * to disagree about it.
 *
 * The reason is what distinguishes two parks of one cap. It is only ever a
 * cause somebody STATED (`parkReason`, the plan gate's verdict) or the cap's
 * own evidence; a park reason the parser SUBSTITUTED is never guessed at
 * (#404's rule) and a cap that names no cause gets one row, which is still the
 * truth: this same cap fired again against this same issue text.
 */
export function hostParkOf(state: WorkState): { cap: string; reason: string } | undefined {
  const hit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  if (!hit || hit.kind !== "cap-hit") return undefined;
  if ((COVERED_PARK_CAPS as readonly string[]).includes(hit.cap)) return undefined;
  return {
    cap: hit.cap,
    reason: hit.parkReason ?? hit.planVerdict ?? hit.evidence ?? "",
  };
}

/**
 * Record that a HOST handoff published this cycle's park. Called from the
 * handoff step, which owns the one rule that matters: a park is published when
 * a non-empty body was rendered for the host. `published` is that rule's answer
 * passed IN rather than re-derived here — the handoff already computed it for
 * the covered record's delivery count, and a second reading of "was it
 * delivered" is how one of them goes stale.
 *
 * Covers every cap outside `COVERED_PARK_CAPS`, so a park the covered records
 * never saw is counted once too. Best-effort: never throws, and no record
 * problem costs a handoff.
 */
export async function recordHostPark(
  ctx: DriverContext,
  state: WorkState,
  published: boolean,
): Promise<void> {
  if (!published || !repeatParkEnabled()) return;
  // A host channel that posts nothing is the only one that needs this memory.
  if (handoffChannel() !== "host") return;
  const park = hostParkOf(state);
  if (!park) return;
  try {
    const fingerprint = await parkFingerprint(
      ctx,
      ctx.issue,
      state.pipelineState.issueBodyArtifact,
    );
    if (!fingerprint) return; // An unreadable body is not a park we can identify.
    const rows = await readHostParkSignals(ctx.repoRoot, ctx.issue, "handoff");
    const at = Date.now();
    const prior = rows.find(
      (r) => r.cap === park.cap && r.reason === park.reason && r.fingerprint === fingerprint,
    );
    // A resumed cycle re-entering its own handoff already counted; the number
    // the guard refuses on must not move on a re-entry.
    if (prior?.lastCycleId === state.startedAt) return;
    const next = prior
      ? rows.map((r) =>
          r === prior
            ? {
                ...r,
                deliveredCount: r.deliveredCount + 1,
                lastAt: at,
                lastCycleId: state.startedAt,
              }
            : r,
        )
      : [
          ...rows,
          {
            cap: park.cap,
            reason: park.reason,
            fingerprint,
            deliveredCount: 1,
            firstAt: at,
            lastAt: at,
            lastCycleId: state.startedAt,
          },
        ];
    const file = hostParkSignalPath(ctx.repoRoot, ctx.issue);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic, like the covered record: a crash leaves the PREVIOUS rows intact
    // rather than a half-written file the reader (correctly) reads as empty.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    trace(`work-driver: could not update the host park signal: ${(err as Error).message}`);
  }
}

/**
 * Does this issue's artifact directory carry anything a reader would still act
 * on? The artifact sweep's question, answered through THIS module so the sweep
 * never has to learn the host signal's name the way it learns the record's from
 * `work-driver-park-record.ts`. An unreadable signal counts as holding one: the
 * sweep keeps on doubt, since a stale row costs a few bytes where deleting a
 * live one costs a wrong refusal.
 *
 * It also re-checks the covered record rather than trusting the sweep's own
 * reading alone: both memories live in the same directory, and a sweep that
 * deletes either one while its guard still refuses on it destroys the evidence
 * the refusal quotes.
 */
export async function holdsLiveHostParkSignal(
  repoRoot: string,
  issue: number,
  now = Date.now(),
): Promise<boolean> {
  const file = hostParkSignalPath(repoRoot, issue);
  const rows = await readHostParkSignals(repoRoot, issue, "sweep");
  if (rows.some((r) => now - r.lastAt <= PARK_RECORD_MAX_AGE_MS)) return true;
  try {
    // The file exists but nothing in it could be believed (a `count` that is
    // not an integer, a `firstAt` from 1970). Keep the directory: the sweep's
    // own age rule decides when it goes, and a half-read row is not proof of an
    // empty one.
    return (await fs.readFile(file, "utf8")).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Forget this issue's host park signals, AND the covered park records beside
 * them, in one call: a cycle that clears one memory and leaves the other would
 * have the surviving guard refuse a later start over work the operator can see
 * has landed. The two live in the same directory and expire on one clock, so
 * they are forgotten together, with the same best-effort discipline as the
 * claim release beside them — a failure is traced and never costs a merge.
 */
export async function clearHostParkSignals(repoRoot: string, issues: number[]): Promise<void> {
  for (const issue of [...new Set(issues)]) {
    try {
      await fs.rm(path.dirname(hostParkSignalPath(repoRoot, issue)), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      trace(
        `work-driver: could not clear the park memory for #${issue}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Record that a HOST handoff published this cycle's park.
 * park — this cap, this reason, against this exact issue text — twice?
 *
 * PURE: it reads and never writes. Fails open the way `repeatParkVerdict` does:
 * `PI_ENSEMBLE_REPEAT_PARK=0` short-circuits, the forge channel has nothing to
 * be refused for (there a comment and a label carry the report), an unreadable
 * body or signal cannot support a refusal, and a covered cap is left to
 * `repeatParkVerdict`, which counts deliveries rather than publishes.
 * `--restart` bypasses nothing — a factory that restarts every cycle is the
 * shape this was built for.
 */
export async function hostParkVerdict(
  ctx: DriverContext,
  issues: number[] = [ctx.issue],
): Promise<RepeatParkVerdict | undefined> {
  if (!repeatParkEnabled() || handoffChannel() !== "host") return undefined;
  const now = Date.now();
  for (const issue of [...new Set([ctx.issue, ...issues])]) {
    const rows = await readHostParkSignals(ctx.repoRoot, issue);
    const armed = rows.filter(
      (r) =>
        r.deliveredCount >= HOST_PARK_REFUSAL_COUNT && now - r.lastAt <= PARK_RECORD_MAX_AGE_MS,
    );
    // Cheap path first: nothing earned a refusal, so no `gh` call is paid for.
    if (armed.length === 0) continue;
    const fingerprint = await parkFingerprint(ctx, issue);
    if (!fingerprint) {
      trace(`work-driver: host park guard did not run for #${issue} — issue body unreadable`);
      continue;
    }
    for (const row of armed) {
      if (row.fingerprint !== fingerprint) continue;
      if ((COVERED_PARK_CAPS as readonly string[]).includes(row.cap)) continue;
      return {
        issue,
        cap: row.cap as RepeatParkVerdict["cap"],
        reason: row.reason,
        count: row.deliveredCount,
        deliveredCount: row.deliveredCount,
        firstAt: row.firstAt,
      };
    }
  }
  return undefined;
}

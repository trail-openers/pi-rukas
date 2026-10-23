/**
 * work-driver-park-memory-host-read — the READ-ONLY half of the host park
 * signal (#1696): the file's path and name, its row shape, its plausibility
 * rules, and the one function that decides whether a directory still holds a
 * signal someone would act on.
 *
 * It is a separate module for one reason beyond size: **the sweep must never
 * resolve a fingerprint.** `holdsLiveHostParkSignal` is called once per orphan
 * directory by `work-driver-artifact-sweep.ts`, and a fingerprint is a
 * `gh issue view` — about four subprocesses per directory in a sweep that runs
 * at every cycle start and is chartered to cost nothing. Keeping the parser
 * and the sweep's question here, with the fetchers in
 * `work-driver-park-memory-host.ts`, means the sweep's import graph cannot
 * reach a fetch even by accident; `test-work-driver-artifact-sweep.ts` pins
 * that with an injected fetcher that throws.
 *
 * What lives here deliberately:
 *  - `parseHostParkRows` — pure, no I/O, one clock passed IN;
 *  - `sweepHostParkSignal` — the sweep's three answers, including the one that
 *    is NOT fail-open: a non-ENOENT read error HOLDS the directory;
 *  - `readHostParkSignalsImpl` — the guard's and the writer's read of the same
 *    rows through the same rules.
 *
 * What must NOT: anything that calls `signalFingerprint`, `rawIssueBody`,
 * `fetchIssueBodyViaGh` or `ctx.issueBodyFetcherFn`. That is the writer's and
 * the guard's job, in the sibling module.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { PARK_RECORD_MAX_AGE_MS } from "./work-driver-park-record.ts";
import { isKnownCap } from "./workflow-state-validate-caps.ts";
import { workStateDir } from "./workflow-state.ts";

/** The signal file's NAME — the one place that spells it. */
export const HOST_PARK_SIGNAL_FILE = "host-parks.json";

/**
 * How many rows the signal keeps. One row is one (cap, cause, fingerprint), and
 * an issue's causes and edits are bounded in practice — 50 is far past any real
 * cycle's history — so the ceiling exists to stop a file in a repository's
 * working tree growing without bound. Pruning drops the OLDEST first, and every
 * remaining row still arms a refusal on its own.
 */
export const HOST_PARK_MAX_ROWS = 50;

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

/**
 * A counter the writer could have produced: a non-negative SAFE integer. `1e18`
 * is an integer to `Number.isInteger`, and a `deliveredCount` that large would
 * arm the refusal on a file no writer produced — the refusal is a hard stop, so
 * a counter the driver could not have written reads as no protection at all.
 */
function plausibleCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** A timestamp the writer could have produced: finite, after 2020, not ahead of us. */
function plausibleTimestamp(v: unknown, now: number): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && v >= Date.UTC(2020, 0, 1) && v <= now + 60_000
  );
}

/**
 * A cycle id (`state.startedAt`, a ms epoch): a non-negative SAFE integer, the
 * same bar as the counters — an id the writer could not have produced must not
 * be trusted with the idempotency check that decides whether a handoff counts.
 */
function plausibleCycleId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Rows the refusal reads, newest first. The ceiling is enforced in this ONE
 * place, so a file an older writer (or a hand edit) left longer than
 * `HOST_PARK_MAX_ROWS` cannot arm the guard on rows no writer would have kept —
 * and the writer reads it back, so its own write cannot grow past it either.
 * Exported for the writer in the sibling module, which prunes before it inserts
 * its own row: two implementations of "newest first" is how the writer and the
 * reader start disagreeing about which rows the file is allowed to hold.
 *
 * `lastAt` decides, because it is the clock every age test in this module uses
 * (the guard's and the sweep's both compare `now - lastAt`). Sorting on the cycle
 * id instead would prune by a number that is not a clock: a resumed cycle carries
 * its original `startedAt`, so a row it published — one the reader still believes
 * — would be the first one pruned.
 */
export function newestFirstHostRows(rows: HostParkRow[]): HostParkRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) => b.row.lastAt - a.row.lastAt || b.row.lastCycleId - a.row.lastCycleId || a.i - b.i,
    )
    .map((x) => x.row);
}

/**
 * The READ-ONLY half of the read: parse the file's text and keep the rows this
 * build could believe. NO fetch, NO fingerprint, NO forge — this is what makes
 * the sweep's question cheap, and it is the reason `sweepHostParkSignal` below
 * is the sweep's whole answer.
 *
 * A row is believed when its shape is the writer's shape (`cap` a known cap
 * literal, strings where strings belong), its counters are safe integers the
 * writer could have produced, its timestamps are dates, and — with `now`, the
 * ONE clock this call uses for every row — it is inside the age the covered
 * record shares. A cap outside the published vocabulary (`isKnownCap`) is
 * dropped rather than kept: the cap is echoed into a refusal message, so a
 * fabricated one is untrusted text with no legitimate use, and a writer can
 * only ever have emitted a known literal.
 *
 * Rows come back newest first and capped at `HOST_PARK_MAX_ROWS`, so every
 * reader — the guard, the sweep, and the writer's own max-before-increment —
 * agrees on the window the file is allowed to have.
 */
export function parseHostParkRows(text: string, reader: string, now: number): HostParkRow[] {
  const file = `host park signal read by the ${reader}`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    trace(`work-driver: ${file} is not JSON: ${(err as Error).message}`);
    return [];
  }
  if (!Array.isArray(raw)) {
    trace(`work-driver: ${file} is not an array — treated as absent`);
    return [];
  }
  const rows: HostParkRow[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    if (
      r !== null &&
      typeof r === "object" &&
      typeof r.cap === "string" &&
      // Untrusted text on the refusal path: a cap the driver cannot emit is not
      // a row, and it never reaches the message the guard renders.
      isKnownCap(r.cap) &&
      typeof r.reason === "string" &&
      typeof r.fingerprint === "string" &&
      plausibleCount(r.deliveredCount) &&
      plausibleTimestamp(r.firstAt, now) &&
      plausibleTimestamp(r.lastAt, now) &&
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
      trace(`work-driver: ${file} carries an implausible row — dropped`);
    }
  }
  return newestFirstHostRows(rows).slice(0, HOST_PARK_MAX_ROWS);
}

/**
 * What the sweep asked, answered from ONE read of ONE file on ONE clock.
 *
 * Three answers, and the middle one is the point:
 *   - ENOENT / ENOTDIR — the file is not there, so it holds nothing;
 *   - any other read error — HELD. The sweep keeps on doubt, because deleting a
 *     live signal destroys the evidence behind a refusal the operator was given,
 *     and keeping a stale directory costs a few bytes;
 *   - content that parses to no believable row — not held. `parseHostParkRows`
 *     is pure and never fetches, so "the rows are gone" is a judgement the sweep
 *     can make without paying for `gh` per directory.
 *
 * The age test is the caller's `now`, passed through to the parser so one call
 * uses one clock rather than a new `Date.now()` per row.
 */
export async function sweepHostParkSignal(
  repoRoot: string,
  issue: number,
  now: number,
): Promise<boolean> {
  const file = hostParkSignalPath(repoRoot, issue);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    trace(
      `work-driver: host park signal ${file} unreadable by the sweep (${code ?? "error"}): held — ${(err as Error).message}`,
    );
    return true;
  }
  if (text.trim().length === 0) return false;
  return parseHostParkRows(text, "sweep", now).length > 0;
}

/**
 * Read the signal rows. A missing file is silent and empty (the normal case);
 * anything else a reader could not believe is EMPTY, never trusted, with a
 * trace — the refusal this feeds is a hard stop, so a `deliveredCount` that is
 * not a plausible integer or a `lastAt` from 1970 must not arm it.
 *
 * `now` is the one clock this pass uses; callers that judge several files (the
 * sweep) or several issues (the guard) pass one value so the whole pass agrees
 * on what "14 days" means.
 */
export async function readHostParkSignalsImpl(
  repoRoot: string,
  issue: number,
  /** The host that asked, so an empty result says WHO found nothing. */
  reader = "guard",
  now = Date.now(),
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
  return parseHostParkRows(text, reader, now);
}

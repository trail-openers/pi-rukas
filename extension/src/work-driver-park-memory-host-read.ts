/**
 * work-driver-park-memory-host-read — the READ half of the host park signal
 * (#1696): the file's path and name, the bounds on what it is allowed to hold,
 * and the one function that decides whether a directory still holds a signal
 * someone would act on.
 *
 * It is a separate module for one reason beyond size: **the sweep must never
 * resolve a fingerprint.** `holdsLiveHostParkSignal` is called once per orphan
 * directory by `work-driver-artifact-sweep.ts`, and a fingerprint is a
 * `gh issue view` — about four subprocesses per directory in a sweep that runs
 * at every cycle start and is chartered to cost nothing. Keeping the parser and
 * the sweep's question here, with the fetchers in
 * `work-driver-park-memory-host.ts`, means the sweep's import graph cannot reach
 * a fetch even by accident; `test-work-driver-artifact-sweep.ts` pins that with
 * an injected fetcher that throws. The row policy it applies — shape, bounds,
 * identity, eviction — is the pure sibling `work-driver-park-memory-host-rows.ts`
 * (a §12 file-size seam), and this module re-exports it so the writer and the
 * tests keep ONE name to import.
 *
 * What lives here deliberately:
 *  - `parseHostParkRows` — pure, no I/O, one clock passed IN, and the ONE place
 *    the two ceilings (`HOST_PARK_MAX_ROWS`, `HOST_PARK_REASON_MAX`) are applied;
 *  - `sweepHostParkSignal` — the sweep's three answers, including the one that is
 *    NOT fail-open: a non-ENOENT read error HOLDS the directory;
 *  - `readHostParkSignalsImpl` — the guard's and the writer's read of the same
 *    rows through the same rules.
 *
 * Both reads of the file go through `readHostParkText`, which refuses anything
 * past `HOST_PARK_FILE_MAX_BYTES` before its bytes are buffered — the same shape
 * `readCachedIssueBody` uses for the cached artifact in the sibling module. An
 * oversized file is reported exactly as an unreadable one is, so each reader's
 * EXISTING rule for one decides it: the guard fails open, the sweep holds.
 *
 * What must NOT: anything that calls `signalFingerprint`, `rawIssueBody`,
 * `fetchIssueBodyViaGh` or `ctx.issueBodyFetcherFn`. That is the writer's and
 * the guard's job, in the sibling module.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import {
  HOST_PARK_FILE_MAX_BYTES,
  HOST_PARK_MAX_ROWS,
  HOST_PARK_REASON_MAX,
  clipHostParkReason,
  dedupeHostRows,
  newestFirstHostRows,
  prunedHostRows,
} from "./work-driver-park-memory-host-rows.ts";
import type { HostParkRow } from "./work-driver-park-memory-host-rows.ts";
import { PARK_RECORD_MAX_AGE_MS } from "./work-driver-park-record.ts";
import { isKnownCap } from "./workflow-state-validate-caps.ts";
import { workStateDir } from "./workflow-state.ts";

/** The signal file's NAME — the one place that spells it. */
export const HOST_PARK_SIGNAL_FILE = "host-parks.json";

/**
 * The fingerprint's shape: what `createHash("sha256").digest("hex")` writes in
 * `signalFingerprint`. A row that does not look like it can never be the row the
 * guard matches, so `parseHostParkRows` drops it rather than believing it.
 */
const HOST_PARK_FINGERPRINT = /^[0-9a-f]{64}$/;

export {
  type HostParkRow,
  HOST_PARK_FILE_MAX_BYTES,
  HOST_PARK_MAX_ROWS,
  HOST_PARK_REASON_MAX,
  clipHostParkReason,
  dedupeHostRows,
  dedupeHostRowsForWrite,
  newestFirstHostRows,
  prunedHostRows,
} from "./work-driver-park-memory-host-rows.ts";

/** The signal's path — the sweep's exemption and the tests both ask for it. */
export function hostParkSignalPath(repoRoot: string, issue: number): string {
  return path.join(workStateDir(repoRoot), String(issue), HOST_PARK_SIGNAL_FILE);
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
 * What one read of the signal file produced: its `text`, its absence (ENOENT or
 * ENOTDIR), or a read that failed for some other reason. Three cases because the
 * two readers answer them differently, and a boolean would flatten the pair the
 * sweep's keep-on-doubt rule turns on.
 */
type HostParkRead =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "error"; code: string; message: string };

/**
 * The file's text, or why there is none.
 *
 * `open` then `stat` then read, so an oversized file is refused before its bytes
 * are allocated — a size test after `readFile` bounds the decision, not the
 * memory. An oversized file is reported as an ERROR, not as absence, so the
 * sweep's existing rule for a read error (hold) applies to it; the guard's
 * existing rule for one (fail open) does the same for that reader.
 */
async function readHostParkText(file: string): Promise<HostParkRead> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    if (size > HOST_PARK_FILE_MAX_BYTES) {
      return {
        kind: "error",
        code: "ETOOBIG",
        message: `${size} bytes is past the ${HOST_PARK_FILE_MAX_BYTES} ceiling`,
      };
    }
    const buf = await handle.readFile({ encoding: null });
    // The bound is on the BYTES read, not on the text after the read: a file
    // that grew between the `stat` and the read is still not unbounded.
    if (buf.byteLength > HOST_PARK_FILE_MAX_BYTES) {
      return {
        kind: "error",
        code: "ETOOBIG",
        message: `${buf.byteLength} bytes read is past the ${HOST_PARK_FILE_MAX_BYTES} ceiling`,
      };
    }
    return { kind: "text", text: buf.toString("utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "error", code: code ?? "error", message: (err as Error).message };
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
 * record shares. A cap outside the published vocabulary (`isKnownCap`) is dropped
 * rather than kept: the cap is echoed into a refusal message, so a fabricated one
 * is untrusted text with no legitimate use, and a writer can only ever have
 * emitted a known literal. A `reason` longer than `HOST_PARK_REASON_MAX` is not
 * dropped but CLIPPED, with the constant the writer itself clips with, so the
 * stored value and the read value are one value and dedupe cannot split a park in
 * two.
 *
 * The fingerprint must be what `signalFingerprint` produces — a lowercase hex
 * sha256 — and a row whose fingerprint is anything else is dropped: it can never
 * match the hash the guard computes, so it arms nothing, and letting it through
 * would count it against the ceiling while it sits there believed.
 *
 * Rows come back deduplicated by identity, then pruned by `prunedHostRows` — the
 * newest-written row, then armed rows, then recency — so every reader (the guard,
 * the sweep) and the writer's own prune agree on the window the file is allowed to
 * have.
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
      // Exactly the shape `createHash("sha256").digest("hex")` writes. A row
      // outside it is no publish's fingerprint: the guard compares this field
      // against a hash it computes itself, so a row failing this test can never
      // refuse anything and only occupies the ceiling.
      HOST_PARK_FINGERPRINT.test(r.fingerprint) &&
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
        // Clipped here rather than only on the way out: the value that goes
        // into the row's identity has to be the value the writer stored, or a
        // row whose reason was longer than the ceiling dedupes against a
        // different key than the one the next publish writes for the same park.
        reason: clipHostParkReason(r.reason),
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
  // Dedupe BEFORE the prune: two rows of one identity are one park, and the
  // ceiling counts parks, not rows a hand edit happened to leave behind.
  return prunedHostRows(dedupeHostRows(rows));
}

/**
 * Does this issue's artifact directory carry a host park signal a reader would
 * still act on? The artifact sweep's question, and the reason this module exists
 * separately from the writer: answering it costs ONE bounded file read and ZERO
 * forge calls. Asking it of `work-driver-park-memory-host.ts` instead would make
 * the sweep's import graph reach `fetchIssueBodyViaGh` — the writer's fetcher —
 * and `test-work-driver-artifact-sweep.ts` (k2) walks the graph to refuse that.
 *
 * It does NOT re-check the covered record: the caller in
 * `work-driver-artifact-sweep.ts` reads those itself, through the module that
 * owns them, and asking twice for one directory is how two readers drift.
 */
export async function holdsLiveHostParkSignal(
  repoRoot: string,
  issue: number,
  now = Date.now(),
): Promise<boolean> {
  return sweepHostParkSignal(repoRoot, issue, now);
}

/**
 * What the sweep asked, answered from ONE read of ONE file on ONE clock.
 *
 * Three answers, and the middle one is the point:
 *   - ENOENT / ENOTDIR — the file is not there, so it holds nothing;
 *   - any other read error — HELD. The sweep keeps on doubt, because deleting a
 *     live signal destroys the evidence behind a refusal the operator was given,
 *     and keeping a stale directory costs a few bytes. A file past the byte
 *     ceiling is reported as one of these, so it holds too;
 *   - content that parses to no believable row — not held. `parseHostParkRows` is
 *     pure and never fetches, so "the rows are gone" is a judgement the sweep can
 *     make without paying for `gh` per directory.
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
  const read = await readHostParkText(file);
  if (read.kind === "absent") return false;
  if (read.kind === "error") {
    trace(
      `work-driver: host park signal ${file} unreadable by the sweep (${read.code}): held — ${read.message}`,
    );
    return true;
  }
  const text = read.text;
  if (text.trim().length === 0) return false;
  return parseHostParkRows(text, "sweep", now).length > 0;
}

/**
 * Read the signal rows. A missing file is silent and empty (the normal case);
 * anything else a reader could not believe is EMPTY, never trusted, with a trace
 * — the refusal this feeds is a hard stop, so a `deliveredCount` that is not a
 * plausible integer, a `lastAt` from 1970, or a file past the byte ceiling must
 * not arm it.
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
  const read = await readHostParkText(file);
  if (read.kind === "absent") return [];
  if (read.kind === "error") {
    trace(
      `work-driver: host park signal ${file} unreadable by the ${reader} (${read.code}): ${read.message}`,
    );
    return [];
  }
  return parseHostParkRows(read.text, reader, now);
}

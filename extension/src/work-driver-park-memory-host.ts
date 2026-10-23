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

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchIssueBodyViaGh } from "./work-driver-explore.ts";
import { handoffChannel } from "./work-driver-handoff-channel.ts";
import type { RepeatParkVerdict } from "./work-driver-park-memory.ts";
import { COVERED_PARK_CAPS, PARK_RECORD_MAX_AGE_MS } from "./work-driver-park-record.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

/** The signal file's NAME — the one place that spells it. */
export const HOST_PARK_SIGNAL_FILE = "host-parks.json";

/** How many published parks of one identical shape arm the next refusal. */
export const HOST_PARK_REFUSAL_COUNT = 2;

/**
 * How many rows the signal keeps. One row is one (cap, cause, fingerprint), and
 * an issue's causes and edits are bounded in practice — 50 is far past any real
 * cycle's history — so the ceiling exists to stop a file in a repository's
 * working tree growing without bound. Pruning drops the OLDEST first, and every
 * remaining row still arms a refusal on its own.
 */
export const HOST_PARK_MAX_ROWS = 50;

/**
 * Does this build consult the host park signal? The SAME switch as the covered
 * guard: `PI_ENSEMBLE_REPEAT_PARK=0` turns the whole repeat guard off, records
 * included. Read from the environment here rather than imported, for the import
 * -cycle reason in this file's header.
 */
export function hostParkEnabled(): boolean {
  return process.env.PI_ENSEMBLE_REPEAT_PARK !== "0";
}

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
function plausibleTimestamp(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= Date.UTC(2020, 0, 1) &&
    v <= Date.now() + 60_000
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

/** The host that asked, so an empty result says WHO found nothing. */
function read(ctx: DriverContext, reader: string): Promise<HostParkRow[]> {
  return readHostParkSignalsImpl(ctx.repoRoot, ctx.issue, reader);
}

/**
 * Rows the refusal reads, newest first. The ceiling is enforced in this ONE
 * place, so a file an older writer (or a hand edit) left longer than
 * `HOST_PARK_MAX_ROWS` cannot arm the guard on rows no writer would have kept —
 * and the writer reads it back, so its own write cannot grow past it either.
 *
 * `lastAt` decides, because it is the clock every age test in this module uses
 * (the guard's and the sweep's both compare `now - lastAt`). Sorting on the cycle
 * id instead would prune by a number that is not a clock: a resumed cycle carries
 * its original `startedAt`, so a row it published — one the reader still believes
 * — would be the first one pruned.
 */
function newestFirst(rows: HostParkRow[]): HostParkRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) => b.row.lastAt - a.row.lastAt || b.row.lastCycleId - a.row.lastCycleId || a.i - b.i,
    )
    .map((x) => x.row);
}

/**
 * Read the signal rows. A missing file is silent and empty (the normal case);
 * anything else a reader could not believe is EMPTY, never trusted, with a
 * trace — the refusal this feeds is a hard stop, so a `deliveredCount` that is
 * not a plausible integer or a `lastAt` from 1970 must not arm it.
 *
 * The rows come back newest first and capped at `HOST_PARK_MAX_ROWS`, so every
 * reader — the guard, the sweep, and the writer's own max-before-increment —
 * agrees on the window the file is allowed to have.
 */
export async function readHostParkSignalsImpl(
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
  return newestFirst(rows).slice(0, HOST_PARK_MAX_ROWS);
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
 * The issue text a park is identified by: this cycle's cached artifact when it
 * has one (immune to an edit landing between explore and handoff), else the
 * forge fetch. Same text, same hash as `parkFingerprint` on the covered path.
 */
async function rawIssueBody(
  ctx: DriverContext,
  issue: number,
  localArtifact?: string,
): Promise<string | undefined> {
  if (localArtifact) {
    const file = path.resolve(ctx.repoRoot, localArtifact);
    try {
      const text = await fs.readFile(file, "utf8");
      if (text.trim()) return text;
    } catch (err) {
      trace(
        `work-driver: host park artifact ${file} unreadable, falling back to the fetch: ${(err as Error).message}`,
      );
    }
  }
  const fetchBody = ctx.issueBodyFetcherFn ?? fetchIssueBodyViaGh;
  try {
    const { stdout } = await fetchBody(issue, ctx.repoRoot);
    return stdout.trim() ? stdout : undefined;
  } catch (err) {
    trace(`work-driver: host park fingerprint for #${issue} unreadable: ${(err as Error).message}`);
    return undefined;
  }
}

/** sha256 of the issue text, or `undefined` when it could not be read. */
async function signalFingerprint(
  ctx: DriverContext,
  issue: number,
  localArtifact?: string,
): Promise<string | undefined> {
  const raw = await rawIssueBody(ctx, issue, localArtifact);
  return raw === undefined ? undefined : createHash("sha256").update(raw).digest("hex");
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
  if (!published || !hostParkEnabled()) return;
  // A host channel that posts nothing is the only one that needs this memory.
  if (handoffChannel() !== "host") return;
  const park = hostParkOf(state);
  if (!park) return;
  try {
    const fingerprint = await signalFingerprint(
      ctx,
      ctx.issue,
      state.pipelineState.issueBodyArtifact,
    );
    if (!fingerprint) return; // An unreadable body is not a park we can identify.
    // The first read answers TWO questions, and it is deliberately NOT the set
    // written below: has THIS cycle already published (a resume re-entering its
    // own handoff must not move the number the guard refuses on), and what did
    // THIS writer read — the count a sibling may have moved since.
    const prior = (await read(ctx, "handoff")).find(
      (r) => r.cap === park.cap && r.reason === park.reason && r.fingerprint === fingerprint,
    );
    if (prior?.lastCycleId === state.startedAt) return;
    // Re-read immediately before writing, like `recordPark`: two cycles of one
    // issue can be in flight (a fan-out, a re-run after a crash) and each read
    // its own rows. The set WRITTEN is the FRESH reading, so a row a sibling
    // added in between is not dropped, and the count is the larger of the two
    // readings plus one — the cheap lost-update guard. Not a lock, and it does
    // not need to be one. Sorted and capped before the new row goes in, so the
    // row THIS cycle published is never the one pruned: the write below stamps it
    // with `at`, the newest timestamp in the file by the reader's own clock, and
    // the file never grows past the ceiling.
    const at = Date.now();
    const live = await read(ctx, "handoff");
    // Pruning to one row under the ceiling keeps RECENCY over ARMEDNESS on
    // purpose: an armed row (count >= 2) is never special-cased, so the oldest
    // row goes even if a younger one armed nothing. A real cycle cannot lose its
    // own row this way — the write below stamps its row with `at`, the newest
    // timestamp in the file, so it is the last candidate for the prune, not the
    // first.
    const next = newestFirst(live)
      .slice(0, HOST_PARK_MAX_ROWS - 1)
      .map((r) =>
        r.cap === park.cap && r.reason === park.reason && r.fingerprint === fingerprint
          ? {
              ...r,
              deliveredCount: Math.max(r.deliveredCount, prior?.deliveredCount ?? 0) + 1,
              lastAt: at,
              lastCycleId: state.startedAt,
            }
          : r,
      );
    if (!next.some((r) => r.lastCycleId === state.startedAt)) {
      next.push({
        cap: park.cap,
        reason: park.reason,
        fingerprint,
        deliveredCount: 1,
        firstAt: at,
        lastAt: at,
        lastCycleId: state.startedAt,
      });
    }
    const bounded = next;
    const file = hostParkSignalPath(ctx.repoRoot, ctx.issue);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic, like the covered record: a crash leaves the PREVIOUS rows intact
    // rather than a half-written file the reader (correctly) reads as empty.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(bounded, null, 2), "utf8");
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
  // The module's own reader is the only thing that decides whether a row is
  // believed: it already drops the malformed and the expired, so "at least one
  // row survived" and "this directory still arms a refusal" are the same
  // question. The age test is this caller's own `now`, so a sweep can ask about
  // a clock other than its own.
  const rows = await readHostParkSignalsImpl(repoRoot, issue, "sweep");
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
 *
 * Each call deletes ONLY its own file, never the directory that holds them:
 * the artifact sweep owns that directory's life, and the same door also runs
 * for every sibling issue in the group, so a recursive delete would take a
 * sibling's live record or the cycle's own cached spec with it.
 */
export async function clearHostParkSignals(repoRoot: string, issues: number[]): Promise<void> {
  for (const issue of [...new Set(issues)]) {
    try {
      // ONLY the signal file: the artifact sweep already prunes that directory by
      // age, and the cycle's other artifacts (`<N>.json`, `explore-spec.md`, a
      // covered `park-<cap>.json` belonging to a sibling issue in the group) are
      // not this call's to destroy. `force` keeps a missing file silent.
      await fs.rm(hostParkSignalPath(repoRoot, issue), { force: true });
    } catch (err) {
      trace(
        `work-driver: could not clear the park memory for #${issue}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Has this issue's host signal already PUBLISHED this park — this cap, this
 * reason, against this exact issue text — twice?
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
  if (!hostParkEnabled() || handoffChannel() !== "host") return undefined;
  const now = Date.now();
  for (const issue of [...new Set([ctx.issue, ...issues])]) {
    const rows = await readHostParkSignalsImpl(ctx.repoRoot, issue);
    const armed = rows.filter(
      (r) =>
        r.deliveredCount >= HOST_PARK_REFUSAL_COUNT && now - r.lastAt <= PARK_RECORD_MAX_AGE_MS,
    );
    // Cheap path first: nothing earned a refusal, so no `gh` call is paid for.
    if (armed.length === 0) continue;
    const fingerprint = await signalFingerprint(ctx, issue);
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

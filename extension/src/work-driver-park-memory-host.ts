/**
 * work-driver-park-memory-host — the WRITE and GUARD halves of the host park
 * signal (#1696): the (cap, reason) a cycle publishes, the fingerprint of the
 * issue text it was published against, the atomic write, and the verdict the
 * pre-loop guard reads.
 *
 * The file's NAME and PATH, its row shape, its plausibility rules and the
 * sweep's question are in `work-driver-park-memory-host-read.ts` — a module
 * that imports no fetcher, so the artifact sweep cannot reach a `gh` call
 * through them. Everything BELOW this header can: `signalFingerprint` is a
 * subprocess, so it belongs to a caller (the handoff, the guard) and never to
 * the sweep. Read that module's header before adding a reader here.
 *
 * What this memory is: one row per (cap, reason, issue-text fingerprint) a host
 * handoff actually PUBLISHED, and how many times. "Published" is the handoff
 * step's own rule: a non-empty body reached the host in the result. An empty
 * body counted nothing, because nobody received anything. It lives at
 * `.pi/work-state/<N>/host-parks.json`, the directory the covered records
 * already live in — the one that survives a factory's `--restart` (which wipes
 * only `<N>.json`) and that the artifact sweep already keeps alive while a park
 * is still believed.
 *
 * Why it exists: `work-driver-park-record.ts` remembers a park for three caps
 * only (`COVERED_PARK_CAPS`). Every other park — a lens round cap, a
 * `verify-failed:develop`, a `step-failed:explore` — leaves nothing on disk,
 * and on the `host` channel it leaves nothing ANYWHERE: pi-rukas posts no
 * comment and applies no `needs-human-attention` label there, by contract
 * (docs/headless.md, `test-headless-handoff-channel.ts`). The same park was
 * re-run and re-reported three to nine times on an unchanged issue with no
 * signal that anyone had ever been told about it.
 *
 * What it does NOT do: it is not a label (the host owns that channel and this
 * module never touches a forge), it does not replace the covered records (the
 * covered caps keep theirs, with their delivery counting and their forge
 * re-checks), and it never refines a verdict. The refusal it feeds is written
 * by `refuseHostPublishedPark` in `work-driver-state-guards.ts` in the same
 * shape as the #1743 one: cap `repeat-park`, no step dispatched, no state file
 * written.
 *
 * Fails open in every direction the guard cannot honestly judge — an unreadable
 * issue body, an unreadable or malformed file, an expired row — because a start
 * the signal wrongly refuses is a start nothing can get back. The one
 * exception is the sweep's keep-on-doubt rule, which is the reader's to state
 * (see `sweepHostParkSignal`).
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { fetchIssueBodyViaGh } from "./work-driver-explore.ts";
import { handoffChannel } from "./work-driver-handoff-channel.ts";
import {
  HOST_PARK_FILE_MAX_BYTES,
  HOST_PARK_MAX_ROWS,
  HOST_PARK_REASON_MAX,
  clipHostParkReason,
  dedupeHostRows,
  dedupeHostRowsForWrite,
  hostParkSignalPath,
  parseHostParkRows,
  prunedHostRows,
  readHostParkSignalsImpl,
  sweepHostParkSignal,
} from "./work-driver-park-memory-host-read.ts";
import type { HostParkRow } from "./work-driver-park-memory-host-read.ts";
import type { RepeatParkVerdict } from "./work-driver-park-memory.ts";
import {
  COVERED_PARK_CAPS,
  PARK_RECORD_MAX_AGE_MS,
  REPEAT_PARK_REFUSAL_COUNT,
  repeatParkEnabled,
} from "./work-driver-park-record.ts";
import { lastCapHitAny } from "./workflow-state-cap.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

/**
 * The ceiling on the cached issue-body artifact. `parkFingerprint` on the
 * covered path reads the same file, and an unbounded read of a path that came
 * out of a persisted state file is a memory bound the driver does not own.
 * Generous (a GitHub issue body is capped far below it) so a real artifact is
 * never the one thing clipped, and the hash stays the hash of the whole body.
 */
const HOST_PARK_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

export {
  type HostParkRow,
  HOST_PARK_FILE_MAX_BYTES,
  HOST_PARK_MAX_ROWS,
  HOST_PARK_REASON_MAX,
  HOST_PARK_SIGNAL_FILE,
  clipHostParkReason,
  dedupeHostRows,
  dedupeHostRowsForWrite,
  holdsLiveHostParkSignal,
  hostParkSignalPath,
  newestFirstHostRows,
  parseHostParkRows,
  prunedHostRows,
  readHostParkSignalsImpl,
  sweepHostParkSignal,
} from "./work-driver-park-memory-host-read.ts";

/**
 * The (cap, reason) this cycle publishes, when no covered record covers it.
 * `undefined` for a covered cap — that park has its own record, with delivery
 * counting and the forge re-checks, and two memories of one park is two chances
 * to disagree about it.
 *
 * The reason is what distinguishes two parks of one cap. It is only ever a
 * cause somebody STATED (`parkReason`, the plan gate's verdict); a park reason
 * the parser SUBSTITUTED is never guessed at (#404's rule) and a cap that names
 * no cause gets one row, which is still the truth: this same cap fired again
 * against this same issue text.
 *
 * `evidence` is NOT a reason. It is a free-text field (`lens-fix-not-integrated`
 * carries raw git output, a verify cap carries command failures), so keying on
 * it would put untrusted prose into the row identity that decides a refusal —
 * and two parks of one cap with two different failure logs would read as two
 * parks. A cap that states no cause gets the single empty-reason row.
 *
 * The reason is clipped to `HOST_PARK_REASON_MAX` HERE, with the constant the
 * reader applies in `parseHostParkRows`: the row identity is (cap, reason,
 * fingerprint) and the stored value is what the next publish compares against,
 * so writer and reader must agree on it or a long reason becomes two parks where
 * the operator sees one.
 */
export function hostParkOf(state: WorkState): { cap: string; reason: string } | undefined {
  // The shared scan (`workflow-state-cap.ts`), not a hand-rolled reverse-find:
  // every reader of the last cap-hit agrees by construction, which is the rule
  // #830 established for exactly this event.
  const hit = lastCapHitAny(state);
  if (!hit) return undefined;
  if ((COVERED_PARK_CAPS as readonly string[]).includes(hit.cap)) return undefined;
  return { cap: hit.cap, reason: clipHostParkReason(hit.parkReason ?? hit.planVerdict ?? "") };
}

/**
 * Is a cached artifact path one of the driver's own capability files, however it
 * is spelled? See the call site below for why both spellings are asked.
 */
export function isProtectedArtifactPathForTest(p: string): boolean {
  return isProtectedPath(p) || isProtectedPath(p.replace(/\\/g, "/").toLowerCase());
}

/**
 * The cached issue-body artifact, when the cycle has one and it is USABLE.
 * Same containment rule as `readCachedBody` in `work-develop-scope-fence-seam.ts`:
 * the path is persisted state data, so it must resolve inside this issue's
 * work-state directory — no `..`, no absolute path — or it is refused, and the
 * size is bounded the way `parkFingerprint` bounds its read. The artifact is
 * what THIS cycle fetched, so hashing it is immune to an edit landing between
 * explore and handoff.
 */
async function readCachedIssueBody(
  repoRoot: string,
  localArtifact: string,
): Promise<string | undefined> {
  const stateDir = workStateDir(repoRoot);
  const file = path.resolve(repoRoot, localArtifact);
  const rel = path.relative(stateDir, file);
  if (rel === "" || rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) {
    trace(`work-driver: host park artifact ${file} is outside ${stateDir}; refused`);
    return undefined;
  }
  // A persisted artifact path must not point the fingerprint at a file whose
  // contents gate the cycle: `.pi/`, `.github/` and `CODEOWNERS`/`agents.json`
  // are the driver's own capability files, and hashing one would make this
  // guard read (and echo a hash of) whatever protected file a state file names.
  // Refused, not trusted — the fetch path below still answers, so this fails
  // open the same way the containment check does.
  //
  // Case-folded, not raw: `isProtectedPath` compares segments exactly, so on a
  // case-insensitive checkout — the common macOS/Windows default — a dotted
  // capitalisation of `.pi` IS this cycle's verify-command directory and of
  // `.github` IS the workflow that gates it, while a raw check waves both
  // through. The same bar the planner's own path gate applies
  // (`isProtectedRepairPath` in `work-driver-plan-repair.ts`); it folds INTO the
  // raw check rather than replacing it, because `isProtectedPath` also matches
  // bare filenames (`CODEOWNERS`, `agents.json`) that only the raw spelling names.
  if (isProtectedArtifactPathForTest(localArtifact) || isProtectedArtifactPathForTest(rel)) {
    trace(`work-driver: host park artifact ${file} is a protected path; refused`);
    return undefined;
  }
  let text: string;
  try {
    // Bound the read BEFORE buffering it: `stat` first, so an oversized file is
    // refused without its bytes ever being allocated. A size test after
    // `readFile` bounds the decision, not the memory.
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size > HOST_PARK_ARTIFACT_MAX_BYTES) {
        trace(
          `work-driver: host park artifact ${file} is ${size} bytes, past the ${HOST_PARK_ARTIFACT_MAX_BYTES} ceiling; falling back to the fetch`,
        );
        return undefined;
      }
      const buf = await handle.readFile({ encoding: null });
      // The bound is on the BYTES read, not on the text after the read: a file
      // that grew between the `stat` and the read is still not unbounded.
      if (buf.byteLength > HOST_PARK_ARTIFACT_MAX_BYTES) {
        trace(
          `work-driver: host park artifact ${file} is ${buf.byteLength} bytes, past the ${HOST_PARK_ARTIFACT_MAX_BYTES} ceiling; falling back to the fetch`,
        );
        return undefined;
      }
      text = buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    trace(
      `work-driver: host park artifact ${file} unreadable, falling back to the fetch: ${(err as Error).message}`,
    );
    return undefined;
  }
  return text.trim() ? text : undefined;
}

/**
 * The issue text a park is identified by: this cycle's cached artifact when it
 * has one (immune to an edit landing between explore and handoff), else the
 * forge fetch. Same text, same hash as `parkFingerprint` on the covered path.
 * No new fetcher: the injected seam or `fetchIssueBodyViaGh`, which already
 * carries its own per-attempt deadline and buffer bound.
 */
async function rawIssueBody(
  ctx: DriverContext,
  issue: number,
  localArtifact?: string,
): Promise<string | undefined> {
  if (localArtifact) {
    const cached = await readCachedIssueBody(ctx.repoRoot, localArtifact);
    if (cached !== undefined) return cached;
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

/**
 * One issue body per guard/handoff pass, at most. Several rows of one issue can
 * arm, and each of them asks the same question of the forge — a pass over a
 * five-row signal used to be up to five `gh issue view` calls, each with its
 * own 45 s bound, in a pre-loop gate that is supposed to cost nothing. `undefined`
 * means "not asked yet"; `null` means "asked and could not be read", so a
 * failure does not retry itself for every row (and fails open, as it always did).
 */
export type IssueBodyMemo = Map<string, string | null>;

export function newIssueBodyMemo(): IssueBodyMemo {
  return new Map();
}

/**
 * The issue text's hash, at most once per (issue, artifact) per pass.
 * `null` in the memo means "asked, could not be read", so an unreadable body
 * does not retry itself once per armed row.
 */
async function fingerprintOf(
  ctx: DriverContext,
  issue: number,
  memo: IssueBodyMemo,
  localArtifact?: string,
): Promise<string | undefined> {
  const key = `${issue}\u0000${localArtifact ?? ""}`;
  const cached = memo.get(key);
  if (cached === undefined) {
    const raw = await rawIssueBody(ctx, issue, localArtifact);
    memo.set(key, raw ?? null);
    return raw === undefined ? undefined : createHash("sha256").update(raw).digest("hex");
  }
  return cached === null ? undefined : createHash("sha256").update(cached).digest("hex");
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
  const memo = newIssueBodyMemo();
  try {
    const fingerprint = await fingerprintOf(
      ctx,
      ctx.issue,
      memo,
      state.pipelineState.issueBodyArtifact,
    );
    if (!fingerprint) return; // An unreadable body is not a park we can identify.
    // ONE read answers TWO questions, and it is deliberately NOT the set written
    // below: has THIS cycle already published (a resume re-entering its own
    // handoff must not move the number the guard refuses on), and what did THIS
    // writer read. The write below re-reads only after the awaits that can
    // actually interleave a sibling — the old double read of the same file with
    // nothing in between was one `fs.readFile` the first answer already covered.
    const prior = (await readHostParkSignalsImpl(ctx.repoRoot, ctx.issue, "handoff")).find(
      (r: HostParkRow) =>
        r.cap === park.cap && r.reason === park.reason && r.fingerprint === fingerprint,
    );
    if (prior?.lastCycleId === state.startedAt) return;
    // Re-read immediately before writing, like `recordPark`: two cycles of one
    // issue can be in flight (a fan-out, a re-run after a crash) and each read
    // their own rows, so the set WRITTEN is the FRESH reading — a row a sibling
    // added in between is not dropped — and the count is the larger of the two
    // readings plus one, the cheap lost-update guard. Not a lock, and it does not
    // need to be one.
    const at = Date.now();
    const live = await readHostParkSignalsImpl(ctx.repoRoot, ctx.issue, "handoff");
    // A WRITE never prunes: every row already on disk stays, and THIS cycle's row
    // goes in at the tail. What makes that safe is the ceiling living in ONE
    // place — `parseHostParkRows` — as an ordering the WRITER then obeys. Every
    // row `readHostParkSignalsImpl` returns is one the reader keeps (armed rows
    // first, then the newest-written row, then the rest by recency) and
    // `dedupeHostRowsForWrite` writes them back in that same order, so `live` is
    // always the file's most-worthy `HOST_PARK_MAX_ROWS` and the appended row is
    // the one row the reader's cut drops. Pruning here — the whole file, or the
    // file minus this identity — was the first shape and it lost the publish: at
    // the ceiling the cut reached the row this cycle had just written, its count
    // stayed at 1, and the guard never armed. The row a publish writes is the row
    // the NEXT start refuses on, so it is not a cut candidate on either side.
    // Recency alone was the other first rule, and it lost armedness: on a full
    // file the oldest row went even when it was the one armed row, so a park the
    // operator had already been handed twice stopped being refused for the
    // unrelated reason that fifty other parks had been published since.
    const mineOf = (r: HostParkRow) =>
      r.cap === park.cap && r.reason === park.reason && r.fingerprint === fingerprint;
    const next: HostParkRow[] = live.map((r: HostParkRow) =>
      mineOf(r)
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
    // The row THIS cycle published is at the tail and is never a cut candidate:
    // `at` is the newest timestamp in the file, which is the row `prunedHostRows`
    // pins on both sides of the read/write pair. Dedupe runs here too (one row
    // per (cap, reason, fingerprint), see
    // `dedupeHostRows`) — the file on disk is what the next writer reads and what
    // an operator inspects, and two rows of one identity would make a single
    // publish count against whichever twin the increment happened to match.
    const bounded = dedupeHostRowsForWrite(next, { ...park, fingerprint }, state.startedAt);
    // The ceiling is applied HERE, once, through the reader's own rule rather
    // than a second copy of it: `parseHostParkRows` runs the same
    // `prunedHostRows(dedupeHostRows(...))` the guard and the sweep will run on
    // this file, so what the writer keeps is exactly what the reader would keep,
    // and the tail row this cycle appended is the only one the cut can take
    // (it is the newest-written row, which `prunedHostRows` pins). Sorting the
    // whole set at every write is cheaper than a second policy that can drift.
    const capped = parseHostParkRows(JSON.stringify(bounded), "writer", at);
    const file = hostParkSignalPath(ctx.repoRoot, ctx.issue);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic, like the covered record: a crash leaves the PREVIOUS rows intact
    // rather than a half-written file the reader (correctly) reads as empty.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(capped, null, 2), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      // A failed rename leaves the tmp file behind, and the signal directory is
      // one the sweep only deletes whole: an orphaned `.tmp` per failed write is
      // litter nobody cleans up. Best-effort removal, then the original error.
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    trace(`work-driver: could not update the host park signal: ${(err as Error).message}`);
  }
}

/**
 * Forget this issue's HOST park signals — ONLY the signal file. The covered
 * park records beside it are the merge path's to clear, through
 * `clearParkRecords` in `work-driver-park-record.ts`, which this call does NOT
 * touch: it deletes one file per issue and nothing else in the directory.
 *
 * Each call deletes ONLY its own file, never the directory that holds them:
 * the artifact sweep owns that directory's life, and the same door also runs
 * for every sibling issue in the group, so a recursive delete would take a
 * sibling's live record or the cycle's own cached spec with it.
 *
 * Best-effort, with the same discipline as the claim release beside it — a
 * failure is traced and never costs a merge.
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
        `work-driver: could not clear the host park signal for #${issue}: ${(err as Error).message}`,
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
 *
 * The cached artifact (`state.pipelineState.issueBodyArtifact`) is preferred
 * when the caller passes one: it is what this cycle fetched, so a refusal that
 * quotes it compares the same text the publish hashed, and the `gh` call is
 * never made at all. One body per issue per pass, whatever the number of armed
 * rows (`memo`).
 */
export async function hostParkVerdict(
  ctx: DriverContext,
  issues: number[] = [ctx.issue],
  /** The cycle's cached issue body, when it has one (see above). */
  localArtifact?: string,
): Promise<RepeatParkVerdict | undefined> {
  if (!repeatParkEnabled() || handoffChannel() !== "host") return undefined;
  const now = Date.now();
  const memo = newIssueBodyMemo();
  for (const issue of [...new Set([ctx.issue, ...issues])]) {
    const rows = await readHostParkSignalsImpl(ctx.repoRoot, issue, "guard", now);
    const armed = rows.filter(
      (r) =>
        r.deliveredCount >= REPEAT_PARK_REFUSAL_COUNT && now - r.lastAt <= PARK_RECORD_MAX_AGE_MS,
    );
    // Cheap path first: nothing earned a refusal, so no `gh` call is paid for.
    if (armed.length === 0) continue;
    const fingerprint = await fingerprintOf(ctx, issue, memo, localArtifact);
    if (!fingerprint) {
      trace(`work-driver: host park guard did not run for #${issue} — issue body unreadable`);
      continue;
    }
    for (const row of armed) {
      if (row.fingerprint !== fingerprint) continue;
      if ((COVERED_PARK_CAPS as readonly string[]).includes(row.cap)) continue;
      return {
        issue,
        // The reader already dropped anything `isKnownCap` rejects, so this is
        // the union rather than a string from a hand-edited file.
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

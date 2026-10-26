/**
 * review-findings-critical-probe — the three-valued "does this branch still
 * hold an open line-bearing CRITICAL?" answer (#1832), split out of
 * review-findings-store.ts (AGENTS.md §12 file-size gate; the store keeps every
 * write and the fail-open prompt read).
 *
 * The one consumer is the automatic-delta decision (`resolveReviewDiff` in
 * lens-review-diff.ts): when the answer is anything but `absent`, no automatic
 * delta applies and the round runs as a full review. That is what makes the
 * #1832 retirement reachable at all — a delta round is `reviewKind === "delta"`
 * in lens-review-findings.ts, and `rowFate` resolves nothing on a delta, so a
 * CRITICAL the previous round filed could never retire while every follow-up
 * stayed a delta.
 *
 * Why three answers rather than a boolean lives on the predicate below.
 *
 * READ-ONLY (#1832 rounds 1 and 2). This module creates nothing: no directory, no
 * mode change, no token, and — unlike the round's own record path — no
 * `.corrupt-*` copy of an unreadable file. It is consulted on the way to a review
 * that may not run, by a decision that owns none of those artefacts. The location
 * comes from `findingsStoreLocation` (review-state-path.ts), which is the SAME
 * computation the creating path runs (#1832 round 2: one function, two arms, so
 * the probe and the round can never name two stores for one clone), and the bytes
 * come from `parseFindingsFile` — the round's own parser, so the two cannot
 * disagree about what a valid row is. The round's own read (`readBranchRowsRaw`)
 * keeps its fail-closed copy-aside exactly as before: that read is the one that
 * records, and the one whose operator needs to be told where the bytes went.
 */

import { execp } from "./exec.ts";
import { isRetirableOpenCriticalRow } from "./review-findings-fate.ts";
import { parseFindingsFile } from "./review-findings-file.ts";
import type { StoredFinding } from "./review-findings-file.ts";
import { FINDINGS_FILE, findingsStoreLocation } from "./review-state-path.ts";
import { trace, traceWarn } from "./trace.ts";

/**
 * #1832 — the three answers the open-CRITICAL probe gives. `unreadable` carries
 * WHY, so the forced-full trace and the `Mode:` line can name the repair: an
 * operator who is told "the findings memory could not be read" without a cause
 * cannot tell a missing file from a corrupt one, and those two have different
 * actions.
 */
export type OpenCriticalProbe =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

/** What the one read of the store answered (see `readBranchRowsForProbe`). */
type StoreRead =
  | { kind: "absent" }
  | { kind: "rows"; rows: StoredFinding[] }
  | { kind: "unreadable"; reason: string };

/** The longest unreadable-reason this module will report: enough to name the
 * fault, short enough that it survives into the `Mode:` line whole. */
const REASON_CHARS = 160;

/** Clip to one line and a bounded length: the reason is rendered into the
 * summary and the trace, and a multi-line or unbounded fault must not become
 * either. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
}

/**
 * The branch's rows from the file at `file`, read WITHOUT the round's
 * fail-closed disclosure.
 *
 * `parseFindingsFile` is the ROUND's parser and is reused here rather than
 * re-spelled (#1832 round 2): the probe and the record path must agree on what a
 * valid row is, or a row the round stores is a row the probe cannot see. It reads
 * the one file and copies nothing aside, which is what a read on a decision path
 * needs.
 *
 * Three answers, and the middle one is the point of the function:
 *
 *   - `absent` — there is nothing at that location to answer from: no file, or a
 *     file whose only rows for this branch are malformed. A store that does not
 *     exist holds no rows, and no rows means no CRITICAL. This is NOT a read
 *     failure: the ordinary state of a branch that has never had a finding is no
 *     file, and a probe that called that `unreadable` would force a full review on
 *     every clean branch — a forced round no operator can ever answer, because
 *     there is nothing to repair. Rows that are ALL malformed take the same
 *     answer, and say so in the trace: the record path does not refuse on that
 *     either (it sets the malformed rows aside and carries on with the valid
 *     ones), so the probe must not be stricter than the path whose memory it
 *     reads.
 *   - `rows` — the file parsed and yielded rows the schema accepts.
 *   - `unreadable` — a file that EXISTS but cannot be read or parsed, with the
 *     cause. `parseFindingsFile`'s own classification is the whole reason; the
 *     errno code is appended for a read fault. Never raw error text and never a
 *     path: this string reaches the summary's `Mode:` line and the PR, and a
 *     findings-store path is not something those surfaces name (#1764).
 */
function readBranchRowsForProbe(file: string, branch: string): StoreRead {
  const parsed = parseFindingsFile(file);
  if (!parsed.ok) {
    // `parseFindingsFile` answers `ok: false` only for a file that is there and
    // will not parse (or has no rows array): a MISSING file is its own `ok: true`
    // with no rows. So an unparseable file is the genuine `unreadable`.
    return { kind: "unreadable", reason: oneLine(parsed.reason) };
  }
  const mine = parsed.rows.filter((r) => r.branch === branch);
  const malformed = parsed.malformed.filter((r) => (r as { branch?: unknown })?.branch === branch);
  if (mine.length === 0) {
    if (malformed.length > 0) {
      // Every row this branch has is malformed: nothing trustworthy to answer
      // from, and no trustworthy row means no CRITICAL — but the operator is told,
      // because a store whose rows all fail the schema is a store being quietly
      // forgotten.
      traceWarn(
        `review-findings: open-CRITICAL probe found only ${malformed.length} malformed row(s) for ${branch} — answered absent`,
      );
    }
    return { kind: "absent" };
  }
  if (malformed.length > 0) {
    // A malformed row is not a row and the probe cannot resolve or carry anything,
    // so it answers from the rows the schema accepts — the same rule the record
    // path's reader applies, and no stricter: refusing on any malformed row would
    // force a full round for a branch whose only CRITICAL is a malformed HIGH
    // beside a genuinely absent set.
    trace(
      `review-findings: open-CRITICAL probe ignored ${malformed.length} malformed row(s) for ${branch}`,
    );
  }
  return { kind: "rows", rows: mine };
}

/**
 * Does this branch hold an OPEN, LINE-BEARING CRITICAL row that a full review
 * could retire? The shape of that row is `isRetirableOpenCriticalRow` — the ONE
 * predicate the fate rule and this probe share, so the veto and the rule that
 * consumes the forced round can never disagree about which rows need one.
 *
 * Three answers, and the difference between the last two is the whole function:
 *
 *   - `present` — at least one row the shared predicate accepts. Accepted and
 *     resolved CRITICAL rows never qualify: an accepted row is suppressed by an
 *     operator decision (and a round is forbidden to report it), and a resolved
 *     row is already retired. A CRITICAL with no `lineHash` has no proof its
 *     cited line changed and can never retire under #1832, so forcing a full
 *     round for it buys nothing.
 *   - `absent` — nothing on the branch to answer from: the store was never
 *     created, holds no rows for this branch, or holds only malformed ones. No
 *     rows, no CRITICAL. A first review is full on its own merits anyway (no delta
 *     base exists for it).
 *   - `unreadable` — a file sits at the computed location and cannot be read or
 *     parsed, and `reason` says which. That is NOT "absent": `readBranchRows`
 *     (review-findings-store.ts) answers fail-open, and a forced-full rule built on
 *     that answer would silently reintroduce the very delta this exists to veto
 *     whenever the file is corrupt. So the caller forces a full review on
 *     `unreadable` too, and says which of the two it is.
 *
 * Fail-soft by design: a probe that threw would fail a review that was about to
 * run anyway. Every fault is answered as `unreadable`, never rethrown.
 */
export async function branchHasOpenCriticalRow(
  cwd: string,
  branch: string,
): Promise<OpenCriticalProbe> {
  let file: string;
  try {
    // ONE location computation for both paths (`review-state-path.ts`): the same
    // override precedence, common-dir lookup, repo-key hashing, token read and
    // corrupt-token fallback the record path uses, with none of its writes. The
    // `exists` it reports is derived from that same computed location, so the
    // absent/unreadable split below can never describe a different file.
    const loc = await findingsStoreLocation(execp, cwd);
    if (!loc) {
      // No ledger resolved and no common dir at all (not a clone): this process
      // cannot name a location to read. Reported, not assumed empty.
      const reason = `no findings store location could be resolved for this clone (${FINDINGS_FILE})`;
      trace(`review-findings: open-CRITICAL probe: ${reason}`);
      return { kind: "unreadable", reason: oneLine(reason) };
    }
    if (!loc.exists) {
      // The store has never been created at the location BOTH arms compute. That
      // is an empty store, not a fault: no rows, so no CRITICAL, so no forced
      // round. #1832 round 2 — before this, a clone that had never had a finding
      // answered `unreadable` whenever its token was unreadable or absent, which
      // forced a full review on clean branches and named a repair for a file that
      // does not exist.
      return { kind: "absent" };
    }
    file = loc.file;
  } catch (err) {
    // Only the errno code is reported, never the error's own text: a location
    // fault is a filesystem fact, and the message of a git or fs failure carries a
    // path.
    const code = readErrno(err);
    const reason = `the findings store location could not be resolved${code ? ` (${code})` : ""}`;
    trace(`review-findings: open-CRITICAL probe: ${reason}`);
    return { kind: "unreadable", reason };
  }
  try {
    const read = readBranchRowsForProbe(file, branch);
    switch (read.kind) {
      case "absent":
        return { kind: "absent" };
      case "unreadable":
        trace(`review-findings: open-CRITICAL probe finds the store unreadable: ${read.reason}`);
        return { kind: "unreadable", reason: read.reason };
      case "rows":
        return { kind: read.rows.some(isRetirableOpenCriticalRow) ? "present" : "absent" };
    }
  } catch (err) {
    const code = readErrno(err);
    const reason = `the findings file could not be read${code ? ` (${code})` : ""}`;
    trace(`review-findings: open-CRITICAL probe finds the store unreadable: ${reason}`);
    return { kind: "unreadable", reason };
  }
}

/** The errno CODE of a filesystem fault, or undefined when it has none. The code
 * alone is safe to put in a disclosure (`ENOENT`, `EACCES`); the error's message
 * is not — Node puts the path in it, and the store's location is exactly what
 * #1764 moved out of reach. */
function readErrno(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && code.length > 0 && code.length <= 24 ? code : undefined;
}

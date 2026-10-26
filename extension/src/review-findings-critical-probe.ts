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
 * READ-ONLY (#1832 round 1). This module creates nothing: no directory, no mode
 * change, no token, and — unlike the round's own record path — no `.corrupt-*`
 * copy of an unreadable file. It is consulted on the way to a review that may not
 * run, by a decision that owns none of those artefacts. The location comes from
 * `findingsStoreLocationReadOnly` (review-state-path.ts), which resolves the same
 * path `findingsStateDir` would without touching the disk, and the bytes come
 * from `readFindingsRowsReadOnly` below, which parses without disclosing. The
 * round's own read (`readBranchRowsRaw`) keeps its fail-closed copy-aside exactly
 * as before: that read is the one that records, and the one whose operator needs
 * to be told where the bytes went.
 */

import { existsSync, readFileSync } from "node:fs";
import { execp } from "./exec.ts";
import { isRetirableOpenCriticalRow } from "./review-findings-fate.ts";
import { splitRows } from "./review-findings-file.ts";
import type { StoredFinding } from "./review-findings-file.ts";
import { FINDINGS_FILE, findingsStateDir } from "./review-state-path.ts";
import { trace } from "./trace.ts";

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

/**
 * The branch's rows, read WITHOUT the round's fail-closed disclosure.
 *
 * `readBranchRowsRaw` is the record path's reader and behaves correctly there:
 * an unreadable file it can quote is copied to `.corrupt-<hash>` and named in a
 * throw, so an operator can recover the rows. This read has no such duty — it
 * answers one question and is not about to overwrite anything — so copying bytes
 * aside here would leave an artefact behind on a decision path that runs even
 * when no review does. Same parse, same row validation (`splitRows`, so a
 * malformed row is never returned as a row), none of the writing.
 *
 * Throws with a cause-only message; the caller turns any throw into `unreadable`.
 */
function readFindingsRowsReadOnly(file: string, branch: string): StoredFinding[] | undefined {
  // A MISSING file is the genuine empty store, not a read failure. The creating
  // resolver's answer and this one are the same path, so "the directory exists
  // but no file has ever been written in it" is the ordinary state of a branch
  // that has never had a finding — and a probe that called that `unreadable`
  // would force a full review on every clean branch, and could never be answered
  // by an operator because there is nothing to repair.
  if (!existsSync(file)) return undefined;
  let bytes: string;
  try {
    bytes = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`the findings file could not be read (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (err) {
    throw new Error(`the findings file is not valid JSON (${(err as Error).message})`);
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    throw new Error("the findings file has no rows array");
  }
  const mine = rows.filter((r) => (r as { branch?: unknown })?.branch === branch);
  const split = splitRows(mine);
  if (split.malformed.length > 0 && split.rows.length === 0) {
    // Every row this branch has is malformed: there is nothing trustworthy to
    // answer from, so the safe mode is a full review and the operator is told why.
    throw new Error("the findings file holds only malformed rows");
  }
  if (split.malformed.length > 0) {
    // A malformed row is not a row and the probe cannot resolve or carry anything,
    // so it answers from the rows the schema accepts — the same rule the record
    // path's reader applies (`splitRows`), and no stricter: refusing on any
    // malformed row would force a full round for a branch whose only CRITICAL is
    // a malformed HIGH beside a genuinely absent set.
    trace(
      `review-findings: open-CRITICAL probe ignored ${split.malformed.length} malformed row(s) for ${branch}`,
    );
  }
  return split.rows;
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
 *   - `absent` — the store was read and no such row exists. A MISSING file is
 *     `absent`: there is genuinely nothing on the branch, and a first review is
 *     full on its own merits (no delta base exists for it anyway).
 *   - `unreadable` — the store could not be located, read, or parsed, and `reason`
 *     says which. That is NOT "absent": `readBranchRows` (review-findings-store.ts)
 *     answers fail-open, and a forced-full rule built on that answer would
 *     silently reintroduce the very delta this exists to veto whenever the file is
 *     corrupt. So the caller forces a full review on `unreadable` too, and says
 *     which of the two it is.
 *
 * Fail-soft by design: a probe that threw would fail a review that was about to
 * run anyway. Every fault is answered as `unreadable`, never rethrown.
 */
export async function branchHasOpenCriticalRow(
  cwd: string,
  branch: string,
): Promise<OpenCriticalProbe> {
  let file: string | undefined;
  try {
    // ONE resolver for both paths: `findingsStateDir` with `readOnly`, so the
    // probe and the record path share the override, the common-dir lookup, the
    // repo-key hashing and the token read, and cannot name two stores for one
    // clone. The flag is what keeps this read from creating anything.
    file = (await findingsStateDir(execp, cwd, { readOnly: true }))?.file;
  } catch (err) {
    const reason = `the store's location could not be resolved (${(err as Error).message})`;
    trace(`review-findings: open-CRITICAL probe: ${reason}`);
    return { kind: "unreadable", reason };
  }
  if (!file) {
    // No git common dir at all, or no minted token to name the state dir: this
    // process cannot tell what the branch holds. Reported, not assumed empty.
    const reason = `no findings store could be located for this clone (${FINDINGS_FILE} is not reachable by a read-only lookup)`;
    trace(`review-findings: open-CRITICAL probe: ${reason}`);
    return { kind: "unreadable", reason };
  }
  try {
    const rows = readFindingsRowsReadOnly(file, branch);
    if (rows === undefined) return { kind: "absent" };
    return { kind: rows.some(isRetirableOpenCriticalRow) ? "present" : "absent" };
  } catch (err) {
    const reason = (err as Error).message.replace(/\s+/g, " ").slice(0, 160);
    trace(`review-findings: open-CRITICAL probe finds the store unreadable: ${reason}`);
    return { kind: "unreadable", reason };
  }
}

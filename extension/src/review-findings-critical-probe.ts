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
 */

import { execp } from "./exec.ts";
import type { StoredFinding } from "./review-findings-file.ts";
import { readBranchRowsRaw } from "./review-findings-read.ts";
import { findingsStateDir } from "./review-state-path.ts";
import { trace } from "./trace.ts";

/** #1832 — the three answers the open-CRITICAL probe gives. */
export type OpenCriticalProbe = { kind: "present" } | { kind: "absent" } | { kind: "unreadable" };

/**
 * Does this branch hold an OPEN, LINE-BEARING CRITICAL row?
 *
 * Three answers, and the difference between the last two is the whole function:
 *
 *   - `present` — at least one row with `status === "open"`, `severity ===
 *     "CRITICAL"`, a `line` and a `lineHash`. Accepted and resolved CRITICAL
 *     rows never qualify: an accepted row is suppressed by an operator decision
 *     (and a round is forbidden to report it), and a resolved row is already
 *     retired. A CRITICAL with no `lineHash` has no proof its cited line
 *     changed and can never retire under #1832, so forcing a full round for it
 *     buys nothing.
 *   - `absent` — the store was read and no such row exists.
 *   - `unreadable` — the store could not be located or read. That is NOT
 *     "absent": `readBranchRows` (review-findings-store.ts) answers fail-open,
 *     and a forced-full rule built on that answer would silently reintroduce
 *     the very delta this exists to veto whenever the file is corrupt. So the
 *     caller forces a full review on `unreadable` too, and says which of the
 *     two it is.
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
    file = (await findingsStateDir(execp, cwd))?.file;
  } catch (err) {
    trace(
      `review-findings: open-CRITICAL probe cannot locate the store: ${(err as Error).message.slice(0, 120)}`,
    );
    return { kind: "unreadable" };
  }
  if (!file) {
    trace("review-findings: open-CRITICAL probe found no state dir for the clone — unreadable");
    return { kind: "unreadable" };
  }
  let rows: StoredFinding[] | undefined;
  try {
    rows = readBranchRowsRaw(file, branch)?.rows;
  } catch (err) {
    trace(
      `review-findings: open-CRITICAL probe finds the store unreadable: ${(err as Error).message.slice(0, 120)}`,
    );
    return { kind: "unreadable" };
  }
  if (rows === undefined) return { kind: "unreadable" };
  const present = rows.some(
    (r) =>
      r.status === "open" &&
      r.severity === "CRITICAL" &&
      r.line !== undefined &&
      r.lineHash !== undefined,
  );
  return { kind: present ? "present" : "absent" };
}

/**
 * lens-review-advisory — a finding blocks only on lines this PR changed
 * (#1140 file level, #1125 decision 1 line level).
 *
 * Findings memory (review-findings-store.ts) carries an open row into every
 * later round while its file and cited line exist. A row stored outside what
 * the PR touches (#1133: a phantom two-dot diff) therefore blocked forever,
 * and a carried CRITICAL set `hasCritical`, so only an operator editing the
 * store could unblock the PR. Production review tools block only on code the
 * change touched; this module applies that rule to every reported finding —
 * fresh or carried — at LINE level:
 *
 *   - a finding that cites a line is BLOCKING only when that line falls in
 *     `git diff <base>...<head>`'s changed ranges on the new side (head: the
 *     review's resolved head SHA; base: the review's explicit `base`, else the
 *     mainline). A finding elsewhere is ADVISORY — out of the verdict, out of
 *     `hasCritical`, listed under "Advisory (outside this PR's diff)";
 *   - a finding with no line (a file-level finding) blocks when its path is in
 *     that diff, exactly as #1140 had it;
 *   - a finding with no path at all blocks — there is nothing to place in the
 *     diff, so nothing can make it advisory;
 *   - when the changed ranges cannot be read, EVERY finding blocks (today's
 *     behaviour) and the returned note says so. The advisory tier is a
 *     discount, and a discount is never granted on evidence that could not be
 *     read.
 *
 * Because the same list feeds the verdict, `bySeverity`, the summary and the
 * ledger's `hasCritical` (lens-round-cap.ts, merge-guard-round-cap.ts read it
 * from the latest lens entry), an out-of-diff CRITICAL can no longer hold the
 * round budget or the merge (#1143's invariant, kept at line level).
 *
 * The store rows are not modified: an advisory finding stays `open` there and
 * becomes blocking again the moment its cited line is inside the diff.
 */

import { neutraliseEvidence } from "./comment-evidence.ts";
import { changedRanges } from "./lens-review-changed-ranges.ts";
import type { Finding } from "./lens-review-types.ts";

export const ADVISORY_HEADING = "Advisory (outside this PR's diff)";

const norm = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * True when `line` falls in one of `spans`. A one-sided hunk (`+21,0` — a
 * pure deletion) lands on the line it deletes INTO, so the span collapses to
 * that single line rather than vanishing: a finding citing the neighbourhood
 * of a deletion still counts as changed code.
 */
function inRanges(spans: ReadonlyArray<readonly [number, number]>, line: number): boolean {
  return spans.some(([lo, hi]) => line >= lo && line <= (hi < lo ? lo : hi));
}

/**
 * Blocking when the cited code is in the PR's changed lines; advisory when it
 * demonstrably is not. A missing path or line can never be shown to be out of
 * range, so it blocks.
 */
function isAdvisory(
  f: Finding,
  ranges: Map<string, Array<[number, number]>>,
  fileChanged: (path: string) => boolean,
): boolean {
  if (typeof f.line === "number") return !inRanges(ranges.get(norm(f.path)) ?? [], f.line);
  return !fileChanged(f.path);
}

export interface AdvisorySplit {
  /** The findings that block: verdict, counts, summary and `hasCritical`. */
  blocking: Finding[];
  /** Summary fields: `advisory` rows, and a `memoryNote` when the changed-line
   * ranges were unreadable (every finding then blocks). Empty when nothing is
   * advisory, so it never overwrites a findings-memory note. */
  fields: { advisory?: Finding[]; memoryNote?: string };
}

/** The disclosure the summary and the residual comment carry when the ranges
 * could not be read: the discount is withheld and the reason is named. */
function unreadableNote(reason: string): string {
  return `findings all treated as blocking: the PR's changed lines could not be read (${reason})`;
}

/**
 * Split the round's reported findings (fresh lens findings and carried store
 * rows alike) into blocking (inside the PR's changed lines) and advisory.
 *
 * `rangeReadable` says whether this run has a range to speak of at all — its
 * head resolved to a commit, so `base...head` means something. When it is
 * false, NO finding is discounted and no note is emitted: the discount is
 * earned by a range that was actually read, never assumed (#1143's invariant is
 * "out of range", never "range unknown"). When it is true and the read still
 * fails, every finding blocks AND the note says why, so a fail-closed round is
 * visible rather than merely conservative.
 */
export async function splitAdvisory(
  reported: readonly Finding[],
  cwd: string | undefined,
  base: string | undefined,
  head: string | undefined,
  rangeReadable = true,
): Promise<AdvisorySplit> {
  if (reported.length === 0) return { blocking: [...reported], fields: {} };
  if (!rangeReadable) return { blocking: [...reported], fields: {} };
  // A throw is contained like a failed git read: every finding blocks.
  const list = await changedRanges(cwd ?? process.cwd(), base, head).catch((err: unknown) => ({
    ok: false as const,
    reason: `changed-line check failed: ${(err as Error)?.message ?? String(err)}`,
  }));
  if (!list.ok) {
    return {
      blocking: [...reported],
      fields: { memoryNote: unreadableNote(list.reason) },
    };
  }
  const changed = (path: string | undefined): boolean =>
    path !== undefined && list.ranges.has(norm(path));
  const blocking: Finding[] = [];
  const advisory: Finding[] = [];
  for (const f of reported) {
    (f.path && isAdvisory(f, list.ranges, changed) ? advisory : blocking).push(f);
  }
  return { blocking, fields: advisory.length > 0 ? { advisory } : {} };
}

/** The summary/disclosure section listing advisory rows (empty when none). */
export function advisorySection(advisory: readonly Finding[] | undefined): string[] {
  if (!advisory || advisory.length === 0) return [];
  return [
    "",
    `${ADVISORY_HEADING} (${advisory.length}) — outside the lines this PR changed; they do not block:`,
    ...advisory.map((f) =>
      neutraliseEvidence(
        `- advisory: [${f.severity}] ${f.path}:${f.line ?? "?"} — ${f.title} (${f.lens})`,
      ),
    ),
  ];
}

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
 *   - a finding that cites a line is BLOCKING only when that line falls in the
 *     changed ranges on the new side of the range the round belongs to. The
 *     ranges come from ONE of two sources, chosen by who produced the diff:
 *     - a review that COMPUTED its own diff — a ref range the review resolved
 *       itself (`resolveReviewDiff`, never a caller `diff` string) — judges
 *       `changedLineRanges` of that diff, the same value the lenses were handed,
 *       so the split and the review cannot disagree about what was reviewed;
 *     - everything else — a caller-pasted diff string, or a delta round, whose
 *       diff covers only `since..head` — judges the WHOLE PR range,
 *       `git diff <base>...<head>`, read through the hardened git read. A diff
 *       somebody pasted is not evidence of what the PR changed: it omits, truncates
 *       and contradicts, and the row that decided the verdict must not be judged
 *       against it. A carried finding the branch introduced keeps blocking just
 *       because this round's delta did not touch its line; decision 5 scopes what
 *       a delta may RESOLVE (review-findings-store.ts), never what blocks. So a
 *       pasted diff omits the lines of one, the split reads the range and the
 *       finding still blocks.
 *     The base is the review's explicit `base`, or the base its diff was
 *     computed against, else the mainline. A finding outside the range is
 *     ADVISORY — out of the verdict, out of `hasCritical`, listed under
 *     "Advisory (outside this PR's changed lines)".
 *     Ranges are read from a rename-splitting diff on BOTH paths (`--no-renames`,
 *     `lens-review-changed-ranges.ts`), so a pure rename contributes no changed
 *     lines on the new side and a finding on a renamed file's unchanged content
 *     is advisory: the range is about lines, not paths. A reviewer who wants one
 *     cites the content line it moved to, which the range then contains.
 *   - a finding with no line (a file-level finding) blocks when its path is in
 *     that diff, exactly as #1140 had it; a `line` that is not a positive
 *     integer is malformed and is treated as line-less, so it blocks when its
 *     file changed rather than silently matching no range;
 *   - a finding with no path at all blocks — there is nothing to place in the
 *     diff, so nothing can make it advisory;
 *   - when the changed ranges cannot be read, EVERY finding blocks (today's
 *     behaviour) and the returned note says so. The advisory tier is a
 *     discount, and a discount is never granted on evidence that could not be
 *     read.
 *
 * Because the same list feeds the verdict, `bySeverity`, the summary and the
 * ledger's `hasCritical` (lens-round-cap.ts, merge-guard-round-cap.ts read it
 * from the latest lens entry), an out-of-range CRITICAL can no longer hold the
 * round budget or the merge (#1143's invariant, kept at line level).
 *
 * The store rows are not modified: an advisory finding stays `open` there and
 * becomes blocking again the moment its cited line is inside the diff.
 */

import { neutraliseEvidence } from "./comment-evidence.ts";
import { changedRanges, rangeLabel, rangesFromDiff } from "./lens-review-changed-ranges.ts";
import type { Finding } from "./lens-review-types.ts";

export const ADVISORY_HEADING = "Advisory (outside this PR's changed lines)";

const norm = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * True when `line` falls in one of `spans`. A one-sided hunk (`+21,0` — a
 * pure deletion) lands on the line it deletes INTO, so the span collapses to
 * that single line rather than vanishing: a finding citing the neighbourhood
 * of a deletion still counts as changed code.
 */
function inRanges(spans: ReadonlyArray<readonly [number, number]>, line: number): boolean {
  return spans.some(([lo, hi]) => line >= lo && line <= hi);
}

/** A cited line usable for placement. `line` arrives from a lens payload or a
 * store row, so a non-positive or non-integer one is possible: it is malformed
 * rather than out of range, and treating it as line-less asks the file rule
 * (which blocks when the file changed) instead of the range rule (which would
 * match no span and discount it). */
const usableLine = (f: Finding): number | undefined =>
  typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 ? f.line : undefined;

/**
 * Blocking when the cited code is in the PR's changed lines; advisory when it
 * demonstrably is not. A missing path or line can never be shown to be out of
 * range, so it blocks.
 */
function isAdvisory(f: Finding, ranges: Map<string, Array<[number, number]>>): boolean {
  const line = usableLine(f);
  if (line !== undefined) return !inRanges(ranges.get(norm(f.path)) ?? [], line);
  // A line-less (file-level) finding blocks when its FILE contributes changed
  // lines — the #1140 rule, expressed over the same per-file map.
  return !ranges.has(norm(f.path));
}

/** What a round's split yields: the list the verdict reads, plus the summary
 * fields. File-local — the only consumer is `resolveReportedFindings`, which
 * names the shape through the function's return type. */
interface AdvisorySplit {
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

/** The arguments of `splitAdvisory`. File-local for the same reason as
 * `AdvisorySplit`: one caller, and an exported options bag invites a second
 * caller that guesses at the meaning of `diffComputed`. */
interface AdvisorySplitOptions {
  /** Every finding the round reported: the round's own plus the carried rows. */
  reported: readonly Finding[];
  /** Where a fallback range read runs. */
  cwd?: string;
  /** The range's base, when the review knows one. */
  base?: string;
  /** The review's resolved head SHA. */
  head?: string;
  /** The diff the review ran (`resolveReviewDiff`'s output). Judged as the source
   * of the changed lines ONLY when `diffComputed` says the review produced it
   * itself: a caller-pasted string, and a delta's `since..head` diff, are both
   * judged against the `base...head` read instead (see the module header). */
  diff?: string;
  /** True when `diff` is the value the review COMPUTED from refs it resolved
   * itself (`resolveReviewDiff`'s `diffSource === "computed"`) rather than a
   * string a caller pasted, or the delta's own `since..head`. The only shape the
   * split trusts as the reviewed range. */
  diffComputed?: boolean;
  /** Injected for tests; defaults to the git read in lens-review-changed-ranges.ts. */
  rangeRead?: (
    cwd: string,
    base: string | undefined,
    head: string | undefined,
  ) => Promise<RangeList>;
}

/** A range read: the changed lines, or the reason they could not be had. */
export type RangeList =
  | { ok: true; ranges: Map<string, Array<[number, number]>> }
  | { ok: false; reason: string };

/**
 * Split the round's reported findings (fresh lens findings and carried store
 * rows alike) into blocking (inside the PR's changed lines) and advisory.
 *
 * `head` says whether this run has a range to speak of at all — its head
 * resolved to a commit, so the range means something. When it is absent, NO
 * finding is discounted and no note is emitted: the discount is earned by a
 * range that was actually read, never assumed (#1143's invariant is "out of
 * range", never "range unknown"). When it is present and the read still fails,
 * every finding blocks AND the note says why, so a fail-closed round is visible
 * rather than merely conservative.
 */
export async function splitAdvisory({
  reported,
  cwd,
  base,
  head,
  diff,
  diffComputed = false,
  rangeRead = changedRanges,
}: AdvisorySplitOptions): Promise<AdvisorySplit> {
  if (reported.length === 0) return { blocking: [...reported], fields: {} };
  if (!head) return { blocking: [...reported], fields: {} };
  const dir = cwd ?? process.cwd();
  const label = rangeLabel(dir, base, head);
  // Only a diff the review COMPUTED from refs it resolved is the reviewed range:
  // the value the lenses were handed, so split and review cannot disagree. A
  // pasted string and a delta's `since..head` are both judged against the PR's
  // whole `base...head` instead (decision 5 scopes RESOLUTION, not blocking).
  // The git read is also the fallback when a trusted diff yields no ranges — a
  // string that parses to nothing is not evidence that nothing changed.
  // A throw is contained like a failed read: every finding blocks.
  const fromDiff = diff && diffComputed ? rangesFromDiff(diff, label) : undefined;
  const list = fromDiff?.ok
    ? fromDiff
    : await rangeRead(dir, base, head).catch((err: unknown) => ({
        ok: false as const,
        reason: `changed-line check failed: ${(err as Error)?.message ?? String(err)}`,
      }));
  if (!list.ok) {
    return {
      blocking: [...reported],
      fields: { memoryNote: unreadableNote(`${list.reason} — for ${label}`) },
    };
  }
  const blocking: Finding[] = [];
  const advisory: Finding[] = [];
  for (const f of reported) {
    (f.path && isAdvisory(f, list.ranges) ? advisory : blocking).push(f);
  }
  return { blocking, fields: advisory.length > 0 ? { advisory } : {} };
}

/** The disclosure section listing advisory rows (empty when none). */
export function advisorySection(advisory: readonly Finding[] | undefined): string[] {
  if (!advisory || advisory.length === 0) return [];
  const line = (f: Finding) =>
    neutraliseEvidence(
      `- advisory: [${f.severity}] ${f.path}:${f.line ?? "?"} — ${f.title} (${f.lens})`,
    );
  const fresh = advisory.filter((f) => !f.carried);
  const carried = advisory.filter((f) => f.carried);
  return [
    "",
    `${ADVISORY_HEADING} (${advisory.length}) — outside the lines this PR changed; they do not block:`,
    ...fresh.map(line),
    ...(carried.length > 0
      ? [
          `Carried from earlier rounds (${carried.length}) — still open, outside the changed lines:`,
          ...carried.map(line),
        ]
      : []),
  ];
}

/**
 * adversarial-diff-cap — the bound on the diff text the adversarial prompts inline.
 *
 * Measured: an `adversarial_loop` over a large branch inlined a ~650,000-character
 * diff verbatim in the reviewer prompt AND again in the fix-developer prompt.
 * The child's context filled (~258K tokens), it stopped after one output token
 * with `stopReason: "length"`, wrote no `VERDICT:` line, and every retry failed
 * the same way — an infrastructure failure the loop could not get past. The
 * reviewer never reviewed; the cycle parked.
 *
 * lens-review bounds its equivalent (`FULL_CONTEXT_CAP` in
 * `lens-review-diff.ts`), but that cap slices a head out of one block and says
 * nothing about what was cut. Here the diff is the review's SUBJECT, so cutting
 * it silently would be worse than cutting it noisily. The bound returns a
 * structured value — `{ diff, note }` — and the prompt builders put ONLY `diff`
 * inside their fenced diff block:
 *
 *   - `diff` is the full diff at/under the cap, else its head cut on a line
 *     boundary (so a quoted diff can never break the fence it sits in);
 *   - `note` is the per-file inventory plus the truncation notice, and BOTH
 *     builders print it as plain prose AFTER the closing fence, where a reviewed
 *     diff that quotes the notice's own sentences cannot impersonate it.
 *
 * The inventory names every file carrying a git file header — parsed from the
 * text itself, so no extra git call is needed — and states what it actually
 * shows: how many of those files have their body shown in full in the inlined
 * head, how many are cut mid-file, and how many are not shown at all. It never
 * claims to be complete: rows are capped at {@link MAX_INVENTORY_ROWS} (the
 * fullest rows are kept, the rest counted on one overflow line), and lines the
 * diff attributes to no file (the /work merged diff's workstream headers and its
 * truncation marker) are counted wherever they appear and reported, so the
 * inventory never promises more than it can compute.
 *
 * At or under the cap there is no note and the diff is returned UNCHANGED,
 * byte-for-byte, so a normal-sized review produces exactly the prompt this
 * module shipped without.
 *
 * Escape hatch: PI_ENSEMBLE_ADVERSARIAL_DIFF_CAP=0 (or `false`) restores the
 * pre-#1816 shape — the whole diff verbatim, no inventory, no notice.
 */

/**
 * Characters of diff text the adversarial prompts may inline. Comfortably under
 * the ~258K-token context the measured child ran out of, and above any diff a
 * reviewed workstream has realistically carried (the /work path already caps
 * its own fetch at 1 MiB, so this bound is what actually bites).
 */
export const MAX_INLINE_DIFF_CHARS = 120_000;

/**
 * How many rows the per-file inventory may print. A 10k-file branch would put a
 * 10k-line table in front of the reviewer — the same context problem the bound
 * exists to fix, arrived at from the summary side instead of the diff side. The
 * fullest rows are kept and the rest counted on one line.
 */
export const MAX_INVENTORY_ROWS = 300;

/** One changed file, read off the git file headers of the diff text. */
export interface DiffFileSummary {
  path: string;
  added: number;
  removed: number;
  /** True when this file's body appears in the inlined head COMPLETELY: its
   * section ends before the cut, so nothing about it is missing from the prompt.
   * `false` means the head stops inside this section, or never reaches it. */
  shown: boolean;
}

/** What the bound hands the prompt builders: fenced text, and prose. */
export interface BoundedDiff {
  /** What goes INSIDE the fenced diff block: the full diff, or its head. */
  diff: string;
  /** What goes AFTER the closing fence as plain prose: the inventory and the
   * truncation notice. Absent when nothing was cut. */
  note?: string;
}

/** The ref range a caller actually diffed, as two halves. */
export interface DiffRange {
  base: string;
  head: string;
}

const GIT_HEADER = "diff --git ";

/**
 * A ref is untrusted text. A control character, a line separator or a backtick
 * inside one would close the prompt's fenced diff block early and print its own
 * `VERDICT:` line outside the fence, where the loop's marker reader would find
 * it — so a ref carrying any of them mints no command at all.
 */
const UNSAFE_REF = /[\p{Cc}\u2028\u2029`]/u;

/**
 * `PI_ENSEMBLE_ADVERSARIAL_DIFF_CAP=0` (or `false`) restores the pre-#1816
 * shape: both prompts inline the whole diff verbatim, no inventory and no
 * notice. Any other value, and an unset variable, keep the bound.
 */
function diffCapDisabled(): boolean {
  const raw = process.env.PI_ENSEMBLE_ADVERSARIAL_DIFF_CAP;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false";
}

/**
 * The path a `diff --git a/x b/y` header names. A quoted header (spaces or
 * unusual bytes in a name) is taken verbatim rather than guessed at — the
 * summary only has to NAME the file, and a wrong guess misnames it.
 */
function headerPath(line: string): string | null {
  const rest = line.slice(GIT_HEADER.length);
  if (!rest) return null;
  if (rest.startsWith('"')) return rest;
  const b = rest.indexOf(" b/");
  if (b < 0) return null;
  const candidate = rest.slice(b + 3);
  return candidate.length ? candidate : null;
}

/** A line belongs to no file when it is non-empty and either outside every
 * section (before the first header, or after the merged-diff truncation marker)
 * or one of the `/work` merged-diff markers, which sit between sections and mean
 * something the reviewer must not read as file content: a `## workstream: …`
 * header, or the bracketed truncation marker. */
const UNATTRIBUTED_MARKER_LINE = /^(## |\[)/;

function isUnattributedLine(
  line: string,
  current: DiffFileSummary | null,
  truncated: boolean,
): boolean {
  if (line.trim() === "") return false;
  if (UNATTRIBUTED_MARKER_LINE.test(line)) return true;
  return current === null || truncated;
}

/**
 * Per-file added/removed counts parsed from the diff text, in ONE pass over the
 * text (the unattributed-line count and the shown/cut marks are derived from the
 * same walk — a second `split` would double the work on a 650 KB diff).
 *
 * Body lines are only counted inside a file section (never against a header), so
 * a `+++`/`---` marker line cannot count as content; a hunk header starting with
 * `+` or `-` after its column is rare and miscounts one line, which is not
 * load-bearing.
 *
 * `headChars` is the length of the head the prompt will inline: a section that
 * ends at or before it is `shown`, so the inventory can say which bodies the
 * reviewer actually has and which it does not.
 */
export function summarizeDiffFiles(
  diff: string,
  headChars = diff.length,
): { files: DiffFileSummary[]; unattributed: number } {
  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | null = null;
  let unattributed = 0;
  /** Set once the /work 1 MiB truncation marker appears: nothing after it is a file. */
  let truncated = false;
  /** Offset into `diff` of the line the loop is reading, kept for the shown pass. */
  let lineStart = 0;
  /** Start offsets of every file section, in order — the `shown` pass needs them. */
  const sectionStarts: number[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith(GIT_HEADER)) {
      const path = headerPath(line);
      if (path) {
        current = { path, added: 0, removed: 0, shown: false };
        files.push(current);
        sectionStarts.push(lineStart);
      }
    } else if (current !== null && !truncated) {
      if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
    }
    if (isUnattributedLine(line, current, truncated)) unattributed += 1;
    if (line.startsWith("[... merged diff truncated")) truncated = true;
    lineStart += line.length + 1;
  }

  // A section is shown when it ENDS before the cut, i.e. when the next section
  // starts at or before it; the last section ends at the end of the diff.
  for (let i = 0; i < files.length; i++) {
    const end = i + 1 < files.length ? (sectionStarts[i + 1] ?? diff.length) : diff.length;
    const file = files[i];
    if (file) file.shown = end <= headChars;
  }
  return { files, unattributed };
}

/** The lead line of the per-file inventory, worded for what the diff actually shows. */
function inventoryLead(files: DiffFileSummary[], unattributed: number): string {
  if (files.length === 0) {
    return "No `diff --git` file headers were found in this diff, so a per-file inventory could not be built — judge the body below and say what you could not see:";
  }
  const shown = files.reduce((n, f) => n + (f.shown ? 1 : 0), 0);
  const attribution =
    unattributed > 0 ? ` ${unattributed} line(s) could not be attributed to a file.` : "";
  return `EVERY file this diff changes (${files.length}), with added/removed line counts — bodies shown in full for ${shown}, cut mid-file or not shown for ${files.length - shown}.${attribution}`;
}

function rowsText(files: DiffFileSummary[]): string {
  const width = files.reduce((w, f) => Math.max(w, f.path.length), 0);
  return files.map((f) => `  ${f.path.padEnd(width)}  +${f.added} -${f.removed}`).join("\n");
}

/** The per-file inventory the reviewer sees as prose after the fenced diff. */
function inventoryText(files: DiffFileSummary[], unattributed: number): string {
  const lead = `${inventoryLead(files, unattributed)}\n`;
  if (files.length === 0) return `${lead}\n`;
  if (files.length <= MAX_INVENTORY_ROWS) return `${lead}${rowsText(files)}\n\n`;
  // The fullest rows are the ones worth the reviewer's attention; the rest are
  // still counted on the overflow line rather than silently dropped.
  const kept = [...files]
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, MAX_INVENTORY_ROWS);
  const overflow = `\nand ${files.length - kept.length} more file(s) not listed.\n\n`;
  return `${lead}${rowsText(kept)}${overflow}`;
}

/**
 * The command reproducing a ref-range diff, or nothing when it may not be
 * printed. The only place the string is assembled — one representation of "no
 * command", so a caller never has to build one somewhere else and second-guess
 * whether it was refused.
 */
function rereadCommand(range?: DiffRange): string | undefined {
  if (!range) return undefined;
  const { base, head } = range;
  if (!base.trim() || !head.trim()) return undefined;
  if (UNSAFE_REF.test(base) || UNSAFE_REF.test(head)) return undefined;
  return `git diff ${base}...${head}`;
}

/** Cut at the cap, landing on a line boundary so the diff block never breaks mid-line. */
function cutAtLineBoundary(text: string, cap: number): string {
  const slice = text.slice(0, cap);
  const nl = slice.lastIndexOf("\n");
  return nl > 0 ? slice.slice(0, nl) : slice;
}

/**
 * Bound the diff text a prompt may inline.
 *
 * At or under {@link MAX_INLINE_DIFF_CHARS} the diff is returned as `diff` with
 * NO `note`, so the prompt is byte-identical to the pre-bound one. Over it,
 * `diff` is the head cut at a line boundary and `note` carries the inventory,
 * the character counts and — when the caller knows the range it diffed — the
 * command to read the rest. The note is prose, never fenced diff: see the module
 * header.
 *
 * `range` is the ref range the CALLER itself diffed. The command is minted here
 * from the two refs, and refused when a ref carries bytes that would escape the
 * fence — which is why callers pass refs rather than a pre-built command string.
 */
export function boundDiffForPrompt(diff: string, range?: DiffRange): BoundedDiff {
  if (diffCapDisabled() || diff.length <= MAX_INLINE_DIFF_CHARS) return { diff };
  const head = cutAtLineBoundary(diff, MAX_INLINE_DIFF_CHARS);
  const { files, unattributed } = summarizeDiffFiles(diff, head.length);
  const command = rereadCommand(range);
  const howToReadRest = command
    ? `To read what is not inlined here, run \`${command}\` in your working directory — read the individual files this change touches rather than the whole range.`
    : "No ref range was supplied with this diff, so the remaining content is not available to you; judge what is shown and say what you could not see rather than guessing at it.";
  const note = `${inventoryText(files, unattributed)}… (diff truncated: inlined ${head.length} of ${diff.length} characters — the body above is a PREFIX of the change, not all of it)\n${howToReadRest}`;
  return { diff: head, note };
}

/**
 * The range one round may name in its truncation notice, or nothing.
 *
 * Lives with the bound rather than in the loop so the loop keeps its own shape
 * and there is ONE representation of "no command": the caller says whether this
 * round actually read the range, and `boundDiffForPrompt` decides whether the
 * refs are safe to print. A round whose diff re-read FAILED passes `false` — the
 * loop keeps the previous diff, so no range produced the text under review and
 * the notice must not name one.
 */
export function rereadRangeForRound(
  range: DiffRange | null | undefined,
  head: string | undefined,
  roundReadRange: boolean,
): DiffRange | undefined {
  if (!range || !roundReadRange) return undefined;
  return { base: range.base, head: head ?? range.head };
}

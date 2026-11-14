/**
 * lens-diff-bound — how the diff a LENS prompt carries is bounded (#2261).
 *
 * `adversarial-diff-cap.ts` bounds the diff the adversarial prompts inline. The
 * lens prompt had no equivalent: `lensPromptFor` interpolated whatever diff it
 * was handed verbatim, and the delta arm appended a ~100 KB full-branch block on
 * top. A ~795 KB delta therefore became six ~911 KB prompts, every lens died at
 * the provider with HTTP 400 "maximum context length" in about 0.6 s, and the
 * only reason the operator read was `exit 1` / `REVIEW_INCOMPLETE`.
 *
 * This module is the lens side of the same helper, split from the adversarial
 * cap because the two prompts need different guarantees. The adversarial bound
 * cuts a head at a character cap; the lens bound admits WHOLE FILES while they
 * fit and moves the rest out of the fenced block, because a lens that is told a
 * file exists and cannot read it files a finding about a file it never saw. So:
 *
 *   - `diff` is the diff built from the file sections that fit, in order — never
 *     a section cut in half;
 *   - `note` is prose printed AFTER the closing fence (never inside it, so a
 *     reviewed diff that quotes the notice cannot impersonate it): the per-file
 *     inventory, the character counts, the paths whose bodies were omitted, and
 *     the command that reads them (`git diff <base>...<head> -- <file>`, which a
 *     lens can run with its read-only tools);
 *   - `context` is the caller's context with the delta's full-branch block
 *     INSIDE the same budget rather than added on top of it. That block is diff
 *     text wearing a context label, and it is the half that a plain per-field cap
 *     misses: the field stays inside its own limit while the prompt does not.
 *
 * At or under the budget the diff is returned UNCHANGED with no note, so a
 * normal-sized review produces exactly the prompt this module shipped without —
 * the property `PI_ENSEMBLE_LENS_LARGE_DIFF=0` restores at any size.
 */

import {
  type DiffFileSummary,
  type DiffRange,
  GIT_HEADER,
  MAX_INLINE_DIFF_CHARS,
  MAX_INVENTORY_ROWS,
  cutAtLineBoundary,
  headerPath,
  inventoryLead,
  inventoryText,
  rereadCommand,
  rowsText,
  summarizeDiffFiles,
} from "./adversarial-diff-cap.ts";
import { lensLargeDiffEnabled } from "./lens-large-diff-switch.ts";

/** The budget a lens prompt has for the diff it inlines. */
export const LENS_DIFF_BUDGET_FLOOR = 20_000;

/**
 * How much of the bound the diff may use, given the text that shares the prompt
 * beside it (the caller's context, the evidence and the prior-findings blocks).
 *
 * Floored rather than allowed to reach zero: a prompt whose context happens to
 * be large still has to show the reviewer *something*, and an empty diff block
 * with no inventory is how a lens ends up approving a change it never saw.
 */
export function lensDiffBudget(alreadyInlined: number): number {
  const remaining = MAX_INLINE_DIFF_CHARS - Math.max(0, alreadyInlined);
  return Math.max(LENS_DIFF_BUDGET_FLOOR, remaining);
}

/**
 * The decision `lensPromptFor` makes about its diff, and the two strings it
 * prints as a result.
 *
 * `whole` is the pre-#2261 shape (at or under the budget, or with the operator's
 * escape hatch set): the diff goes into the fenced block verbatim and the
 * context keeps its own text. `bounded` says the diff was cut to the files that
 * fit and `note` carries what was cut and how to read it.
 */
export interface LensPromptDiff {
  mode: "whole" | "bounded";
  /** What goes inside the fenced diff block. */
  diff: string;
  /** Prose printed after the closing fence; absent when nothing was cut. */
  note?: string;
  /** The context to print, with the full-context block inside the same budget. */
  context: string;
}

/**
 * Bound the diff a lens prompt may inline, counting everything else the prompt
 * carries against the SAME budget.
 *
 * `fullContext` is the delta arm's full-branch orientation block: it is kept only
 * as far as the budget allows, and what the prompt cannot afford is truncated
 * with a notice rather than appended past the bound. `range` is the ref range the
 * caller actually diffed — the reread command is minted from it here and refused
 * when a ref carries fence-breaking bytes.
 */
export function boundLensPromptDiff(opts: {
  diff: string;
  context: string;
  fullContext?: string;
  range?: DiffRange;
}): LensPromptDiff {
  if (!lensLargeDiffEnabled()) return { mode: "whole", diff: opts.diff, context: opts.context };
  const budget = lensDiffBudget(opts.context.length);
  if (opts.diff.length <= budget) {
    return { mode: "whole", diff: opts.diff, context: appendFullContext(opts, budget) };
  }
  const head = wholeFileHead(opts.diff, budget);
  const { files, unattributed } = summarizeDiffFiles(opts.diff, head.diff.length);
  const command = rereadCommand(opts.range);
  const howToReadRest = command
    ? `To read what is not inlined here, run \`${command}\` in your working directory — and for a file whose body the notice marks as omitted, read just that file with \`${command} -- <file>\` rather than the whole range.`
    : "No ref range was supplied with this diff, so the remaining content is not available to you; judge what is shown and say what you could not see rather than guessing at it.";
  const omitted =
    head.omitted.length === 0
      ? ""
      : `Files whose bodies are NOT inlined here — read each one with the command below: ${head.omitted.map((p) => `\`${p}\``).join(", ")}\n`;
  const note = `${inventoryText(files, unattributed)}${omitted}… (diff truncated: inlined ${String(head.diff.length)} of ${String(opts.diff.length)} characters — the body above is a PREFIX of the change, not all of it)\n${howToReadRest}`;
  return {
    mode: "bounded",
    diff: head.diff,
    note,
    context: appendFullContext(opts, budget),
  };
}

/** The full-branch orientation block, kept inside the prompt's ONE budget. */
function appendFullContext(
  opts: { context: string; fullContext?: string },
  budget: number,
): string {
  const block = opts.fullContext;
  if (block === undefined || block === "") return opts.context;
  const room = Math.max(0, Math.floor(budget / 2));
  if (block.length <= room) return `${opts.context}\n\n${block}`;
  const cut = cutAtLineBoundary(block, room);
  return `${opts.context}\n\n${cut}\n… (full-branch context truncated at ${String(cut.length)} of ${String(block.length)} characters to keep this prompt inside its bound)`;
}

/**
 * The file bodies a bounded prompt can still afford: the diff text containing
 * ONLY those whole sections, plus the paths whose bodies did not fit.
 *
 * Sections are admitted in order while they fit and the first one that does not
 * fit stops the walk, so no file is ever cut in half.
 */
export function wholeFileHead(diff: string, cap: number): { diff: string; omitted: string[] } {
  if (diff.length <= cap) return { diff, omitted: [] };
  const sections = diff.split(`\n${GIT_HEADER}`).map((s, i) => (i === 0 ? s : `${GIT_HEADER}${s}`));
  const kept: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  let stopped = false;
  for (const section of sections) {
    const path = headerPath(section.split("\n")[0] ?? "") ?? "(unattributed file section)";
    if (stopped) {
      omitted.push(path);
      continue;
    }
    if (size + section.length + 1 > cap) {
      stopped = true;
      omitted.push(path);
      continue;
    }
    kept.push(section);
    size += section.length + 1;
  }
  return { diff: kept.join("\n"), omitted };
}

/**
 * The per-file inventory of a diff whose bodies live ELSEWHERE: the same rows
 * the adversarial bound prints after its fence, with no `shown` claim — every
 * body is omitted from this prompt, so a row that said "shown in full" would be
 * a lie about the prompt it is printed in.
 */
export function omittedFilesInventory(diff: string): string {
  const { files, unattributed } = summarizeDiffFiles(diff, 0);
  if (files.length === 0) return inventoryLead([], unattributed);
  const lead = `EVERY file this diff changes (${String(files.length)}), with added/removed line counts — none of their bodies are inlined in this prompt.`;
  const attribution =
    unattributed > 0 ? ` ${String(unattributed)} line(s) could not be attributed to a file.` : "";
  const rows: DiffFileSummary[] = files.map((f) => ({ ...f, shown: false }));
  if (files.length <= MAX_INVENTORY_ROWS) return `${lead}${attribution}\n${rowsText(rows)}`;
  const kept = [...rows]
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, MAX_INVENTORY_ROWS);
  return `${lead}${attribution}\n${rowsText(kept)}\nand ${String(files.length - kept.length)} more file(s) not listed.`;
}

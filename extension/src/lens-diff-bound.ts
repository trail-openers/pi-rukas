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
 *     a section cut in half. A section too large for what is left of the budget
 *     is skipped and named, not a stop signal: the files after it that the budget
 *     DOES afford still reach the reviewer.
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
  type DiffRange,
  GIT_HEADER,
  MAX_INLINE_DIFF_CHARS,
  cutAtLineBoundary,
  headerPath,
  inventoryLead,
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
/**
 * What the whole-file walk returns: the joined block of sections that fit, the
 * paths left out, and the paths whose bodies the block really contains. The last
 * one is what lets the inventory say `shown` truthfully — the block is a SET of
 * files, not a prefix, so an offset into the diff cannot tell the two apart.
 */
export interface WholeFileHead {
  diff: string;
  omitted: string[];
  inlined: string[];
}

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
  const command = rereadCommand(opts.range);
  // The note is part of the prompt, so it is charged to the SAME budget as the
  // block beside it: a bound that counts the fenced diff and waves the prose
  // through is the per-field cap this module exists to replace. The note grows
  // with the number of files it has to name, and the block grows with the number
  // of files it can afford — both move together as the walk's cap moves, so the
  // cap is stepped DOWN (whole files leave the block, never more than the budget)
  // until block + note fit, or the block reaches the floor its prompt must always
  // be shown and the notice is trimmed to whatever room is left.
  let cap = budget;
  let kept: WholeFileHead = wholeFileHead(opts.diff, cap);
  // Whether the block is a slice that stops INSIDE a file. Only the line-boundary
  // fallback below ever sets this: the whole-file walk's block is a set of whole
  // files, so its notice may claim a prefix of the change and print exact
  // per-file counts, and conflating the two would let a mid-file slice read as a
  // complete file review.
  let partial = false;
  let noteParts = buildNoteParts(opts, kept, partial, command);
  let note = assemble(noteParts);
  // The loop terminates because every iteration that continues strictly lowers
  // `cap`, and it is bounded below by the floor. Lowering the cap drops whole
  // files out of the block, which shrinks BOTH sides of the sum — the block and
  // the note's inventory of what is missing — so the sum always comes down. The
  // loop stops when the pair fits, or at the floor, where the notice is trimmed
  // instead of the diff.
  while (kept.diff.length + note.length > budget && cap > LENS_DIFF_BUDGET_FLOOR) {
    // Step strictly below the current cap, aiming at the budget minus the note.
    // `Math.min(cap - 1, …)` is what makes this terminate: the earlier form let
    // `cap` stall where the note could not shrink further, and the block was
    // handed back over its budget with the notice's reread command already lost.
    const next = Math.max(LENS_DIFF_BUDGET_FLOOR, Math.min(cap - 1, budget - note.length - 1));
    if (next >= cap) break;
    cap = next;
    kept = wholeFileHead(opts.diff, cap);
    noteParts = buildNoteParts(opts, kept, partial, command);
    note = assemble(noteParts);
  }
  if (kept.diff.length + note.length > budget) {
    // The NOTICE gives up bytes before the diff does: the inventory table goes
    // first, and the reread command, the counts and the omitted-path list are
    // what survives — a lens with a smaller block and a command to read the rest
    // is still a lens that can finish its review.
    note = trimNote(noteParts, Math.max(0, budget - kept.diff.length));
  }
  // ── #2261 finding 2: a bounded prompt is never an EMPTY prompt. Whole files
  // are the preference, and their bodies are what a lens can actually judge, but
  // when no single section fits the budget — one generated bundle, one lockfile,
  // one vendored file larger than the whole bound — six lenses spawned to receive
  // nothing and a notice that called the empty block a prefix of the change. Fall
  // back to a head cut at a LINE boundary: partial evidence, honestly labelled,
  // beats an empty fence, and the file it came from is still named below.
  if (kept.diff.length === 0) {
    // The fallback block is a slice of the raw diff, not a set of whole files, so
    // it inlines NO complete body — the inventory marks nothing `shown`, which is
    // the honest claim for a mid-file slice.
    kept = {
      diff: cutAtLineBoundary(opts.diff, Math.max(0, budget - note.length - 1)),
      omitted: kept.omitted,
      inlined: [],
    };
    partial = true;
    noteParts = buildNoteParts(opts, kept, partial, command);
    note = assemble(noteParts);
    if (kept.diff.length + note.length > budget) {
      note = trimNote(noteParts, Math.max(0, budget - kept.diff.length));
    }
  }
  // The invariant every caller depends on: the fenced block and the notice printed
  // after it together never exceed the budget. `trimNote` keeps the reread command
  // and the counts and gives up the inventory table, so reaching here over budget
  // means the fixed prose itself has no room — the block then gives, not the note,
  // because a lens with a smaller block is still a lens with a command to read the
  // rest, and a lens with a full block and no command is stuck.
  //
  // `room` is re-derived from the note as it was ACTUALLY returned, every pass:
  // a room computed from a note that then grew (see `trimNote`) is a room that
  // admits an over-budget pair and never fires this fallback. The loop terminates
  // because each pass strictly shrinks the block (`cutAtLineBoundary` at a room
  // that just failed to fit) and re-measures the note, and the block is bounded
  // below by zero.
  for (let guard = 0; guard < 4; guard++) {
    if (kept.diff.length + note.length <= budget) break;
    const room = Math.max(0, budget - note.length);
    if (kept.diff.length <= room) break;
    kept = { ...kept, diff: cutAtLineBoundary(kept.diff, room) };
    noteParts = buildNoteParts(opts, kept, partial, command);
    note = trimNote(noteParts, Math.max(0, budget - kept.diff.length));
  }
  return {
    mode: "bounded",
    diff: kept.diff,
    note,
    context: appendFullContext(opts, budget),
  };
}

/**
 * The note, as its parts rather than one string. The prose is built once and
 * trimmed by dropping whole rows, so the two pieces a lens can act on — the
 * omitted-path list and the reread command — can never be the things a budget cut
 * removes. They are the point of the notice.
 */
interface NoteParts {
  /** The inventory lead line (what the table below claims to be). */
  lead: string;
  /** The per-file rows, the first thing to go when the budget is tight. */
  rows: string;
  /** The paths whose bodies did not make it into the block. */
  omittedPaths: string;
  /** How many paths `omittedPaths` lists — the row-drop sentence has to say the
   * number when it drops the list itself, and the list is not there to count. */
  omittedCount: number;
  /** The counts and what the block above actually is. */
  counts: string;
  /** How to read what is not inlined, or why it cannot be read here. */
  howToRead: string;
}

function assemble(n: NoteParts): string {
  return `${n.lead}\n${n.rows}${n.omittedPaths}${n.counts}\n${n.howToRead}`;
}

/** The prose printed after the fence: inventory, omitted paths, counts, reread command. */
function buildNoteParts(
  opts: { diff: string; range?: DiffRange },
  kept: WholeFileHead,
  partial: boolean,
  command: string | undefined,
): NoteParts {
  // The block is a SET of whole files (or the line-boundary fallback), not a
  // prefix, so `shown` comes from the paths the walk actually inlined — an offset
  // test would call a skipped oversized file "shown" and a kept later file "not
  // shown", which is the inventory lying about the prompt it is printed in.
  const { files, unattributed } = summarizeDiffFiles(
    opts.diff,
    kept.diff.length,
    new Set(kept.inlined),
  );
  const howToRead = command
    ? `To read what is not inlined here, run \`${command}\` in your working directory — and for a file whose body the notice marks as omitted, read just that file with \`${command} -- <file>\` rather than the whole range.`
    : "No ref range was supplied with this diff, so the remaining content is not available to you; judge what is shown and say what you could not see rather than guessing at it.";
  const omittedPaths =
    kept.omitted.length === 0
      ? ""
      : `Files whose bodies are NOT inlined here — read each one with the command below: ${kept.omitted.map((p) => `\`${p}\``).join(", ")}\n`;
  // What the block above actually is. Calling an EMPTY block "a PREFIX of the
  // change" is a false claim about a prompt that contains no change at all, and a
  // lens that believes it reviews a diff it never saw. The PARTIAL form says what
  // the line-boundary fallback did: the block stops inside a file, which the
  // reviewer must know it is reading rather than weigh as a complete set of changes.
  const whatAbove =
    kept.diff.length === 0
      ? "the body above is EMPTY — every file's body was omitted, so there is nothing here to review: say so rather than guessing at the change"
      : partial
        ? "the body above is PARTIAL — no single file fit this prompt's budget, so it is the head of the diff cut at a line boundary and it may stop in the middle of a file: judge what is shown and say what you could not see"
        : "the body above is a PREFIX of the change, not all of it";
  return {
    lead: inventoryLead(files, unattributed),
    rows: files.length === 0 ? "" : `${rowsText(files)}\n\n`,
    omittedPaths,
    omittedCount: kept.omitted.length,
    counts: `… (diff truncated: inlined ${String(kept.diff.length)} of ${String(opts.diff.length)} characters — ${whatAbove})`,
    howToRead,
  };
}

/**
 * The note shrunk to what the budget has left, by dropping INVENTORY ROWS first
 * and the omitted-path list's overflow second.
 *
 * Never a tail cut: the counts, the omitted-path list and the reread command are
 * the only parts a lens can act on, and a bound that clipped them off would leave
 * a reviewer told about files it cannot locate and given no command to read them
 * with. The rows are the bulk of the note and the least load-bearing, so they go
 * first, and the notice says the inventory was shortened rather than posing as
 * complete. In the corner where even the fixed prose has no room the reread command
 * is RESERVED ahead of the cut rather than being its casualty — the omitted-path
 * line directs the lens to it, so dropping it there leaves a notice pointing at a
 * command it never printed.
 *
 * The rows are reserved for the sentence that admits they were shortened: the
 * reserve is that sentence's OWN rendered length, not an estimate of it. A fixed
 * reserve shorter than the sentence lets re-assembly re-grow the note past the
 * room it was just given — which is how a few-thousand-file diff (where the
 * notice is the larger half: measured, 100 355 note characters against a 19 661
 * block) rendered block + note past the budget, while the caller's block-gives
 * fallback sat unreachable because its room came from the note already accepted.
 */
/** The sentence that admits the inventory table was shortened. Its length varies
 * only with the digit count of `dropped`, so callers can bound the note by its
 * widest rendering rather than guessing a reserve. */
function overflowSentence(dropped: number): string {
  return `\n…and roughly ${String(dropped)} characters of the per-file inventory dropped to keep this prompt inside its bound.\n\n`;
}

function trimNote(parts: NoteParts, room: number): string {
  const whole = assemble(parts);
  if (room >= whole.length) return whole;
  // The rowless rendering is the floor: anything below it is the tight-budget
  // corner where even the fixed prose has no room.
  const floor = assemble({ ...parts, rows: "" });
  if (room < floor.length) {
    // The tight-budget corner: even the rowless notice does not fit, so something
    // has to be cut from the fixed prose. The reread command is what the
    // omitted-path line above it PROMISES ("read each one with the command
    // below"), so it is never what the cut removes — its length is reserved first
    // and whatever room is left is filled at a line boundary, lead first, then the
    // paths, then the counts. The tail that goes is therefore the counts sentence,
    // which restates numbers the block already shows, and never the command.
    const command = parts.howToRead;
    const bodyRoom = Math.max(0, room - command.length - 1);
    let body = cutAtLineBoundary(`${parts.lead}\n${parts.omittedPaths}${parts.counts}`, bodyRoom);
    // A path list is never half-named: a path cut mid-name, or its closing backtick
    // clipped, is a file the reviewer can neither read nor locate. When the room
    // cannot hold the list whole, the list goes and the notice says it did.
    const paths = parts.omittedPaths.trimEnd();
    if (paths !== "" && !body.includes(paths)) {
      const dropped = `… (${String(parts.omittedCount)} omitted path${parts.omittedCount === 1 ? "" : "s"} not listed: too many to name inside this prompt's bound)`;
      body = cutAtLineBoundary(`${parts.lead}\n${dropped}\n${parts.counts}`, bodyRoom);
      if (!body.includes(parts.lead)) body = parts.lead;
    }
    return body === "" ? command : `${body}\n${command}`;
  }
  const allRows = parts.rows.trimEnd();
  // Measured against the real rendering, so the returned note is <= `room` by
  // construction rather than by how well a reserve was guessed. The overflow
  // sentence's length depends only on the digit count of `dropped`, so it is
  // bounded by its own widest rendering — a fixed reserve shorter than the
  // sentence let re-assembly re-grow the note past the room it had just been
  // given, which is how a few-thousand-file diff rendered over the budget.
  const overflowWidth = overflowSentence(allRows.length).length;
  let keptRows = cutAtLineBoundary(allRows, Math.max(0, room - floor.length - overflowWidth));
  let dropped = allRows.length - keptRows.length;
  if (dropped <= 0) return assemble({ ...parts, rows: keptRows === "" ? "" : `${keptRows}\n\n` });
  // Belt to the measurement above: a note that admits its own shortening must not
  // be the thing that breaks the bound, so the pair gives a row rather than a
  // character. The loop terminates because each pass strictly shortens `keptRows`.
  let rows = `${keptRows}${overflowSentence(dropped)}`;
  while (assemble({ ...parts, rows }).length > room && keptRows !== "") {
    const lastNl = keptRows.lastIndexOf("\n");
    keptRows = lastNl > 0 ? keptRows.slice(0, lastNl) : "";
    dropped = allRows.length - keptRows.length;
    rows = keptRows === "" ? "" : `${keptRows}${overflowSentence(dropped)}`;
  }
  return assemble({ ...parts, rows });
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
 * Sections are admitted in order while they fit, so no file is ever cut in half.
 * A section that does not fit is skipped, named, and the walk CONTINUES. Stopping
 * at the first oversized section was the shape that made this module useless on
 * the input it exists for: the first file in a large diff is often a generated
 * bundle, lockfile or vendored file bigger than the whole budget, and a latched
 * stop then handed every lens an EMPTY block — six spawns, no diff, and a notice
 * that called it a prefix of the change. The later files the budget affords are
 * evidence; dropping them for nothing was not the safe default.
 */
export function wholeFileHead(diff: string, cap: number): WholeFileHead {
  if (diff.length <= cap) {
    // The whole diff fits: every file is inlined, and none is omitted.
    const all = new Set<string>();
    for (const section of diff.split(`\n${GIT_HEADER}`)) {
      const lead = section.startsWith(GIT_HEADER) ? section : `${GIT_HEADER}${section}`;
      const p = headerPath(lead.split("\n")[0] ?? "");
      if (p !== null) all.add(p);
    }
    return { diff, omitted: [], inlined: [...all] };
  }
  const sections = diff.split(`\n${GIT_HEADER}`).map((s, i) => (i === 0 ? s : `${GIT_HEADER}${s}`));
  const kept: string[] = [];
  const omitted: string[] = [];
  const keptPaths: string[] = [];
  // The size of the text the walk would JOIN, measured as it is built: sections
  // rejoined with "\n", so every kept section after the first costs its own length
  // PLUS the separator. Sizing a section by `length + 1` undercounts once and the
  // bound is then off by the number of files kept — which is how the block came to
  // exceed the budget it was handed.
  let size = 0;
  for (const section of sections) {
    const path = headerPath(section.split("\n")[0] ?? "") ?? "(unattributed file section)";
    const joined = size === 0 ? section.length : size + 1 + section.length;
    if (joined > cap) {
      omitted.push(path);
      continue;
    }
    kept.push(section);
    keptPaths.push(path);
    size = joined;
  }
  return { diff: kept.join("\n"), omitted, inlined: keptPaths };
}

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
 * it silently would be worse than cutting it noisily: the bound keeps a
 * per-file summary of EVERY changed file — parsed from the `diff --git` headers
 * in the text itself, so no extra git call is needed — plus the head of the
 * diff and a notice naming what was dropped and how to read the rest.
 *
 * At or under the cap the diff is returned UNCHANGED, byte-for-byte, so a
 * normal-sized review produces exactly the prompt this module shipped without.
 */

/**
 * Characters of diff text the adversarial prompts may inline. Comfortably under
 * the ~258K-token context the measured child ran out of, and above any diff a
 * reviewed workstream has realistically carried (the /work path already caps
 * its own fetch at 1 MiB, so this bound is what actually bites).
 */
export const MAX_INLINE_DIFF_CHARS = 120_000;

/** One changed file, read off the `diff --git` headers of the diff text. */
export interface DiffFileSummary {
  path: string;
  added: number;
  removed: number;
}

const GIT_HEADER = "diff --git ";

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

/**
 * Per-file added/removed counts parsed from the diff text. Body lines are only
 * counted inside a file section (never against a header), so a `+++`/`---`
 * marker line cannot count as content; a hunk header starting with `+` or `-`
 * after its column is rare and miscounts one line, which is not load-bearing.
 */
export function summarizeDiffFiles(diff: string): DiffFileSummary[] {
  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith(GIT_HEADER)) {
      const path = headerPath(line);
      if (!path) continue;
      current = { path, added: 0, removed: 0 };
      files.push(current);
    } else if (current) {
      if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
    }
  }
  return files;
}

/**
 * Non-empty lines that fall outside every `diff --git` file section.
 *
 * The /work driver's merged diff carries text no file section owns: `##
 * workstream: <id>` headers between worktrees, and the 1 MiB truncation marker.
 * Counting them is what lets the inventory say how much of the text it could
 * NOT attribute instead of claiming a completeness it does not have.
 */
function unattributedLines(diff: string): number {
  let insideFile = false;
  let loose = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith(GIT_HEADER)) insideFile = true;
    else if (!insideFile && line.trim() !== "") loose += 1;
  }
  return loose;
}

/** The lead line of the per-file inventory, worded for what the diff actually shows. */
function inventoryLead(files: DiffFileSummary[], loose: number): string {
  if (files.length === 0) {
    return "No `diff --git` file headers were found in this diff, so a per-file inventory could not be built — judge the body below and say what you could not see:";
  }
  const completeness =
    loose === 0
      ? "this inventory is COMPLETE, the file bodies below it are not"
      : `${loose} line(s) of the diff could not be attributed to a file, so this inventory covers the ${files.length} file(s) that carry a \`diff --git\` header and no more`;
  return `EVERY file this diff changes (${files.length}), with added/removed line counts — ${completeness}:`;
}

/** The one-line-per-file inventory the reviewer sees in place of the cut body. */
function fileTable(files: DiffFileSummary[], loose: number): string {
  const lead = `${inventoryLead(files, loose)}\n`;
  if (files.length === 0) return `${lead}\n`;
  const width = files.reduce((w, f) => Math.max(w, f.path.length), 0);
  const rows = files.map((f) => `  ${f.path.padEnd(width)}  +${f.added} -${f.removed}`).join("\n");
  return `${lead}${rows}\n\n`;
}

/**
 * Bound the diff text a prompt may inline.
 *
 * `diff` at or under {@link MAX_INLINE_DIFF_CHARS} is returned unchanged.
 * Over it: the complete per-file inventory, then the head of the diff cut at a
 * line boundary, then a notice carrying the character counts and — when the
 * caller knows the range it diffed — the exact command to read the rest with in
 * its working directory. With no command (a caller-pasted diff) the notice says
 * plainly that the rest is not available, so the reviewer does not go hunting
 * for a range it cannot see.
 */
export function boundDiffForPrompt(diff: string, rereadCommand?: string): string {
  if (diff.length <= MAX_INLINE_DIFF_CHARS) return diff;
  const head = cutAtLineBoundary(diff, MAX_INLINE_DIFF_CHARS);
  const command = rereadCommand?.trim();
  const howToReadRest = command
    ? `To read what is not inlined here, run \`${command}\` in your working directory — read the individual files this change touches rather than the whole range.`
    : "No ref range was supplied with this diff, so the remaining content is not available to you; judge what is shown and say what you could not see rather than guessing at it.";
  return `${fileTable(summarizeDiffFiles(diff), unattributedLines(diff))}${head}\n\n… (diff truncated: inlined ${head.length} of ${diff.length} characters — the body above is a PREFIX of the change, not all of it)\n${howToReadRest}`;
}

/** Cut at the cap, landing on a line boundary so the diff block never breaks mid-line. */
function cutAtLineBoundary(text: string, cap: number): string {
  const slice = text.slice(0, cap);
  const nl = slice.lastIndexOf("\n");
  return nl > 0 ? slice.slice(0, nl) : slice;
}

/**
 * The command that reproduces a ref-range diff, worded as the reviewer must run
 * it. The truncation notice prints it verbatim, so it is built in ONE place from
 * the same refs the loop passed to its diff function — a notice naming a command
 * nobody ran would send the reviewer looking for a range it has none of, which is
 * why callers only ever pass a command they themselves executed.
 *
 * A ref is untrusted text. A newline or backtick inside one would close the
 * prompt's fenced diff block early and print its own `VERDICT:` line outside
 * the fence, where the loop's marker reader would find it — so such a command
 * is refused (empty) and the notice falls back to its "not available" wording.
 */
export function rangeRereadCommand(base: string, head: string): string {
  const command = `git diff ${base}...${head}`;
  return /[\r\n`]/.test(command) ? "" : command;
}

/**
 * The reread command the truncation notice may print for ONE round, or nothing
 * when it may not print one. Kept here so the loop's mint sites cannot drift
 * from the rule: an empty `rangeRereadCommand` means the refs carry bytes that
 * would escape the prompt's fence, and the caller must fall back to the "not
 * available" wording rather than print an empty inline.
 */
export function rereadCommandForRound(base: string, head: string): string | undefined {
  return rangeRereadCommand(base, head) || undefined;
}

/**
 * public-hygiene-substitution — a publish whose text the SHELL BUILDS is a
 * publish the guard cannot read (#1788 round 2).
 *
 * `public-hygiene-unreadable.ts` already refuses `--body "$(cat f)"`, where the
 * substitution sits at the head of the operand and the word splitter has nothing
 * left to read. It does not catch
 * `gh pr comment 3 --body "PREFIX $(cat f) tail"`. `simpleCommands` ENDS a
 * command the moment it meets `$(` — it must, so the substituted body gets its
 * own scan — so that operand arrives as the single word `PREFIX`, which is clean
 * prose, while bash publishes whatever `cat f` prints. The gap is the space: a
 * substitution glued to the flag was already caught, one after a space was not.
 *
 * This module answers the question the word list structurally cannot: which
 * segments of the RAW command both publish inline text and contain a live
 * command substitution. One left-to-right walk tracks quoting and substitution
 * depth and cuts segments only where bash would (an unquoted `;`, `&`, `|` or
 * newline OUTSIDE a substitution — cutting inside one would hand the next
 * segment a fragment of the previous command's body). For each candidate segment
 * it then asks the EXISTING helpers the ordinary question: does the command
 * publish (`publishesText`) and does it carry one of the inline text flags (the
 * table `unreadableOperands` already owns, imported, never copied). So the
 * decision is still made by the tables that make it everywhere else; this module
 * only makes sure they are asked of the whole operand rather than the prefix that
 * survived the cut.
 *
 * Fail-closed: a segment whose quote never closed is INDETERMINATE — bash's own
 * word reader reports no words at all for `--body 'unterminated` — so it is
 * treated as substituting rather than as clean.
 */

import { publishesText } from "./public-hygiene-scan.ts";
import { API_FIELD_FLAGS, TEXT_FLAG_LOCATIONS } from "./public-hygiene-unreadable.ts";

/** Does any word of this argv name an inline publish-text flag with a value? */
function carriesInlineTextFlag(argv: readonly string[]): boolean {
  for (const w of argv) {
    for (const [flag] of TEXT_FLAG_LOCATIONS) {
      if (w === flag) return true;
      if (flag.length > 2 && w.startsWith(`${flag}=`)) return true;
      // A glued short form (`-mtext`) carries its value inline; a long flag
      // never glues, so `--bodyfile` is not `--body` with a value.
      if (flag.length === 2 && w.startsWith(flag) && w.length > flag.length) return true;
    }
    if (API_FIELD_FLAGS.has(w)) return true;
  }
  return false;
}

/**
 * The words bash would hand the head command of `segment`, quotes removed.
 *
 * Written here rather than taken from `simpleCommands`: that splitter ENDS a
 * command at `$(`, so for `gh … --body "PREFIX $(cat f) tail"` it returns the
 * words up to the cut and no text flag at all — the very blindness this module
 * exists to close, which would make the segment look like a non-publish.
 */
function headWords(segment: string): string[] {
  const argv: string[] = [];
  let seenProgram = false;
  let word = "";
  let q: "'" | '"' | null = null;
  const flush = (): void => {
    if (word === "") return;
    if (!seenProgram) {
      // Leading `KEY=value` assignment prefixes belong to the same command.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        word = "";
        return;
      }
      seenProgram = true;
    }
    argv.push(word);
    word = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (q !== null) {
      // Inside double quotes a backslash escapes the next character, so `\"` does
      // NOT close the quote and the words after it stay part of the operand.
      if (ch === "\\" && q === '"') {
        word += segment[++i] ?? "";
        continue;
      }
      if (ch === q) q = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      continue;
    }
    // A parenthesis ends a word: `-F body=<(/dev/stdin)` must not arrive as the
    // single word `body=<`, which would hide the process substitution in a word
    // whose value reads as a literal field.
    if (ch === "(" || ch === ")" || /\s/.test(ch)) {
      flush();
      continue;
    }
    word += ch;
  }
  flush();
  return argv;
}

/**
 * Does the head command of this segment publish inline text? Only the head: a
 * publish owned by a later command in the same segment (`… && echo $(date)`) is
 * that command's business, not this one's.
 */
function publishesInlineText(segment: string): boolean {
  const argv = headWords(segment);
  if (argv.length === 0) return false;
  return publishesText(argv) && carriesInlineTextFlag(argv);
}

/** One pass over the raw command, accumulating the state of the current segment. */
interface Walk {
  quote: "'" | '"' | null;
  inBacktick: boolean;
  depth: number;
  hasSubstitution: boolean;
}

/** Does the walk end with a quote or a backtick left open? */
function unbalanced(w: Walk): boolean {
  return w.quote !== null || w.inBacktick;
}

/**
 * Did every `'` in the raw command pair up?
 *
 * The fail-closed tail rule exists for an operand the shell could not finish
 * reading. It must not fire on a command whose apostrophes all closed (`--body
 * "it's fine"`): there the imbalance the walk reports is its own double-quote
 * tracking, not the author's, and refusing a clean prose body is how a guard gets
 * its escape hatch set.
 */
function balancedApostrophes(raw: string): boolean {
  let open = false;
  let inDouble = false;
  for (const ch of raw) {
    if (ch === '"') inDouble = !inDouble;
    else if (ch === "'" && !inDouble) open = !open;
  }
  return !open;
}

/**
 * The raw text of every simple-command segment that BOTH publishes inline text
 * AND contains a command substitution outside single quotes.
 *
 * Each returned segment is a publish whose text does not exist in the command
 * this guard can read. Empty for anything the walk finds clean.
 */
export function publishSegmentsWithSubstitution(raw: string): string[] {
  const out: string[] = [];
  const w: Walk = { quote: null, inBacktick: false, depth: 0, hasSubstitution: false };
  let start = 0;

  const endSegment = (end: number): void => {
    const text = raw.slice(start, end);
    // The conjunction of two INDEPENDENT observations: this segment publishes
    // inline text, AND the walk saw a live substitution in it. A single-quoted
    // `$(…)` never sets `hasSubstitution`, so a literal body stays clean.
    if (w.hasSubstitution && publishesInlineText(text)) out.push(text);
    start = end + 1;
    w.hasSubstitution = false;
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? "";
    if (w.quote === "'") {
      if (ch === "'") w.quote = null;
      continue;
    }
    if (ch === "`") {
      // A backtick toggles a substitution body — outside quotes and inside double
      // quotes alike, because a backtick expands in both.
      w.inBacktick = !w.inBacktick;
      w.hasSubstitution = true;
      continue;
    }
    if (w.inBacktick) continue;
    if (ch === "'" && w.quote !== '"') {
      // Inside double quotes a `'` is LITERAL text (`--body "it's fine"`); this
      // branch is unreachable there because the quote test above already handled
      // it. Opening a single quote inside double quotes is the bug that swallowed
      // every word after an apostrophe, publish flags included.
      w.quote = "'";
      continue;
    }
    if (ch === "\\" && w.quote === '"' && i + 1 < raw.length) {
      // Inside double quotes a backslash escapes the next character, so `\"` does
      // NOT close the quote. Outside quotes it falls through: skipping it
      // everywhere is how the `'` of a following `\'` got swallowed.
      i++;
      continue;
    }
    if (ch === '"' && w.quote === null) {
      w.quote = '"';
      continue;
    }
    if (ch === "$") {
      // `$(` substitutes; `$NAME` and `${NAME}` are text whose contents no scan of
      // this command can know either — the rule `shellBuilt` already applies to a
      // word the splitter read whole. A `$` heading neither (`100$`) stays prose.
      const next = raw[i + 1] ?? "";
      if (next === "(") {
        w.depth++;
        w.hasSubstitution = true;
        i++;
      } else if (/^[A-Za-z_{]/.test(next)) {
        w.hasSubstitution = true;
      }
      continue;
    }
    if ((ch === "<" || ch === ">") && raw[i + 1] === "(" && raw[i - 1] !== ">") {
      w.depth++;
      w.hasSubstitution = true;
      i++;
      continue;
    }
    if (ch === ")" && w.depth > 0) {
      w.depth--;
      continue;
    }
    if (w.depth === 0 && (ch === ";" || ch === "&" || ch === "|" || ch === "\n")) {
      endSegment(i);
    }
  }
  // The final segment: an unbalanced quote makes it indeterminate, so it counts
  // as substituting (fail closed) rather than as clean. The publish test is still
  // asked, but of the text with its dangling quotes removed and an inline text
  // flag appended — a word reader handed an unterminated quote reports no flags
  // at all, and "could not tell" has never meant "clean" in this guard.
  const tail = raw.slice(start);
  endSegment(raw.length);
  if (unbalanced(w) && !out.includes(tail) && !balancedApostrophes(raw)) {
    const probe = `${tail.replace(/['"`]/g, "")} --body x`;
    if (probe.trim() !== "" && publishesInlineText(probe)) out.push(tail);
  }
  return out;
}

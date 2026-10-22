/**
 * review-accept-exempt — the EXEMPTION proof for clause (5) (#1764 round 4).
 *
 * THE INVARIANT: the accept guard is MONOTONE over its base. Base's clause (5) was a
 * command-wide, program-agnostic refusal — "some word names a read tool (or a VCS /
 * runtime), and some word carries `$`/a backtick" — and every per-segment narrowing this
 * PR layered on top of it became a hole the reviews kept finding (prefix words:
 * `timeout 300 cat $V`, `xargs cat $V`; a stale-literal rebinding: `F=x; F=$V; cat $F`).
 * So the BASE rule is the default verdict again, and this module is the only thing that
 * may lift it.
 *
 * THE EXEMPTION, NEVER THE REFUSAL, IS THE THING THAT NEEDS PROOF. `inScope` refuses
 * whenever this module cannot POSITIVELY understand EVERY segment of the command; a
 * segment this module does not recognise is not "nothing to check", it is a failed proof
 * and the base refusal stands. Understating the exemption costs an over-refusal (clause
 * (b)'s accepted cost); overstating it is the security boundary opening.
 *
 * A command is UNDERSTOOD when all of this holds:
 *
 *  - it parses: every quote closes and every heredoc delimiter returns — an unresolved
 *    here-string, heredoc or parse failure means nothing was understood;
 *  - no UNQUOTED heredoc body carries an expansion: the shell expands such a body into
 *    the program's stdin, and the guard cannot read what arrives;
 *  - EVERY segment's redirection targets are literal, or resolve unambiguously through
 *    assignment resolution (asked FIRST, on every segment, whatever its program);
 *  - if a segment contains a CHECKED_TOOLS word anywhere (a content reader, a search
 *    tool, a file-stat tool, or a pattern tool no arm admits), an exemption needs that
 *    word to BE the recognised program after the sanctioned prefix words are stepped
 *    over — `xargs cat $V`, `parallel cat $V` and `timeout 300 cat $V` keep the base
 *    refusal because the guard cannot say what the unrecognised word does to the
 *    operand; and every operand, option value and (non-prose) pattern of that tool then
 *    stands the same literal-or-resolved test;
 *  - a segment run through a SHELL / eval builtin (`sh -c`, `eval`) is understood only
 *    when the whole segment is expansion-free — it executes text, whatever its quotes;
 *  - a segment whose program is not one the guard reasons about must be expansion-free
 *    in every positional word it hands the program (`tee $F` is not understood;
 *    `timeout 900 bats tests/x.bats` is), except the PRINT class, whose arguments are
 *    its own output (`echo "FMT_EXIT=$?"` is ordinary shell text).
 *
 * Assignment resolution (#1764 rule (b)) runs before every question: a name with more
 * than one binding, or with any non-literal binding, is ambiguous and NEVER resolves, so
 * `F=x; F=$V; cat $F` fails the proof rather than resolving to the stale `x`.
 */

import {
  EXPANSION,
  armsOf,
  baseName,
  closingQuote,
  shellWords,
  skipHeredoc,
  unquote,
} from "./review-accept-command.ts";
import {
  CHECKED_TOOLS,
  NAVIGATE_TOOLS_ONLY,
  PATTERN_FIRST_TOOLS,
  PRINT_TOOLS_ONLY,
  heredocArgumentWords,
  operandWords,
  patternIsProse,
  programName,
  redirectTargets,
} from "./review-accept-readtools.ts";
import { ASSIGNMENT_SHAPE, withSameCommandAssignmentsApplied } from "./review-accept-views.ts";

/** A program that EXECUTES the text it is handed: an expansion anywhere in its segment
 * is bytes it will run, however quoted. `.` is the POSIX source spelled as punctuation. */
const EXEC_PROGRAMS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "dash",
  "ksh",
  "zsh",
  "eval",
  "source",
  ".",
]);

/**
 * The command reduced to the words the shell parses as its own arguments, or `null` when
 * the proof cannot start: an unterminated quote, a heredoc whose delimiter never returns,
 * or an UNQUOTED heredoc body carrying an expansion (the body becomes stdin bytes the
 * program receives, and the guard cannot read them). A quoted body is data the shell
 * hands over verbatim and is dropped — its `$` was never an argument.
 */
function understoodArgumentText(command: string): string | null {
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === "'" || c === '"') {
      const end = c === "'" ? command.indexOf("'", i + 1) : closingQuote(command, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i) && !command.startsWith("<<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return null;
      if (!past.quoted && EXPANSION.test(command.slice(past.bodyStart, past.bodyEnd))) return null;
      i = past.end;
      continue;
    }
    i++;
  }
  return heredocArgumentWords(command);
}

/** Does one segment of the RESOLVED command pass the understanding test? `words` are the
 * segment's words with quotes kept (which is what tells a single-quoted literal from a
 * double-quoted expansion). */
function segmentUnderstood(words: string[]): boolean {
  // Redirection first and on EVERY segment: the bytes a redirection moves go through a
  // path no arm ever saw, whatever the segment's program kind says (criterion 2).
  if (redirectTargets(words).some((target) => EXPANSION.test(target))) return false;
  if (words.length === 0) return true;
  const program = programName(words);
  const hasChecked = words.some((w) => CHECKED_TOOLS.has(baseName(unquote(w))));
  if (hasChecked) {
    // Rule (a): a checked tool standing behind any word the guard does not recognise is
    // an UN understood segment — the prefix word may consume, split or re-execute the
    // operand before the tool ever sees it (`xargs cat`, `watch -n 1 cat`).
    if (!CHECKED_TOOLS.has(program)) return false;
    return !operandWords(words, PATTERN_FIRST_TOOLS.has(program)).some((operand) =>
      EXPANSION.test(operand),
    );
  }
  if (EXEC_PROGRAMS.has(program)) {
    return !words.some((w) => EXPANSION.test(unquote(w)));
  }
  // The PRINT class echoes its arguments; nothing opens them. Its redirections were
  // already asked above, and the pipe-to-shell clause (4) catches `echo $F | sh`.
  if (PRINT_TOOLS_ONLY.has(program)) return true;
  // An unknown program (or `cd`): every word it is handed must be a literal or a
  // resolved one — the guard does not know what the program OPENS, so an unresolved
  // positional is the end of the proof. Assignments bind values (their ambiguity is
  // counted by the resolver, they are not paths opened); flags carry their value inside
  // and are asked for expansion after unquoting.
  for (const raw of words) {
    const word = unquote(raw);
    if (word === "") continue;
    if (word.startsWith("-")) {
      if (EXPANSION.test(word)) return false;
      continue;
    }
    if (ASSIGNMENT_SHAPE.test(word)) continue;
    if (!patternIsProse(raw)) return false;
  }
  return true;
}

/**
 * Does the guard POSITIVELY understand every segment of this command? Only `true` may
 * lift the base clause-(5) refusal; `false` (and any internal failure) leaves the base
 * verdict standing. `command` is the guard's lowercased raw view, newlines kept.
 */
export function commandFullyUnderstood(command: string): boolean {
  try {
    const args = understoodArgumentText(command);
    if (args === null) return false;
    const resolved = withSameCommandAssignmentsApplied(args);
    return armsOf(resolved).every((segment) => segmentUnderstood(shellWords(segment)));
  } catch {
    // An exemption that threw is a proof that failed, not a pass.
    return false;
  }
}

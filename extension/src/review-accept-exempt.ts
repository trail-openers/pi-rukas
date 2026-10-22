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
 *  - EVERY segment's redirection targets are literal (asked FIRST, on every segment,
 *    whatever its program);
 *  - if a segment contains a CHECKED_TOOLS word anywhere (a content reader, a search
 *    tool, a file-stat tool, or a pattern tool no arm admits), an exemption needs that
 *    word to BE the recognised program after the sanctioned prefix words are stepped
 *    over — `xargs cat $V`, `parallel cat $V` and `timeout 300 cat $V` keep the base
 *    refusal because the guard cannot say what the unrecognised word does to the
 *    operand; and every operand, option value and (non-prose) pattern of that tool then
 *    stands the same literal test — the word as the shell receives it, expansion-free;
 *  - a segment run through a SHELL / eval builtin (`sh -c`, `eval`) is understood only
 *    when the whole segment is expansion-free — it executes text, whatever its quotes;
 *  - a segment whose program is not one the guard reasons about must be expansion-free
 *    in every positional word it hands the program (`tee $F` is not understood;
 *    `timeout 900 bats tests/x.bats` is), except the PRINT class, whose arguments are
 *    its own output (`echo "FMT_EXIT=$?"` is ordinary shell text).
 *
 * ── THE TEXT THE PROOF READS (#1764 round 5) ────────────────────────────────────
 *
 * THE INVARIANT: the proof reads only the text the shell receives. It never reads a view
 * this module or views.ts rewrote.
 *
 * Rounds 3 and 4 both found the CRITICAL in the same place: the proof asked its questions
 * of `withSameCommandAssignmentsApplied(...)`, a text THIS harness had pasted together.
 * `F=.git/zz<store>; cat ${F//zz/}` is the shape — the old matcher read `${F` as a
 * reference (its braces were optional), substituted the literal value, and the proof then
 * adjudicated an expansion-free path the shell never produces while bash prints the store.
 * Substitution is a GUESS about what the shell will do, and a proof may not rest on a
 * guess: `commandFullyUnderstood`, `segmentUnderstood`, the `operandWords` the proof asks
 * and `patternIsProse` all run on the RAW command.
 *
 * The consequence is accepted, not argued away: a checked or pattern tool whose operand,
 * redirect target or option value carries ANY `$` or backtick in the raw text is never
 * exempted, and rows that only went green through substitution (`F=notes.md; cat $F`) are
 * refused again and recorded in the accepted-costs table. Substitution still feeds the
 * STORE-NAME test (`storeNameSubject`) and nothing else — there it can only ever ADD a
 * name to the text asked, so it can only add a refusal; asked of an operand test it did the
 * opposite, because pasting a value in can REMOVE the `$` that was the whole reason to ask.
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
  heredocArgumentWords,
  operandWords,
  patternIsProse,
  programName,
  programWordIndex,
  redirectTargets,
} from "./review-accept-readtools.ts";
import { CHECKED_TOOLS, PATTERN_FIRST_TOOLS, PRINT_TOOLS_ONLY } from "./review-accept-toolkinds.ts";
import { ASSIGNMENT_SHAPE } from "./review-accept-views.ts";

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

/** A shell builtin whose operands are BINDINGS the shell consumes, not paths any program
 * opens — `export`, the `declare` family, and `env`, whose whole job is to bind a name for
 * the program that follows it. In one of these a `$NAME` / `${NAME}` value is ordinary
 * shell text: `export PATH=/tmp/bats-core/bin:$PATH; bats …` is the single most common
 * shape in the harvested corpus, and refusing it is the ~6,400-command misfire #1764 was
 * filed for. What still ends the proof there is a value that EXECUTES (see
 * `EXEC_EXPANSION`). An assignment-shaped word handed to any OTHER program as an argument
 * is asked the stricter question (#1764 round 5, MUST-DO 6). */
const BINDING_PREFIXES: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "unset",
  "env",
]);

/** The spellings that make a word EXECUTE text: a command substitution or a backtick. An
 * assignment value carrying one runs bytes the guard cannot read whatever the program is
 * (`export F=$(cat "$F")`), so it ends the proof even in a binding position. */
const EXEC_EXPANSION = /\$\(|`/;

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

/** Does one segment of the RAW command pass the understanding test? `words` are the
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
  // An unknown program (or `cd`): every word it is handed must be a literal — the guard
  // does not know what the program OPENS, so an unresolved positional is the end of the
  // proof. Flags carry their value inside and are asked for expansion after unquoting.
  //
  // An ASSIGNMENT-SHAPED word is asked according to WHOSE HAND carries it (#1764 round 5,
  // MUST-DO 6). After the program word it is an argv entry the program itself interprets:
  // `python3 X=$F` hands python3 a word whose final text the guard cannot name, and what an
  // unknown program OPENS with such a word is exactly what the guard does not know, so a
  // value carrying `$` or a backtick ends the proof. Before the program word — or after a
  // binding prefix (`export`, `env`, `declare`) — it is a binding the SHELL consumes, where
  // a plain `$NAME` reference is ordinary text; a binding whose value EXECUTES (`F=$(…)`,
  // `` F=`…` ``) still ends the proof.
  const argvFrom = programWordIndex(words);
  for (let i = 0; i < words.length; i++) {
    const raw = words[i] as string;
    const word = unquote(raw);
    if (word === "") continue;
    if (word.startsWith("-")) {
      if (EXPANSION.test(word)) return false;
      continue;
    }
    if (ASSIGNMENT_SHAPE.test(word)) {
      const prefix = i > 0 ? baseName(unquote(words[i - 1] as string)) : "";
      const handedToProgram = argvFrom >= 0 && i > argvFrom && !BINDING_PREFIXES.has(prefix);
      if (handedToProgram ? EXPANSION.test(word) : EXEC_EXPANSION.test(word)) return false;
      continue;
    }
    if (!patternIsProse(raw)) return false;
  }
  return true;
}

/**
 * Does the guard POSITIVELY understand every segment of this command? Only `true` may
 * lift the base clause-(5) refusal; `false` (and any internal failure) leaves the base
 * verdict standing. `command` is the guard's lowercased raw view, newlines kept.
 *
 * THE TEXT IT READS IS THE RAW COMMAND (#1764 round 5). No call to
 * `withSameCommandAssignmentsApplied` and no call to any other view in
 * `review-accept-views.ts`: a substituted text is a text this harness wrote, and rounds 3
 * and 4 both put the CRITICAL in a proof that trusted one. The only rewrite in this path
 * is `heredocArgumentWords`, which DROPS a heredoc body — bytes the shell hands to stdin
 * and never to the argument vector — so it removes text, it never pastes any in.
 */
export function commandFullyUnderstood(command: string): boolean {
  try {
    const args = understoodArgumentText(command);
    if (args === null) return false;
    return armsOf(args).every((segment) => segmentUnderstood(shellWords(segment)));
  } catch {
    // An exemption that threw is a proof that failed, not a pass.
    return false;
  }
}

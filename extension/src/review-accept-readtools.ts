/**
 * review-accept-readtools — WHICH read tool runs a segment, and whether the file it was
 * handed is one the guard can read (#1764 criterion 1).
 *
 * Clause (a)'s fifth test used to ask "does any word name a read tool, and does the
 * command carry a `$` anywhere". A shell command almost always carries a `$` somewhere —
 * `$?`, `$PATH`, `$PWD` — so on a host that runs `/work` all day that one line put
 * thousands of ordinary commands (`echo "rc=$?"`, `cd $WT && bats …`, `grep -n "pat" f
 * && echo $?`) in front of the arms, where no arm admits them and the findings-store
 * refusal was the answer. Measured on one live run: ~6,400 refusals, none of them aimed
 * at the store.
 *
 * The question clause (5) was reaching for is narrower: a read tool is dangerous only
 * when the FILE it opens is text the guard cannot read, because that is the only shape
 * in which a protected name can be ASSEMBLED rather than spelled. So the tools split
 * three ways, and only two of the three bring a command into scope:
 *
 *  - CONTENT readers (`cat`, `head`, `tail`) — they print the bytes of the file they are
 *    handed, so an unreadable operand is an unreadable read;
 *  - SEARCH tools (`grep`, `rg`) — their FILE operands are the same risk, but their
 *    PATTERN operand is prose: `grep -n 'a$' src/x.ts` is a `$` in a pattern, which
 *    prints nothing of the store and names nothing;
 *  - PRINT / NAVIGATE tools (`echo`, `printf`, `ls`, `wc`, `pwd`, `cd`, `true`, …) — they
 *    read no file an agent could be reaching for the store with. An expansion in one of
 *    their arguments is an ordinary shell (`echo "FMT_EXIT=$?"`) and clause (a) leaves
 *    the command alone.
 *
 * A store name spelled in the clear is still caught — by test (1), which asks every
 * word including a search pattern. This module decides only the unreadable-word question.
 */

import { armsOf, baseName, shellWords, unquote } from "./review-accept-command.ts";
import { withSameCommandAssignmentsApplied } from "./review-accept-views.ts";

/** A word carrying a substitution the shell will resolve later — the guard cannot read
 * what comes out. Same character class clause (5) always asked; what changed is WHO is
 * asked about it. */
const EXPANSION = /[$`]/;
/** A redirection operator word (`>`, `2>`, `>>`): the word after it is a PATH operand and
 * is asked like one, but the operator itself is not an argument. */
const REDIRECT_WORD = /^(?:\d*)?>>?$/;
/** A `-e <pat>` / `--regexp <pat>` pair: the value is prose, like the bare pattern. */
const PATTERN_FLAG = /^(?:-e|--regexp)$/;

/** Tools that print the CONTENT of the file they are handed. */
const CONTENT_TOOLS = new Set(["cat", "head", "tail"]);
/** Tools that search a file: the pattern is prose, the rest are files. */
const SEARCH_TOOLS = new Set(["grep", "rg"]);
/** Tools that print their own arguments or move the shell along: they read no file the
 * guard could be protecting, so an expansion among their arguments is ordinary shell
 * text and brings nothing into scope (#1764 criterion 1's never-a-trigger list). */
const PRINT_TOOLS = new Set([
  "ls",
  "wc",
  "file",
  "stat",
  "which",
  "basename",
  "dirname",
  "echo",
  "printf",
  "cd",
  "pwd",
  "true",
]);

/** The read tools arm A8 admits. Defined HERE, as the union of the three kinds the scope
 * test distinguishes, so the arm's list and the clause's classification cannot drift into
 * each other — a tool added to one and not the other is the bug this shape prevents. */
export const READ_TOOLS = new Set([...CONTENT_TOOLS, ...SEARCH_TOOLS, ...PRINT_TOOLS]);

/** The operands of one read-tool segment the guard must be able to read: everything
 * after the tool except its pattern, its flags, and everything from a heredoc operator
 * on (a heredoc body is data, never an argument — see `normalise`). */
function operandWords(words: string[], search: boolean): string[] {
  const operands: string[] = [];
  let patternSkipped = false;
  for (let i = 1; i < words.length; i++) {
    const raw = words[i] as string;
    if (raw.startsWith("<<")) break;
    const word = unquote(raw);
    if (word === "") continue;
    if (REDIRECT_WORD.test(word)) {
      const target = unquote(words[i + 1] ?? "");
      if (target !== "") operands.push(target);
      i++;
      continue;
    }
    if (word.startsWith("-")) {
      if (search && PATTERN_FLAG.test(word)) i++;
      continue;
    }
    if (search && !patternSkipped) {
      // The FIRST non-option operand is the pattern — prose, not a path.
      patternSkipped = true;
      continue;
    }
    operands.push(word);
  }
  return operands;
}

/**
 * Does some segment of this command run a CONTENT reader or a SEARCH tool on a file
 * operand carrying an expansion that the command itself never resolves? `cat $F` where
 * `F` was assigned earlier in the same command is a readable read; `cat $F` where it was
 * not is a path the guard cannot name, and the command is the guard's business. A
 * PRINT-tool segment (`echo $PATH`) and a search PATTERN (`grep 'a$' f`) never answer yes.
 */
export function readToolCarriesUnresolvedOperand(command: string): boolean {
  const text = withSameCommandAssignmentsApplied(command);
  return armsOf(text).some((segment) => {
    const words = shellWords(segment);
    if (words.length < 2) return false;
    const tool = baseName(unquote(words[0] ?? ""));
    const search = SEARCH_TOOLS.has(tool);
    if (!search && !CONTENT_TOOLS.has(tool)) return false;
    return operandWords(words, search).some((operand) => EXPANSION.test(operand));
  });
}

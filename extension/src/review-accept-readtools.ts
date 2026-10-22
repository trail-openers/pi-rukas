/**
 * review-accept-readtools — WHICH read tool runs a segment, and whether the FILE it was
 * handed is one the guard can read (#1764 criterion 1, hardened in its fix round).
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
 * when the FILE it opens is text the guard cannot read, because that is the only shape in
 * which a protected name can be ASSEMBLED rather than spelled. So the tools split four
 * ways, and three of the four bring a command into scope:
 *
 *  - CONTENT readers (`cat`, `head`, `tail`) — they print the bytes of the file they are
 *    handed, so an unreadable operand is an unreadable read;
 *  - SEARCH tools (`grep`, `rg`) — their FILE operands are the same risk, but their
 *    PATTERN operand is prose: `grep -n 'a$' src/x.ts` is a `$` in a pattern, which
 *    prints nothing of the store and names nothing. A PATTERN FLAG changes that
 *    arithmetic: once `-e` / `--regexp` / `-f` / `--file` appears, the positional is no
 *    longer the pattern, so EVERY positional is a file operand;
 *  - FILE-STAT tools (`ls`, `wc`, `file`, `stat`) — they read the file they are handed
 *    (its bytes, its size, its inode, its directory), so an unreadable operand is an
 *    unreadable read exactly as `cat`'s is. They sit in the PRINT class no longer: `wc -l
 *    $F` is `cat $F` with a different verb, and the fix round moved all four back (#1764);
 *  - PRINT tools (`echo`, `printf`, `pwd`, `true`, `basename`, `dirname`, `which`) — they
 *    read no file an agent could be reaching for the store with, so an expansion among
 *    their arguments is ordinary shell (`echo "FMT_EXIT=$?"`);
 *  - NAVIGATE (`cd`) — admitted, but neither a reader nor a print tool: its operand moves
 *    the shell along, and a `cat` chained after it is still checked, because the CHECK is
 *    per segment.
 *
 * Two sets are deliberately NOT admissible and are still CHECKED, because the question
 * "can this program read the file it was handed?" is not the question "does an arm admit
 * it?": `ag` is a search tool no arm vouches for, and `sed` / `awk` each run a shell
 * (`sed -n '1e id'`, `awk BEGIN{system("id")}`) and write a file (`sed -n 'w /tmp/x'`),
 * which is why they left the allowlist entirely — but `sed -n 1,20p $F` and `awk '{print}'
 * $F` print the bytes of whatever `$F` expands to, so they bring a command into scope
 * exactly as `cat` does (#1764 fix round, criterion 1). A SHELL is not here and never will
 * be: `bash` is deliberately absent from READ_TOOLS — it EXECUTES its operand, which is
 * why `review-accept-arms.ts` counts shells as executing programs.
 *
 * REDIRECTION IS THE EXCEPTION to the tool split (#1764 fix round): a segment that sends
 * bytes to, or reads bytes from, a target the guard cannot resolve is in scope WHATEVER
 * the program is — `echo x > $F` moves bytes through a path no arm ever saw, and the
 * program's own kind says nothing about that. So the redirect-target scan runs above the
 * kind test, for every segment.
 *
 * A store name spelled in the clear is still caught — by test (1), which asks every
 * word including a search pattern. This module decides only the unreadable-word question.
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
import { withSameCommandAssignmentsApplied } from "./review-accept-views.ts";

/** A redirection operator, with whatever the shell glued to it: `>`, `>>`, `2>`, `&>`,
 * `<`, and the attached spellings `>OUT` / `2>OUT`. The word after a bare operator is the
 * PATH the bytes move through, and it is asked like an operand. */
const REDIRECT_WORD = /^(?:\d*)?(?:&>>?|>>?|<)(.*)$/;
/** A `-e <pat>` / `--regexp <pat>` pair, attached or spaced. Its PRESENCE says the
 * positional is not the pattern. Its VALUE: the LONG spelling is a word the tool receives
 * and is asked like any other flag value (#1764 fix round 3, H1); the SHORT `-e` is not,
 * because the arms receive the command case-folded and `grep -E` (extended regex, whose
 * value is the pattern) folds onto `-e` — asking `-e`'s value refused a harvested corpus row
 * (`grep -o -E "[a-z]…$" Dockerfile`) whose unreadable word is a regex nobody opens. The
 * harvested row is the reason the two spellings are not one rule. */
const PATTERN_FLAG = /^(?:-e|--regexp)(?:$|=)/;
/** The pattern-bearing spellings whose VALUE is asked as an operand: `-f` / `--file` name
 * a file the tool opens, and `--regexp` is a word the tool receives. Only the `-e` spelling
 * keeps a prose value. */
const PATTERN_VALUE_ASKED = /^(?:--regexp|-f|--file)(?:$|=)/;
/** `-f <file>` / `--file <file>`: patterns read FROM A FILE, so the value is a path and
 * every positional is a path too. */
const PATTERN_FILE_FLAG = /^(?:-f|--file)(?:$|=)/;
/** A long option whose value is the NEXT word when spelled with a space, and a PATH or a
 * program the tool opens or runs. Spelled with `=` the value already rode inside the flag
 * word and was asked; spaced, it used to fall through as an ordinary word — and for a
 * SEARCH tool the first ordinary word is the PATTERN, which is prose, so
 * `grep --include $F -r x .` read the store path as a regex and walked free (#1764 fix
 * round 3, H1). A spaced value is asked EXACTLY as the attached one is. */
const VALUE_TAKING_LONG =
  /^--(?:exclude-from|ignore-file|pre|pre-glob|include|exclude|file|regexp|exec|command)(?:$|=)/;
/** A HERE-STRING operator (`<<<`, optionally with an fd in front) and whatever the shell
 * glued to it. A here-string is a REDIRECTION of one word to the program's stdin, so the
 * word is asked like any other redirect target — it is not a heredoc and has no body
 * (#1764 fix round 3, H4). */
const HERE_STRING_WORD = /^(?:\d*)?<<<(.*)$/;
/** An option carrying its own value on a SHORT flag: `-Gpath`, `-odata`. The long
 * `--x=y` spelling is read by the caller's `=` split. */
const ATTACHED_VALUE = /^-[A-Za-z](.*)$/;

/** Tools that print the CONTENT of the file they are handed. */
const CONTENT_TOOLS: ReadonlySet<string> = new Set(["cat", "head", "tail"]);
/** Tools that search a file: the pattern is prose, the rest are files — until a pattern
 * flag makes every positional a file. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "rg"]);
/** Pattern-argument tools no arm admits: `ag` is a grep peer the allowlist never named,
 * and `sed` / `awk` were REMOVED from the allowlist because each can run a shell or write
 * a file. They are still asked the operand question — all three print the bytes of the
 * file they are handed — so an unresolved operand on any of them is in scope, where no arm
 * will then admit the segment (#1764 fix round, criterion 1's pattern-tool list). */
const PATTERN_TOOLS_ONLY: ReadonlySet<string> = new Set(["ag", "sed", "awk"]);
/** Tools that read the file they are handed to describe it, not to print it: `wc` counts
 * its bytes, `file` its magic, `stat` its inode, `ls` its directory entry. An unreadable
 * operand is an unreadable read (#1764 fix round: they left PRINT_TOOLS for this). */
const FILE_TOOLS: ReadonlySet<string> = new Set(["ls", "wc", "file", "stat"]);
/** Tools that print their own arguments or move the shell along: they read no file the
 * guard could be protecting, so an expansion among their arguments is ordinary shell
 * text and brings nothing into scope (#1764 criterion 1's never-a-trigger list). */
const PRINT_TOOLS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "pwd",
  "true",
  "basename",
  "dirname",
  "which",
]);
/** A navigate tool: admitted by A8, reads no file, prints no file. Separated from the
 * print class so "PRINT_TOOLS is exactly the seven argument-printers" stays a checkable
 * claim (#1764 fix round, criterion 3). */
const NAVIGATE_TOOLS: ReadonlySet<string> = new Set(["cd"]);

/** The read tools arm A8 admits. Defined HERE, as the union of the kinds the scope test
 * distinguishes, so the arm's list and the clause's classification cannot drift into each
 * other — a tool added to one and not the other is the bug this shape prevents. The
 * pattern tools no arm admits are deliberately NOT in this union. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  ...CONTENT_TOOLS,
  ...SEARCH_TOOLS,
  ...FILE_TOOLS,
  ...PRINT_TOOLS,
  ...NAVIGATE_TOOLS,
]);

/** The tools whose FILE operands the scope test asks: everything that opens a file it was
 * handed, admissible or not. A SEARCH-class tool's first positional is its pattern; the
 * two sets share that arithmetic because the pattern prose is the same fact for `grep` and
 * for `awk` alike. */
const CHECKED_TOOLS: ReadonlySet<string> = new Set([
  ...CONTENT_TOOLS,
  ...FILE_TOOLS,
  ...SEARCH_TOOLS,
  ...PATTERN_TOOLS_ONLY,
]);
/** Among the checked tools, the ones whose FIRST positional is a pattern / program rather
 * than a file. */
const PATTERN_FIRST: ReadonlySet<string> = new Set([...SEARCH_TOOLS, ...PATTERN_TOOLS_ONLY]);

/** The value an option carries: `--include=X` → `X`, `-Gpath` → `path`. `""` when the
 * option takes no attached value (a switch, or a spaced option whose value is the NEXT
 * word and is handled by the caller). */
function attachedOptionValue(word: string): string {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    return eq < 0 ? "" : word.slice(eq + 1);
  }
  return ATTACHED_VALUE.exec(word)?.[1] ?? "";
}

/**
 * The words of one tool segment the guard must be able to read: its file operands and its
 * redirection targets, minus its flags and — for a SEARCH tool with no explicit pattern
 * flag — its single positional PATTERN. Everything from a heredoc operator on is data,
 * never an argument (see `normalise`), so the scan stops there.
 *
 * Three shapes the fix round closed (#1764), all of them the same mistake — reading
 * "the first positional is the pattern" as if no flag could change it:
 *
 *  - an explicit PATTERN FLAG (`-e`, `--regexp`, `-f`, `--file`) anywhere in the segment
 *    ends the pattern reading: what follows is a FILE operand, so `grep -e "" $F` names
 *    an unreadable file and `grep -f $P notes.txt` names two;
 *  - the option `-f` / `--file` takes a PATH as its value, and that path is asked;
 *  - `--` ends the OPTIONS, not the operands: every positional after it is a file, so
 *    `grep -e pat -- $F` is refused even though a naive scan treats `--` as a flag.
 */
function operandWords(words: string[], search: boolean): string[] {
  const operands: string[] = [];
  let patternTaken = false;
  let optionsOver = false;
  for (let i = 1; i < words.length; i++) {
    const raw = words[i] as string;
    // A here-string's word is an operand, not a body: `cat <<<$F` hands the program the
    // bytes of whatever `$F` is, and the scan must not stop at the `<`s the way it stops
    // at a heredoc (#1764 H4).
    if (/^(?:\d*)?<<</.test(raw)) {
      const here = HERE_STRING_WORD.exec(unquote(raw));
      const inline = here?.[1] ?? "";
      if (inline !== "") operands.push(inline);
      else {
        const next = unquote(words[i + 1] ?? "");
        if (next !== "") operands.push(next);
        i++;
      }
      continue;
    }
    if (raw.startsWith("<<")) break;
    const word = unquote(raw);
    if (word === "") continue;
    if (!optionsOver && word === "--") {
      optionsOver = true;
      continue;
    }
    if (!optionsOver && word.startsWith("-")) {
      if (search && (PATTERN_FILE_FLAG.test(word) || PATTERN_FLAG.test(word))) {
        // The flag's PRESENCE is what makes every later positional a file. Its value is
        // asked as an operand when the spelling is one whose value the tool opens or
        // receives (`--file`, `--regexp`); the folded-`-E` `-e` keeps its prose value and
        // simply consumes it when spaced, so the pattern does not resurface as a file.
        patternTaken = true;
        const attached = attachedOptionValue(word);
        if (PATTERN_VALUE_ASKED.test(word)) {
          if (attached !== "") operands.push(attached);
          else {
            const next = unquote(words[i + 1] ?? "");
            if (next !== "") operands.push(next);
            i++;
          }
        } else if (attached === "") i++;
        continue;
      }
      const attached = attachedOptionValue(word);
      if (attached !== "") {
        operands.push(attached);
        continue;
      }
      if (VALUE_TAKING_LONG.test(word)) {
        // Spaced: the value is the next word, and the tool opens it. Same question as the
        // `=` spelling, which the branch above already asked.
        const next = unquote(words[i + 1] ?? "");
        if (next !== "") operands.push(next);
        i++;
      }
      continue;
    }
    if (search && !patternTaken && !optionsOver) {
      // The FIRST non-option operand is the pattern — prose, not a path. `grep -n 'a$'
      // src/x.ts` is a `$` in a pattern, and the row that this exception exists for.
      patternTaken = true;
      continue;
    }
    operands.push(word);
  }
  return operands;
}

/** The targets of every redirection in one segment, bare-operator and attached alike.
 * Asked of EVERY segment whatever its program: a redirection moves bytes through a path
 * no arm ever saw, which is a fact about the segment, not about `cat` vs `echo`. */
function redirectTargets(words: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = unquote(words[i] ?? "");
    // A here-string is a redirection of ONE word, so unlike a heredoc it does not end the
    // scan — the word it points at is a target the guard has to be able to name.
    if (/^(?:\d*)?<<</.test(word)) {
      const inline = HERE_STRING_WORD.exec(word)?.[1] ?? "";
      if (inline !== "") {
        targets.push(inline);
        continue;
      }
      const next = unquote(words[i + 1] ?? "");
      if (next !== "") targets.push(next);
      i++;
      continue;
    }
    if (word.startsWith("<<")) break;
    const match = REDIRECT_WORD.exec(word);
    if (match === null) continue;
    const inline = match[1] ?? "";
    if (inline !== "") {
      targets.push(inline);
      continue;
    }
    const next = unquote(words[i + 1] ?? "");
    if (next !== "") targets.push(next);
    i++;
  }
  return targets;
}

/** The command with every heredoc reduced to the words the shell parses as THIS command's
 * arguments — the words after the OPENING tag on its line (`cat <<'PY' > $F` redirects to
 * `$F`, and dropping them was the hole criterion 5 names) and the words after the CLOSING
 * tag (`… EOF | sh`) — with every BODY dropped, quoted or not.
 *
 * This is the view the read-tool OPERAND test asks, and it is deliberately a different
 * question from `withoutHeredocBodies`: there an unquoted body stays visible because the
 * shell expands it into what the program RECEIVES; here a body's words were never
 * arguments of the program at all, and reading them as operands refused the harvested
 * corpus rows whose bodies carry a `$` (`cat > /tmp/w.py <<'PY' … "$@" … PY`) — an
 * over-refusal of a file write the guard can read end to end (#1764 fix round, criteria 4
 * and 5 read together). `null` when a body never terminates (the flattened single-line
 * shape those harvested rows carry): the caller then asks the raw text, where the loops
 * below stop at the `<<` — the behaviour the corpus was measured against. On a body that
 * never terminates the RAW command is handed back, never the prefix seen so far: a view
 * that quietly loses the tail of a command is the guard failing open, and the loops below
 * stop at the `<<` on their own (#1764 fix round 3, C1).
 */
function heredocArgumentText(command: string): string {
  let visible = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === "'" || c === '"') {
      const end = c === "'" ? command.indexOf("'", i + 1) : closingQuote(command, i);
      if (end < 0) return command;
      visible += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i) && !command.startsWith("<<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return command;
      visible += ` ${[past.head, past.tail].filter((x) => x !== "").join(" ")} `;
      i = past.end;
      continue;
    }
    visible += c;
    i++;
  }
  return visible;
}

/** A word that is not the program: the shell's group punctuation and keywords, and the
 * prefixes that hand the real program to the NEXT word. Asked because the read-tool test
 * decides by PROGRAM NAME, and a scanner that read `sudo` or `(` as the program saw no
 * read tool at all — `sudo cat $F` and `(cat $F)` both walked free while `cat $F` was
 * refused (#1764 fix round: a prefix word must not hide the program behind it). */
const NOT_THE_PROGRAM =
  /^(?:sudo|env|nohup|time|command|exec|builtin|nice|stdbuf|noglob|do|then|else|fi|done|while|until|if)$/;
/** An environment binding in front of a program (`sudo F=x cat $F`): neither the program
 * nor one of its operands. */
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The name of the program a segment runs, past whatever the shell puts in front of it. */
function programName(words: string[]): string {
  for (const raw of words) {
    const word = unquote(raw).replace(/^[([{]+|[)\]};]+$/g, "");
    if (word === "" || LEADING_ASSIGNMENT.test(word) || NOT_THE_PROGRAM.test(word)) continue;
    return baseName(word);
  }
  return "";
}

/**
 * Does some segment of this command hand the guard a file it cannot name? Three shapes
 * answer yes: a CONTENT / SEARCH / FILE-stat tool whose file operand carries an expansion
 * the command never resolved; a search tool whose PATTERN is unreadable next to a file
 * operand; and ANY segment — whatever its program — redirecting to or from a target
 * carrying an expansion (`echo x > $F`). `cat $F` where `F` was assigned earlier in the
 * same command is a readable read; `cat $F` where it was not is a path the guard cannot
 * name, and the command is the guard's business.
 */
export function readToolCarriesUnresolvedOperand(command: string): boolean {
  const text = withSameCommandAssignmentsApplied(heredocArgumentText(command));
  return armsOf(text).some((segment) => {
    const words = shellWords(segment);
    // The redirect test runs FIRST and on EVERY segment: a segment's own program kind says
    // nothing about the bytes its redirection moves (#1764 criterion 2).
    if (redirectTargets(words).some((target) => EXPANSION.test(target))) return true;
    if (words.length < 2) return false;
    const tool = programName(words);
    if (!CHECKED_TOOLS.has(tool)) return false;
    return operandWords(words, PATTERN_FIRST.has(tool)).some((operand) => EXPANSION.test(operand));
  });
}

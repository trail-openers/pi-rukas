/**
 * merge-inert-write — the one shape the merge classifier answers `none` for on
 * its command words alone: text written to a file by `cat`/`printf`/`echo`.
 *
 * #1559. The trigger (merge-trigger.ts) reads the raw text, so a verdict file
 * whose PROSE spells a merge next to a forge word — `cat > spec.md <<'EOF'`
 * quoting an issue that says "the PR merge flow in gh" — was held four times
 * in one parked cycle, and the agent got its file written only by splitting
 * the text until no single command spelled both words. What a command does is
 * decided by its command words, not by its arguments: a `printf … > FILE`
 * execs `printf` whatever the quoted text says.
 *
 * So this answers one question, conservatively: is EVERY simple command in the
 * text one of `cat` / `printf` / `echo` with its stdout redirected to a file,
 * or an inert `mkdir` / `true`, with nothing bash would execute hidden inside?
 * Anything it cannot prove that of answers `false` and goes to the trigger and
 * the grammar exactly as before, so this can only ever shorten a hold, never
 * read a merge. Refused outright (answer `false`):
 *
 *   - any command word that is not in `INERT`, or is quoted/escaped/expanded
 *     (`bash`, `sh`, `eval`, `xargs`, `env`, `FOO=1 echo`, `"cat"`);
 *   - a pipe, a background `&`, a subshell or group `( ) { }`, a comment;
 *   - a command substitution or process substitution anywhere bash would
 *     run one: `$(` / backtick outside single quotes, `<(` / `>(`, and the
 *     same inside an UNQUOTED heredoc body (a quoted one is literal);
 *   - a here-string `<<<`, an unterminated heredoc, a heredoc delimiter
 *     glued to more text (`<<E\OF`), an ANSI-C `$'…'` string (its `\'`
 *     does not close the quote), an unbalanced quote;
 *   - a text command whose stdout is not redirected to a file (`echo "gh pr
 *     merge 12"` stays judged by the trigger), an fd duplication (`>&`), and
 *     a `/dev/tcp` or `/dev/udp` target.
 *
 * Linear: one pass over the text, each heredoc body line read once.
 */

/** Command words whose execution reaches no forge, whatever their arguments. */
const TEXT_WRITERS = new Set(["cat", "printf", "echo"]);
const INERT = new Set([...TEXT_WRITERS, "mkdir", "true"]);

interface Segment {
  words: string[];
  /** Whether the first word was spelled with quotes, escapes or expansions. */
  plainHead: boolean;
  stdoutToFile: boolean;
  badTarget: boolean;
}

interface Heredoc {
  delim: string;
  stripTabs: boolean;
  quoted: boolean;
}

/** Whether an unquoted heredoc body line would run a command. */
const expandsCommand = (line: string): boolean => line.includes("`") || line.includes("$(");

/** Whether `command` is nothing but text written to files (see the module doc). */
export function isInertFileWrite(command: string): boolean {
  const segments: Segment[] = [];
  let seg: Segment = { words: [], plainHead: true, stdoutToFile: false, badTarget: false };
  let word: string | undefined;
  let wordPlain = true;
  let redirect: "stdout" | "other" | undefined;
  let quote: "'" | '"' | undefined;
  const pending: Heredoc[] = [];
  const n = command.length;

  const endWord = (): void => {
    if (word === undefined) return;
    if (redirect !== undefined) {
      if (/^\/dev\/(?:tcp|udp)\//.test(word)) seg.badTarget = true;
      if (redirect === "stdout") seg.stdoutToFile = true;
      redirect = undefined;
    } else {
      if (seg.words.length === 0) seg.plainHead = wordPlain;
      seg.words.push(word);
    }
    word = undefined;
    wordPlain = true;
  };
  const endSegment = (): boolean => {
    endWord();
    if (redirect !== undefined) return false; // a redirection with no target
    if (seg.words.length > 0 || seg.stdoutToFile) segments.push(seg);
    seg = { words: [], plainHead: true, stdoutToFile: false, badTarget: false };
    return true;
  };
  const add = (ch: string, plain = true): void => {
    word = (word ?? "") + ch;
    if (!plain) wordPlain = false;
  };

  for (let i = 0; i < n; i += 1) {
    const ch = command[i] as string;
    const next = command[i + 1] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else add(ch);
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) return false;
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\") {
        add(next);
        i += 1;
      } else add(ch);
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      add("", false);
    } else if (ch === "\\") {
      if (next !== "\n") add(next, false);
      i += 1;
    } else if (ch === "$") {
      if (next === "'") return false; // ANSI-C: `\'` does not end the quote
      add(ch, false);
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === ";") {
      if (!endSegment()) return false;
    } else if (ch === "&" || ch === "|") {
      if (next !== ch) return false; // a pipe or a background job
      if (!endSegment()) return false;
      i += 1;
    } else if (ch === "\n") {
      if (!endSegment()) return false;
      const resume = consumeHeredocs(command, i + 1, pending);
      if (resume === undefined) return false;
      i = resume - 1;
    } else if (ch === "<" && next === "<") {
      if (command[i + 2] === "<") return false; // a here-string
      const op = readHeredocOperator(command, i + 2);
      if (op === undefined) return false;
      endWord();
      pending.push(op.heredoc);
      i = op.end - 1;
    } else if (ch === ">" || ch === "<") {
      if (next === "(" || next === "&" || redirect !== undefined) return false;
      const fd = word;
      word = undefined;
      wordPlain = true;
      if (fd !== undefined && !/^[0-9]+$/.test(fd)) {
        word = fd;
        endWord();
      }
      redirect = ch === ">" && (fd === undefined || fd === "1") ? "stdout" : "other";
      if (ch === ">" && (next === ">" || next === "|")) i += 1;
    } else if ("(){}#".includes(ch) && word === undefined) {
      return false;
    } else if ("()".includes(ch)) {
      return false;
    } else {
      add(ch);
    }
  }
  if (quote !== undefined || pending.length > 0 || !endSegment()) return false;
  if (segments.length === 0) return false;
  return segments.every((s) => {
    const head = s.words[0];
    if (head === undefined || !s.plainHead || !INERT.has(head) || s.badTarget) return false;
    return !TEXT_WRITERS.has(head) || s.stdoutToFile;
  });
}

/** `[-] [blanks] DELIM`, the delimiter ending at a word boundary. Sticky: matched at an index. */
const HEREDOC_OPERATOR =
  /(-?)[ \t]*(?:'([\w.-]+)'|"([\w.-]+)"|\\([\w.-]+)|([\w.-]+))(?=[\s;&|<>]|$)/y;

/** Read `[-] [blanks] DELIM` after a `<<`; the delimiter may be quoted or escaped. */
function readHeredocOperator(
  command: string,
  start: number,
): { heredoc: Heredoc; end: number } | undefined {
  HEREDOC_OPERATOR.lastIndex = start;
  const m = HEREDOC_OPERATOR.exec(command);
  if (m === null) return undefined;
  const bare = m[5];
  const delim = m[2] ?? m[3] ?? m[4] ?? bare ?? "";
  return {
    heredoc: { delim, stripTabs: m[1] === "-", quoted: bare === undefined },
    end: start + m[0].length,
  };
}

/**
 * Skip the bodies of the heredocs opened on the line that just ended, in
 * order. Returns the index after the last terminator line, or undefined when a
 * body is unterminated or an unquoted body would run a command.
 */
function consumeHeredocs(command: string, start: number, pending: Heredoc[]): number | undefined {
  let at = start;
  while (pending.length > 0) {
    const doc = pending.shift() as Heredoc;
    for (;;) {
      if (at > command.length) return undefined;
      const nl = command.indexOf("\n", at);
      const end = nl === -1 ? command.length : nl;
      const raw = command.slice(at, end);
      const line = doc.stripTabs ? raw.replace(/^\t+/, "") : raw;
      at = end + 1;
      if (line === doc.delim) break;
      if (!doc.quoted && expandsCommand(line)) return undefined;
      if (nl === -1) return undefined;
    }
  }
  return at;
}

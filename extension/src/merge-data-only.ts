/**
 * merge-data-only — the one question #2125 added to the merge classifier: does
 * this command mention a merge ONLY in data, meaning text bash hands to a
 * program as an argument or as input rather than text it execs?
 *
 * The trigger (merge-trigger.ts) scans the RAW command, so vocabulary that
 * lives only in data holds commands that exec no forge: a memory note quoting
 * the verb pair, a grep pattern naming the merge form, a commit message
 * explaining a merge, a `cat <<'EOF'` whose body quotes a merge command. The
 * field sweep of held commands showed those shapes are the majority of holds.
 *
 * So this answers one conservative question, and can only ever shorten a hold:
 *
 *   1. The WHOLE command parses in a deliberately small grammar — plain words,
 *      `'…'` strings, `"…"` strings carrying no `$`, backtick or backslash,
 *      quoted-delimiter heredocs (`<<'X'` / `<<"X"`, body up to a line equal
 *      to X), the separators `|`, `&&`, `||`, `;` and newline, and `>` `>>` `<`
 *      to a plain path. Anything else — an unquoted `$ \` \ ( ) { } * ? ~ !`,
 *      a bare `&`, an unquoted heredoc, a here-string, `/dev/tcp` — answers
 *      `false` and the command is judged on its raw text exactly as today. An
 *      unrecognised shape is a refusal, never a partial read.
 *   2. Each segment's command word is taken by basename after the existing
 *      WRAPPERS unwrap (bash-destructive-write.ts — no second wrapper list).
 *      The segment EXECUTES — so its arguments are code, not data — when that
 *      word is a shell, an interpreter, an argument-running builtin or
 *      launcher, an HTTP/forge client, `git` with a merge-capable subcommand,
 *      or a word that is not a plain identifier. A pipeline that feeds an
 *      executing segment makes every segment of that pipeline executing, and so
 *      does a heredoc attached to one (its body is that program's stdin).
 *   3. `true` only when no executing segment's raw text spells the merge
 *      vocabulary and some non-executing segment's raw text does.
 *
 * A redirect target is a destination, not a program, so a file writer's heredoc
 * body stays data whatever punctuation its prose carries. Linear: one pass over
 * the text, each heredoc body line read once.
 */

import { SHELLS, unwrap } from "./bash-destructive-write.ts";
import { MERGE_WORD, VERB_PAIR } from "./merge-lex-views.ts";

/** Words outside `SHELLS` that run what bash hands them as arguments. */
const INTERPRETERS = new Set([
  "awk",
  "bun",
  "deno",
  "expect",
  "groovy",
  "java",
  "jshell",
  "lua",
  "mysql",
  "node",
  "perl",
  "php",
  "psql",
  "python",
  "python2",
  "python3",
  "ruby",
  "sqlite3",
  "sqlplus",
]);
/** Argument-running builtins and tools outside the wrapper set. */
const RUNNERS = new Set([".", "command", "builtin", "eval", "exec", "nohup", "source", "xargs"]);
/**
 * Builtins whose argument becomes a command bash later runs (`alias m='gh pr
 * merge'`). Their argument is deferred code, so the segment executes what it
 * names even though no program runs at definition time.
 */
const DEFINERS = new Set(["alias", "declare", "typeset", "export", "readonly"]);
/** Clients that reach the forge over HTTP, or speak its CLI under another name. */
const CLIENTS = new Set(["curl", "wget", "http", "https", "httpie", "gh", "glab", "hub"]);
/** The forge CLIs themselves: a word naming one anywhere runs what it is given. */
const FORGE_CLI = new Set(["gh", "glab", "hub"]);
/** Words that run another program, and so run what their arguments name. */
const LAUNCHERS = new Set(["sudo", "doas", "setsid", "watch", "env", "time"]);
/** Writers whose heredoc body is text they do not interpret. */
const WRITERS = new Set(["cat", "echo", "printf", "tee"]);
/** `git` subcommands that move commits, and so can perform a merge. */
const GIT_MOVING = new Set(["merge", "pull", "am", "cherry-pick", "rebase", "push"]);
/** A quoted heredoc delimiter: `<<'X'`, `<<"X"` or the escaped `<<\X`. */
const QUOTED_DELIM = /(?:'([\w.-]+)'|"([\w.-]+)"|\\([\w.-]+))/y;
/**
 * Characters the small grammar does not place outside quotes: every one of
 * them is an expansion, a glob, a grouping, a comment or an escape in bash, so
 * a command carrying one is judged on its raw text exactly as today.
 */
const FORBIDDEN = "$`\\(){}*?~!#[]|&;,<>";

/** Whether the basename of `word` is in `set`. */
function isOneOf(word: string | undefined, set: ReadonlySet<string>): boolean {
  return word !== undefined && set.has(word.split("/").pop() ?? "");
}

/** Whether `w` names a program that the words after a launcher would run. */
function executableWord(w: string): boolean {
  if (w.startsWith("-")) return false;
  const head = w.split("/").pop() ?? "";
  return SHELLS.has(head) || INTERPRETERS.has(head) || CLIENTS.has(head) || RUNNERS.has(head);
}

/** Whether `words` is a segment that execs what it is given. */
function executes(words: string[], heredoc: boolean, redirected: boolean): boolean {
  const { argv, split } = unwrap(words);
  // `env -S STRING` re-splits its payload into a command line bash execs.
  if (split !== undefined) return true;
  const head = argv[0];
  // A word naming a program that RUNS its arguments (a forge CLI, a shell, an
  // interpreter, a runner, an alias definer, a launcher) anywhere in the
  // segment makes it execute: in the small grammar such words only appear in
  // command-word position (heredoc bodies and quoted args never become words),
  // so catching them anywhere covers `oo gh pr merge`, `GH pr merge`,
  // `./g pr merge` where the tool is not the head. Writers (`cat`, `echo`,
  // `printf`, `tee`) and the inert `git` subcommands are excluded: their text
  // is data, not a program to run.
  const anyWordRuns = argv.some((w, wAt) => {
    if (w.startsWith("-")) return false;
    const base = w.split("/").pop() ?? "";
    if (isOneOf(base, WRITERS)) return false;
    // `.` and `source` are only the dot-source builtin in COMMAND-WORD
    // position; elsewhere a bare `.` is a path (`grep -rn x .`, `cat > .`).
    if ((base === "." || base === "source") && wAt !== 0) return false;
    return (
      FORGE_CLI.has(base) ||
      SHELLS.has(base) ||
      INTERPRETERS.has(base) ||
      RUNNERS.has(base) ||
      DEFINERS.has(base) ||
      LAUNCHERS.has(base)
    );
  });
  if (anyWordRuns) return true;
  // A command word bash would not dispatch on plainly (`$m`, `"cat"`) is not
  // readable here, so it is treated as running whatever it is given.
  if (head === undefined || !/^[A-Za-z0-9_.\/-]+$/.test(head) || isOneOf(head, SHELLS)) {
    return true;
  }
  // The forge/HTTP tools run whatever their arguments name: the `gh api` REST
  // merge door is a command word plus a path.
  if (isOneOf(head, CLIENTS)) return true;
  // `eval`, `.` and `source` run their argument as shell code, so a literal
  // argument spelling a merge is EXECUTED, not held as data — unlike `xargs`
  // or `command`, which take a program word their `argv` does expose.
  if (isOneOf(head, new Set([".", "eval", "source"]))) return true;
  // An alias/function definition hands bash a command line to run later, so a
  // literal argument spelling a merge is code, not data.
  if (isOneOf(head, DEFINERS)) return true;
  // A bare (unquoted) forge verb pair among the words is a merge being invoked
  // on some command word this parser cannot resolve to a known tool (`GH pr
  // merge`, `./g pr merge`, `hubcli mr merge`). Quoted strings and heredoc
  // bodies never become words, so a mention only there stays data.
  for (let w = 1; w < argv.length; w += 1) {
    const a = argv[w] ?? "";
    const b = argv[w + 1] ?? "";
    if (/^(?:pr|mr)$/i.test(a) && /^(?:merge|accept)$/i.test(b)) return true;
  }
  // A wrapper or argument-running builtin executes its arguments only when one
  // of them names a program (`timeout 5 python3 m.py`, `echo x | xargs gh …`).
  if (isOneOf(head, RUNNERS) || isOneOf(head, LAUNCHERS)) {
    return argv.slice(1).some(executableWord);
  }
  // A writer's output is data only when it reaches a terminal: stdout or a
  // plain file. Piping it (`echo … | sh`) hands the text to another program,
  // and redirecting it to a file that a later segment may run is out of this
  // predicate's view — so only an unwritten writer keeps its text as data.
  if (heredoc && !isOneOf(head, WRITERS)) return true;
  // A writer's text is data only while it reaches a terminal: stdout, or a
  // plain file redirected by the inert-write rule. A redirection this parser
  // saw (`> file`) means text is being staged to disk for a possible later
  // `sh`, which the predicate cannot see; refuse the exemption (AGENTS §6).
  if (isOneOf(head, WRITERS) && redirected) return true;
  if (isOneOf(head, INTERPRETERS) || isOneOf(head, GIT_MOVING)) return true;
  // `git merge-capable-subcommand`, however many flags sit between the two.
  if (isOneOf(head, new Set(["git"]))) return argv.slice(1).some((w) => GIT_MOVING.has(w));
  return false;
}

/** One parsed segment: raw text, words, whether it opens a heredoc or pipes. */
interface Segment {
  text: string;
  words: string[];
  heredoc: boolean;
  /** Whether the segment carried a `>`/`>>` redirection this parser saw. */
  redirected: boolean;
  /** Whether a `|` ends it, so the next segment is fed by this one. */
  piped: boolean;
}

/** Whether the raw text of `s` spells the merge vocabulary the trigger spells. */
const spellsMerge = (s: Segment): boolean => MERGE_WORD.test(s.text) || VERB_PAIR.test(s.text);

/** The verdict over the parsed segments: no executing segment may spell a merge. */
function verdict(segments: Segment[]): boolean {
  if (segments.length === 0) return false;
  const end = segments.length - 1;
  const executing = segments.map((_, at) => {
    let head = at;
    while (head > 0 && segments[head - 1]?.piped) head -= 1;
    let tail = at;
    while (tail < end && segments[tail]?.piped) tail += 1;
    for (let k = head; k <= tail; k += 1) {
      const s = segments[k] as Segment;
      if (executes(s.words, s.heredoc, s.redirected)) return true;
    }
    return false;
  });
  if (segments.some((s, at) => executing[at] && spellsMerge(s))) return false;
  return segments.some((s, at) => !executing[at] && spellsMerge(s));
}

/**
 * Whether `command` mentions a merge only in data. `false` whenever the shape
 * is outside the small grammar, whenever any executing segment's raw text
 * spells a merge, or when nothing outside the executing segments mentions one.
 */
export function dataOnlyMergeMention(command: string): boolean {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  /** The delimiter of the heredoc the current segment opens, if any. */
  let delim: string | undefined;
  let redirect = false;
  /** Whether the current segment carried a redirection operator at all. */
  let segHasOperator = false;
  /** Whether the current segment still expects its command word. */
  let expectHead = true;
  /** The raw text of the segment being scanned, heredoc bodies included. */
  let segText = "";
  const n = command.length;

  const pushWord = (): boolean => {
    if (!inWord) return true;
    if (redirect) {
      // The word after `>` or `>>` is a destination, not a program: it joins the
      // segment's raw text only, so `/dev/tcp/…` is never read as an executable.
      if (!/^[A-Za-z0-9_./+-]+$/.test(word)) return false;
      redirect = false;
    } else {
      words.push(word);
      expectHead = false;
    }
    inWord = false;
    word = "";
    return true;
  };
  const endSegment = (piped = false): boolean => {
    if (!pushWord()) return false;
    if (redirect || (expectHead && words.length === 0 && segHasOperator)) {
      return false; // a redirection operator whose target is missing
    }
    const at = words.length > 0;
    const segRedirected = segHasOperator;
    redirect = false;
    expectHead = true;
    segHasOperator = false;
    if (at)
      segments.push({ text: segText, words, heredoc: false, redirected: segRedirected, piped });
    words = [];
    segText = "";
    return true;
  };
  const add = (w: string, raw: string): void => {
    word += w;
    segText += raw;
    inWord = true;
  };

  for (let i = 0; i < n; i += 1) {
    const ch = command[i] as string;
    if (ch === "\n" && delim !== undefined) {
      // Consume the heredoc this segment opened: every body line, then the
      // terminator line. The body is literal text the reader program receives
      // (an argument to `cat`, stdin to a shell), so it joins this segment's
      // raw text and never spawns a new segment. The loop owns its cursor `k`
      // and returns the terminator's newline, so the outer loop's own
      // increment resumes cleanly on whatever follows the heredoc.
      let k = i;
      let bodyText = "";
      for (;;) {
        const nl = command.indexOf("\n", k + 1);
        const line = command.slice(k + 1, nl === -1 ? n : nl);
        if (line === delim) break;
        if (nl === -1) return false; // an unterminated heredoc
        if (/[$`\\]/.test(line)) return false; // an expansion the scanner cannot place
        bodyText += `${line}\n`;
        k = nl;
      }
      // The terminator must stand at column 0 on its own line: whatever follows
      // it must be a separator, as bash requires.
      const rest = command.slice(k + 1);
      if (rest !== "" && !/^[\s;&|()]/.test(rest)) return false;
      const openedWords = words;
      const opened: Segment = {
        text: `${segText}${bodyText}`,
        words: openedWords,
        heredoc: true,
        redirected: segHasOperator,
        piped: false,
      };
      words = [];
      segText = "";
      delim = undefined;
      redirect = false;
      expectHead = true;
      segHasOperator = false;
      if (opened.words.length > 0) segments.push(opened);
      // `k` is the terminator's newline; the outer increment resumes at the
      // next command's first byte. A trailing newline (`k === n - 1`) is the
      // normal end of the command.
      i = k;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushWord();
      segText += ch;
    } else if ((ch === "\n" || ch === ";" || ch === "&" || ch === "|") && delim === undefined) {
      // Only `&&`, `||`, `;` and `\n` separate; a bare `&` is outside the
      // grammar, and a `|` that ends a segment marks the pipeline.
      if (ch === "&" && command[i + 1] !== "&") return false;
      if (!endSegment(ch === "|" && command[i + 1] !== "|")) return false;
      if (command[i + 1] === ch && ch !== "\n") i += 1;
    } else if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end === -1) return false;
      const body = command.slice(i + 1, end);
      if (ch === '"' && /[$`\\]/.test(body)) return false;
      add(body, command.slice(i, end + 1));
      i = end;
    } else if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<" || delim !== undefined) return false; // here-string
      QUOTED_DELIM.lastIndex = i + 2;
      const m = QUOTED_DELIM.exec(command);
      if (m === null) return false; // an unquoted delimiter: the body expands
      pushWord();
      const operator = command.slice(i, QUOTED_DELIM.lastIndex);
      segText += operator;
      delim = operator
        .slice(2)
        .replace(/^[-\s]+/, "")
        .replace(/^['"\\]|['"\\]$/g, "");
      i = QUOTED_DELIM.lastIndex - 1;
    } else if (ch === ">" || (ch === "<" && delim === undefined)) {
      if (redirect) return false; // a second redirection in one segment
      pushWord();
      segText += ch;
      if (command[i + 1] === ">" || command[i + 1] === "|") {
        i += 1;
        segText += ch;
      }
      // `2>&1` and `>&` duplicate a descriptor, which the scanner cannot read
      // as a destination, so an `&` after the operator refuses the command.
      if (command[i + 1] === "&") return false;
      redirect = true;
      segHasOperator = true;
    } else if (FORBIDDEN.includes(ch) || ch < " " || ch > "~") {
      return false; // a metacharacter the small grammar does not cover
    } else {
      add(ch, ch);
    }
  }
  return verdict(endSegment() ? segments : []);
}

/**
 * review-accept-guard — deny-by-default refusal of agent bash that could reach the
 * review findings store (#1105, #1125).
 *
 * Accepting a recorded review finding suppresses it from every later round, so it
 * must stay a human act: the operator runs `extension/scripts/review-accept.ts` in a
 * terminal. This hook refuses, in every mode and for every role, agent bash that
 * could reach that store, and agent edit / write / multiedit of the findings file,
 * one of its `.tmp` / `.corrupt` siblings, or the store module's own source.
 *
 * ADVISORY, not a security boundary: every rule is a string match on the command
 * text or the target path. The threat model is the honest-but-forgetful agent, and
 * the operator's terminal is the real boundary.
 *
 * ── THE ADJUDICATION RULE (the spec of #1125; operator decision 2026-10-16) ──────
 *
 *   (a) ORDERING. An EXACT allowlist of read-only command forms is authoritative.
 *       Every OTHER bash command that names the findings store — the data file, the
 *       store module, their stems, or a `.tmp` / `.corrupt` sibling — is refused. A
 *       command that cannot be parsed (unbalanced quotes, an unreadable heredoc
 *       body, a throw inside this module) is refused too.
 *   (b) POLARITY. Fail closed. Over-refusing a harmless read is an ACCEPTED COST
 *       (see KNOWN OVER-REFUSALS below), and the refusal names the flag to drop or
 *       the accept CLI to use instead.
 *   (c) EVOLUTION. A newly discovered bypass spelling is closed by REMOVING AN
 *       ALLOWANCE or ADDING A REFUSAL — never by adding a new command scanner.
 *       There is deliberately no "plain git" exemption, no per-route scanner and no
 *       positional runtime test in this file: there is one allowlist, and the only
 *       way in is to match one of its arms.
 *
 * ── THE DECISION, in order ───────────────────────────────────────────────────────
 *
 *   1. normalise(): ONE pass — lowercase, whitespace and newlines collapsed,
 *      balanced `'…'` / `"…"` spans removed (their contents are prose, so a commit
 *      message may name the store), heredoc bodies removed. An odd count of `'` or
 *      `"`, or a heredoc whose delimiter never returns, is PARSE_FAIL and clause (a)
 *      refuses it: the caller never sees a partial normalisation.
 *   2. namesAnythingProtected(): TOKEN-wise match against the protected names, their
 *      stems and the `.tmp` / `.corrupt` siblings, asked of BOTH the raw and the
 *      normalised text — the flag-dropping bug that made `matchAll` read one token is
 *      closed by the explicit `g` flag in tokensOf().
 *   3. THE FAST PATH: nothing protected is named, and no runtime word, no git/gh/
 *      glab, no edit-capable word and no redirect appears → allow, before the
 *      allowlist is consulted. This is why deny-by-default costs nothing ordinary.
 *   4. THE ALLOWLIST: every segment (split on `|`, `;`, `&`, `&&`, `||`, newline)
 *      must EXACTLY match one arm — A1 git read, A2/A3 gh/glab read, A4 bun test,
 *      A5 verify-loop, A6 read tools, the exact build forms, and `git commit -m`
 *      with quoted prose. A segment that matches no arm is refused.
 *
 * ── KNOWN OVER-REFUSALS — 8, clause (b)'s accepted costs, each asserted ──────────
 *
 *   1. `git show HEAD:README.md --output=/tmp/x` — any -o/--output is refused
 *      whether or not it names a protected path;
 *   2. `git -c core.pager=cat log` — any -c is refused; the remedy names the flag to
 *      drop (`git --no-pager log`) or the allowlisted `bun test` arm to use instead;
 *   3. `bun test smoke-tests/review-findings-store*` — a glob on the store's STEM is
 *      refused: name the real test file (`smoke-tests/test-review-*.ts`) so the run
 *      says which suite it executes;
 *   4. `cp -r review-findings-store /tmp` — a command that names a protected path
 *      outside quotes has no arm, whatever the verb;
 *   5. `printf x | bun -` — a runtime reading a program from stdin is refused: the
 *      body is the part this guard cannot read;
 *   6. `bun -y` — an installer run is refused for the same reason;
 *   7. a quoted `|` or `;` still opens a segment, so a markdown table whose cells
 *      hold `|` beside a store path is refused — write the prose to a file instead;
 *   8. `bash smoke-tests/lib/verify-loop.sh --digest-mode on …` — a flag whose VALUE
 *      is a separate word is refused: the arm admits switches and paths only, never a
 *      switch-and-argument pair, so a spelling it cannot read is not vouched for.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace, traceWarn } from "./trace.ts";

/** The names whose stem marks a protected path, whatever suffix follows. */
const PROTECTED_STEMS = ["review-accept", "review-accept-row", "review-findings-store"];
/** A basename that names the findings store: the data file, its siblings, the modules. */
const PROTECTED_BASENAME = new RegExp(
  String.raw`^review-(?:findings\.json(?:\.(?:tmp|corrupt-[a-z0-9]+))?|findings-store|accept(?:-row)?)(?:\.ts)?$`,
);

/** A JS runtime: its invocation executes a program, so it is never a read tool. */
const RUNTIME = /^(?:bun|bunx|node|npx|tsx|ts-node|deno)$/;
/** The forge CLIs, whose read arms are exact. */
const VCS = /^(?:git|gh|glab)$/;
/** A word that edits a file rather than reading one — never on the allowlist. */
const EDIT_CAPABLE = new Set([
  "sed",
  "awk",
  "perl",
  "python",
  "python3",
  "ruby",
  "tee",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "touch",
  "truncate",
  "dd",
  "install",
  "chmod",
  "chown",
  "ln",
  "tar",
  "unzip",
  "patch",
]);
/** Read-only file tools: arm A6 admits them only for arguments naming nothing protected. */
const READ_TOOLS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "file",
  "stat",
  "which",
  "basename",
  "dirname",
  // `sed` and `awk` are edit-capable wherever they sit in argv, so they are read
  // tools ONLY in invocation position — armRead's own head test enforces that, and
  // they stay out of this set so the fast path still treats them as dangerous.
]);
/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";
/** An eval or preload flag: the runner then executes text, so the run is not read-only. */
const NO_EVAL_FLAGS = ["-e", "-p", "--print", "--eval", "-r", "--require", "--preload"];
/** The write-capable arguments clause (b) refuses, and the refusal names. */
const WRITE_FLAGS = [
  "-o",
  "--output",
  "-c",
  "--ext-diff",
  "--git-dir",
  "--work-tree",
  "-f",
  "--file",
  "-t",
  "--template",
];
/** The verbs arm A1 admits: reads that print to stdout and take no output argument. */
const GIT_READ_VERBS = ["status", "log", "diff", "show", "blame"];

/** Tokenise into maximal runs of word / dot / hyphen / slash characters. */
function tokensOf(text: string): string[] {
  return Array.from(text.matchAll(/[\w./-]+/g), (m) => m[0] as string);
}

/** The basename of a token, on either separator. */
function baseName(token: string): string {
  const i = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return i < 0 ? token : token.slice(i + 1);
}

/** Does a token name the findings store — as path, module, bare stem or sibling? */
function isProtectedToken(token: string): boolean {
  const base = baseName(token);
  if (PROTECTED_BASENAME.test(base)) return true;
  return PROTECTED_STEMS.includes(base.replace(/\.tsx?$/, ""));
}

/** Does the text name the findings store anywhere, token-wise? */
function namesAnythingProtected(text: string): boolean {
  return tokensOf(text).some(isProtectedToken);
}

/** Collapse whitespace. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Drop `NAME=value` prefixes: an env assignment is inert for the guard's purposes. */
/**
 * The `arms` view, built in ONE pass over the command: balanced quote spans are
 * replaced by a single space (so a quoted `|` or `;` never opens a segment) and the
 * environment prefixes are cut (so `FOO=1 bun test …` keeps its runner in first
 * position). The operand text each span carried is returned alongside, in position
 * order: an arm still has to see `'test-x.ts'` as the one argument it is, so the loop
 * hands back the spans whose placeholder fell inside its own segment. A placeholder
 * is one character, so a segment of length N is followed by the spans whose
 * placeholders were the N+1-th character onward.
 */
function armView(text: string): { view: string; raw: string; quoted: string[]; at: number[] } {
  let out = "";
  const quoted: string[] = [];
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) break;
      quoted.push(text.slice(i, end + 1));
      at.push(out.length);
      out += " ";
      i = end;
      continue;
    }
    out += ch;
  }
  // The placeholder offsets are counted on the UNSQUEEZED text, which is also what
  // the segment walk below splits — squeezing would shift every later placeholder.
  const raw = stripEnvPrefixes(out.toLowerCase());
  const kept: string[] = [];
  const keptAt: number[] = [];
  for (let n = 0; n < quoted.length; n++)
    if (at[n]! < raw.length) {
      kept.push(quoted[n]!);
      keptAt.push(at[n]!);
    }
  return { view: squeeze(raw), raw, quoted: kept, at: keptAt };
}

function stripEnvPrefixes(text: string): string {
  return text.replace(/(?:^|\s)[a-z_][a-z0-9_]*=\S+(?=\s|$)/g, " ");
}

/**
 * Skip a heredoc body starting at `start`, and return the index just past it;
 * PARSE_FAIL when the terminating delimiter never appears — an unreadable body is
 * refused, never guessed at (clause (a)). Handles `<<TAG`, `<<-TAG` and a quoted
 * delimiter.
 */
function skipHeredoc(command: string, start: number): number | "PARSE_FAIL" {
  let i = start + 2;
  if (command[i] === "-") i++;
  const from = i;
  while (i < command.length && /\w/.test(command[i] as string)) i++;
  if (i === from) return "PARSE_FAIL";
  const tag = command.slice(from, i).replace(/^['"]|['"]$/g, "");
  const lineEnd = command.indexOf("\n", i);
  if (lineEnd < 0) return "PARSE_FAIL";
  let cursor = lineEnd + 1;
  for (;;) {
    const at = command.indexOf("\n", cursor);
    const line = command.slice(cursor, at < 0 ? undefined : at).trim();
    if (line === tag) return at < 0 ? command.length : at + 1;
    if (at < 0) return "PARSE_FAIL";
    cursor = at + 1;
  }
}

/**
 * ONE normalisation pass. PARSE_FAIL (clause (a): refuse) on an unbalanced quote or
 * an unterminated heredoc, so nothing downstream has to reason about text it cannot
 * read as prose. Balanced quoted spans become a single space: their contents are
 * prose, and a `|` inside them must not open a segment.
 */
function normalise(command: string): string | "PARSE_FAIL" {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return "PARSE_FAIL";
      out += " ";
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return "PARSE_FAIL";
      out += " ";
      i = past;
      continue;
    }
    out += ch;
    i++;
  }
  for (const quote of ["'", '"'])
    if (((out.match(new RegExp(quote, "g")) ?? []).length) % 2 !== 0) return "PARSE_FAIL";
  return squeeze(out.toLowerCase());
}

/**
 * Split a normalised command into shell segments. `&&` and `||` precede the
 * single-character operators in the alternation, so no operator survives inside a
 * segment for an arm to misread as an argument.
 */
function splitSegments(text: string): string[] {
  return text
    .split(/\|\||&&|[|;&\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * One shell word: adjacent quoted and unquoted runs GLUE into one word as the shell
 * glues `a"b c"d`, and a balanced quoted run keeps its quotes so `armCommit` can
 * still see that a name was quoted. A quote with no partner is left as an ordinary
 * character — `normalise` has already refused the unparseable command.
 */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] as string)) {
      i++;
      continue;
    }
    let word = "";
    while (i < text.length && !/\s/.test(text[i] as string)) {
      const c = text[i] as string;
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1);
        if (end >= 0) {
          word += text.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      word += c;
      i++;
    }
    words.push(word);
  }
  return words;
}

/**
 * A word with its quote characters gone — the text the tool actually receives. A
 * word may be several quoted and unquoted runs glued together (`a"b c"d`), so every
 * balanced span is removed, not just a pair at the ends.
 */
function unquote(word: string): string {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i] as string;
    if (c === "'" || c === '"') {
      const end = word.indexOf(c, i + 1);
      if (end >= 0) {
        out += word.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** A shell word that begins with `-`, quotes stepped over. */
const isOptionWord = (word: string): boolean => unquote(word).startsWith("-");
/** The end-of-options marker: everything after it is an operand, not a flag. */
const isEndOfOptions = (word: string): boolean => unquote(word) === "--";
/** A whole switch (`-n`, `--no-pager`) or a switch with an attached `=value`. */
function isWholeSwitch(word: string): boolean {
  return /^--?[a-z][a-z0-9-]*(?:=[^\s]*)?$/.test(unquote(word));
}

/**
 * A word that opens a SUBSHELL or an expansion rather than naming an argument: a `(`,
 * which groups a whole command (`$(…`, `x=$(…`), or a `$` / backquote, whose value the
 * guard cannot read. `(` is a WORD character in `tokensOf`, so the fast path's token
 * scan never sees it — this is the only place that catches it, and it is why
 * `echo $(cat <store>)` cannot slip through the read arm.
 */
/** A word the fast path treats as inert: an option, an assignment, a digit, or
 * punctuation. Only a word that could NAME a program decides the fast path. */
const INERT_WORD = /^(?:-{1,2}[a-z0-9][\w.-]*|\d+|[^\w]+)$/;
/** The shell quoting and redirection punctuation the guard does not read as program
 * text. An apostrophe inside prose and the `$`/backquote of an expansion both live
 * here, so the fast path defers to the arms whenever they appear — clause (a). */
const SHELL_PUNCT = /[|&;()<>$'"`]/;
/** Words that are never the program being run: an option, an assignment, a number,
 * punctuation, or the two prefixes the guard accepts ahead of a runtime. */
/** Words that are never the program being run: an option, an assignment, a number,
 * punctuation, or the two prefixes the guard accepts ahead of a runtime. A word that
 * merely CONTAINS punctuation (`;`, `rm`) is not inert — only a word made of it is. */
const NOT_A_PROGRAM = /^(?:-{1,2}[a-z0-9][\w.-]*|\d+|[^\w]+|sudo|env)$/;
const isPotentialProgram = (token: string): boolean =>
  !NOT_A_PROGRAM.test(token) && !token.includes("=");

/**
 * A dangerous word only counts where the shell would RUN it: the first or second word
 * of a segment, outside quotes. `grep -rn bun <path>` has `bun` as a pattern and
 * `cp -r <store> /tmp` has `-r` as a flag; `sudo bun -e …` and `env bun -e …` still
 * run the interpreter, while a THIRD word (`command bun …`) is a prefix the guard does
 * not recognise and therefore does not vouch for.
 */
function invocationPositionNames(word: string, index: number): boolean {
  if (index > 1 || /["']/.test(word)) return false;
  const head = unquote(word);
  if (!isPotentialProgram(head)) return false;
  const b = baseName(head);
  return RUNTIME.test(b) || VCS.test(b) || EDIT_CAPABLE.has(b) || isProtectedToken(head);
}

/** Does any segment run, or open, something dangerous? Judged on the RAW text. */
function dangerousInvocation(raw: string): boolean {
  return splitSegments(raw).some((s) => shellWords(s).some((w, i) => invocationPositionNames(w, i)));
}

function containsExpansion(text: string): boolean {
  return /[$`]/.test(text);
}

/**
 * Clause (a), stated once for every arm: a word that begins with `-` and is neither a
 * whole switch nor `--switch=value` is an ATTACHED option (`-odata`, `-cfoo`, `-j4`)
 * or a bare `-`, and no arm takes a value glued to a flag letter. Such a segment
 * matches nothing. The test is on the WORD, quotes and all — a token test would see
 * the `/` of `--jq .name` as path punctuation and call the switch an attached option.
 */
function armHasUnknownOption(words: string[]): boolean {
  return words
    .filter((w) => !/["']/.test(w))
    .some((w) => isOptionWord(w) && !isWholeSwitch(w) && !isEndOfOptions(w));
}

/**
 * Is any of `flags` present? EVERY spelling is a shell word of its own, so a flag is
 * matched whole: `--output=x` is the `=` form, and `-o <path>` / `-c k=v` are the
 * flag word followed by its value. An ATTACHED spelling (`-odata`, `-cfoo`) is
 * refused by `armHasUnknownOption` — a matcher that half-stripped the prefix silently
 * admitted the attached forms, which is the #1125 flag-dropping bug.
 */
function hasFlag(words: string[], ...flags: string[]): boolean {
  return words.some((w) => flags.includes(unquote(w)) || flags.some((f) => w.startsWith(`${f}=`)));
}

/**
 * A file-writing or config argument on a forge command — clause (b)'s named flag.
 *
 * The bare `key=value` shape is a git config argument (`git -c core.pager=cat log`,
 * `git config alias.x=…`), and it is asked ONLY of words after the verb: an env
 * prefix (`PI_ENSEMBLE_VIPUNE_REQUIRED=1 bun …`) is the same shape, and is stripped
 * and inert, so testing it would refuse the repo's own verify command.
 */
/**
 * A file-writing or config argument on a forge or git command — clause (b)'s named
 * flag. An option's VALUE is not an option, so `--output /tmp/x`, `--output=/tmp/x`,
 * `-o /tmp/x` and `-c k=v` are all recognised; `--jq .name` carries no such flag.
 */
function carriesWriteFlag(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = unquote(words[i]!);
    const eq = w.indexOf("=");
    const head = eq < 0 ? w : w.slice(0, eq);
    if (WRITE_FLAGS.includes(head)) return true;
    // `-o data` / `-c k=v`: the flag word itself, or the value it was handed.
    if (WRITE_FLAGS.includes(w)) return true;
    if (i > 0 && WRITE_FLAGS.includes(unquote(words[i - 1]!))) return true;
  }
  return words.some((w) => /^[a-z][a-z0-9_.]*=[^=]/.test(unquote(w)));
}

/** The findings DATA file and its `.tmp` / `.corrupt` siblings — the store itself, as
 * opposed to the module source, which a `git log -- <module>` legitimately reads. */
const FINDINGS_FILE = /^review-findings\.json(?:\.(?:tmp|corrupt-[a-z0-9]+))?$/;
function namesFindingsFileOperand(words: string[]): boolean {
  return words.some((w) => FINDINGS_FILE.test(baseName(unquote(w))));
}

/** The read arms may not see an argument that IS the findings store: `git log -- <data>`
 * opens the data file and `gh api <data>` names it as a path, and neither is a read the
 * guard may vouch for. */
function namesProtectedOperand(words: string[]): boolean {
  return words.some((w) => isProtectedToken(unquote(w)));
}

/** A1: `git status|log|diff|show|blame`, optional `--no-pager`, no write-capable flag. */
function armGitRead(words: string[], rawWords: string[]): boolean {
  let i = unquote(words[0] ?? "") === "git" ? 1 : 0;
  if (unquote(words[i] ?? "") === "--no-pager") i++;
  if (!GIT_READ_VERBS.includes(unquote(words[i] ?? ""))) return false;
  const rest = words.slice(i + 1);
  // The read may name the store MODULE (a diff of source is a read); it may not open
  // the findings FILE itself, which is what `-- <data>` or `show <data>` would do.
  // A write flag (`-c k=v`, `-o <path>`) is refused wherever it sits, quoted or not —
  // over-refusals 1 and 2, and the only git read the guard vouches for is a pure read.
  if (carriesWriteFlag(rawWords) || namesFindingsFileOperand(rest)) return false;
  return !rest.some((w) => /^(?:alias|filter|credential|remote)\./.test(unquote(w)));
}

/** A2/A3: `gh|glab pr|mr view|diff`, `gh repo view`, `gh api <path>` — no write flag. */
function armForgeRead(words: string[], rawWords: string[]): boolean {
  const tool = unquote(words[0] ?? "");
  if (tool !== "gh" && tool !== "glab") return false;
  // Clause (a): the allowlist is authoritative, so a forge subcommand no arm spells
  // (`pr create`, `alias set`, `config set`) is refused whatever its arguments say.
  const spoken = squeeze(rawWords.map(unquote).join(" "));
  if (/(?:^|\s)(?:create|edit|merge|close|reopen|set|delete|comment|review|ready|rebase|squash)(?:\s|$)/.test(spoken))
    return false;
  const area = unquote(words[1] ?? "");
  const verb = unquote(words[2] ?? "");
  if (area === "api") {
    // `gh api <path> [--flag value]*` — the path is the single non-option operand and
    // every LATER word is an option or the value it was handed, so `--jq .name` is
    // admitted while `api /a /b` (two positionals) is not.
    const rest = words.slice(3);
    let positionals = verb === "" || isOptionWord(words[2] ?? "") ? 0 : 1;
    let lastWasOption = false;
    for (const w of rest) {
      if (isOptionWord(w)) {
        lastWasOption = true;
        continue;
      }
      if (!lastWasOption && ++positionals > 1) return false;
      lastWasOption = false;
    }
    // A write flag is refused wherever it sits, value included: `--output=<data>`
    // would have its path swallowed by quote removal, so the RAW command is asked.
    return (
      positionals <= 1 &&
      !carriesWriteFlag(rawWords) &&
      !namesProtectedOperand(rest) &&
      !rest.some((w) => unquote(w) === "set")
    );
  }
  const shape =
    ((area === "pr" || area === "mr") && (verb === "view" || verb === "diff")) ||
    (area === "repo" && verb === "view");
  if (!shape) return false;
  const rest = words.slice(3);
  return (
    !carriesWriteFlag(rawWords) &&
    !namesProtectedOperand(rest) &&
    !rest.some((w) => unquote(w) === "set")
  );
}

/** A4: `bun|bunx test <test paths>` — every argument test-shaped, no eval flag. */
function armTest(words: string[]): boolean {
  if (!RUNTIME.test(unquote(words[0] ?? "")) || unquote(words[1] ?? "") !== "test") return false;
  return testArgv(words.slice(2), false);
}

/**
 * The argv rule arms A4 and A5 share: no eval or preload flag before `--`, and every
 * argument test-shaped, a switch, or `--` itself. A GLOB may end the path but may not
 * sit inside it — `test-review-*.ts` is a suite, `review-findings-store*` is a stem
 * the guard cannot resolve, and the second is clause (b)'s accepted cost.
 */
function testArgv(args: string[], digestAllowed: boolean): boolean {
  const cut = args.findIndex(isEndOfOptions);
  const head = cut < 0 ? args : args.slice(0, cut);
  // The runner's own switches come before the first operand; after it, only test paths
  // are operands and a bare word — or an eval flag — has no arm.
  const operands = args.filter((w) => !isOptionWord(w) && unquote(w) !== "");
  if (hasFlag(head, ...NO_EVAL_FLAGS)) return false;
  if (operands.some((w) => hasFlag([w], ...NO_EVAL_FLAGS))) return false;
  return args.every((raw) => {
    const a = unquote(raw);
    // The MODULE source is a legitimate subject of a suite name (`test-review-accept
    // .ts`); the findings DATA file and its siblings are the store itself.
    if (FINDINGS_FILE.test(baseName(a))) return false;
    if (a === "--") return true;
    if (digestAllowed && a === "--digest") return true;
    // A switch, or nothing else: `--digest-mode on` puts a VALUE in operand position,
    // and an argument the arm cannot read is not a suite path (over-refusal 8).
    if (/^-{1,2}[a-z][a-z0-9-]*$/.test(a)) return false;
    // A suite path: a `test`/`spec` segment and a `.ts`/`.tsx` suffix, built from path,
    // glob and option characters. `*` and `?` are inside the class as well as after the
    // suffix, so `smoke-tests/test-*.ts` passes as well as `smoke-tests/test-a.ts`;
    // a bare word, a flag value, or the store's stem does not.
    return /^[\w./?*()-]*(?:test|spec)[\w./?*()-]*\.tsx?[*?]*$/.test(a);
  });
}

/** A5: `bash …/verify-loop.sh <test paths>`, with `--digest` allowed. */
function armVerifyLoop(words: string[]): boolean {
  // The exemption is for `bash …/verify-loop.sh` in INVOCATION position: a prefix word
  // (`sudo bash …`) is not the arm, whatever follows it.
  if (unquote(words[0] ?? "") !== "bash") return false;
  if (!/(?:^|\/)verify-loop\.sh$/.test(unquote(words[1] ?? ""))) return false;
  return testArgv(words.slice(2), true);
}

/**
 * A7: `bun <suite.ts>` — the develop gate's capability arm, which runs one file whose
 * name says it is a suite. The name must end `.ts`/`.tsx` and carry a `test`/`spec`
 * segment; anything else (`bun ./src/x.ts`, a stem glob, a flag) is a program the
 * guard cannot vouch for.
 */
function armScript(words: string[]): boolean {
  if (!RUNTIME.test(unquote(words[0] ?? ""))) return false;
  const args = words.slice(1);
  if (args.length === 0) return false;
  return args.every((raw) => {
    const a = unquote(raw);
    if (isProtectedToken(a)) return false;
    if (/^-{1,2}[a-z][a-z0-9-]*$/.test(a)) return true;
    return /^[\w./?*()-]*(?:test|spec)[\w./?*()-]*\.tsx?[*?]*$/.test(a);
  });
}

/** A6: the read tools, whose arguments must name nothing protected. */
function armRead(words: string[]): boolean {
  const head = unquote(words[0] ?? "");
  if (head === "") return false;
  if (VCS.test(head) || RUNTIME.test(head)) return false;
  // `sed` and `awk` are edit-capable wherever they sit in argv, so they are read tools
  // only in invocation position (here, at the head) and only for a print.
  if (!READ_TOOLS.has(head) && head !== "sed" && head !== "awk") return false;
  if (head === "sed" && unquote(words[1] ?? "") !== "-n") return false;
  if (head === "awk" && !/["']/.test(words[1] ?? "")) return false;
  // A write-capable flag on ANY command is refused, not just on git and the forge
  // CLIs: `-o`/`--output` redirects output to a file and `-c` changes the tool's
  // configuration, so a segment carrying one is not the read this arm vouches for.
  if (carriesWriteFlag(words)) return false;
  // Only words OUTSIDE the quotes are arguments the shell hands the tool: a quoted word
  // is prose. The store may not be among the opened arguments, and no word may expand
  // something the guard cannot read.
  const opened = words.slice(1).filter((w) => !/["']/.test(w));
  return !opened.some((w) => isProtectedToken(unquote(w)) || /[$(`]/.test(w));
}

/** The exact build and type-check forms, spelled precisely. */
function armBuild(words: string[]): boolean {
  const joined = words.map(unquote).join(" ");
  return (
    joined === "bun run build" ||
    joined === "bun run check" ||
    joined === "bunx tsc --noemit" ||
    joined === "bun x tsc --noemit"
  );
}

/**
 * `git commit -m "<prose>"`. The prose view dropped the quoted spans, so a protected
 * name that appears in the raw view and not in the prose view was inside the message:
 * prose, and harmless. A name that survives quote removal is a path operand and has
 * no arm. The message itself must be QUOTED — `-m` beside a bare word is an operand,
 * not prose — and no `-F/--file` may name a protected path.
 */
function armCommit(words: string[], raw: string): boolean {
  let i = unquote(words[0] ?? "") === "git" ? 1 : 0;
  if (unquote(words[i] ?? "") === "--no-pager") i++;
  if (unquote(words[i] ?? "") !== "commit") return false;
  const rest = words.slice(i + 1);
  // The message is the quoted word `-m` was handed. A quoted word immediately followed
  // by another quoted word is an odd spelling (`'it''s'`) whose message cannot be
  // located, so the arm declines it — over-refusal 4.
  const at = rest.findIndex((w) => /["']/.test(w));
  if (at < 0 || /["']/.test(rest[at + 1] ?? "")) return false;
  if (!["-m", "-message", "--message"].includes(unquote(rest[at - 1] ?? ""))) return false;
  const others = rest.filter((_, n) => n !== at);
  if (hasFlag(others, "-f", "--file", "-t", "--template") || carriesWriteFlag(others)) return false;
  // The name must live in the message and nowhere else: the arm's words for a `commit`
  // are its operands, so a protected name among them was a path, not prose.
  if (namesAnythingProtected(squeeze(others.map(unquote).join(" ")))) return false;
  // The arm is `git commit -m "<prose>"` ITSELF, whether or not the prose names the
  // store: clause (a)'s exact allowlist. It used to END in `return namesAnythingProtected(raw)`,
  // which FAILED OPEN on the very form the issue names as must-stay-allowed — a commit
  // message that names nothing at all, and any plain `-m` commit, was refused.
  return true;
}

/** The refusal reasons (clause (b)): one base, plus the sentence for the route that fired. */
function refusalReason(
  opts: { vcsWrite?: boolean; dataOperand?: boolean; target?: string } = {},
): string {
  if (opts.target)
    return `The review findings file (${opts.target}) is written only by ${ACCEPT_CLI}. Agents may not edit it.`;
  const base =
    `Accepting a review finding is an operator act: agents may not reach the review findings ` +
    `store. Run ${ACCEPT_CLI} from a terminal for an acceptance. Allowed reads: git ` +
    `status/log/diff/show/blame (no -o/--output/-c), gh|glab pr|mr view|diff, gh repo view, ` +
    `gh api <path>, bun test <test-path.ts>, bash smoke-tests/lib/verify-loop.sh <test-path.ts>, ` +
    `bun run build, bun run check, bunx tsc --noEmit, or a read tool (cat, grep, rg, sed -n, …) ` +
    `on a path that is not the findings store.`;
  const vcs = opts.vcsWrite
    ? " This command carries a file-writing or config argument: drop -o/--output/-c — e.g. `git --no-pager log` instead of `git -c core.pager=cat log`."
    : "";
  // The data route names the OPERAND to drop; a write flag is a different mistake and
  // the two sentences must not be confused for the agent's remedy.
  const data =
    opts.dataOperand === true
      ? " The store was named as a path operand: drop the path — it is not an argument any command may take."
      : "";
  trace(`review-accept-guard: refused${opts.vcsWrite ? " (vcs-write)" : ""}`);
  return base + vcs + data;
}

/**
 * THE DECISION — clause (a) in code: parse first (a failure refuses), then the fast
 * path, then the allowlist, and a segment with no matching arm refuses.
 *
 * THREE views, each with one job: `norm` (quotes and heredoc bodies gone) decides what
 * the shell PARSES and splits into segments, so prose leaves no words behind; `raw`
 * (the command, quotes KEPT) is what `armCommit` compares against `norm` to tell a
 * name inside a message from a path operand; `arms` (quotes kept, env prefixes cut,
 * lowercased) is what every arm matches, so a quoted operator cannot lift a word into
 * command position and an env prefix never pushes a runner out of first position.
 */
function scanCommand(command: string): string | undefined {
  if (squeeze(command) === "") return undefined;
  const norm = normalise(command);
  if (norm === "PARSE_FAIL") return refusalReason({ dataOperand: true });
  const raw = squeeze(command.toLowerCase());

  // The fast path, and the second half of clause (a): a command that names nothing
  // protected — in either view — is allowed only when nothing on it can execute a
  // program, write a file, or reach a forge CLI. A quoted word still counts here, so
  // `echo '…; bun -e …'` beside the store is refused rather than trusted, and `$`, a
  // backquote or a `(` is text the guard cannot read at all.
  const protectedAnywhere = namesAnythingProtected(raw) || namesAnythingProtected(norm);
  if (!protectedAnywhere) {
    const canReach =
      containsExpansion(command) ||
      SHELL_PUNCT.test(command) ||
      dangerousInvocation(raw);
    if (!canReach) return undefined;
  }

  const segments = splitSegments(norm);
  if (segments.length === 0) {
    // Nothing the shell would run, and nothing dangerous named anywhere: prose.
    return dangerousInvocation(raw) ? refusalReason() : undefined;
  }
  // The remedy sentence is decided on the RAW segments: quote removal would take a
  // quoted `-o` away with the prose, and the flag is named whenever it is on a
  // forge command at all.
  const vcsWrite = splitSegments(raw).some((s) => {
    const w = shellWords(s);
    return VCS.test(baseName(unquote(w[0] ?? ""))) && carriesWriteFlag(w);
  });

  const seen = armView(command.toLowerCase());
  // The SEGMENTS come from the un-squeezed view, so segment i of `arms` is the i-th
  // piece of `seen.raw` and placeholder offsets line up with both. Squeezing here would
  // shift every later placeholder and attribute a quoted word to the wrong segment.
  const arms = seen.raw.split(/\|\||&&|[|;&\n]/).map((s) => s.trim()).filter((s) => s !== "");
  // Offsets count on the SAME text the placeholders were counted on — `armView` strips
  // env prefixes BEFORE it squeezes — so the raw arm segments are split on that same
  // text and segment i and raw segment i are the same piece of the command.
  const rawArms = stripEnvPrefixes(command.toLowerCase());
  const rawArmsAll = rawArms.split(/\|\||&&|[|;&\n]/).map((s) => s.trim()).filter((s) => s !== "");
  let rawSpan = 0;
  // The view is built by REPLACING each quote span with a single placeholder character
  // — never by moving text — so arm segment i is made from the i-th piece of the
  // unsqueezed view, and the quoted words that fell out of it are exactly the spans
  // whose placeholder sat inside that piece. The walk is monotonic, so two identical
  // segments still get their own quoted words.
  const viewPieces = seen.raw.split(/\|\||&&|[|;&\n]/);
  let span = 0;
  let offset = 0;
  let rawOffset = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = arms[i] ?? "";
    const words = shellWords(segment);
    const piece = viewPieces[i] ?? "";
    while (span < seen.at.length && seen.at[span]! < offset) span++;
    const pieceEnd = offset + piece.length;
    let next = span;
    while (next < seen.at.length && seen.at[next]! < pieceEnd) next++;
    const tail = shellWords(seen.quoted.slice(span, next).join(" "));
    span = next;
    offset = pieceEnd;
    const argv = [...words, ...tail];
    // The same segment with its quoted words at their own offsets — what the shell
    // actually received, and what a write flag is judged on.
    const rawPiece = rawArmsAll[i] ?? "";
    while (rawSpan < seen.at.length && seen.at[rawSpan]! < rawOffset) rawSpan++;
    const rawPieceEnd = rawOffset + rawPiece.length;
    let rawNext = rawSpan;
    while (rawNext < seen.at.length && seen.at[rawNext]! < rawPieceEnd) rawNext++;
    const rawArgv = shellWords(seen.quoted.slice(rawSpan, rawNext).join(" "));
    rawSpan = rawNext;
    rawOffset = rawPieceEnd;
    const rawWords = [...shellWords(rawPiece), ...rawArgv];
    // No arm admits a segment that expands something it cannot read, carries an
    // attached option, or is empty.
    if (words.length === 0 || containsExpansion(segment) || armHasUnknownOption(argv))
      return refusalReason({ vcsWrite });
    const admitted =
      armGitRead(argv, rawWords) ||
      armForgeRead(argv, rawWords) ||
      armTest(argv) ||
      armVerifyLoop(argv) ||
      armScript(argv) ||
      armRead(argv) ||
      armBuild(argv) ||
      armCommit(argv, raw);
    if (!admitted) return refusalReason({ vcsWrite });
  }
  return undefined;
}

/** The refusal text when a bash command could reach the findings store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return scanCommand(command);
}

/** Edit tools whose `path` argument is checked against the protected files. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** The findings file and its tmp / corrupt-copy siblings — the store writes these. */
const FINDINGS_SIBLING = /^review-findings\.json\.(?:tmp|corrupt-[a-z0-9]+)$/;

/** The target path when an edit-style call would write a protected file, else undefined. */
export function editsFindingsFile(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const target = (input as { path?: unknown } | null)?.path;
  if (typeof target !== "string") return undefined;
  const base = target.split(/[\\/]/).pop() ?? "";
  return PROTECTED_BASENAME.test(base) ||
    FINDINGS_SIBLING.test(base) ||
    PROTECTED_STEMS.includes(base.replace(/\.tsx?$/, ""))
    ? target
    : undefined;
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string })?.command ?? "";
      // A scan that throws must not read as "nothing to block": a guard that fails
      // open on its own bug stops being a guard (clause (a) again).
      let reason: string | undefined;
      try {
        reason = scanCommand(command);
      } catch (err) {
        traceWarn(
          `review-accept-guard: scan threw, refusing fail-open (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        reason = refusalReason();
      }
      if (!reason) return;
      trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
      return { block: true, reason };
    }
    const target = editsFindingsFile(event.toolName, event.input);
    if (!target) return;
    trace(`review-accept-guard: BLOCKED ${event.toolName} of the review findings file`);
    return { block: true, reason: refusalReason({ target }) };
  });
}

/**
 * review-accept-guard — the mode-independent refusal of agent-run review
 * acceptance and of agent writes to the review findings store (#1105).
 *
 * Accepting a recorded review finding suppresses it from every later round, so
 * it must stay a human act: the operator runs `extension/scripts/review-accept.ts`
 * in a terminal. This hook refuses, in every mode and for every role, a bash
 * command that runs that script, that names the findings data file, or that
 * reaches the store through a JS runtime; and an edit / write / multiedit whose
 * target is the findings file, one of its `.tmp` / `.corrupt` siblings, or the
 * store module's own source.
 *
 * ADVISORY, not a security boundary. The OPERATOR'S TERMINAL is the boundary:
 * every rule here is a string match on the command text or the target path, and
 * a string match is not a fence. The threat model is the honest-but-forgetful
 * agent, not an adversary; keep the rules few and legible.
 *
 * THE VIEWS, and which route uses which — this is the whole design:
 *
 *   - `removeQuoted(raw)` drops balanced quoted segments ENTIRELY. Text inside
 *     balanced quotes is prose (a commit message, a doc comment, a table cell), so
 *     it neither runs a runtime nor writes a file. Runtime position and write-flag
 *     tests are judged here, and the name is taken from the RAW command: a
 *     `grep -rn bun <store>` has `bun` in argument position, so it is a pattern and
 *     not a route, while `bun -e 'import("./src/<store>.ts")'` has the runtime in
 *     position and its name inside a quoted body — exactly the half the guard
 *     cannot read, so the name is not asked of the removed view (#1125);
 *   - `quotedOff(raw, false)` BLANKS balanced segments to same-width spaces and
 *     answers "does an ARGUMENT name the data file as a path operand?" — the data
 *     file dominates the plain-git exemption, and `git add <data>` is not prose
 *     while `git commit -m "…<data>…"` is;
 *   - Only BALANCED quotes count as prose. A quote character occurring an odd
 *     number of times makes the text unparseable, so every route falls back to the
 *     RAW command: guessing the benign reading of text we cannot parse is how a
 *     guard fails open (#1125).
 *
 * `nameOf` is the one rule for what "names the file" means, shared by every route,
 * so a name cannot be protected on one route and missed on another.
 *
 * THE ROUTES, each asserted in test-review-accept-guard-hardened.ts:
 *   - the findings DATA file named as a path operand is refused wherever the shell
 *     sees it: cat, cp, sed, a heredoc, a redirect, or a plain git operand (`git
 *     add`, `git mv`, `git rm`, `git commit <file>`, …) (#1125);
 *   - a git/gh/glab argument that makes the tool write a file or run a shell:
 *     `--output` / `-o` in any spacing or attached form, and `-c`; plus `gh alias
 *     set`, `gh config set alias` and `git config alias.`, which install a command
 *     the next plain invocation runs;
 *   - a JS runtime (bun/bunx/node/npx/tsx/ts-node/deno) in INVOCATION POSITION —
 *     the first or second word of the command, or of a segment after `|`, `;`, `&`,
 *     `(` or a newline — in a command naming the store, wherever the name sits,
 *     including on a later line (a here-doc) or inside a quoted body;
 *   - `bun -` / `node -` reading a program from stdin, and the `-e` / `-p` /
 *     `--print` / `--eval` / preload eval forms: the body never appears in the
 *     command string, so the runtime alone is the route;
 *   - the operator script or its write module run directly by path;
 *   - an edit / write / multiedit whose target basename is the findings file, one
 *     of its `.tmp` / `.corrupt` siblings, or the store module's source (#1125).
 *
 * A TEST RUN (`bun test …` / `bash …/verify-loop.sh …`) is exempt as a read-only
 * suite, but the exemption is CONDITIONAL and judged on the RAW command (#1125):
 * an operator character or a line break anywhere in it — even inside quotes —
 * revokes it; every argument must be a `--digest`-style switch or a test path
 * (`smoke-tests/test-*.ts`-shaped), so a bare word (`verify-loop.sh bun <store>.ts`)
 * revokes it too; and it may not carry an eval flag or name the operator's script.
 *
 * WHAT IT DOES NOT COVER — everything not one of the shapes listed above:
 *   - a WRITE to the store module's source through BASH — `sed -i`, `cp`, `mv`,
 *     `tee` or a redirect naming `review-findings-store.ts`. The `edit` / `write` /
 *     `multiedit` tools are blocked on it, `bash` is not; only the findings DATA
 *     file and its siblings are refused as bash path operands;
 *   - any route that does not spell the name in the command text: a variable
 *     expanded later, a shell redirect, an obfuscated or composed path, a wildcard,
 *     `find -exec`, or any of the ways a shell reaches a file it never names;
 *   - a name the tokeniser cannot align to a protected one, e.g. a path built by
 *     concatenation (`"review-findings-"$SUFFIX`).
 *
 * In trust mode an agent with a shell can always reach the file. It exists to stop
 * an agent that is not trying to bypass it.
 *
 * KNOWN OVER-REFUSALS — 8, deliberate, each asserted in
 * test-review-accept-guard-hardened.ts. A string match cannot tell these from a
 * command, so the guard refuses rather than guesses:
 *   1. a fenced `bun run build` line followed by prose naming the store;
 *   2. a quoted markdown table whose cells hold `|` and name the store, since a `|`
 *      inside quotes still opens a segment;
 *   3. a regex literal `/bun|node|deno/` beside a store path, for the same reason;
 *   4. any command whose quoted text carries an odd number of quotes, judged on the
 *      raw command — `git commit -m 'it''s about <data>'`;
 *   5. a git/gh/glab argument that merely LOOKS like a write flag and names a
 *      protected file (`git commit --all -o <data>`);
 *   6. a test run carrying a flag the guard does not recognise (`bun test --reporter
 *      junit <store>`), because an unknown argument is not test-shaped;
 *   7. a verify-loop run taking a flag whose VALUE is a separate word;
 *   8. a runtime reached through a prefix word beyond the second (`env BUN_X=1 bun
 *      -e …`): it is not in invocation position, so the guard cannot prove it is not
 *      a runtime, and refuses.
 */

/* build 1792158174211 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace, traceWarn } from "./trace.ts";

/**
 * The names the guard protects: the operator script, its write module, the store
 * module and the findings data file. Every route below is built from this list, so
 * a name cannot be protected on one route and missed on another.
 */
const PROTECTED_NAMES = {
  script: "review-accept",
  writeModule: "review-accept-row",
  store: "review-findings-store",
  data: "review-findings.json",
};
const PROTECTED_LIST = Object.values(PROTECTED_NAMES);
/** The JS runtimes whose invocation executes a program. */
const RUNTIME_WORDS = ["bun", "bunx", "node", "npx", "tsx", "ts-node", "deno"];

/** RegExp-escape a literal from {@link PROTECTED_LIST}. */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fast exit for a command that names nothing protected — the overwhelmingly common
 * case, and this runs on every bash call in the session. A substring test answers
 * "could any route fire" without tokenising; the token walk answers it exactly.
 */
const NAMES_PRESENT = new RegExp(PROTECTED_LIST.map(escapeRe).join("|"));
/** A runtime word as a whole word — the invocation-position test. */
const RUNTIME_WORD = new RegExp(`^(?:${RUNTIME_WORDS.join("|")})$`);
/**
 * A runtime reading its program from standard input: the runtime followed by a
 * STANDALONE `-` token — not `-y`, not `--yes`. The body arrives from somewhere the
 * command never shows, so this route is decided by the runtime alone, whatever the
 * pipe carries.
 */
const RUNTIME_STDIN = new RegExp(
  String.raw`(?:^|[;&|\n(]|\s)(?:${RUNTIME_WORDS.join("|")})\b(?![-\w])\s+-(?=\s|$)`,
);
/** The operator script and its write module — names that are never a test file. */
const SCRIPT_NAMES = [PROTECTED_NAMES.script, PROTECTED_NAMES.writeModule];
/** The script run directly by path as the first word, e.g. `./review-accept.ts`. */
const DIRECT_RUN = new RegExp(
  String.raw`^\s*(?:\S*\/)?(?:${PROTECTED_NAMES.script}|${PROTECTED_NAMES.writeModule})(?:\.ts)?(?=\s|$)`,
);
/**
 * Plain git/gh/glab: no shell operator and no line break, so the whole command is
 * one invocation whose arguments are text (a commit message may name the store, and
 * `glab` reads the same way as its two siblings) (#1125).
 */
const PLAIN_VCS = /^\s*(?:git|gh|glab)\s[^;&|`$<>\n\r]*$/;
/**
 * A git/gh/glab argument that makes the tool itself write a file, or run arbitrary
 * code. `--output` / `-o` redirect what it prints to disk
 * (`git show HEAD:x --output=review-findings.json`) and `-c` sets a config value,
 * including `alias.x='!…'`, which executes a shell command. Each takes its value as
 * the next word or glued to the flag, so both spellings are one token shape —
 * `-oreview-findings.json`, and the `\b` the old pattern put after the letter never
 * matched the letter that followed it.
 */
const VCS_WRITE_TOKEN = /^(?:--output\S*|-o\S*|-c\S*)$/i;
/** An alias installed for the next invocation to run. */
const VCS_ALIAS = /(?:^|\s)(?:gh\s+alias\s+set|gh\s+config\s+set\s+alias|git\s+config\s+alias\.)/;
/**
 * A test run (bun test / verify-loop): no shell operator, no operator character and
 * no line break — judged on the RAW command, so an operator or newline inside a
 * quoted argument revokes the exemption rather than hiding in prose.
 */
const TEST_RUN = /^(?:bun\s+test|bash\s+\S*verify-loop\.sh)\s[^;&|`$<>\n\r]*$/;
/** A flag a test-run exemption may carry: a `--digest`-style switch, never a value. */
const TEST_RUN_FLAG = /^--(?:[a-z0-9]+-)*[a-z0-9]+$/;
/**
 * A test path or glob: something with a `test`/`spec` segment and a `.ts` suffix, so
 * `smoke-tests/test-*.ts`, `./test-x.ts` and `review-findings-store.test.ts` pass and
 * a bare word (`bun`), a module path or a flag-with-value does not. `*` and `?` are
 * allowed because a suite is named by glob.
 */
/**
 * A test path or glob, and ONE argument: a `test`/`spec` segment plus a `.ts` suffix,
 * built only from path and glob characters. `\S`-style classes would let a single
 * "argument" swallow `bun ./src/<store>.ts` and hide a runtime in the gaps, which is
 * precisely the shape the exemption has to refuse.
 */
const TEST_PATH = /^[\w./-]*(?:test|spec)[\w./-]*\.ts(?:[*?]+)?$/;
/**
 * An eval flag: the runtime then executes code named on the command line, which is
 * why a test run carrying one is not exempt. bun documents `-e` as an alias of
 * `--print` and also accepts `-p`, so both spellings are one route; a preload
 * (`--preload`, `-r`, `--require`) runs a named module before the run.
 */
const EVAL = /(?:^|\s)(?:-e|-p|--eval|--print|-r|--require|--preload)(?=\s|=|$)/;
/** Edit tools whose `path` argument is checked against the protected files. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/**
 * The findings file and its tmp / corrupt-copy siblings (`review-findings.json.tmp`,
 * `review-findings.json.corrupt-123`), by basename. The store writes these, so an
 * agent edit of one is an edit of the store's contents.
 */
const FINDINGS_BASENAME = new RegExp(String.raw`^${escapeRe(PROTECTED_NAMES.data)}(?:\.[\w-]+)?$`);
/** The store module's own source, by basename — the edit tools do not write it either. */
const STORE_BASENAME = new RegExp(String.raw`^${escapeRe(PROTECTED_NAMES.store)}\.ts$`);

/**
 * One compiled residual test per protected name, longest name first so the write
 * module (`review-accept-row`) is never reported as the operator script
 * (`review-accept`) with a stem glued on. Clause (c) allows whole hyphen-separated
 * segments only.
 */
const NAME_RESIDUALS: ReadonlyArray<readonly [string, RegExp]> = [...PROTECTED_LIST]
  .sort((a, b) => b.length - a.length)
  .map(
    (name) =>
      [
        name,
        new RegExp(String.raw`^${escapeRe(name)}(?:\.ts|-(?:[a-z0-9]+-)*[a-z0-9]+\.ts)?$`),
      ] as const,
  );

/**
 * A path token: a maximal run of word characters, dots and hyphens. `lastIndex` on a
 * `/g` regex is stateful, so every walk takes its own clone — a shared cursor makes a
 * verdict depend on which scan ran last, the worst kind of bug in a guard.
 */
const TOKEN_RE = /[\w.-]+/g;

/** The path tokens of a command, in order — see TOKEN_RE. */
function tokenise(text: string): string[] {
  return text.match(new RegExp(TOKEN_RE)) ?? [];
}

/** The basename of a path token, on either separator. */
function basenameOf(token: string): string {
  return token.slice(Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\")) + 1);
}

/**
 * THE ONE NAME RULE — the only place this module decides whether a command names a
 * protected file. Every route asks through `nameIn` / `namedIn`; if a route wants a
 * different answer, that is the bug, not the fix.
 *
 * A protected name is recognised inside a path token (see TOKEN_RE) when the token,
 * after its leading directory segments and its leading option characters are dropped,
 * is one of:
 *
 *   (a) exactly the name — `review-findings.json`;
 *   (b) the name plus `.ts` — the module's own file, `review-findings-store.ts`;
 *   (c) the name plus a hyphenated stem plus `.ts` — `test-review-findings-store.ts`.
 *       These NAME the store: they are how a command reaches the module by its real
 *       path, and a guard blind to them cannot see the route it exists to close. The
 *       stem must be whole hyphen-separated segments, so a name abutted by letters
 *       (`review-findings-storeX.ts`) is not the module.
 *
 * Nothing else may follow the name: `.json`, `.md` or any other tail is a different
 * file. Names are tried longest-first, so `review-accept-row` is not reported as
 * `review-accept` plus a stem. The prefix is stripped in code rather than expressed as
 * a lookbehind, and that is the fix: `-o` glued to the data file and `./src/` glued to
 * the module are the same shape once the prefix is gone, whereas a lookbehind that
 * accepts the `o` of `-o` must accept the `t` of `test-` too.
 */
function nameOf(token: string): string | undefined {
  const base = basenameOf(token);
  const stripped = base.replace(/^[-=]+/, "");
  for (const candidate of [base, stripped, stripped.replace(/^[a-z]/, "")]) {
    for (const [name, re] of NAME_RESIDUALS) if (re.test(candidate)) return name;
  }
  return undefined;
}

/** The protected name a token list spells, restricted to `wanted` when given. */
function nameIn(tokens: string[], wanted?: string[]): string | undefined {
  for (const token of tokens) {
    const name = nameOf(token);
    if (name && (!wanted || wanted.includes(name))) return name;
  }
  return undefined;
}

/** The protected name a command spells out, restricted to `wanted` when given. */
function namedIn(command: string, wanted?: string[]): string | undefined {
  return nameIn(tokenise(command), wanted);
}

/**
 * True when a token list names `name` as a bare path operand — the basename, or the
 * basename with option punctuation glued on, and nothing else. Stricter than `nameOf`:
 * `review-findings.json.bak` is a DIFFERENT file and the data route must not refuse it
 * as if it were the store.
 */
function namesOperand(tokens: string[], name: string): boolean {
  return tokens.some((token) => {
    const base = basenameOf(token);
    return base === name || base.replace(/^[-=]+/, "") === name;
  });
}

/**
 * The command with single- and double-quoted segments BLANKED to same-width spaces
 * (answers "does an ARGUMENT name the data file?"), or REMOVED outright
 * (`removeQuoted`, answers "does a word the shell parsed RUN something?").
 *
 * Only BALANCED segments are touched. A quote character occurring an ODD number of
 * times makes the rest of the command ambiguous, so such a segment is left as typed
 * and every route judges the RAW command — failing closed on text we cannot parse
 * (#1125). Written as a loop rather than a `replace` callback: the segment regex has
 * two capture groups, so a callback's `offset`/`whole` would be those groups.
 */
function quotedOff(command: string, remove: boolean): string {
  const out: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch !== "'" && ch !== '"') {
      out.push(ch);
      i++;
      continue;
    }
    const end = command.indexOf(ch, i + 1);
    if (end < 0 || (command.split(ch).length - 1) % 2 !== 0) {
      out.push(ch);
      i++;
      continue;
    }
    out.push(remove ? "" : " ".repeat(end - i + 1));
    i = end + 1;
  }
  return out.join("");
}

/**
 * Are the quotes of this character balanced across the command? Parity alone is not
 * enough when the other quote type is present: 'echo 'it\'s' 'bun run 'review-findings-store.ts''
 * has an even number of single quotes and an unbalanced pair of doubles. A quote
 * character whose total count is odd is unbalanced, and both views then fall back to
 * the RAW command (#1125, fail closed).
 */
function balanced(command: string, quote: string): boolean {
  return (command.split(quote).length - 1) % 2 === 0;
}

/** Balanced quoted segments removed entirely, so prose leaves no words behind. */
function removeQuoted(command: string): string {
  return quotedOff(command, true);
}

/**
 * Balanced quoted segments BLANKED to same-width spaces, except that SEPARATORS
 * inside them are preserved. A quoted body is prose for the purpose of FLAGS — a
 * `|` in a commit message is not a pipeline — but it is not prose for the purpose of
 * RUNTIME POSITION: an `echo '…; bun -e …'` and a markdown table whose cells hold `|`
 * beside a store path are refused rather than trusted, because a string match cannot
 * tell them from a command (see KNOWN OVER-REFUSALS). An unbalanced quote leaves the
 * text as typed, which is the other fail-closed direction (#1125).
 */
function positionView(command: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end >= 0 && balanced(command, ch)) {
        for (const inner of command.slice(i, end + 1))
          out.push(SEPARATOR_CHARS.has(inner) ? inner : " ");
        i = end + 1;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * A runtime in invocation position: the first or second word of the command, or of a
 * segment after `|`, `;`, `&`, `(` or a newline. The first word covers `bun -e …` and
 * `bash …/verify-loop.sh …`; the second also covers `sudo bash …` and `env bun …`, so a
 * prefix word cannot put a runtime out of position. A word deeper is an argument, so
 * `grep -rn bun <store>` — `bun` as a grep PATTERN — is not a route (#1125). Judge it
 * through `positionView`, which keeps quoted words out and quoted separators in.
 */
/**
 * The command's arguments as the SHELL would group them: whitespace-separated, with a
 * balanced quoted run kept as ONE argument and its quotes removed. The test-run
 * exemption needs this shape — a plain whitespace split turns `'bun ./src/x.ts'` into
 * two innocent-looking words and lets a runtime through the exemption (#1125).
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let glue = false;
  let i = 0;
  const push = () => {
    if (current !== "") words.push(current);
    current = "";
  };
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end >= 0 && (command.split(ch).length - 1) % 2 === 0) {
        current += command.slice(i + 1, end);
        i = end + 1;
        glue = true;
        continue;
      }
    }
    if (!glue && /\s/.test(ch)) {
      push();
      i++;
      continue;
    }
    current += ch;
    glue = false;
    i++;
  }
  push();
  return words;
}

/** The characters that open a new segment. A Set, not a string: `"".includes("")` is
 * true, so a string test would call every character a separator. */
const SEPARATOR_CHARS = new Set(["|", ";", "&", "(", "\n"]);

/**
 * Words that run what follows them, so a runtime after one is still executing: `bash
 * …/verify-loop.sh …` and `sudo bash …` and `env bun …` all reach a program. They are
 * only skipped as the FIRST word of a segment, which is what keeps `grep -rn bun
 * <store>` — `grep` first, `bun` third — out of invocation position (#1125).
 */
const LAUNCHER_WORDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "env",
  "sudo",
  "time",
  "nohup",
  "exec",
  "command",
  "nice",
  "stdbuf",
  "ionice",
  "chrt",
  "setsid",
]);
/**
 * Words that sit in front of a runtime without consuming the command position, beyond
 * the launchers: `command`, the git/gh verbs whose own argument follows them, and the
 * scheduling wrappers. A word that is neither is an argument, which is what puts
 * `grep -rn bun <store>` (bun as a grep PATTERN) out of the route (#1125).
 */
const COMMAND_SHIELD = new Set([
  ...LAUNCHER_WORDS,
  "command",
  "git",
  "gh",
  "glab",
  "nice",
  "stdbuf",
  "ionice",
  "chrt",
  "setsid",
]);
/**
 * Words allowed to sit BEFORE a runtime in command position: the launchers, `command`,
 * and the git/gh/glab verbs that take a following word as their own argument — which
 * is why `git grep -e bun <path>` has `bun` in argument position, not command
 * position, and is allowed.
 */

/**
 * A runtime in invocation position: the first or second word of the command, or of a
 * segment after `|`, `;`, `&`, `(` or a newline; the word after a LAUNCHER word counts
 * too, however many launchers are stacked, because they all still execute their
 * argument. A word deeper is an argument, so `grep -rn bun <store>` — `bun` as a grep
 * PATTERN — is not a route (#1125). Judge it through `positionView`, which keeps
 * quoted words out and quoted separators in.
 */
function runtimeInvoked(command: string): boolean {
  // A runtime in COMMAND position. The command itself counts in word 1 (a launcher may
  // sit before it: `sudo bun …`, `nice bun …`, `bash verify-loop.sh bun …`); a segment
  // after `|`, `;`, `&`, `(` or a newline counts only in word 0, so a `|` inside a
  // quoted message cannot lift a later word into command position. Word 0 of the whole
  // command is a runtime too. Quoted words are blanked and quoted separators kept, so
  // `echo '…; bun -e …'` and a table row naming bun beside a store path are still
  // refused (KNOWN OVER-REFUSALS) while `grep -rn bun <store>` — bun as a pattern — is
  // not, because `-rn` is neither a runtime nor a launcher (#1125).
  const view = positionView(command);
  const parts = view.split(/[|;&(\n]/);
  if (invokedAt(wordsOf(parts[0] ?? ""), 2)) return true;
  return parts.slice(1).some((segment) => invokedAt(wordsOf(segment), 1));
}

/** The non-empty whitespace words of a segment. */
function wordsOf(segment: string): string[] {
  return segment
    .trimStart()
    .split(/\s+/)
    .filter((w) => w !== "");
}

/**
 * Is a runtime reachable within `budget` leading words, stepping over launchers? A
 * leading word that is neither a launcher nor a runtime is an argument (or prose) and
 * ends the scan.
 */
function invokedAt(words: string[], budget: number): boolean {
  let i = 0;
  while (i < budget - 1 && COMMAND_SHIELD.has(words[i] as string)) i++;
  return i < budget && i < words.length && RUNTIME_WORD.test(words[i] as string);
}

/** True when a git/gh/glab segment of the command carries an argument that can write a
 * file or install an alias. Alias and write-flag tests both run PER SEGMENT, so a write
 * flag belonging to some other program in a chain is not blamed on git. */
function vcsSegmentCarriesWrite(text: string): boolean {
  if (VCS_ALIAS.test(text)) return true;
  for (const segment of text.split(/[|;&\n]/)) {
    if (!/^\s*(?:git|gh|glab)\s/.test(segment)) continue;
    if (tokenise(segment).some((t) => VCS_WRITE_TOKEN.test(t))) return true;
  }
  return false;
}

/** The route that decided a refusal — the reason text is written per route. */
type Route = "data" | "vcs-write" | "runtime" | "script";

/**
 * The scan. Every route needs a protected name, so a command that names none is out
 * immediately.
 *
 * @param command the raw command text
 * @returns the offending name and the route that fired, else undefined
 */
function scanCommand(command: string): { name: string; route: Route } | undefined {
  if (!NAMES_PRESENT.test(command)) return undefined;
  // Tokenise ONCE; every name test reuses this list (read from the RAW command —
  // a commit message does name the store, and the exemptions make that harmless).
  const tokens = tokenise(command);
  const named = nameIn(tokens);
  if (!named) return undefined;
  // The two views (see the header). An unbalanced quote leaves both equal to raw.
  const unquoted = removeQuoted(command);
  const argTokens = tokenise(quotedOff(command, false));
  const dataOperand = namesOperand(argTokens, PROTECTED_NAMES.data);

  // A test run may name the store's files by glob (a read-only suite). Judged on the
  // RAW command, so an operator or newline inside a quoted argument revokes it. It may
  // not carry an eval flag, name the operator's script, or be handed anything that is
  // not a `--flag` switch or a test path — a bare word means the runner is running
  // more than tests.
  if (TEST_RUN.test(unquoted) && !EVAL.test(command) && !namedIn(command, SCRIPT_NAMES)) {
    // Split on WHITESPACE but treat a balanced quoted run as ONE argument, so a
    // hidden `bun ./src/<store>.ts` cannot pass as two test paths.
    const argv = shellWords(unquoted).slice(
      /^bun$/.test(shellWords(unquoted)[0] as string) ? 2 : 3,
    );
    if (argv.length > 0 && argv.every((t) => TEST_RUN_FLAG.test(t) || TEST_PATH.test(t)))
      return undefined;
  }

  // The data file named as a path operand is refused wherever the shell sees it, and
  // before the runtime route so `bun <data>` reports the data route — both refuse, and
  // the reason text differs.
  if (dataOperand) return { name: PROTECTED_NAMES.data, route: "data" };
  // A runtime reading its program from stdin: the body is the part the guard cannot
  // read, so the runtime alone is the route.
  if (RUNTIME_STDIN.test(unquoted)) return { name: PROTECTED_NAMES.store, route: "runtime" };
  // A runtime in invocation position, naming the store anywhere — inside a quoted body
  // or on a later line, which is what a here-doc and `printf … | bun -` need. The name
  // is asked of the RAW tokens: the body is exactly the half quotes remove (#1125).
  if (runtimeInvoked(command) && nameIn(tokens, [PROTECTED_NAMES.store]))
    return { name: PROTECTED_NAMES.store, route: "runtime" };
  // The plain-git/gh exemption covers prose arguments only, and is revoked by an
  // argument that makes the tool write a file or run an alias.
  if (PLAIN_VCS.test(command) && !vcsSegmentCarriesWrite(unquoted)) return undefined;
  // The operator script or its write module, run directly by path.
  const direct = DIRECT_RUN.exec(command);
  if (direct) return { name: direct[0].trim(), route: "script" };
  // A git/gh segment inside a chain is not plain, so it lands here; its write-capable
  // argument is what makes naming the store a route.
  if (vcsSegmentCarriesWrite(unquoted)) return { name: named, route: "vcs-write" };
  return undefined;
}

/** The matched invocation when a command runs review-accept or names the store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return scanCommand(command)?.name;
}

/** The target path when an edit-style call would write a protected file, else undefined. */
export function editsFindingsFile(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const target = (input as { path?: unknown } | null)?.path;
  if (typeof target !== "string") return undefined;
  // The basename goes through the same `nameOf` walk every bash route uses, so the edit
  // route cannot recognise names differently. `nameOf` clause (c) covers a hyphenated
  // stem before `.ts`; `FINDINGS_BASENAME` adds the `.tmp` / `.corrupt` tails, which
  // clause (c) cannot express (#1125).
  const base = target.split(/[\\/]/).pop() ?? "";
  return nameIn([base]) === PROTECTED_NAMES.data ||
    FINDINGS_BASENAME.test(base) ||
    STORE_BASENAME.test(base)
    ? target
    : undefined;
}

/** The refusal text for the route that fired: only the vcs-write route can name a
 * write-capable argument as the thing to drop. */
function refusalReason(route: Route, target?: string): string {
  if (target)
    return `The review findings file (${target}) is written only by the operator's review-accept.ts. Agents may not edit it.`;
  const remedy =
    route === "vcs-write"
      ? " If this is an ordinary git/gh read, drop the write-capable argument (--output/-o/-c or an alias) and it is allowed again — e.g. `git --no-pager log`."
      : " Naming the review findings data file as a path operand is refused; name it only inside a quoted message.";
  const base =
    "Accepting a review finding is an operator act. Agents may not run" +
    " extension/scripts/review-accept.ts or touch the review findings store; the" +
    " operator runs review-accept.ts in a terminal with " +
    "`--reason`.";
  const reason = base + remedy;
  trace(`review-accept-guard: refused route ${route}`);
  return reason;
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string })?.command ?? "";
      // A scan that throws must not read as "nothing to block": a guard that fails open
      // on its own bug stops being a guard.
      let hit: ReturnType<typeof scanCommand>;
      try {
        hit = scanCommand(command);
      } catch (err) {
        traceWarn(
          `review-accept-guard: scan threw, refusing fail-open (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        return { block: true, reason: refusalReason("data") };
      }
      if (!hit) return;
      trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
      return { block: true, reason: refusalReason(hit.route) };
    }
    const target = editsFindingsFile(event.toolName, event.input);
    if (!target) return;
    trace(`review-accept-guard: BLOCKED ${event.toolName} of the review findings file`);
    return { block: true, reason: refusalReason("data", target) };
  });
}

/**
 * review-accept-guard — the mode-independent refusal of agent-run review
 * acceptance and of agent writes to the review findings store (#1105).
 *
 * Accepting a recorded review finding suppresses it from every later round, so
 * it must stay a human act: the operator runs `extension/scripts/review-accept.ts`
 * in a terminal. This hook refuses, in every mode and for every role, a bash
 * command that runs that script, that names the findings data file, or that
 * reaches the store through a JS runtime; and an edit / write / multiedit whose
 * target is the findings file (or one of its `.tmp` / `.corrupt` siblings).
 *
 * ADVISORY, not a security boundary. The OPERATOR'S TERMINAL is the boundary:
 * every rule here is a string match on the command text or the target path,
 * and a string match is not a fence. The threat model is the honest-but-
 * forgetful agent, not an adversary; keep the rules few and legible.
 *
 * THE ONE RULE THAT DECIDES A PROSE COMMAND: a command that merely MENTIONS a
 * protected name inside a quoted argument (a doc comment, a table cell, a
 * sentence) is allowed. It is refused only when something in it RUNS — a JS
 * runtime in argument position, the operator script by path, the data file
 * itself, or a git/gh argument that writes. `nameOf` is the one rule for what
 * "names the file" means, shared by every route, so a name cannot be protected
 * on one route and missed on another.
 *
 * The command is scanned AS A WHOLE, never line by line. Two misses let the
 * original scan through, both fixed here (#1125): the runtime pattern joined the
 * runtime word to the name with a single-line negated-newline class, so a
 * here-doc (runtime on line one, `import` on line two) and a program piped into
 * `bun -` named nothing; and the trailing lookahead rejected a `.ts` suffix, so
 * a path-qualified module import was invisible — the `.tmp` / `.corrupt` siblings
 * of the data file were named while the module itself was not.
 *
 * WHAT IT COVERS:
 *   - a JS runtime (bun/node/npx/tsx/deno…) naming a protected file, whether the
 *     name sits on the runtime's own line or on a later one: a here-doc body or a
 *     program piped into stdin counts, because the runtime only has to be invoked
 *     somewhere in the command and a protected name has to appear somewhere in it
 *     (#1125).
 *     The runtime half of that cross-line test must be in invocation position —
 *     the start of the command, of a pipeline/list segment, or right after `|`,
 *     `;`, `&`, `(`, or a newline that begins a command line — so prose or a
 *     table cell that merely mentions `bun` is not a route (#1125);
 *   - `bun -` / `node -` reading a program from stdin, and the `-e` / `-p` /
 *     `--print` / `--eval` eval forms, in a command that also names the store:
 *     the program body never appears in the command string, so the runtime plus
 *     the store route is refused on its own (#1125);
 *   - any command that names the findings data file outright (cat, cp, sed, a
 *     heredoc, a redirect), and a plain git that deletes or overwrites it
 *     (`git checkout`/`restore`/`rm`/`stash`/`clean` naming the data file);
 *   - plain git/gh commands that carry an argument which makes the tool write a
 *     file or run a shell: `--output` / `-o` in any spacing or attached form
 *     (`-oreview-findings.json`, `-c…`), and `-c` (#1125). These belong to no
 *     prose exemption, so the command is scanned like any other and naming a
 *     protected file decides the verdict. Quoted text is stripped first, so a
 *     commit message that merely contains `-o` keeps its exemption;
 *   - `gh alias set`, `gh config set alias` and `git config alias.`, which
 *     install a command the next plain invocation runs;
 *   - an edit / write / multiedit whose target basename is the findings file
 *     or one of its `.tmp` / `.corrupt` siblings.
 *
 * WHAT IT DOES NOT COVER — everything not one of the shapes listed above:
 *   - a WRITE to the store module's own source, `review-findings-store.ts`:
 *     through `sed -i`, `cp`, `mv`, `tee`, a shell redirect, or the `edit` /
 *     `write` / `multiedit` tools. Only the findings DATA file and its `.tmp` /
 *     `.corrupt` siblings are guarded against writes. Naming the module is what
 *     trips the runtime and git rules above, so a command that runs it is
 *     refused, but an agent that edits the module's source is not;
 *   - any route that does not spell the name in the command text: quote
 *     splitting, a variable expanded later, a shell redirect, an obfuscated or
 *     composed path, a wildcard, `find -exec`, or any of the ways a shell reaches
 *     a file it never names. A here-doc or stdin body is seen only as far as the
 *     command itself names the file;
 *   - a name the tokeniser cannot align to a protected one, e.g. a path built by
 *     concatenation (`"review-findings-"$SUFFIX`).
 *
 * In trust mode an agent with a shell can always reach the file. It exists to
 * stop an agent that is not trying to bypass it.
 *
 * KNOWN OVER-REFUSALS, deliberate, each asserted in
 * test-review-accept-guard-hardened.ts:
 *   - a fenced `bun run build` line followed by prose that names the store —
 *     the fence puts `bun` in argument position and the scan cannot tell a code
 *     fence from a script;
 *   - a quoted markdown table whose cells contain `|` and name the store while
 *     `bun` appears elsewhere in the same command;
 *   - a regex literal `/bun|node|deno/` beside a store path: the word `bun`
 *     survives the removal of quoted text, so it reads as an invocation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

/**
 * The names the guard protects: the operator script, its write module, the
 * store module and the findings data file. Every route below is built from this
 * list, so a name cannot be protected on one route and missed on another.
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

/**
 * One compiled residual test per protected name, longest name first so the
 * write module (`review-accept-row`) is never reported as the operator script
 * (`review-accept`) with a stem glued on. Clause (c) of the rule allows whole
 * hyphen-separated segments only.
 */
const NAME_RESIDUALS: ReadonlyArray<readonly [string, RegExp]> = [...PROTECTED_LIST]
  .sort((a, b) => b.length - a.length)
  .map(
    (name) =>
      [name, new RegExp(`^${escapeRe(name)}(?:\\.ts|-(?:[a-z0-9]+-)*[a-z0-9]+\\.ts)?$`)] as const,
  );

/**
 * A path token: a maximal run of word characters, dots and hyphens.
 *
 * `lastIndex` on a `/g` regex is stateful, and this one is shared by every scan
 * in the module — so each use takes its own clone. A single shared instance
 * makes a verdict depend on which scan ran last, which is the worst kind of bug
 * in a guard: it looks like the rule is wrong when only the cursor moved.
 */
const TOKEN_RE = /[\w.-]+/g;

/** RegExp-escape a literal from {@link PROTECTED_LIST}. */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * THE ONE NAME RULE — the only place this module decides whether a command
 * names a protected file. Every route asks through `namedIn`; if a route wants a
 * different answer, that is the bug, not the fix.
 *
 * A protected name is recognised inside a path token (see TOKEN_RE) when the
 * token, after its leading directory segments and its leading option characters
 * are dropped, is one of:
 *
 *   (a) exactly the name — `review-findings.json`;
 *   (b) the name plus `.ts` — the module's own file, `review-findings-store.ts`;
 *   (c) the name plus a hyphenated stem plus `.ts` — `test-review-findings-
 *       store.ts`, `review-findings-store-utils.ts`. These NAME the store: they
 *       are how a command reaches the module by its real path, and a guard that
 *       could not see them would be blind to the very route it exists to close.
 *       The stem must be whole hyphen-separated segments, so a name merely
 *       abutted by letters (`review-findings-storeX.ts`) is not the module.
 *
 * Nothing else may follow the name: `.json`, `.md` or any other tail is a
 * different file. Names are tried longest-first, so `review-accept-row` is not
 * reported as `review-accept` plus a stem.
 *
 * The prefix is stripped in code rather than expressed as a lookbehind, and that
 * is the fix: `-o` glued to the data file and `./src/` glued to the module are
 * the same shape once the prefix is gone, whereas a lookbehind that accepts the
 * `o` of `-o` is forced to accept the `t` of `test-` too. The old `(?<![-\w])`
 * rejected both, which is how `git show -oreview-findings.json` named nothing
 * and walked straight through (#1125). Stripping and comparing is exact, cannot
 * backtrack, and reads directly.
 */
function nameOf(token: string): string | undefined {
  const i = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = i >= 0 ? token.slice(i + 1) : token;
  // `-oreview-findings.json` and `--output=review-findings.json` are the same
  // argument with its value glued on: punctuation first, then one option letter.
  // Both are tried alongside the untouched token so a bare name, a
  // path-qualified module and an attached flag all reach one comparison.
  const stripped = base.replace(/^[-=]+/, "");
  for (const candidate of [base, stripped, stripped.replace(/^[a-z]/, "")]) {
    for (const [name, re] of NAME_RESIDUALS) if (re.test(candidate)) return name;
  }
  return undefined;
}

/**
 * The protected name a command spells out, restricted to `wanted` when given.
 * Quoted text is tokenised like anything else, so a program handed to `bun -e
 * '...'` or piped into `bun -` still reveals the path inside it: the body is the
 * part the guard cannot read, which is why that route refuses on the name alone.
 */
function namedIn(command: string, wanted?: string[]): string | undefined {
  for (const token of command.match(new RegExp(TOKEN_RE)) ?? []) {
    const name = nameOf(token);
    if (name && (!wanted || wanted.includes(name))) return name;
  }
  return undefined;
}

/**
 * The store half of the runtime route, asked of text the caller has already
 * stripped of quoted segments: text inside quotes is a program's source or a
 * person's prose, and the guard has no way to tell a doc comment naming the
 * module from a table cell naming it, so neither counts as a runtime reaching
 * it. `namedIn` is never asked of the raw command for this half.
 */
function storeNamed(shellView: string): boolean {
  return namedIn(shellView, [PROTECTED_NAMES.store, PROTECTED_NAMES.data]) !== undefined;
}

/**
 * A runtime told to read its program from standard input. The body arrives from
 * somewhere the command never shows, so the producer side is all there is to
 * judge — and the store name there is inside a quoted argument (`printf 'import
 * "./src/<store>.ts"' | bun -`), which is exactly what `storeNamed` ignores. So
 * this one shape is decided by the runtime alone: an explicit stdin read is a
 * route regardless of what the pipe carries.
 */
const RUNTIME_STDIN = new RegExp(
  String.raw`(?:^|[;&|\n(]|\s)(?:${RUNTIME_WORDS.join("|")})\b(?![-\w])\s+-\b`,
);

const SCRIPT_NAMES = [PROTECTED_NAMES.script, PROTECTED_NAMES.writeModule];

/**
 * A runtime word followed, on the same line, by a path token. Which token is
 * left to the name test ({@link namedIn}), the only place a protected name is
 * recognised; this pattern only has to say "a runtime ran something whose name
 * appears on its line".
 */
const RUNTIME_NAME = new RegExp(
  String.raw`(?:^|[;&|\n(=]|\s)(?:${RUNTIME_WORDS.join("|")})\b(?![-\w])[^\n]*?[\w.-]+`,
);
/**
 * A runtime in argument position — the cross-line half of the scan (#1125). The
 * runtime word must open its own word: at the start of the command, after a
 * shell operator (`|`, `;`, `&`, `(`, `=`), after whitespace, or at the start of
 * a line. That is what keeps a command which merely MENTIONS `bun` — in a table
 * cell, a doc comment, a sentence — from satisfying the runtime half, since the
 * name half is matched anywhere in the command.
 */
const RUNTIME_INVOKED = new RegExp(
  String.raw`(?:^|[;&|\n(=]|\s)(?:${RUNTIME_WORDS.join("|")})\b(?![-\w])`,
);
/** The script run directly by path as the first word, e.g. `./review-accept.ts`. */
const DIRECT_RUN = /^\s*(?:\S*\/)?review-accept(?:\.ts)?(?=\s|$)/;
/**
 * A plain git that deletes or overwrites the data file. The exemption exists
 * for prose arguments, not for `git rm` of the store (#1125).
 */
const DESTRUCTIVE_VCS = /(?:^|\s)(?:checkout|restore|rm|stash|clean)\b/i;
/**
 * Plain git/gh/glab: no shell operator and no line break, so the whole command
 * is one invocation whose arguments are text (a commit message may name the
 * store, and `glab` reads the same way as its two siblings) (#1125).
 */
const PLAIN_VCS = /^\s*(?:git|gh|glab)\s[^;&|`$<>\n\r]*$/;
/**
 * #1125 — a git/gh argument that makes the tool itself write a file, or run
 * arbitrary code. `--output` / `-o` redirect what it prints to disk
 * (`git show HEAD:x --output=review-findings.json`) and `-c` sets a config value,
 * including `alias.x='!…'`, which executes a shell command. Each takes its value
 * either as the next word or glued to the flag, so both spellings are the same
 * token shape: the flag alone, or the flag with its value attached —
 * `-oreview-findings.json` is one token, and the `\b` the old pattern put after
 * the letter never matched the letter that followed it.
 *
 * The plain-vcs exemption exists so prose arguments — a commit message, a PR
 * body — are left alone. Those arguments cannot write anything; an argument that
 * can does not get the exemption, and so the test runs on the command with
 * quoted segments stripped: `-o` inside a `"…"` message is prose the shell never
 * saw as a flag. The command is then scanned like any other, and naming a
 * protected file decides the verdict — a git command with these flags that names
 * no protected file stays allowed.
 */
const VCS_WRITE_TOKEN = /^(?:--output\S*|-o\S*|-c\S*)$/i;
/** An alias installed for the next invocation to run. */
const VCS_ALIAS = /(?:^|\s)(?:gh\s+alias\s+set|gh\s+config\s+set\s+alias|git\s+config\s+alias\.)/;

/** True when one token is a git/gh argument that can write a file or run a shell. */
function writeToken(token: string): boolean {
  return VCS_WRITE_TOKEN.test(token);
}

/** A test run (bun test / verify-loop): no shell operator and no line break. */
const TEST_RUN = /^\s*(?:bun\s+test|bash\s+\S*verify-loop\.sh)\s[^;&|`$<>\n\r]*$/;
/**
 * An eval flag: the runtime then executes code named on the command line, which
 * is why a test run carrying one is not exempt. bun documents `-e` as an alias
 * of `--print` and also accepts `-p`, so both spellings are the same route; a
 * preload (`--preload`, `-r`, `--require`) runs a named module before the run
 * and is treated the same way.
 */
const EVAL = /(?:^|\s)(?:-e|-p|--eval|--print|-r|--require|--preload)(?=\s|=|$)/;
/** Edit tools whose `path` argument is checked against the findings file. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** The findings file and its tmp / corrupt-copy siblings, by basename. */
const FINDINGS_BASENAME = /^review-findings\.json(?:\.|$)/;

/**
 * True when a git/gh argument the SHELL would have seen can write a file or run
 * an alias. Runs on the quote-stripped command, so `-o` inside a commit message
 * never revokes the exemption.
 */
function carriesWriteArg(stripped: string): boolean {
  if (VCS_ALIAS.test(stripped)) return true;
  return (stripped.match(new RegExp(TOKEN_RE)) ?? []).some(writeToken);
}

/** True when a git/gh segment of a chain carries a write-capable argument. */
function vcsSegmentCarriesWrite(stripped: string): boolean {
  if (VCS_ALIAS.test(stripped)) return true;
  // Look at each `git`/`gh`/`glab` segment of the chain, not the whole command,
  // so a write flag belonging to some other program is not blamed on git.
  for (const segment of stripped.split(/[|;&\n]/)) {
    if (!/^\s*(?:git|gh|glab)\s/.test(segment)) continue;
    if ((segment.match(new RegExp(TOKEN_RE)) ?? []).some(writeToken)) return true;
  }
  return false;
}

/**
 * Single- and double-quoted segments replaced by a space, so the git/gh
 * write-argument test sees only what the shell would have passed as an argument:
 * `-o` inside a commit message is prose, not a flag. A quote that never closes
 * drops the rest of the line, so unbalanced quoting is judged as the riskier
 * case rather than the safer one.
 */
function stripQuotes(command: string): string {
  return command.replace(/'[^']*'?|"[^"]*"?/g, " ");
}

/**
 * The command as the SHELL saw it: quoted segments removed entirely (not blanked
 * as in `stripQuotes`), so an operator character inside a message — the `|` of a
 * markdown table, the `;` of a sentence — is not mistaken for a pipeline, and a
 * word inside a message is not mistaken for a flag. Anything the shell would
 * have passed as an argument survives; everything the user typed as text does
 * not.
 */
function unquoted(command: string): string {
  return command.replace(/'[^']*'|"[^"]*"/g, " ");
}

/** The matched invocation when a command runs review-accept or names the store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return scanCommand(command);
}

/**
 * The scan. Every route needs a protected name, so a command that names none is
 * out immediately — one token walk answers that for all of them at once.
 *
 * @param command the raw command text
 * @returns the refusal token when the command must be blocked, else undefined
 */
export function scanCommand(command: string): string | undefined {
  // Every route needs a protected name, so one token walk answers the question
  // for all of them. It reads the RAW command: a commit message does name the
  // store, and it is the exemptions below that make that harmless — not a blind
  // spot in the name test.
  const named = namedIn(command);
  if (!named) return undefined;
  // `stripped` (quotes blanked) answers "does an ARGUMENT write"; `shellView`
  // (quotes removed) answers "does a word the shell actually parsed run
  // something". Text inside quotes is prose, and the guard cannot tell a doc
  // comment naming the module from a table cell naming it — so prose never
  // decides a verdict on its own.
  const stripped = stripQuotes(command);
  const shellView = unquoted(command);
  // A test run may name the store's files by glob (a read-only suite); it may not
  // name the operator's script, and it may not carry an eval flag. This is judged
  // BEFORE the runtime route below, because `bun test` is an invocation of a
  // runtime and would otherwise be refused by it: what distinguishes a suite that
  // reads the store from one that reaches it is the runner's shape, not the
  // presence of the name.
  if (TEST_RUN.test(shellView) && !EVAL.test(shellView) && !namedIn(command, SCRIPT_NAMES))
    return undefined;

  // #1125 — a runtime that reads its program from stdin, or evaluates code named
  // on the command line, executes a body the command never shows. The runtime
  // plus the store route is therefore refused on its own, whichever line each
  // half sits on, and the store half is the EXACT name rather than any mention
  // of it. `bun -` alone is refused too: what arrives down the pipe is
  // precisely the part the guard cannot read.
  if (RUNTIME_STDIN.test(shellView)) return PROTECTED_NAMES.store;
  if ((EVAL.test(shellView) || RUNTIME_INVOKED.test(shellView)) && storeNamed(shellView))
    return PROTECTED_NAMES.store;
  // #1125 — the plain-git/gh exemption is revoked by an argument that makes the
  // tool write a file or run an alias, and by a git that removes the data file:
  // the data file dominates the exemption. Everything else about the command is
  // judged below.
  if (PLAIN_VCS.test(command)) {
    const destructive = named === PROTECTED_NAMES.data && DESTRUCTIVE_VCS.test(command);
    if (!carriesWriteArg(stripped) && !destructive) return undefined;
  }
  // The data file is refused wherever it appears.
  if (named === PROTECTED_NAMES.data) return named;
  // The operator script or its write module, run directly by path.
  const direct = DIRECT_RUN.exec(command);
  if (direct) return direct[0].trim();
  // A runtime and a protected name on one line.
  const same = RUNTIME_NAME.exec(command);
  if (same) return same[0].trim();
  // A git/gh segment inside a chain is not plain, so it lands here; its
  // write-capable argument is what makes naming the store a route.
  if (vcsSegmentCarriesWrite(stripped)) return named;
  return undefined;
}

/** The target path when an edit-style call would write the findings file, else undefined. */
export function editsFindingsFile(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const target = (input as { path?: unknown } | null)?.path;
  if (typeof target !== "string") return undefined;
  const base = target.split(/[\\/]/).pop() ?? "";
  return FINDINGS_BASENAME.test(base) ? target : undefined;
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string })?.command ?? "";
      if (!runsReviewAccept(command)) return;
      trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
      return {
        block: true,
        reason:
          "Accepting a review finding is an operator act. Agents may not run extension/scripts/review-accept.ts or touch the review findings store; the operator runs review-accept.ts in a terminal with `--reason`. If this is an ordinary git/gh read, drop the write-capable argument (--output/-o/-c or an alias) and it is allowed again.",
      };
    }
    const target = editsFindingsFile(event.toolName, event.input);
    if (!target) return;
    trace(`review-accept-guard: BLOCKED ${event.toolName} of the review findings file`);
    return {
      block: true,
      reason: `The review findings file (${target}) is written only by the operator's review-accept.ts. Agents may not edit it.`,
    };
  });
}

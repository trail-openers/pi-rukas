/**
 * memory-write-tokenizer — the shell-shaped half of the #1437 memory-write
 * refusal: what counts as a `vipune` invocation, and where in a command line a
 * verb may be found.
 *
 * `memory-write-guard.ts` owns the POLICY (which verbs are refused, the
 * exemption, the refusal text). This module owns the PARSE: the token walk that
 * tracks command position through wrappers, env assignments, brace groups and
 * the binary's own global options, plus the flag scanner. The seam is the token
 * list and the (index, verb, argument-span) triples — the guard never touches a
 * regex, and this module never names a refused verb.
 *
 * Why the scan walks TOKENS rather than one monolithic regex: the two questions
 * — "is this token the binary?" and "was the previous token a command-position
 * starter?" — cannot both live in a pattern without distorting each other. An
 * earlier single-regex version failed both ways: a greedy option-skip group
 * captured `42` as the verb of `vipune --json delete 42`, and its lazy
 * counterpart captured `--json`.
 */

import { COMMAND_WRAPPERS, stripQuotedSegments } from "./bash-command-parser.ts";

/**
 * Strip quote characters from a string.
 *
 * Deliberately NOT `stripQuotedSegments`: that one drops the CONTENT of every
 * quoted run, which is right for the `vipune delete`-mentioned-in-a-memory-body
 * case and wrong for flag names. A flag name that survives to the binary is a
 * flag the binary acts on, and bash's quote removal keeps it: measured,
 * `vipune update 1 "--status" active` answers `error: unexpected argument
 * 'active' found` — i.e. clap consumed `--status`, so the row really is
 * mutated. An agent can put quotes around any single word and it still reaches
 * clap, so the flag scan reads the de-quoted form.
 *
 * The two forms are used together and the difference is the whole point: the
 * VERB scan reads the quote-stripped skeleton (which is why
 * `vipune add 'vipune delete is denied'` stays allowed), the FLAG scan also
 * reads this (which is why `vipune update 1 "--status" active` is refused).
 */
export function stripQuoteChars(s: string): string {
  return s.replace(/["']/g, "");
}

/**
 * The same command with the QUOTE CHARACTERS removed but every quoted run kept
 * as one token — which is what bash's word splitting then produces, and what
 * clap receives.
 *
 * `stripQuoteChars` on the whole command is the obvious version and it overreaches:
 * it dissolves the quote boundary, so `vipune add 'say update --status please'`
 * becomes a run of bare words in which a granted verb appears to carry a mutating
 * flag. Walking the quote structure keeps that body ONE token, so it is not a flag
 * and not a verb, while `"--status"` still de-quotes to the flag clap honours.
 *
 * Escapes inside double quotes are left in place (`\"` stays two characters), which
 * is the conservative choice: an escaped quote cannot become a real flag boundary.
 * An unterminated quote returns the input unchanged — a malformed command is not
 * this pass's problem, and the primary pass still sees it via `stripQuotedSegments`'
 * own fail-closed return of the raw command.
 */
export function deQuoteKeepingQuotedRuns(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n && s[i] !== quote) {
        if (quote === '"' && s[i] === "\\" && i + 1 < n) {
          out += s[i] ?? "";
          i++;
        }
        out += s[i] ?? "";
        i++;
      }
      if (i >= n) return s; // unterminated — leave the command as the agent typed it
      i++; // the closing quote is dropped; the run stays one token
      continue;
    }
    out += ch ?? "";
    i++;
  }
  return out;
}

/**
 * Flags that change an existing row. `update` alone is inert (it requires at
 * least one of these to do anything), so the clause that tests them binds to
 * the `update` verb first.
 *
 * Measured against vipune 0.15.0 — `vipune update <id> --stat active` answers
 * `error: unexpected argument '--stat' found` — clap does **not** accept an
 * abbreviated long flag. `--stat`, `--imp`, `--mem-t` and `--memorytyp=fact`
 * therefore mutate nothing, and are deliberately NOT matched: refusing a command
 * the binary rejects outright would report a threat that does not exist, and the
 * module header, `docs/troubleshooting.md` and `skill/vipune/SKILL.md` say exact
 * names and `=` forms for the same reason.
 *
 * Clustered short flags are the opposite case and ARE accepted by the binary:
 * measured, `vipune update <id> -tm` reaches the database and rewrites the row
 * with content `m`, because `t` consumes `m` as `--text`'s value. A cluster
 * member can mutate a row invisibly, so clusters are scanned character by
 * character in `hasMutatingFlag` below.
 *
 * The same flag names exist on `add` (`-m`, `--memory-type`, `--status`,
 * `--importance`), which is exactly why they must bind to `update` — a
 * verb-blind flag scan refuses every driver write.
 */
export const MUTATING_UPDATE_FLAGS: readonly string[] = [
  "-t",
  "--text",
  "-m",
  "--metadata",
  "--memory-type",
  "--status",
  "--importance",
];

// Command-position starters are the sibling guards' set (`discardsUncommittedWork`
// and `createsIssue` scan after `[;&|\n]`) plus `(`, `!` and the compound keywords
// bash puts before a command. The keywords are matched as WHOLE tokens — `then`,
// never a `then` inside `todo` — which the token walk gives us for free and a
// `\b`-anchored pattern does not (`_` is a word character, so `\b` cannot
// separate `memory__` from `vipune` either).
const COMMAND_POSITION_STARTERS: readonly string[] = [
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "for",
  "case",
  "&&",
  "||",
  "|||",
];

// Openers that attach to the token that follows them with no space, so they are
// stripped from the front of a token before the binary test (`(vipune delete 42)`).
// `{` is in the class because `{ vipune delete 42; }` is a brace GROUP — bash runs
// the words inside it as a command, so the `{` plays exactly the role `(` plays
// for a subshell. `}` is matched too: the shell tokenises `{ vipune …` as `{` +
// `vipune`, but `{vipune` attaches with no space and the opener has to come off.
const TOKEN_OPENERS = /^[(!{}]+/;

// Between the starter and the binary: process wrappers and KEY=value env
// assignments (`env FOO=1 vipune …`, `VIPUNE_DEBUG=1 vipune …`, `timeout 30
// vipune …`, `nice -n 5 vipune …`). The wrapper words are the ONE list in
// bash-command-parser.ts (`COMMAND_WRAPPERS`), so this guard and the prefix
// extractor cannot drift into disagreeing about what a wrapper is.
//
// A wrapper consumes its own positional arguments (`timeout 30`, `nice -n 5`,
// `env FOO=1`) — the token after a wrapper is ITS argument, not the command — so
// the scan stays in command position across them. That is what `env FOO=1 vipune
// delete 42` and `timeout 30 vipune delete 42` depend on: the wrapper rule is the
// ONLY difference between those two and `echo x vipune delete 42`, which is
// correctly not refused.
function isWrapperToken(token: string): boolean {
  return (
    COMMAND_WRAPPERS.has(token) ||
    PRIVILEGE_WRAPPERS.includes(token) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
  );
}

// Privilege / session wrappers, kept LOCAL to this guard and deliberately NOT
// added to the shared `COMMAND_WRAPPERS`. That set drives prefix extraction for
// "Allow always (cmd *)" scopes, where `sudo npm test` must NOT collapse to
// `npm test` — a cached scope for the unprivileged form must not cover the
// privileged one. Here the requirement is the mirror image: `sudo vipune delete`
// IS the same memory write as `vipune delete`, so the wrapper is transparent.
// Two consumers, two correct answers, so two lists.
//
// Each is matched as a WHOLE token, and `sudo`'s option arguments are consumed
// (`-u`/`-g` take a value; `-E`, `-H`, `-b` take none) so `sudo -u postgres
// vipune delete 42` does not read `postgres` as the command and give up.
// `sudo -C` / `--chdir` take a value and are in the value set for the same
// reason. `nsenter` takes options but also a program, so the general fall-through
// (a non-option token after a wrapper stays in command position) covers it.
const PRIVILEGE_WRAPPERS: readonly string[] = ["sudo", "doas", "pkexec", "setsid", "nsenter"];

// `sudo`'s long forms whose value is the NEXT token. The short forms of the same
// options (`-u`, `-g`, `-C`, `-D`) are handled by the `-`-prefix rule in the
// wrapper loop, which consumes the token after any `-flag` this wrapper owns.
const PRIVILEGE_WRAPPER_VALUE_FLAGS: readonly string[] = [
  "--user",
  "--group",
  "--chdir",
  "--login-class",
  "--prompt",
  "--rdprofile",
  "--profile",
];

// Does this wrapper's option take a separate-token value?
function privilegeOptionTakesValue(token: string): boolean {
  if (PRIVILEGE_WRAPPER_VALUE_FLAGS.includes(token)) return true;
  // Short forms that take a value: -u, -g, -C, -D (and the combined `-upostgres`
  // form carries its own value and matches neither branch, which is fine — it is
  // one token and consumes one slot).
  return /^-[uGC]$/.test(token);
}

// Is this token the vipune binary? Bare `vipune`, `oo vipune` (the allowlist's
// wrapper verb, handled by the wrapper loop), or a path whose FINAL segment is
// `vipune` (`/usr/local/bin/vipune`, `~/bin/vipune`, `./vipune`). The path form
// requires a `/`, which — together with the whole-token comparison — is what keeps
// `mcp__codebase_memory__vipune` unmatchable: it is one token, it is not equal to
// `vipune`, and it carries no `/`.
// Matched against a WHOLE token. `mcp__codebase_memory__vipune` is one token, is
// not equal to `vipune`, and carries no `/`, so no branch reaches it — which is
// what the leading `(?:^|…)` on the token level buys and a `\b` pattern could not.
//
// NOT global, and that is load-bearing: this is the one pattern here reused with
// `.exec()` rather than `.test()`, so a `g` flag would make it carry `lastIndex`
// between calls and go intermittently blind — every second invocation starting
// mid-string, the binary token never matching, the guard reporting "no
// violation". `test-memory-write-guard.ts` pins `.global === false`.
const BINARY_TOKEN = /^(?:[^\s;&|()<>]*\/)vipune$|^vipune$/;

// Global options `vipune` accepts before the verb, with how many SEPARATE-TOKEN
// values each requires — transcribed from `vipune --help`'s `Options:` block, and
// that is the whole table on purpose: this is not a clap grammar, it is the four
// lines the binary prints. `test-memory-write-guard.ts` re-reads the help block
// and fails if the table and the binary disagree about which take a value.
//
// The arity is what makes the verb findable. Without a stopping rule, `vipune -p
// other delete 42` and `vipune --db-path X delete 42` each leave a bare word
// between the flag and the verb: a scan that keeps going reads past `delete`, a
// scan that stops reads `-p` as the verb. clap decides — `vipune -p` alone answers
// `error: a value is required for '--project <PROJECT>'`, `vipune --json` alone
// proceeds to "requires a subcommand" — so a `<VALUE>` option consumes one token
// and a bare flag consumes none.
type GlobalOption = { readonly flags: readonly string[]; readonly values: number };

export const GLOBAL_OPTIONS: readonly GlobalOption[] = [
  { flags: ["--json"], values: 0 },
  { flags: ["-h", "--help"], values: 0 },
  { flags: ["-V", "--version"], values: 0 },
  { flags: ["-p", "--project"], values: 1 },
  { flags: ["--db-path"], values: 1 },
];

/**
 * How many following tokens this option token consumes as its values.
 *
 * `undefined` means "not an option" — that is where the skip stops and the verb
 * begins. An UNKNOWN `-f` flag returns its arity as 0 rather than `undefined`,
 * which is the fail-toward-refusing direction the PM asked for: consuming nothing
 * means the next token is read as the verb, so a `vipune --verbose delete 42`
 * still reports `delete`, while a `vipune search --whatever foo` cannot have a
 * refused verb conjured out of a granted one (the verb still has to literally
 * appear, and it has to be one of the refused names).
 */
export function optionArity(token: string): number | undefined {
  if (token.length < 2 || token[0] !== "-") return undefined;
  if (token.includes("=")) return 0; // `--flag=value` carries its own value
  for (const spec of GLOBAL_OPTIONS) {
    if (spec.flags.includes(token)) return spec.values;
  }
  return 0;
}

// The tokeniser splits on the WHOLE whitespace class, not `[ \t]`: bash separates
// words on `$' \t\n\v\f\r'`, so `vipune delete\v42` is TWO words to bash — measured
// (`bash -c $'vipune delete\v42'` → `unrecognized subcommand 'delete42'`, because
// dash-class shells strip the `\v` in the *second* word too) — and a space-and-tab
// splitter reads the same command's verb as one token with an escape glued to it.
// The refused direction is the cheap one, but the asymmetry is real: bash's own IFS
// is what decides whether a verb exists at all, so the guard reads the same class.
// `\s` is a superset of IFS (it adds U+00A0/U+2028/U+2029, which bash treats as
// ordinary argument bytes) and splitting an argument on one of those can only ever
// turn "not matched" into "matched", never the reverse — the failure direction a
// guard takes.
//
// Literal regexes, never `new RegExp` from a class string with the `g` flag: a
// global regex object carries `lastIndex` between `split` calls, so one shared
// module-level instance makes every other split start mid-string and silently drop
// the token holding the binary — the whole guard then reports "no violation" on
// every other command.
export const WORD_SEPARATOR = /\s+/;
// Segments split on the operator set ONLY — deliberately NOT on any whitespace
// character. The symmetry with `WORD_SEPARATOR` is tempting and wrong in both
// directions, and both directions were measured:
//
//   - cutting on `\s` is what makes `vipune update 12 && cp --status x` start
//     being refused, and cuts a clause mid-argument;
//   - cutting on the IFS whitespace (`\v\f\r`) as well would cut the `vipune`
//     binary itself in half, because `stripQuotedSegments` leaves the delimiters
//     of a removed quoted run in place — `vipune\vdelete 42` would split to
//     `vipune` + `delete 42` and the binary would never match.
//
// `WORD_SEPARATOR` is the half that reads a verb out of `vipune\vdelete`; this is
// the half that keeps a clause whole. A quoted memory body that hid a second
// invocation behind a `\v` is covered by `verbsIn` scanning the whole segment for
// binary tokens, not by cutting.
export const SEGMENT_SEPARATOR = /[;&|\n]/;

// Command-position starters plus `{`/`}` — the brace-group delimiters, which bash
// tokenises as separate words (`{ vipune delete 42; }` runs the command) and which
// also glue to the token after them (`{vipune`). Splitting them out of the wrapper
// comparison keeps that widening local to "may this token start a command", where
// `{` cannot be a binary anyway.
const POSITION_STARTERS: readonly string[] = [...COMMAND_POSITION_STARTERS, "{", "}"];

/**
 * One hit: the verb's token index, the verb as the quote-stripped skeleton reads
 * it, the de-quoted tokens after the binary, and the COLLAPSED verb — the same
 * slot with quotes and backslashes removed, which is what clap is handed.
 *
 * The two verb readings differ exactly where round 3's lens findings landed:
 * `vipune del""ete 42` reads `delete` here and `delete` in `collapsed`, and only
 * one of those is in the refused set. Keeping both on the hit, rather than
 * re-deriving one from the other at the call site, is what stops the two halves
 * of the seam disagreeing about which spelling a command used.
 */
export type VerbHit = readonly [number, string, readonly string[], string];

/**
 * Every (tokenIndex, verb, argument-span) triple in one operator-delimited
 * segment: each position where a vipune binary token appears in command position,
 * paired with the verb that follows it and the de-quoted option tokens scanned
 * while looking for that verb. Returns the segment's token list too, because the
 * update-flag check has to read the same list the scan produced — a single shared
 * mutable would let the two halves disagree whenever a segment is scanned between
 * the call and the check, so the pair travels together.
 */
export function verbsIn(segment: string): { tokens: string[]; hits: VerbHit[] } {
  const tokens = segment.split(WORD_SEPARATOR).filter((t) => t !== "");
  const hits: VerbHit[] = [];
  // `inPosition` is true at the start of a segment (a `;`-delimited clause begins
  // in command position) and after any starter token; any other token that is not
  // the binary clears it, because after `cp foo` the next word is an argument.
  let inPosition = true;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] ?? "";
    // `(vipune`, `!vipune`, `{vipune`: openers attach with no space, so they are
    // stripped before the whole-token comparisons.
    const token = raw.replace(TOKEN_OPENERS, "");
    if (token === "") continue;
    if (POSITION_STARTERS.includes(token) || isOperatorStarter(raw)) {
      inPosition = true;
      continue;
    }
    if (isWrapperToken(token)) {
      // `timeout 30`, `nice -n 5`, `env FOO=1`, `sudo -u postgres`: consume the
      // wrapper's own arguments, but a NON-wrapper token after a wrapper may be
      // the command itself (`nohup vipune …`, `exec vipune …`, `sudo vipune …`),
      // so only a KEY=value token or a `-flag`/`-n` option is swallowed. Anything
      // else leaves command position set for the next token, which is what
      // `nohup vipune delete 42` and the bare-wrapper shapes depend on.
      const privilege = PRIVILEGE_WRAPPERS.includes(token);
      let k = i + 1;
      while (k < tokens.length) {
        const next = (tokens[k] ?? "").replace(TOKEN_OPENERS, "");
        if (next === "-n") {
          k += 2; // `nice -n 5` — the value after the option
          continue;
        }
        if (privilege && next.startsWith("-")) {
          // `sudo -E -u postgres vipune …`: every option this wrapper owns is its
          // own, never the command's, and a value-taking one also swallows the
          // token after it. Without this, `postgres` is read as the command and
          // the invocation is missed.
          k += privilegeOptionTakesValue(next) ? 2 : 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
          k++; // `env FOO=1` / `VIPUNE_DEBUG=1`
          continue;
        }
        if (/^\d+[smhd]?$/.test(next)) {
          k++; // `timeout 30`, `timeout 30s` — a duration, never a command
          continue;
        }
        break;
      }
      i = k - 1;
      continue;
    }
    // `oo` is the allowlist's wrapper verb and transparent: `oo vipune delete 42`
    // is the same invocation as `vipune delete 42`, so `oo` neither is the binary
    // nor ends command position.
    if (token === "oo") continue;
    if (BINARY_TOKEN.test(token)) {
      if (!inPosition) continue;
      // Skip this invocation's leading global options and their required values;
      // the next token is the verb. `flags` is EVERY token after the binary, in the
      // de-quoted form clap sees — quote removal is what makes `"--status" active`,
      // `--"status" active` and `"--status active"` real flags that the
      // quote-stripped skeleton cannot show.
      const flags: string[] = [];
      let j = i + 1;
      while (j < tokens.length) {
        const option = tokens[j] ?? "";
        flags.push(stripQuoteChars(option));
        const arity = optionArity(option);
        if (arity === undefined) break;
        j += 1 + arity;
        if (arity > 0) flags.push(stripQuoteChars(tokens[j] ?? ""));
      }
      for (let k = j + 1; k < tokens.length; k++) flags.push(stripQuoteChars(tokens[k] ?? ""));
      // The collapsed reading of the verb slot — what clap gets after quote and
      // backslash removal. `vipune del""ete 42` reaches the binary as `delete`, so
      // the refused-verb test has to read THIS, not the quote-stripped skeleton.
      hits.push([j, tokens[j] ?? "", flags, collapsedToken(tokens[j] ?? "")]);
      // Everything after the binary in this clause is an argument, so a second
      // `vipune` later in the clause is an argument word, not a command.
      inPosition = false;
      continue;
    }
    inPosition = false;
  }
  return { tokens, hits };
}

// An operator glued to the front of a token (`&&vipune`, `(vipune`) is still a
// starter — `;` and `&&` were already split away above, but `(` and `!` attach.
function isOperatorStarter(token: string): boolean {
  return token === "(" || token === "!" || token.startsWith("&&") || token.startsWith("||");
}

/** The segment's tokens, split the way bash splits them. */
export function tokenize(segment: string): string[] {
  return segment.split(WORD_SEPARATOR).filter((t) => t !== "");
}

/** Is this token the vipune binary (bare, pathed, with openers glued on)? */
export function isBinaryToken(token: string): boolean {
  return BINARY_TOKEN.test(token.replace(TOKEN_OPENERS, ""));
}

/**
 * The quote-stripped skeleton the verb scan reads: quoted runs removed, so a
 * memory body that merely MENTIONS `vipune delete` is not a command.
 *
 * Re-exported rather than imported by the guard directly so the guard's only
 * parsing dependency is this module — one place to look for how a command is read.
 */
export function stripQuotedCommand(command: string): string {
  return stripQuotedSegments(command);
}

/**
 * The verb-position reading of a token: quote characters and backslash escapes
 * removed, so `del""ete`, `dele''te` and `de\lete` all collapse to `delete`.
 *
 * This is NOT `stripQuoteChars` (which removes quotes but keeps the contents of
 * every run, and is used for FLAGS) and NOT `stripQuotedSegments` (which drops
 * the contents outright, and is what makes a memory body that MENTIONS
 * `vipune delete` allowed). The three differ because they answer three
 * questions, and only this one asks "what verb does clap get?": bash removes
 * quotes and backslashes before the word is dispatched, so an ungranted verb
 * split across an empty quote still dispatches.
 *
 * Applied to command-position tokens only — verb slot and option-value slot —
 * never to an argument span, where a memory body's own quotes would collapse
 * into a verb that was never in command position.
 */
export function collapsedToken(token: string): string {
  return token.replace(/["'\\]/g, "");
}

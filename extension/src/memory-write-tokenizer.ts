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
import { GLOBAL_OPTIONS, optionArity } from "./memory-write-cli-surface.ts";

// The binary's own vocabulary lives in `memory-write-cli-surface.ts` and is
// re-exported here so the guard's parsing dependency stays this one module — the
// seam documented in the header. Consumers never import the surface directly.
export {
  GLOBAL_OPTIONS,
  MUTATING_UPDATE_FLAGS,
  optionArity,
} from "./memory-write-cli-surface.ts";

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

// Wrappers that LOOK UP a name instead of running it. `command -v vipune` prints
// `/usr/local/bin/vipune` and exits; the word after `-v` is the option's operand,
// not a command, so command position ends there. Every other wrapper execs its
// operand, so its options are consumed and the command still follows — conflating
// the two is what let `env -i vipune delete 42` reach the binary while
// `command -v vipune` was wrongly refused.
const RESOLVING_WRAPPERS = new Set(["command", "builtin", "type"]);

// The resolving wrappers' "the NEXT WORD IS THE NAME" options: `-v`/`-V` print the
// path (`-V` prints `command`'s own version, which runs nothing either), `-n`
// suppresses the alias in `type`/`builtin`. A value-taking option that EXECUTES
// (`command -p PATH cmd` runs `cmd`) is deliberately absent, and that absence is the
// whole difference between `command -v vipune /usr/bin/vipune` (prints a path) and
// `command -p /opt/bin vipune delete 42` (deletes a row).
const RESOLVING_OPERAND_OPTIONS: readonly string[] = ["-v", "-V", "-n"];

// Options on a resolving wrapper that take a separate-token VALUE and then EXECUTE
// their operand: `command -p /opt/bin vipune delete 42` prepends a path and runs the
// command, so the path is the option's operand and `vipune` is still the command.
// `-v`/`-V`/`-n` are NOT here — they print and exit — and `-i`/`-a`/`--foreground`
// are not either, being valueless flags whose following word stays the command.
const WRAPPER_OPTIONS_WITH_VALUE: readonly string[] = ["-p", "-P", "-u", "-k"];

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
  const tokens = tokenize(segment);
  const hits: VerbHit[] = [];
  // `inPosition` is true at the start of a segment (a `;`-delimited clause begins
  // in command position) and after any starter token; any other token that is not
  // the binary clears it, because after `cp foo` the next word is an argument.
  let inPosition = true;
  // Token indices a wrapper consumed as its own argument. A wrapper's arguments are
  // skipped by BOTH scans — this walk and the guard's raw-text pass — because
  // "is a wrapper argument" is a property of the word's place in the clause, not of
  // the state of the scan. Without the set, the outer loop and the wrapper scan
  // disagree about the same token depending on which of them ran first.
  const consumed = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
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
      // A wrapper's arguments are its own, never the command; and unlike the other
      // two ways a word is disqualified — "after the binary it is an argument",
      // "after a non-binary command it is an argument" — "is a wrapper argument" is
      // a property of the word's PLACE in the clause, not of the state of the scan.
      // So the words this scan consumes are skipped for the OUTER loop as well, via
      // `consumed`. That is what keeps the two rules that used to fight each other
      // out of the same token: `i` is advanced one-way past everything claimed, and
      // nothing here assigns `inPosition` except the `command -v` rule at the foot.
      const privilege = PRIVILEGE_WRAPPERS.includes(token);
      let k = i + 1;
      while (k < tokens.length) {
        const next = (tokens[k] ?? "").replace(TOKEN_OPENERS, "");
        if (next === "-n") {
          consumed.add(k);
          k += 2; // `nice -n 5` — the value after the option
          continue;
        }
        // THE RULE (PM's, and the only shape here that survives both directions of
        // error): after a wrapper, consume EVERY following `-`-prefixed token and
        // STAY in command position. Arity is not guessed at all. The pre-fix loop
        // stopped at the first `-flag` outside its vocabulary and read the word AFTER
        // it as the command, which is how `env -i vipune delete 42`,
        // `env --unset=FOO vipune delete 42`, `timeout --foreground 30 vipune delete
        // 42` and `nohup -a vipune delete 42` each reached the binary — four shapes,
        // one cause. Guessing arity instead (an earlier draft assumed every bare
        // short flag took a value) fails the other way and silently: `env -i`
        // swallowed `vipune`, and a guard that cannot see the binary reports "no
        // violation". The exceptions below are the two cases where the operand is
        // provably the wrapper's own data (`sudo -u postgres`, `command -p /opt/bin`)
        // and so can never be the command.
        if (next.startsWith("-")) {
          // The wrapper's own operand, never the command. Which options qualify is
          // on the two constants the expression reads; the reason a wrong answer
          // there is survivable in one direction and not the other is on
          // `WRAPPER_OPTIONS_WITH_VALUE`.
          const arity =
            privilege && privilegeOptionTakesValue(next)
              ? 2
              : RESOLVING_WRAPPERS.has(token) && WRAPPER_OPTIONS_WITH_VALUE.includes(next)
                ? 2
                : 1;
          for (let m = k; m < k + arity; m++) consumed.add(m);
          k += arity;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
          consumed.add(k);
          k++; // `env FOO=1` / `VIPUNE_DEBUG=1`
          continue;
        }
        if (/^\d+[smhd]?$/.test(next)) {
          consumed.add(k);
          k++; // `timeout 30`, `timeout 30s` — a duration, never a command
          continue;
        }
        break;
      }
      // The two resolving wrappers' "the word after the option is a NAME" rule, the
      // only place in this scan that ends command position. Conditions and the
      // exec-vs-print split are on the constants it reads.
      const stoppedOn = k < tokens.length ? (tokens[k] ?? "").replace(TOKEN_OPENERS, "") : "";
      const operand = k + 1 < tokens.length ? (tokens[k + 1] ?? "") : "";
      if (
        !privilege &&
        RESOLVING_WRAPPERS.has(token) &&
        RESOLVING_OPERAND_OPTIONS.includes(stoppedOn) &&
        stoppedOn.startsWith("-") &&
        !operand.startsWith("-")
      ) {
        consumed.add(k);
        consumed.add(k + 1); // the option and its operand are both lookups, not commands
        inPosition = false;
        i = k + 1;
        continue;
      }
      // Hand the token the scan stopped on back to the outer loop — it is the
      // candidate command, and the scan's whole contract is to stop on it. Tokens the
      // scan consumed are in `consumed`, so they are never re-read at all; there is
      // no second pass over a wrapper word to disagree with the first about. Resume
      // one slot BACK so the outer loop reads `tokens[k]` itself: `for`'s `i++` lands
      // exactly on it.
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

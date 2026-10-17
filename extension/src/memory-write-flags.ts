/**
 * memory-write-flags — the flag half of the #1437 memory-write refusal.
 *
 * `memory-write-tokenizer.ts` decides *where* a vipune invocation is in a
 * command line; this module decides whether the tokens after its verb carry a
 * flag that mutates an existing row, and reads the quoted forms clap actually
 * receives. Split from the tokenizer at the natural seam: the tokenizer's
 * question is "is this a command", this one's is "does this write".
 */

import {
  MUTATING_UPDATE_FLAGS,
  VerbHit,
  isBinaryToken,
  optionArity,
  tokenize,
} from "./memory-write-tokenizer.ts";

// True when the arguments following `vipune update` carry a row-mutating flag,
// in whole (`--status active`) or `=` (`--status=active`) form, or as a member
// of a clustered short flag (`-tm`). Tokens arrive already split and already cut
// at the next shell operator, so a chained command cannot borrow a flag from a
// different invocation — `vipune update 12 && cp --status x` is not a mutating
// update.
//
// Matching on TOKENS, not on a `(^|\s)flag(\s|=)` regex: the common `&&` chain
// (`vipune update 12 -t x && git add -A`) leaves trailing `&` characters where a
// regex anchored on a whitespace-or-`=` boundary would MISS the exact shape the
// guard exists for. A memory body cannot forge either form, because quoted
// segments are stripped before this runs.
//
// No long-flag prefix matching: measured on vipune 0.15.0, clap rejects every
// abbreviation (`--stat`, `--imp`, `--mem-t`, `--memorytyp=fact` → `unexpected
// argument`), so a prefix that merely LOOKS like `--status` mutates nothing.
export function hasMutatingFlag(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    // A quoted run that contained an operator was cut by the segment split, so a
    // token may carry leading/trailing quote characters (`"-t`, `x"`). They are
    // not what clap sees; the scan reads the name underneath them.
    const name = (token.split("=")[0] ?? "").replace(/^["']+|["']+$/g, "");
    if (MUTATING_UPDATE_FLAGS.includes(name)) return true;
    // Clustered short flags: every character is tested, not just the first.
    // Measured on 0.15.0, each of these reaches the database and rewrites the
    // row — `-tm` stores content `m` (t consumes m as --text's value), `-mt`
    // errors on --metadata's missing value, `-ta`/`-at`/`-xm` likewise mutate.
    // A cluster member is therefore a mutating flag even when the token's first
    // character is not one, which is the whole reason for the inner loop.
    //
    // `=` is not a boundary: `-t=x` is accepted and stores `x` (measured), so
    // `=` introduces no new flag but must not stop the scan either — stopping at
    // it would make `-xm=1` read as a harmless `x`.
    if (name.length > 2 && name.startsWith("-") && !name.startsWith("--")) {
      for (let i = 1; i < name.length; i++) {
        const ch = name[i];
        if (ch === "=") continue;
        for (const flag of MUTATING_UPDATE_FLAGS) {
          if (flag.length === 2 && flag.startsWith("-") && flag[1] === ch) return true;
        }
      }
    }
  }
  return false;
}

/**
 * One `vipune … update …` clause carrying a row-mutating flag, read from the
 * de-quoted text where each quoted run is still ONE token (see
 * `deQuoteKeepingQuotedRuns`). The verb must sit where the verb goes — right after
 * the binary and its global options — and the flag must look like a flag (`-t`,
 * `--status`, `--status=…`, `-tm`), not merely spell one. So `vipune add 'say
 * update --status please'` is not a write (its `update` is not in verb position,
 * and its `--status` is inside one quoted token), while `vipune update 1 "--status"
 * active` is: the quotes come off and clap honours the flag.
 */
export function rawUpdateCarriesMutatingFlag(segment: string): boolean {
  const tokens = tokenize(segment);
  const at = tokens.findIndex(isBinaryToken);
  if (at < 0) return false;
  let v = at + 1;
  while (v < tokens.length) {
    const arity = optionArity(tokens[v] ?? "");
    if (arity === undefined) break;
    v += 1 + arity;
  }
  if (tokens[v] !== "update") return false;
  return tokens.slice(v + 1).some((t) => {
    const name = (t.split("=")[0] ?? "").replace(/^["']+|["']+$/g, "");
    if (MUTATING_UPDATE_FLAGS.includes(name)) return true;
    return (/^-[^-]/.test(name) || /^--/.test(name)) && hasMutatingFlag([name]);
  });
}

/**
 * The hole `verbsIn` leaves by construction: it clears `inPosition` once a
 * clause's first binary token is seen, on the reasoning that everything after
 * that binary is an argument. True for one invocation per clause; wrong for
 * `vipune search q vipune delete 1`, where a second binary token and its verb
 * are a second real command.
 *
 * Scan-not-anchor WITHIN the clause, past the one invocation `verbsIn` resolved:
 * command position is exactly what this hole defeats, so re-testing it would
 * re-create the bug. What bounds it is `from` — the scan starts AFTER the
 * resolved invocation's verb, so nothing before it is re-read — plus the value
 * skip below.
 *
 * `refused` is passed in rather than imported: this module must not name the
 * policy, or the two halves of the seam would each carry a list to drift.
 *
 * NOT scan-not-anchor. A bare "binary token then refused verb" scan refuses
 * `grep vipune delete file.log` and `echo vipune delete 42` — measured, it did —
 * which is the exact overreach the command-position tracking exists to prevent,
 * and the shape the argument-position canary block pins. So the scan is bounded
 * to tokens that FOLLOW a resolved invocation (`from`), and skips any run that an
 * option consumed: `vipune search --filter delete` never tests `delete`, because
 * `--filter`'s value is data, not a command. `vipune`'s own global arity table
 * decides which tokens are values; an unknown `-flag` consumes nothing, matching
 * `optionArity`.
 */
export function strayRefusedVerb(
  tokens: readonly string[],
  collapsed: readonly string[],
  refused: readonly string[],
  from: number,
): string | undefined {
  for (let k = from; k < collapsed.length - 1; k++) {
    const token = tokens[k] ?? "";
    if (!isBinaryToken(token)) {
      // An option of the intervening command owns the token after it when the
      // table says it takes a value — that token is a value, never a verb.
      const arity = optionArity(token.replace(TOKEN_OPENERS_RE, ""));
      if (arity !== undefined) k += arity;
      continue;
    }
    const verb = collapsed[k + 1] ?? "";
    if (refused.includes(verb)) return verb;
    // The rest of this invocation's own arguments: skip its global options and
    // their values, so `-p delete` inside a second command is not read as its verb.
    k += 1;
    let skip = k;
    while (skip < tokens.length) {
      const arity = optionArity((tokens[skip] ?? "").replace(TOKEN_OPENERS_RE, ""));
      if (arity === undefined) break;
      skip += 1 + arity;
    }
    k = skip - 1;
  }
  return undefined;
}

// Mirror of the tokenizer's opener class. Kept as a local literal rather than
// exported for one more call site: `(vipune` must read as `vipune` here exactly
// as it does there, and a `g`-flagged shared instance would be the round-3 bug
// this file already documents.
const TOKEN_OPENERS_RE = /^[(!{}]+/;

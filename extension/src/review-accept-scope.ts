/**
 * review-accept-scope — the six tests of clause (a) (#1125) that decide whether the
 * accept guard (`review-accept-guard.ts`) speaks to a command AT ALL. Split out so the
 * guard keeps its one dispatch (`scanCommand`) and the scope rule is ONE function that
 * BOTH of the guard's paths ask: the parsed command and the PARSE_FAIL one. The unreadable
 * branch used to consult a narrower rule than the readable one (#1738 lens review — it
 * checked the name test alone, so an unparseable command that reached the store by any of
 * the other five routes walked free), and two predicates that must agree are one
 * predicate short of drifting.
 *
 * Nothing here decides a refusal: `inScope` is a predicate. The arms, the segment-wide
 * gates and the remedy sentences stay in the guard, which is clause (c)'s one dispatch.
 */

import {
  hasStdinDash,
  hasWriteCapableArgument,
  namesGit,
  namesGitWriteVerb,
  namesInterpreter,
  namesPipedShell,
  namesShell,
  namesVcsOrForge,
  namesVcsOrRuntime,
} from "./review-accept-arms.ts";
import {
  EXPANSION,
  armsOf,
  isAcceptScriptToken,
  namesStore,
  shellWords,
} from "./review-accept-command.ts";
import { namesAttachedValue } from "./review-accept-names.ts";
import { readToolCarriesUnresolvedOperand } from "./review-accept-readtools.ts";
import { hasUnresolvedRepoSelector } from "./review-accept-selector.ts";
import { storeNameSubject, withoutHeredocBodies } from "./review-accept-views.ts";

/** The expansion test is the SHARED `EXPANSION` from `review-accept-command.ts` — one
 * regex the scope test, the read-tool operand test and the assignment view all ask.
 * Braces are DELIBERATELY absent from it: they are ordinary punctuation in prose and in
 * `awk '{print 1}'`, and a store name assembled from braces is caught by the brace-erased
 * view of `namesStore`. A BACKSLASH is absent for the same reason and by the same
 * argument: `echo -e "a\nb"`, `printf 'x\n'`, a `grep` BRE carrying `\|` and a `gh --jq`
 * filter carrying `"\n"` are ordinary agent text (#1665), and an ESCAPED spelling of the
 * store's name is caught by the backslash-erased view of `namesStore` instead. It is
 * asked of the RAW text minus any QUOTED-tag heredoc body: a quoted body is data, an
 * UNQUOTED one is shell-expanded into the program's arguments, so its `$` counts (#1764
 * criterion 4). */
/** The write-capable arguments clause (b) refuses and names, in the SPACED spelling —
 * `--output <name>`, `--ext-diff <name>`, `-o <name>`, `-c <name>` — and in the
 * `=`-ATTACHED spelling (`--output=<name>`). The arms' `hasWriteCapableArgument` owns the
 * pattern; this clause asks it of the guard's own word list. What is deliberately NOT
 * matched is a value GLUED to a flag letter without `=`: `-odata` is not an option in the
 * tools that take these flags (`git show -odata` reads `data` as a path operand), and
 * reading it as one made every short-flag command that mentions the store — `git commit
 * -oreview-findings.json`, `bun test --reporter junit … <store>` — a refusal for a flag it
 * never passed (#1764 fix round, criterion 6). */
/**
 * THE SCOPE OF CLAUSE (a) (#1125) — six tests decide whether the guard speaks to a
 * command at all. Anything else is an ORDINARY AGENT COMMAND and the allowlist does
 * not govern it: `mkdir -p tmp/x`, `git add -A`, `git push`, `npm install`,
 * `cargo test`, `python3 -c …`, `sed -n` / `awk` / `gh api` on a non-protected path
 * all pass, and neither the segment gates nor the arms are consulted. The arms
 * refusing those was the whole agent surface bricked.
 *
 *  (1) the name spelled as a word anywhere — raw, normalised, or with quotes / braces
 *      / commas erased, so `rev{iew-findings}.json` and `'rev''iew-findings.json'`
 *      count, and a heredoc body counts (the body is part of the raw text); the
 *      operator script's basename counts too, since running it is the act the whole
 *      guard exists to refuse. The ONE exception is a literal value of a known PROSE
 *      option — `git commit -m` / `--message`, `gh` / `glab` `--title` / `--body` / `-m`
 *      (#1764 criterion 12): a commit message ABOUT the guard is a sentence about it, not
 *      a route to it, and refusing those was ~285 halo commands. A prose value carrying
 *      `$` or a backtick is not prose, and an expansion the SAME command assigned is
 *      resolved first, so `F=<store>; cat > $F` is still named (criterion 6);
 *  (2) the name ATTACHED to an option (`git log -G<name>`, `-S<name>`, `--grep=<name>`,
 *      `git show HEAD:x -o<name>`): the option prefix glues the name to the flag, so
 *      no tokeniser ever hands `isProtectedToken` the bare name and no arm's operand
 *      test sees the pair — asked of the raw text and of its lowercase view, since git
 *      reads such a value exactly as written;
 *  (3) a git repo-location / config selector the guard cannot CLEAR (#1643): `-C <path>`
 *      aimed at the git common dir or at a protected file, `--git-dir` / `--work-tree` /
 *      `--exec-path`, or a `-c key=value` whose value the program runs. `git -C <worktree>
 *      log` — AGENTS.md's sanctioned form — clears and brings nothing in. It is a GIT
 *      shape, so it asks only when git itself is the program — `python3 -c '…'` is
 *      Python's inline-code flag and nothing moves. Asked PER SEGMENT, the unit the arms
 *      judge, so a chained `git -C <worktree> log && git -c core.fsmonitor=/tmp/p log`
 *      cannot clear the second segment on the first one's authority;
 *  (4) a heredoc marker or a stdin `-` beside a program that EXECUTES or WRITES from
 *      them: a runtime (`bun`, `node`, …) or a SHELL (`sh`, `bash`, `dash`, `ksh`, `zsh`,
 *      and `env sh` — the body is text the guard cannot read and the program will run it),
 *      or a git verb that puts bytes on disk from an operand it was handed
 *      (`apply`, `am`, `update-index`, `mv`, `rm`, `checkout-index`, `hash-object -w`).
 *      The verb is a POSITION — the bare word after the segment's leading `git`, in the
 *      segment that carries the unreadable operand — so prose that merely MENTIONS `git rm`
 *      is not a write route, and one `hash-object` decoy cannot answer for a write verb
 *      beside it (#1738). Asked of the RAW words, so a quoted `"apply"` — which the shell
 *      hands git as its verb — is not hidden by the quote fold. A `git commit -F- <<EOF`
 *      is neither — its heredoc is a message, read as text and written nowhere, which is
 *      why it stays allowed (#1643);
 *  (5) an UNREADABLE WORD carried by a command that can READ THE STORE. Two program sets
 *      qualify, and they are asked DIFFERENT questions (#1764 criterion 1): a runtime, git
 *      or a forge CLI is asked about ANY unreadable word — on those, a `$` can assemble a
 *      store name and no arm can vouch for the result (`cat {payload.js} | bun -`); a READ
 *      TOOL is asked only about the FILE operand it was handed, per tool kind — a content
 *      reader's (`cat`, `head`, `tail`), a file-stat tool's (`ls`, `wc`, `file`, `stat` —
 *      they read the file they are handed, so they are NOT print tools), and a search
 *      tool's (`grep`, `rg`) operands MINUS its pattern, where a pattern flag (`-e`,
 *      `--regexp`, `-f`, `--file`) or a `--` ends the pattern reading and makes EVERY
 *      positional a file. `echo "FMT_EXIT=$?"`, `cd $WT`, `tail -8` and `grep -n 'a$' f`
 *      name no unreadable file and bring nothing in: the command-wide "any read tool + `$`
 *      anywhere" shape of this test refused ~6,400 ordinary commands on one live run,
 *      which is the whole of #1764. A REDIRECTION TARGET is asked of EVERY segment
 *      whatever its program (`echo x > $F` moves bytes through a path no arm saw), which
 *      is what makes the print class safe to keep. A word with `$` or a backtick has no
 *      determinable final text; an expansion the SAME command assigned a literal to is
 *      resolved first, in READING order and abstaining on a name bound twice with
 *      different values (criterion 6), and a QUOTED-tag heredoc BODY is never an operand
 *      while an unquoted one is (criterion 4). A BACKSLASH is not such a word (#1665):
 *      the shell removes it, and the backslash-erased view of `namesStore` catches an
 *      escaped spelling of the store's name. On a program that is none of these — `awk`,
 *      `python3` — a store name can never reach the guard's protected bytes, and clause
 *      (a) leaves the command alone: braces alone are ordinary punctuation (`echo {a,b}`,
 *      `awk '{print 1}'` pass), and a name assembled from them is caught by (1)'s erased
 *      view.
 *  (6) a WRITE-CAPABLE ARGUMENT on a VCS/forge command: `-o<name>` / `--output=<name>`
 *      / `--ext-diff=<name>` ATTACHED to the flag, and any SPACED flag the arms' own
 *      `hasFlag` recognises. Clause (b) refuses these whatever the target, because the
 *      flag is a route to WRITING the store (`git show HEAD:x --output=f`). Asked only
 *      of a command that runs git / gh / glab, so `bun test --reporter junit …` and
 *      `verify-loop.sh --digest-mode on …` — a test runner's flags, on a program that
 *      writes nothing — stay the ordinary agent commands they are. A value glued to a
 *      flag letter WITHOUT `=` is not a flag at all (`git show -odata` is the path
 *      `data`), which is what keeps `bun test … <store>` and `git commit -m x -o<name>`
 *      adjudicated by the arms rather than by a substring that matches any short flag.
 *
 * `raw` is the command lowercased with its newlines kept, `norm` the folded, quote-folded
 * text normalise() produced (or the squeezed raw text when it did not — see the guard),
 * and `words` the words of `raw` as the shell hands them out.
 *
 * The return value is the CLAUSE THAT FIRED, not a boolean (#1764 criterion 10): a refusal
 * that says only "findings store" cannot be triaged, and the accept-CLI remedy the guard
 * prints is the remedy for test (1) ALONE, so the guard has to know which test spoke.
 * `undefined` is the only answer that means "ordinary agent command".
 */
export type ScopeClause =
  | "store-name"
  | "attached-value"
  | "repo-selector"
  | "executing-operand"
  | "unreadable-word"
  | "write-argument";

export function inScope(raw: string, norm: string, words: string[]): ScopeClause | undefined {
  if (namesStore(storeNameSubject(raw), storeNameSubject(norm), isAcceptScriptToken))
    return "store-name";
  if (namesAttachedValue(norm) || namesAttachedValue(raw)) return "attached-value";
  if (
    armsOf(raw).some(
      (segment) => namesGit(segment) && hasUnresolvedRepoSelector(shellWords(segment)),
    )
  )
    return "repo-selector";
  if (
    (norm.includes("<<") || hasStdinDash(words)) &&
    (namesInterpreter(norm) || namesShell(norm) || namesGitWriteVerb(raw))
  )
    return "executing-operand";
  // The two halves of test (5) ask DIFFERENT texts: the runtime / VCS half asks the whole
  // command (minus any heredoc body — data, never an argument), the read-tool half asks
  // its OWN file operands only — and it asks them of the RAW command, because that test
  // runs its own heredoc scan (`heredocArgumentText`) and feeding it a text whose quoted
  // bodies had already been cut out made the second scan report a body that never
  // terminates and quietly truncate the command at the `<<`, losing the `> $F` the first
  // scan had deliberately kept visible (#1764 fix round 3, C1).
  const readable = withoutHeredocBodies(raw);
  // A pipe whose TARGET runs a shell makes the SENDER the program the guard cannot read:
  // `cat $F | sh` executes whatever `$F` holds with no heredoc marker and no stdin dash for
  // the test above to see (#1764 fix round, criterion 8's shell arm). The unreadable word
  // is required as well, or `bun test 2>&1 | tee /tmp/log` — text the guard can read end to
  // end — would be refused for piping at a program that runs nothing dangerous.
  if (namesPipedShell(norm) && EXPANSION.test(readable)) return "executing-operand";
  if (namesVcsOrRuntime(norm) && EXPANSION.test(readable)) return "unreadable-word";
  if (readToolCarriesUnresolvedOperand(raw)) return "unreadable-word";
  // Asked ONLY of a command that runs git / gh / glab (#1764 fix round, criterion 6): a
  // test runner's OWN flags are not the store's write surface, and the un-gated test was
  // refusing `bun test --reporter junit foo` and `verify-loop.sh --digest-mode on foo`
  // while the store sat in the same command — the second a path the offline gate itself
  // runs. The flag list is the arms' `GIT_WRITE_ARG_FLAGS`, so the clause and arm A7
  // cannot drift apart.
  if (namesVcsOrForge(norm) && hasWriteCapableArgument(words)) return "write-argument";
  return undefined;
}

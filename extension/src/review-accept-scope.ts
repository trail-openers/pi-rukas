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
  OUTPUT_FLAGS,
  hasFlag,
  hasStdinDash,
  hasUnresolvedRepoSelector,
  namesGit,
  namesGitWriteVerb,
  namesInterpreter,
  namesVcsOrRuntime,
} from "./review-accept-arms.ts";
import {
  armsOf,
  isAcceptScriptToken,
  namesStore,
  shellVisible,
  shellWords,
} from "./review-accept-command.ts";
import { namesAttachedValue } from "./review-accept-names.ts";
import { readToolCarriesUnresolvedOperand } from "./review-accept-readtools.ts";
import { storeNameSubject, withoutHeredocBodies } from "./review-accept-views.ts";

/** A word carrying a substitution — `$` or a backtick. Braces are DELIBERATELY absent:
 * they are ordinary punctuation in prose and in `awk '{print 1}'`, and a store name
 * assembled from braces is caught by the brace-erased view of `namesStore`. A BACKSLASH
 * is absent for the same reason and by the same argument: `echo -e "a\nb"`, `printf
 * 'x\n'`, a `grep` BRE carrying `\|` and a `gh --jq` filter carrying `"\n"` are ordinary
 * agent text (#1665), and an ESCAPED spelling of the store's name is caught by the
 * backslash-erased view of `namesStore` instead — which is what an unreadable word could
 * otherwise hide. Asked of the RAW text (minus any heredoc BODY, which is data), so the
 * `$` inside a quoted message still counts and the `$` inside a heredoc body does not
 * (#1764 criterion 4). */
const EXPANSION_WORD = /[$`]/;
/** The write-capable arguments clause (b) refuses and names (`-o`, `--output`, `-c`,
 * `--ext-diff`), in the ATTACHED spelling where the value is glued to the flag. The
 * spaced spelling is the arms' own `hasFlag` question; this one covers `-o<name>` /
 * `--output=<name>`, which is one word and invisible to an arm's `-o <name>` pair test.
 * `=`-attachment only: a value glued straight onto a flag letter (`-odata`) is not an
 * option in the tools that take these flags — `git show -odata` reads `data` as a path
 * operand — and reading it as a flag would brick `bun test --reporter junit …` (`-…er
 * junit`) and every short-flag command that mentions the store (`bun test … <store>`,
 * `bash verify-loop.sh … <store>`, `git commit -oreview-findings.json`). Clause (b)'s
 * "over-refuse a harmless read" is about a READ of the store, not about unrelated flags. */
const ATTACHED_WRITE = /(?:^|\s)(?:--output=\S|-o\S|--ext-diff=\S|-c\S)/;

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
 *      them: a runtime (the body is text the guard cannot read and the interpreter will
 *      run), or a git verb that puts bytes on disk from an operand it was handed
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
 *      reader's (`cat`, `head`, `tail`) operands, and a search tool's (`grep`, `rg`)
 *      operands MINUS its pattern. `echo "FMT_EXIT=$?"`, `cd $WT`, `tail -8` and `grep -n
 *      'a$' f` name no unreadable file and bring nothing in: the command-wide "any read
 *      tool + `$` anywhere" shape of this test refused ~6,400 ordinary commands on one live
 *      run, which is the whole of #1764. A word with `$` or a backtick has no determinable
 *      final text; an expansion the SAME command assigned a literal to is resolved first
 *      (criterion 6) and a heredoc BODY is never an operand (criterion 4). A BACKSLASH is
 *      not such a word (#1665): the shell removes it, and the backslash-erased view of
 *      `namesStore` catches an escaped spelling of the store's name. On a program that is
 *      none of these — `awk`, `python3` — a store name can never reach the guard's
 *      protected bytes, and clause (a) leaves the command alone: braces alone are ordinary
 *      punctuation (`echo {a,b}`, `awk '{print 1}'` pass), and a name assembled from them
 *      is caught by (1)'s erased view.
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
    (namesInterpreter(norm) || namesGitWriteVerb(raw))
  )
    return "executing-operand";
  // The two halves of test (5) ask DIFFERENT texts: the runtime / VCS half asks the whole
  // command (minus any heredoc body — data, never an argument), the read-tool half asks
  // its own file operands only.
  const readable = withoutHeredocBodies(raw);
  if (namesVcsOrRuntime(norm) && EXPANSION_WORD.test(readable)) return "unreadable-word";
  if (readToolCarriesUnresolvedOperand(readable)) return "unreadable-word";
  if (
    namesVcsOrRuntime(norm) &&
    (ATTACHED_WRITE.test(`${shellVisible(raw)} `) || hasFlag(words, ...OUTPUT_FLAGS))
  )
    return "write-argument";
  return undefined;
}

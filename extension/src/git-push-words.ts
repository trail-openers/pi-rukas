/**
 * git-push-words — does this command's git get the push verb as its VERB?
 *
 * ## Why this is not the predicate in `git-push-command.ts`
 *
 * `pushesRemote` is a regex over the command STRING. It is deliberately cheap:
 * `developer-push-guard.ts` (#1113) runs it on every bash call of every child and
 * it is the shape a table test drives. But a regex cannot answer the question the
 * hygiene guard asks, because git's GLOBALS sit between the program and the verb,
 * and a global that consumes an operand moves the verb: a command that reaches the
 * verb behind `git --git-dir X --work-tree Y push` is a push the regex does not
 * see at all. The guard must reach those — a scan that never noticed the command
 * is the silent no-op this repository's gates exist to catch.
 *
 * So the two predicates are UNIONED in `commandPushes`: the regex for the cheap
 * common case, this walker for the shapes a regex cannot parse. Neither replaces
 * the other — the regex keeps the string table's guarantees, this keeps the
 * verb-position guarantee.
 *
 * ## The one walker and the one segmenter
 *
 * Which word is the verb depends on two things: knowing the segments of a
 * command, and knowing which of git's globals consume their value as a SEPARATE
 * word. Both are borrowed rather than re-implemented. The segments come from
 * `publishCommandLines` (`public-hygiene-command.ts`) — the same segmenter
 * `ownPushSegment` in `public-hygiene-push-dir.ts` asks the identical question
 * of — and the walker that knows the globals is `walkGitGlobals`, exported by
 * `public-hygiene-target.ts`. So `-C`, `-c k=v` and a refused `--git-dir` cannot
 * be reasoned about differently in two files, and no wrapper whose payload is
 * itself a command line is dropped here while being read there.
 *
 * The segmenter is load-bearing, not an aesthetic choice, and the mistake it
 * prevents is specific. `publishArgv` (the per-segment stripping) is NOT the
 * segmenter: `unwrap` answers an `env -S '…'` payload with `{ argv: [], split:
 * […] }`, so a reader of `publishArgv` output sees no words at all and never
 * asks about the push inside the payload — while the directory reader, which
 * used `publishCommandLines`, resolved that payload's `-C` without trouble. One
 * reader saw the push and the other did not, and the push nobody read is the one
 * that gets away with it. The same split covers any program outside the wrapper
 * table: `publishArgv` leaves it as the program word, `isGitProgramWord` rejects
 * the argv before the walker runs, and only the recursive segmenter asks the
 * question of what the wrapper was hiding.
 */

import { publishCommandLines } from "./public-hygiene-command.ts";
import { isGitProgramWord, walkGitGlobals } from "./public-hygiene-target.ts";

/**
 * Does this command carry the push verb as git's verb?
 *
 * `pushVerb` is passed in rather than spelled here: the harness that runs the
 * offline suite reads command strings for publish verbs, so the literal lives with
 * the guard that matches on it (`PUSH_VERB`) and every reader compares one value.
 *
 * A command that carries a refused global (`--git-dir`, `--work-tree`) answers
 * TRUE on sight of the verb anywhere after the globals. That is deliberate, not
 * sloppiness about the verb's position: the walker stops at the first `--git-dir`
 * without knowing whether git would have read the next word as the flag's value or
 * as the verb, so it cannot tell an unquoted path that merely LOOKS like a verb
 * from the real one. It takes the conservative side of that uncertainty — a push
 * never goes unscanned — and the command is refused on the refused flag anyway,
 * which is what makes the choice cheap here and would be costly for any other
 * command shape.
 */
export function commandCarriesPushVerb(command: string, pushVerb: string): boolean {
  for (const words of publishCommandLines(command)) {
    if (!isGitProgramWord(words[0])) continue;
    const walk = walkGitGlobals(words);
    // A program is git's own only when the word carries NO whitespace. The
    // segmenter hands back a quoted run as ONE word, so `echo "git push"` arrives
    // as the single word `git push` — which ENDS in the program name and once read
    // as the program `git`, making prose that mentions the verb a push and
    // refusing it with the push directory sentence from a non-repository cwd. Bash
    // never runs a word containing an unquoted space as that program, and a quoted
    // run publishes nothing; a path-delimited git (`/usr/bin/git`, `./git`) still
    // answers, because those carry no space.
    if ((words[0] ?? "").includes(" ")) continue;
    if (walk.refused) return words.some((word, i) => i >= walk.end && word === pushVerb);
    if (words[walk.end] === pushVerb) return true;
  }
  return false;
}

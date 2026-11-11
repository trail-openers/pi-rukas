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
 * ## The one walker
 *
 * Which word is the verb depends on knowing which globals consume their value as
 * a SEPARATE word. The walker that knows it is `walkGitGlobals`, exported by
 * `public-hygiene-target.ts`; this is the only place the verb question is asked of
 * it, so `-C`, `-c k=v` and a refused `--git-dir` cannot be reasoned about
 * differently in two files.
 */

import { simpleCommands } from "./bash-destructive-write.ts";
import { publishArgv } from "./public-hygiene-command.ts";
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
  for (const words of simpleCommands(command).map(publishArgv)) {
    if (!isGitProgramWord(words[0])) continue;
    const walk = walkGitGlobals(words);
    if (walk.refused) return words.some((word, i) => i >= walk.end && word === pushVerb);
    if (words[walk.end] === pushVerb) return true;
  }
  return false;
}

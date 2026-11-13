/**
 * write-fence-deletion-positions — where a bash command deletes, for the child
 * deletion rule (#2200).
 *
 * The hook (write-fence-deletion.ts) decides WHETHER a path may be removed; this
 * module decides WHERE the command claims to remove from. It reads one line
 * through three readers and applies the same rule to all of them: a word counts
 * as a deleted path only when a command this rule owns named it, and anything a
 * delete position holds that cannot be resolved is a refusal rather than a pass.
 *
 *   - the lexer and splitter give each simple command's words and the directory it
 *     runs in, tracked through `cd`/`pushd`, subshells and pipes by the bash walk
 *     (whose own `opaque` verdicts are reused here, so a glob or a `$VAR` at a
 *     delete position is refused on evidence the write fence already computes);
 *   - the operand table (write-fence-bash-writers.ts) says which words of a
 *     command the child NAMED are paths — it has no entry for `unlink` or `shred`,
 *     which is why those two carry their own read here;
 *   - the interpreter reader covers `bun -e`, `node -e`/`--eval`/`--print`,
 *     `python -c`, `python3 -c`, `perl -e` and `ruby -e` (#2200 D7), whose path
 *     lives inside the script body and is invisible to the operand table.
 *
 * The interpreter reader lives on the deletion side and not in the writers table
 * deliberately: putting `bun`/`node`/`python` into the general write list would
 * change what the WRITE fence refuses for every dispatch, which is not what this
 * issue asks.
 */

import path from "node:path";
import { type Tok, type Word, lex } from "./write-fence-bash-lex.ts";
import {
  ASSIGNMENT,
  KEYWORDS,
  DURATION,
  POSITIONAL_ROOT_WRAPPERS,
  VALUE_OPTIONS,
  commandName,
  isRemover,
  isWrapper,
  operands,
  removalOperands,
  simpleCommands,
  stripPrefix,
  withoutPlaceholder,
} from "./write-fence-bash-split.ts";
import { writtenOperands } from "./write-fence-bash-writers.ts";
import { type BashTarget, bashWriteTargets } from "./write-fence-bash.ts";
import { findRemovals, removesMatches } from "./write-fence-deletion-find.ts";
import { interpreterDeletions, isInterpreter } from "./write-fence-deletion-interpreter.ts";
import {
  DELETION_LOG_TOKEN,
  DYNAMIC_TARGET_REASON,
  GIT_CLEAN_LOG_TOKEN,
  GLOB_TARGET_REASON,
  MAGIC_PATHSPEC_REASON,
  NOT_JUDGED_LOG_TOKEN,
  UNJUDGED_WRAPPER_REASON,
  UNREADABLE_REASON,
} from "./write-fence-deletion-tokens.ts";
import { expandHome, safeResolve } from "./write-fence-path.ts";

/** One delete position, ready to judge: `path` set means judge it, `reason` means refuse it. */
export interface RawHit {
  token: string;
  reason: string;
  path?: string;
}

/**
 * One simple command as the reader split it. `find.ts` asks the same question of the
 * producer side (`removesMatches`), so the fields it reads — `name` and `args` — are
 * declared there; the rest are the reader's own.
 */
interface Command {
  name: string;
  /** Set when the wrapper strip left no command for the reader: the segment has a verdict and no
   * path, and the reason is this string (`deletePositions` reads it; `judgedWords` decided it). */
  unjudged?: string;
  args: Word[];
  dir: string;
  /** Whether this command's output is handed to a remover whose victims are its matches. */
  pipedIntoRemover: boolean;
  /** The words of the simple command before the wrappers were stripped, which is what
   * names the `xargs` in front of a remover (`xargs -I{} rm -rf {}` → `rm -rf {}`). */
  xargs: Word[];
}

/** Resolve a deletion word the way the child's shell would, from `dir`. */
function absolutise(text: string, dir: string): string {
  const expanded = expandHome(text);
  return path.isAbsolute(expanded) ? expanded : path.resolve(dir, expanded);
}

/**
 * The simple commands of the line, each with the directory it runs in. The walk
 * owns that tracking (`cd`, `pushd`, subshells, `xargs`, `env -C`), so the
 * directories are read back out of its targets rather than re-derived here; the
 * words come from the lexer, which is the only thing that keeps each word's text.
 * A command the walk named no target for keeps the child's cwd, which is what the
 * walk reports for a `git -C` or an interpreter call anyway.
 */
function commands(command: string, cwd: string): { parsed: boolean; list: Command[] } {
  const lexed = lex(command);
  if (!lexed) return { parsed: false, list: [] };
  const dirs = walkDirs(command, cwd, chdirOperands(lexed.toks));
  const list: Command[] = [];
  let cur: Word[] = [];
  let index = 0;
  // Whether the pending separator is a pipe. Whether the segment that follows a pipe
  // is a remover with no operands is answered when that segment ends, and written back
  // onto both sides of the pipe: the producer's start paths name the victims, and the
  // remover's own empty operand list is then judged by them (#2200's sweep).
  let piped = false;
  const flush = (): void => {
    const words = judgedWords(cur);
    const first = words[0];
    if (first !== undefined) {
      // The verdict `judgedWords` reached, when it reached one: recorded on the Command rather
      // than among its words, since no word of the segment is a command for it to ride on.
      const unjudged = first.refusal;
      const name = commandName(first.text);
      // Only a producer this rule can name hands over victims: a `find` is judged by its
      // start paths, and so is the remover it feeds. Fed by anything else (`ls | xargs rm`,
      // `echo path | xargs rm`) the remover's targets stay unknown, which `unnamedRemoval`
      // refuses rather than judging on the cwd. The whole segment goes to `removesMatches`
      // — the `xargs` wrapper still on it is what makes a `{}` operand a substituted match
      // rather than a path the child typed — along with the producer, whose `-exec` of a
      // remover prints nothing and therefore hands over nothing.
      const producer = list[list.length - 1];
      const feeds = piped && producer?.name === "find" && removesMatches(cur, producer);
      if (feeds) producer.pipedIntoRemover = true;
      list.push({
        name,
        // The verdict a wrapper that swallowed its command leaves behind: no word carries it, so
        // it is recorded on the Command itself rather than among the words (`deletePositions`
        // reads it — an owned-name filter would otherwise drop the segment whole).
        unjudged,
        args: words.slice(1),
        dir: dirs[index] ?? cwd,
        pipedIntoRemover: feeds,
        xargs: cur,
      });
    }
    index++;
    cur = [];
  };
  for (const tok of lexed.toks) {
    if (tok.kind === "word") {
      cur.push(tok.word);
      continue;
    }
    flush();
    piped = tok.text === "|" || tok.text === "|&";
  }
  flush();
  for (const sub of lexed.subs) {
    const inner = commands(sub, cwd);
    list.push(...inner.list);
  }
  return { parsed: true, list };
}

/**
 * The words of a segment as the deletion reader reads them.
 *
 * Normally the splitter's stripped head, which is what the write fence reads too. But the strip trusts
 * the per-wrapper `VALUE_OPTIONS` skip counts, and those hold only option-by-option: an option no
 * wrapper's table names (`strace -p`, `ltrace -l`) or one whose value is OPTIONAL (`watch -q [cycles]`,
 * `env -S <split-string>`) leaves the strip standing one word short of the program it was reading past.
 * So on the DELETION side only, when the stripped head is not a command this rule owns, the segment's
 * option run is read a second time — each option asked of the wrapper whose options they are, never of
 * the surviving word, which is the mistake that read `make`'s or `ls`'s non-existent table for an option
 * belonging to the `watch` in front of it and refused every wrapped build.
 *
 * `last` is the last wrapper that run stepped over, `end` where it stopped consuming options, and `slot`
 * where the strip came to rest. Three answers follow, and they are the only three.
 *
 * - The strip came to rest BELOW that wrapper (`slot < last`): it consumed the wrapper's own NAME as a
 *   value, so the command hides behind it. Read from `last`, with its own options asked of its own table,
 *   the line is judged as what it execs — `sudo -u nobody strace -p 1 rm …` reaches its `rm` through the
 *   `strace` that `sudo`'s miscounted `-u` swallowed.
 * - The run stopped ON an option (`end` holds one): the wrapper has no program, because the option's
 *   value — which is where its program should be — was never given, and a command the line holds can only
 *   be standing in that value slot, in the run between that wrapper's name and the strip's own word.
 *   `watch -q rm -rf <outside>` read `rm` for `-q [cycles]`, `env -S rm -rf <outside>` read it for `-S
 *   <split-string>`, and `watch -q git <verb> -fdx <outside>` read `git` for that same optional value
 *   three words short of the `git` whose tree the command clears. Only a name this rule owns makes that an
 *   escape, and it can only be a verdict: judged as the command itself, the `rm` of that `watch` would
 *   report a deletion of the one name `rm` and leave the tree the sweep takes unnamed.
 * - Otherwise the run reached a program and the word at `end` is it: judged when it names a command this
 *   rule owns (`strace -p 1 rm …`, whose `1` no `strace` table claimed, or the `1000` `nsenter -S` may or
 *   may not have taken), and an ordinary program there is the command the wrapper ran and the line keeps
 *   its head. That last case is what the whole comparison exists to protect: `nice -n 5 make`, `nohup
 *   make`, `timeout 60 make`, `ionice -c 3 make`, `env -i PATH=/usr/bin make`, `strace -p 1 ls`, `sudo -n
 *   true` and a project script behind `nohup` each lost a word to the same option arithmetic and gained a
 *   build, not a deletion — refusing them takes a child's whole toolchain away for nothing.
 *
 * A word above `end` is an operand of the program the run named, so it is never a command here: `timeout
 * 10 rm other` stays a `timeout` line, `env VAR=1 echo rm file` an `echo`, `strace -p 1 ls -rf <shared>`
 * an `ls`, `ls <shared>` an `ls`, a `find`'s `-exec` the `find` reader's. `cd`, `git status` and any
 * ordinary command keep the head the strip gave them, as does every command whose head this rule already
 * owned, and an option run that never got a wrapper to read (`ls -la <shared>`) has nothing to disagree
 * about. The `xargs` words the Command carries are left untouched, because they are what makes a `{}`
 * operand a substituted match rather than a typed path.
 */
function judgedWords(words: Word[]): Word[] {
  const stripped = stripPrefix(words).words;
  const head = stripped[0];
  // A head this rule owns is the command the strip found, and its operands are the judge's: a remover one
  // wrapper deep is still that remover. With no wrapper at all there is no option arithmetic to
  // second-guess, so an `ls`, a `git status` and any command this rule does not read keeps that head too.
  if (head === undefined || owned(commandName(head.text))) return stripped;
  // The strip walked past at least one wrapper's options and did not land on a command this rule reads:
  // either the line execs an ordinary program nobody need judge, or a mis-tabled option swallowed the
  // command out of the program's slot. `eatenByWrapper` replays that option run and answers which.
  const eaten = eatenByWrapper(words);
  // Nothing of this rule's was eaten, so whatever the wrapper ran deletes nothing and the line keeps the
  // head the strip gave it: `make` behind `nice -n 5` and `nohup`, `cargo` behind `nice -n 5`, a project
  // script behind `nohup`, `true` behind `sudo -n`, `watch -q make` and `watch -q 5 make clean` both
  // running `make`, `timeout 10 rm other` a `timeout` line whose argument is spelled `rm`, `env VAR=1 echo
  // rm file` an `echo`, `strace -p 1 ls -rf <shared>` an `ls`, a `find`'s `-exec` left to the `find`
  // reader. Refusing these is the over-refusal that takes a child's whole toolchain away for a deletion
  // that never happened — the whole reason the word is asked this question.
  // A wrapper that ate an owned name while the strip's own head is not a command this rule reads is a
  // line whose program is gone: the option run consumed the one word that named it, and no surviving
  // word can be asked what the line deletes. Refused wherever it points.
  if (eaten !== undefined && head !== undefined && !owned(commandName(head.text))) return eatenEvidence();
  if (eaten === undefined) return stripped;
  // A command this rule owns is missing from the program's slot, so it can only stand in an option's
  // value. What survived below the eaten word says which escape the line is.
  //
  // A command survived: the eaten word was only the miscounted VALUE and the survivor is what the line
  // execs, judged with its operands — `strace -p 1 rm -rf <target>` (the `1` no `strace` table claims),
  // `ltrace -l lib rm -rf <target>` (the `lib`), `nsenter -S 1000 rm -rf <target>` (the `1000` whose value
  // the table over-claimed), and the stacked `sudo -u nobody strace -p 1 rm -rf <target>`, whose `sudo`
  // swallowed the whole `strace -p 1 rm …` as `-u`'s value and whose `rm` is reached by asking the
  // survivor its own questions.
  if (head !== undefined && owned(commandName(head.text))) return judgedWords(stripped);
  // Nothing that survived is a command: the eaten word is the deletion this rule never saw, and no reading
  // of the segment can name what it deletes. `watch -q rm -rf <target>` read `rm` for `-q [cycles]` and
  // left `-rf` standing, `env -S rm -rf <target>` read it for `-S <split-string>`, `watch -q git status`
  // read `git` for that optional value and left `status`, `watch -q git <verb> -fdx <target>` read `git`
  // for it three words short of the `git` whose tree the clean clears. This can only be a verdict: judged
  // as the `rm` of that `watch` the line would report a deletion of the one name `rm` and leave the tree
  // the sweep takes unnamed, so it is refused wherever it points — in the child's own tree included,
  // because no surviving word names a tree to check.
  return eatenEvidence();
}

/** A word that reads as an option: a dash and then something. A bare `-` is stdin, not an option. */
function optionShaped(text: string): boolean {
  return text.startsWith("-") && text !== "-";
}

/**
 * The word the LAST wrapper's option run came to rest on — the one word the strip consumed as an option's
 * value or a wrapper's positional and never read as a command, which is the single position a wrapper's
 * option table can be wrong about. The walk re-reads the wrapper's options with the strip's own tables, so
 * the two readings cannot disagree about the tables themselves: `watch -q` and `env -S` take an OPTIONAL
 * value, and each eats whatever word follows as that value. undefined when the segment names no
 * wrapper, since then there is no option run and nothing was eaten.
 */
/**
 * The command a wrapper's option arithmetic swallowed, or undefined when it swallowed nothing of this
 * rule's. The strip trusts each wrapper's `VALUE_OPTIONS` skip counts, and those hold only option by
 * option: an option the table does not list at all (`strace -p`, `ltrace -l`), or one whose value the
 * usage output marks OPTIONAL and the line never gave (`watch -q [cycles]`, `env -S <split-string>`),
 * leaves the strip one word short of the program it was reading past. So the option run is read a second
 * time here — each option asked of the wrapper whose options they are, never of the surviving word, which
 * is the mistake that read `make`'s non-existent table for the `watch` in front of it and refused every
 * wrapped build. Two slots per wrapper may hold the eaten command, and no others:
 *
 *   - the word the last option ate as its value: the line's command when the table claimed a BOOLEAN
 *     (`watch -q rm -rf <target>`) or an OPTIONAL value went ungiven (`env -S rm -rf <target>`), and the
 *     word after a genuinely value-taking option otherwise — a value, so `nsenter -S 1000 rm …` loses the
 *     `1000` and not the `rm`, and `nice -n 5 make` loses the `5`;
 *   - the word just before the program's slot: where a command hides behind an option the strip consumed
 *     as boolean (`strace -p 1 rm …` walks past `1` and stops before the `rm`), and where `sudo -u nobody
 *     strace …` left the whole `strace -p 1 rm …` it had swallowed as `-u`'s value.
 *
 * An owned name in neither slot means the wrapper ran an ordinary program: `make`, `cargo`, `true`, a
 * project script, or a command this rule does not read the operands of. Every step below advances `i` past
 * at least the wrapper's name and the option run ends on a word that is not an option, so the walk
 * terminates on any finite segment.
 */
/**
 * The command a wrapper's option arithmetic swallowed, or undefined when it swallowed nothing of this
 * rule's. The strip trusts each wrapper's `VALUE_OPTIONS` skip counts, and those hold only option by
 * option: an option no wrapper's table names at all (`strace -p`, `ltrace -l`) leaves the run resting ON
 * the option with the command sitting in the word after it, and an option whose value the usage output
 * marks OPTIONAL and this line never gave (`watch -q [cycles]`, `env -S <split-string>`) leaves the run
 * resting ON the command itself. Both are read here by REPLAYING the strip's own skip counts rather than
 * by consulting the table a second way, so the two readings cannot disagree about the tables themselves;
 * each option is asked of the wrapper whose options they are, never of the surviving word — the mistake
 * that read `make`'s non-existent table for the `watch` in front of it and refused every wrapped build.
 *
 * Then the question is asked of the one word the run came to rest on plus the word after it — the option's
 * value slot, and the slot the wrapper's program occupies:
 *
 *   - `watch -q rm -rf <target>`: `-q` is tabled as value-taking, so the run rested ON `rm` and the
 *     command sits in that value slot. Eaten. `env -S rm …` is the same shape.
 *   - `strace -p 1 rm …`: no `strace -p` row, so the run walked `-p` and `1` as two booleans and rested
 *     ON `1`, leaving the `rm` in the word after it. Eaten — and `sudo -u nobody strace -p 1 rm …` eats
 *     the whole `strace -p 1 rm …` as `-u`'s value, so the same question is asked again of that survivor.
 *   - `nsenter -S 1000 rm …`: `-S`'s value is OPTIONAL, so `1000` was eaten as that value and the `rm` is
 *     what the line execs — a program, so it is judged rather than refused, and judged by the caller.
 *   - `nice -n 5 make`, `watch -q make`, `timeout 10 rm other`, `nohup make`: what the run rested on, and
 *     what stood after it, are an option's value or an ordinary program. Nothing of this rule's was eaten,
 *     and the line keeps the head the strip gave it.
 *
 * Every step advances `i` past at least the wrapper's name, and each replayed option run advances `k` by
 * one or two, so both loops end on any finite segment.
 */
/**
 * The word a wrapper's option arithmetic consumed out of the program's slot, or undefined when it consumed
 * nothing of this rule's. The strip trusts each wrapper's `VALUE_OPTIONS` skip counts, and those hold only
 * option by option: an option no wrapper's table names at all (`strace -p`, `ltrace -l`), or one whose
 * value the usage output marks OPTIONAL and this line never gave (`watch -q [cycles]`,
 * `env -S <split-string>`), leaves the run resting on a word that was really the line's command. So the
 * option run is replayed here — the strip's own counts, so the two readings cannot disagree about the
 * tables themselves — and the words it swallowed are reported rather than dropped.
 *
 * What the replay stops on is the word the wrapper's program would have occupied had the table matched the
 * tool: `watch -q rm -rf <target>` stops on the `rm` the optional cycles value swallowed, `strace -p 1 rm
 * …` on the `1` that no `strace` table claims, `nsenter -S 1000 rm …` on the `1000` whose value is
 * OPTIONAL, and — the case the whole comparison exists to protect — `nice -n 5 make` and `watch -q make`
 * stop on the `make` the wrapper genuinely RUNS. Asking the ordinary question of that word, whether it
 * names a command this rule reads the operands of, is what tells the two apart:
 *
 *   - an ordinary program (`make`, `cargo`, `true`, `ls`, a project script, and the `other` of
 *     `timeout 10 rm other`): the wrapper ran something that deletes nothing, nothing of this rule's was
 *     eaten, and the line keeps the head the strip gave it. Refusing these takes a child's whole toolchain
 *     away for a deletion that never happened;
 *   - a command this rule owns: it is missing from the strip's program slot, so it can only be standing in
 *     an option's value. Then what survived below it says which escape the line is — a command survived
 *     (`strace -p 1 rm …`, whose `1` was the miscounted word and whose `rm` is what the line execs, judged
 *     with its operands) or none (`watch -q rm -rf <target>`, `env -S rm -rf <target>`, `watch -q git
 *     <verb> -fdx <target>`), which is a line no reading of can name what it deletes.
 *
 * A stacked wrapper is read as deep as its own options reach: `sudo -u nobody strace -p 1 rm …` swallows
 * the whole `strace -p 1 rm …` as `-u`'s value, and the replay steps into it and asks again. Every step
 * advances `i` past at least the wrapper's name and each replayed option advances `k` by one or two, so
 * both loops end on any finite segment.
 */
/**
 * The word a wrapper's option arithmetic swallowed out of its program's slot, or undefined when it
 * swallowed nothing of this rule's. The strip trusts each wrapper's `VALUE_OPTIONS` skip counts, and those
 * hold only option by option: an option no wrapper's table names at all (`strace -p`, `ltrace -l`), or one
 * whose value the usage output marks OPTIONAL and this line never gave (`watch -q [cycles]`,
 * `env -S <split-string>`), leaves the strip standing where the program should be. So the option run is
 * REPLAYED here with the strip's own counts — the two readings cannot then disagree about the tables
 * themselves — and each option is asked of the wrapper whose options they are, never of the surviving
 * word (the mistake that read `make`'s non-existent table for the `watch` in front of it and refused every
 * wrapped build). The replay stops where the strip stopped; the words at and just past that stop are the
 * slots a mis-tabled option can have eaten the command from:
 *
 *   - the word it stopped ON, which is where an OPTIONAL value that was really the command sits
 *     (`watch -q rm -rf <target>`, `env -S rm -rf <target>`) or an over-claimed value sits while the
 *     command survived below it (`nsenter -S 1000 rm -rf <target>` lost the `1000` to `-S [uid]`, and
 *     `sudo -u nobody strace …` lost the whole `strace -p 1 rm …` to `-u <user>`);
 *   - the word just PAST it, which is where a command hides behind an option the strip consumed as one
 *     word but the tool consumes as two (`strace -p 1 rm -rf <target>`: no `strace -p` row, so the run
 *     walked `-p` and `1` and stopped before the `rm` that is the line's real command).
 *
 * What sits in neither slot is the ordinary case the whole comparison exists to protect: `make`, `cargo`,
 * `true`, `ls`, `echo`, a project script — an ordinary program the wrapper genuinely runs, or an operand
 * that merely happens to be spelled `rm` (`timeout 10 rm other`). Nothing of this rule's was eaten, and
 * the line keeps the head the strip gave it.
 *
 * A stacked wrapper is read as deep as its own options reach: `sudo -u nobody strace -p 1 rm …` swallows
 * the whole `strace -p 1 rm …` as `-u`'s value, and the replay steps into it and asks again. Every step
 * advances `i` past at least the wrapper's name and each replayed option advances `k` by one or two, so
 * both loops end on any finite segment.
 */
function eatenByWrapper(words: Word[]): Word | undefined {
  let i = 0;
  for (;;) {
    const a = words[i]?.text ?? "";
    if (a === "" || ASSIGNMENT.test(a) || KEYWORDS.has(commandName(a))) {
      i++;
      continue;
    }
    const n = commandName(a);
    if (!isWrapper(n)) return undefined;
    const opts = VALUE_OPTIONS[n] ?? [];
    let k = i + 1;
    for (;;) {
      const o = words[k]?.text ?? "";
      if (o === "" || o === "-") break;
      // `env` takes `A=V` operands before its program: not options, and they consume no value.
      if (n === "env" && ASSIGNMENT.test(o)) {
        k++;
        continue;
      }
      // Everything after `--` is the program's own argument, options and all.
      if (o === "--") {
        k++;
        break;
      }
      if (!optionShaped(o)) break;
      k += opts.includes(o) ? 2 : 1;
    }
    // The slot the wrapper's program occupies, past the new root a `chroot` takes as a POSITIONAL and past
    // a `timeout`'s duration — words the strip swallows that no option table names.
    if (POSITIONAL_ROOT_WRAPPERS.includes(n as "chroot") && !optionShaped(words[k]?.text ?? "")) k++;
    if ((n === "timeout" || n === "gtimeout") && DURATION.test(words[k]?.text ?? "")) k++;
    const eaten = [words[k], words[k + 1]].find((slot) => slot !== undefined && ownsCommand(slot, true));
    if (eaten !== undefined) return eaten;
    i = k;
  }
}

/**
 * The verdict for a command a wrapper swallowed: a word no reading can judge, in place of the words the
 * rule was asked to read. It carries no text and no path, because a deletion whose command the option ate
 * names nothing the fence can resolve — judged as the `rm` of that `watch` it would report a deletion of
 * the one name `rm` and leave the tree the sweep takes unnamed.
 */
const eatenEvidence = (): Word[] => [
  { text: "", dyn: false, refusal: UNJUDGED_WRAPPER_REASON },
];

/**
 * Whether a word names a command this rule reads the operands of. Stripped of its OWN wrappers first, so a
 * remover reached through another wrapper (`/usr/bin/rm`, `nice rm`) is the remover it names rather than an
 * unowned path — but ONLY where the word is not itself standing where a wrapper's option should have put a
 * value: a word the reader is asking about in that position has already been swallowed by the option above
 * it, and stripping a second wrapper from it would read the eaten name's own options (`rm -rf` → `rf`) and
 * answer NO for the one name this rule most needs to hear YES about.
 */
function ownsCommand(word: Word, atOptionValue = false): boolean {
  const stripped = atOptionValue ? [word] : stripPrefix([word]).words;
  const head = stripped[0];
  if (head === undefined) return false;
  return owned(commandName(head.text));
}

/**
 * The directory each simple command of the line runs in, indexed by SEGMENT as the
 * walk's own splitter cuts them (so it has a slot per separator, empty or not).
 * Read back out of the walk's targets, which each carry the directory they were
 * written from. A `cd`/`pushd` operand is itself one of those targets, so it
 * advances the directory for every segment after it. A segment with no target of
 * its own (a `git clean`, an interpreter call, an `xargs` whose paths come from
 * stdin) keeps the last directory the line had reached — which is the point: `cd
 * <shared temp root> && git clean -fdx` is the incident's shape, and the command
 * that does the deleting names no path for the walk to carry a directory on.
 */
function walkDirs(command: string, cwd: string, chdir: ReadonlySet<string>): string[] {
  let reached = cwd;
  const out: string[] = [];
  for (const t of bashWriteTargets(command, cwd)) {
    out.push(reached);
    const moved = movedInto(t, chdir);
    if (moved !== undefined) reached = moved;
  }
  out.push(reached);
  return out;
}

/**
 * The directory a `cd`/`pushd` operand moves the line into, or undefined for any
 * other word. Only the operands the splitter attributed to a `cd`/`pushd` count,
 * so a `find` start path or an `rm` operand never drags the rest of the line to
 * where it points.
 */
function movedInto(t: BashTarget, chdir: ReadonlySet<string>): string | undefined {
  if (t.opaque !== undefined || !chdir.has(t.path)) return undefined;
  const abs = path.isAbsolute(t.path) ? path.resolve(t.path) : path.resolve(t.cwd, t.path);
  return safeResolve(abs) ?? abs;
}

/** The operand words of every `cd`/`pushd` on the line, from the same split the walk used. */
function chdirOperands(toks: Tok[]): Set<string> {
  const out = new Set<string>();
  for (const step of simpleCommands(toks)) {
    if (step.kind !== "command") continue;
    const words = stripPrefix(step.simple.words).words;
    const name = words[0] === undefined ? "" : commandName(words[0].text);
    if (name !== "cd" && name !== "pushd") continue;
    for (const operand of operands(words.slice(1))) out.add(operand.text);
  }
  return out;
}

/**
 * The trees a forcing `git clean` would remove, or undefined when the command is not
 * one. A forcing clean (`-f`/`--force`, never `-n`) is judged by the tree it removes
 * in — the last `-C`/`--work-tree` it names, or the directory the command runs in —
 * which is what makes `git clean -fdx` under the shared temp root a deletion rather
 * than a git command (#2200 D1), AND by every PATH OPERAND after the verb: `git clean
 * -fdx <dir>` removes that pathspec's tree wherever it sits, and `git clean -fdx ..`
 * removes the parent of the directory it runs in. A clean with no operand is still
 * judged by its base (`base ?? "."`), which is the no-path case. A forcing clean carrying
 * a MAGIC PATHSPEC (`:/`, `:(top)…`) is refused, because git takes those pathspecs from the
 * repository top, so no directory this reader can name is the tree it removes.
 */
function gitCleanTrees(args: Word[]): Word[] | undefined {
  let base: Word | undefined;
  let k = 0;
  const take = (v: Word): void => {
    base =
      base === undefined || v.text.startsWith("/")
        ? v
        : { text: `${base.text}/${v.text}`, dyn: base.dyn || v.dyn };
  };
  while (k < args.length) {
    const a = args[k] as Word;
    if (a.text === "-C" || a.text === "--git-dir" || a.text === "--work-tree") {
      const v = args[k + 1];
      if (v !== undefined) take(v);
      k += 2;
      continue;
    }
    if (a.text.startsWith("-C") && a.text.length > 2) {
      take({ text: a.text.slice(2), dyn: a.dyn });
      k++;
      continue;
    }
    if (a.text.startsWith("--git-dir=") || a.text.startsWith("--work-tree=")) {
      take({ text: a.text.slice(a.text.indexOf("=") + 1), dyn: a.dyn });
      k++;
      continue;
    }
    if (a.text === "-c" || a.text === "--namespace") {
      k += 2;
      continue;
    }
    if (a.text.startsWith("-")) {
      k++;
      continue;
    }
    break;
  }
  if (args[k]?.text !== "clean") return undefined;
  const rest = args.slice(k + 1);
  const forcing =
    rest.some((a) => a.text === "--force" || (/^-[^-]/.test(a.text) && a.text.includes("f"))) &&
    !rest.some((a) => a.text === "-n" || a.text === "--dry-run");
  if (!forcing) return undefined;
  // A magic pathspec (`:/`, `:(top)…`, `:(literal)/abs`) is resolved by git from the top of the
  // worktree, not from the directory the command runs in, so no reading of it here can name the
  // tree it removes — the forcing case is refused on the operand rather than judged on a guess.
  if (rest.some((a) => a.text.startsWith(":"))) {
    return [{ text: ":", dyn: false, refusal: MAGIC_PATHSPEC_REASON }];
  }
  // git takes its tree selectors (`-C`/`--git-dir`/`--work-tree`) only before the verb: after
  // `clean` they are top-level options git rejects, so only the operands are read here. Every
  // non-option word after the verb is a pathspec git clean removes (`--` only ends the options,
  // so it is skipped and what follows it read the same way).
  return [...operands(rest), base ?? { text: ".", dyn: false }];
}

/**
 * A remover that names no path — `xargs … rm -rf`, whose targets arrive on
 * standard input as the matched names, or a bare `rm` — cannot be judged, so it is
 * refused. The splitter strips the `xargs` wrapper, so by the time this rule sees
 * the command the wrapper is gone and only the empty operand list distinguishes it
 * from a remover that simply had nothing to remove; `xargs`' own options (`-0`,
 * `-r`, `-I`) are options too, so the read is the non-option operands, not the
 * argument count. This is the incident's shape: thirty name prefixes swept out of
 * the shared temp root through exactly this pipe. The one pipe the rule can judge is
 * the one whose producer names the trees — `find <paths> … | xargs rm`, judged by
 * those paths — so `unnamedRemoval` stands down only when the line is of that shape
 * and the `find` reader has produced real start paths for it.
 */
const REMOVED_UNKNOWN_REASON =
  "it removes paths the command does not name (they arrive on standard input, or from a match), so the target cannot be judged. Name each path literally";

function unnamedRemoval(cmd: Command): RawHit[] {
  if (!isRemover(cmd.name)) return [];
  const named = withoutPlaceholder(removalOperands(cmd.args), cmd.xargs);
  if (named.length > 0) return [];
  // The remover at the mouth of a `find` pipe has its targets judged from that `find`'s
  // start paths, which `deletedWords` returns for it (see below), so the empty operand
  // list here is not the unknown case.
  if (cmd.pipedIntoRemover) return [];
  return [{ token: DELETION_LOG_TOKEN, reason: REMOVED_UNKNOWN_REASON }];
}

/**
 * The words one command deletes, as it named them; empty when it deletes nothing.
 * A remover that named only xargs' placeholders or nothing at all has no path of its
 * own, so it inherits the targets of the `find` whose output it is fed: judging the same
 * paths twice is what keeps the sweep refused by its shared root and an in-tree cleanup
 * allowed by the same paths. A remover that named a literal path AND was fed by a `find`
 * is judged on both — the pipe still carries every match, so the literal cannot hide the
 * tree the `find` walks.
 */
function deletedWords(cmd: Command): Word[] {
  if (isRemover(cmd.name)) {
    const tabled = withoutPlaceholder(writtenOperands(cmd.name, cmd.args), cmd.xargs);
    // The table has no entry for `unlink` or `shred`; their operands are their targets.
    const named =
      tabled.length > 0 ? tabled : withoutPlaceholder(removalOperands(cmd.args), cmd.xargs);
    // Only the `find` pipe is the case this rule can judge: the remover's victims are
    // then the `find`'s matches and the start paths it named are the evidence. Any other
    // remover that names nothing (`ls | xargs rm`, a bare `rm`) names no tree at all and
    // is left to `unnamedRemoval`, which refuses it rather than judging it on the cwd.
    const fromFind = cmd.pipedIntoRemover ? findRemovals(cmd.args, true) : [];
    return [...named, ...fromFind];
  }
  if (cmd.name === "find") return findRemovals(cmd.args, cmd.pipedIntoRemover);
  if (cmd.name === "git") return gitCleanTrees(cmd.args) ?? [];
  return [];
}

/** Is this command one whose words this rule reads at all? */
function owned(name: string): boolean {
  return isRemover(name) || name === "find" || name === "git" || isInterpreter(name);
}

/** A word the rule refuses outright, or a path it can judge, resolved from `dir`. */
function hitFor(w: Word, dir: string, token: string): RawHit {
  if (w.refusal !== undefined) return { token, reason: w.refusal };
  if (w.dyn) return { token, reason: DYNAMIC_TARGET_REASON };
  if (w.glob || /\{[^{}]*(,|\.\.)[^{}]*\}/.test(w.text)) {
    return { token, reason: GLOB_TARGET_REASON };
  }
  return { token, reason: "", path: absolutise(w.text, dir) };
}

/**
 * Every delete position in the command: each word a command this rule owns names,
 * judged from the directory that command ran in, plus every verdict the walk
 * itself refused at a write position inside a removal command — which is how a
 * glob, a `$VAR` or a run-time body is refused without this module re-implementing
 * the pipe, the subshell or the `xargs` wrapper.
 */
export function deletePositions(command: string, cwd: string): RawHit[] {
  const parsed = commands(command, cwd);
  if (!parsed.parsed) return [{ token: NOT_JUDGED_LOG_TOKEN, reason: UNREADABLE_REASON }];
  const hits: RawHit[] = [];
  const ownedCommands = parsed.list.filter((c) => owned(c.name));
  // A segment whose wrapper swallowed the command is named after whatever word survived, so the
  // filter above drops it whole; its verdict lives on the Command, not on a word, and is not
  // dropped with it.
  for (const cmd of parsed.list) {
    if (cmd.unjudged !== undefined) hits.push({ token: DELETION_LOG_TOKEN, reason: cmd.unjudged });
  }
  for (const cmd of ownedCommands) {
    hits.push(...unnamedRemoval(cmd));
    for (const w of deletedWords(cmd)) hits.push(hitFor(w, cmd.dir, tokenFor(cmd.name)));
    const interp = interpreterDeletions(cmd.name, cmd.args, cmd.dir);
    if ("reason" in interp) hits.push({ token: DELETION_LOG_TOKEN, reason: interp.reason });
    else for (const d of interp) hits.push({ token: DELETION_LOG_TOKEN, reason: "", path: d.path });
  }
  for (const t of bashWriteTargets(command, cwd)) {
    if (t.opaque === undefined) continue;
    if (!ownedCommands.some((c) => c.dir === t.cwd)) continue;
    hits.push({ token: DELETION_LOG_TOKEN, reason: t.opaque });
  }
  return hits;
}

/** The log token a command's own deletion carries. */
function tokenFor(name: string): string {
  return name === "git" ? GIT_CLEAN_LOG_TOKEN : DELETION_LOG_TOKEN;
}

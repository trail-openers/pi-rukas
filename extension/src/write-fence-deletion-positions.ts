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
 * Normally the splitter's stripped head, which is what the write fence reads too. But the strip
 * trusts the per-wrapper `VALUE_OPTIONS` skip counts, and those hold only option-by-option: an
 * option absent from a wrapper's table (`strace -p`, `ltrace -l`) or one whose value is OPTIONAL
 * (`nsenter -S [uid]`, `watch -q [cycles]`) makes the stripped head the option's VALUE rather than
 * the remover. So on the DELETION side only, when that head is not a command this rule owns, the
 * reader walks the segment's own option run — with the same tables the strip used — and judges from
 * the FIRST command it owns. That is the class, not another table: an option the table has never
 * heard of costs the strip its head but not the judgement.
 *
 * The strip consumed a wrapper's options with that wrapper's table and then stepped over the word
 * it stopped on without consulting it, so the scan reads every word up to and including that one:
 * that is where a second wrapper hides, and why `sudo -u nobody strace -p 1 rm …` still finds its
 * `rm`. Two bounds keep the read honest. It starts no earlier than where the option run ends, so a
 * word at an operand position is an argument and never the program — an `xargs -I <value>`
 * replacement string, or the target itself — which is what keeps `timeout 10 rm other` a `timeout`
 * line and an xargs line that named no operand the unnamed-target refusal rather than a judgement
 * on its placeholder. And it reads no further than the strip stopped, so an owned name that is an
 * ARGUMENT stays an argument (`env VAR=1 echo rm file` is an `echo`, `ls dir` an `ls`, a `find`'s
 * `-exec` is read by the `find` reader); a segment with no owned word in that position keeps the
 * stripped head, and `cd`, `git status` and any ordinary command read exactly as before. The
 * `xargs` words the Command carries are left untouched, because they are what makes a `{}` operand
 * a substituted match rather than a typed path.
 *
 * Where the scan finds no command at all, the strip has eaten the word in the program's slot — it
 * read the COMMAND as an option's VALUE, which is what an option whose value is OPTIONAL does when
 * the value is never given: `watch -q rm -rf <outside>` read `rm` for `-q [cycles]`, and `watch -q
 * git <verb> -fdx <outside>` read `git` for it, leaving git's VERB where the program should be,
 * three words short of the `git` whose tree the command clears. The head is what shows it: a head
 * that names something this rule runs IS the program and the line is judged as it is, but a head
 * that names none — a bare path, a verb, a subcommand, nothing — is a word no option of a wrapper
 * explains, and the reader has no command to judge the tree against. Such a segment carries a
 * verdict in place of words.
 */
function judgedWords(words: Word[]): Word[] {
  const stripped = stripPrefix(words).words;
  const head = stripped[0];
  if (head !== undefined && owned(commandName(head.text))) return stripped;
  // The tables of every word the strip consumed or stepped over, each read at its own position —
  // which is how the strip reads them too, so the two cannot disagree about what an option took.
  const tables = words
    .slice(0, words.length - stripped.length + 1)
    .map((w) => VALUE_OPTIONS[commandName(w.text)] ?? []);
  // Where the option run ends: the first word that is neither an option nor an option's value.
  let k = 0;
  while (k < words.length) {
    const a = words[k]?.text ?? "";
    if (!a.startsWith("-") || a === "-") break;
    const next = words[k + 1]?.text;
    const taken = tables.some((t) => t.includes(a));
    // A value is only ever a word that is not itself an option (`-p -f` is two flags), and an
    // option no table names takes nothing: `strace -p 1 rm …` and `nsenter -S 1000 rm …` left the
    // value behind, and `watch -q rm …` never had one — the word after them is the remover, which
    // is exactly what this scan is for.
    k += taken && next !== undefined && !next.startsWith("-") ? 2 : 1;
  }
  // `x` is how many words the strip's walk cost; it consumed the same leading options with the
  // same tables, so it stopped exactly where this one does, and the scan starts there.
  const x = words.length - stripped.length;
  if (k <= x) {
    const from = stripped.findIndex((w, i) => i + x >= k && owned(commandName(w.text)));
    if (from >= 0) return stripped.slice(from);
  }
  // The words the strip took are the evidence: it consumed its own word plus the leading options
  // and the values the tables named, so anything past `k` is unexplained, and an unexplained word
  // that is not a program is the program the strip mistook for a value.
  if (x > k && !runsProgram(head)) {
    return [{ text: "", dyn: false, refusal: UNJUDGED_WRAPPER_REASON }];
  }
  return stripped;
}

/**
 * Whether a word names something that RUNS — a command this rule reads operands of, a wrapper it
 * steps over, or an interpreter whose body it reads. The head answers this only where the strip
 * miscounted (see `judgedWords`), and it is the whole of the refusal: a head that runs is the
 * program, whatever the strip's arithmetic looked like, so `timeout 10 rm other`, `env VAR=1 echo
 * rm file` and `watch -q node <path>` are judged as the `timeout`/`echo`/`node` lines they are and
 * their operands stay operands; a head that does not (`clean`, git's VERB, or a bare path) is a
 * word the option's VALUE slot swallowed the program from, and nothing left to read is a command.
 * The wrapper names are the splitter's own, so this cannot drift from what `stripPrefix` consumes.
 */
function runsProgram(word: Word | undefined): boolean {
  if (word === undefined) return false;
  const name = commandName(word.text);
  return owned(name) || isWrapper(name);
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

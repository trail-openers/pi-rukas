/**
 * child-forge-read-path-words.ts — the word-level half of the #2638 read rule.
 *
 * The command judge (`child-forge-read-judge.ts`) asks "does any path this command
 * names sit in a protected forge config directory?". This module answers the half
 * of that question that is about PATHS AND WORDS rather than about commands: which
 * words of a simple command can name a path at all, the absolute name of a word
 * under a directory that a `cd` or a `git -C` may have moved, the operand words of
 * `<` and `<<<` redirects, and whether a word carries a forge config directory in
 * the spelling a case-insensitive filesystem would accept.
 *
 * Nothing here consults the protected set and nothing here reads a process env:
 * every answer is a function of the words handed in, which is what lets the judge,
 * the fail-closed arm and the smoke fixtures ask one lexer run the same questions.
 */

import path from "node:path";
import {
  type ForgeReadHit,
  type ProtectedDir,
  formsOf,
  isKeyValue,
} from "./child-forge-read-words.ts";
import { heredocSubstitutions } from "./write-fence-bash-heredoc.ts";
import { type Tok, type Word, lex } from "./write-fence-bash-lex.ts";
import { simpleCommands } from "./write-fence-bash-split.ts";
import { expandHome } from "./write-fence-path.ts";

/** The absolute name of one word under a directory that may itself be relative. */
function resolveAgainst(cwd: string, word: string, homes: readonly string[]): string {
  for (const form of formsOf(word, cwd)) {
    if (path.isAbsolute(form)) return form;
  }
  for (const home of homes) {
    if (word === "~" || word.startsWith("~/")) return path.resolve(home, word.slice(2));
  }
  return path.resolve(cwd, expandHome(word));
}

/**
 * The words of one simple command that can name a path: every word, its redirect
 * targets, and the value of each `key=VALUE` argument (`dd if=F`, `tar of=F`) —
 * forms the write-side readers have no reason to look at and this rule must.
 *
 * `inputs` are the operand words of this command's `<` redirects. The shared
 * splitter keeps only `>` targets, because to a WRITE fence an input redirect is
 * not a write; here it is precisely the read, so the caller collects them from the
 * token stream (see `redirectOperands`) rather than widen the write fence's
 * contract for a rule that is not its own.
 */
function candidateWords(simple: { words: Word[]; redirects: Word[] }, inputs: Word[]): Word[] {
  const out: Word[] = [...simple.words, ...simple.redirects, ...inputs];
  for (const w of [...out]) {
    for (const part of optionValueParts(w.text)) {
      // A part carved out of a word carries that word's `~` marking with it:
      // `--file=~/x` names a home-relative path just as `~/x` does.
      out.push({ text: part, dyn: w.dyn, raw: w.raw });
    }
  }
  return out.filter((w) => !w.dyn && w.text !== "" && w.text !== "-");
}

/**
 * The option VALUES of a word, as separate candidate paths.
 *
 * Three spellings carry a path the word's own text does not present as one:
 * `if=/abs/f` and `--file=/abs/f` (the value after the `=`), and `-f/abs/f` (the
 * value attached to a two-character short option). The bare `-C` / `--file` /
 * `-f` form is included because a spaced option's VALUE is the path its tool
 * opens (`git config --file .config/gh/hosts.yml`), and this rule's contract is
 * the paths a command can name — an option that opens a file is the read.
 *
 * Only a TWO-character short option has its tail taken: `-abc` is a bundle of
 * boolean flags to `tar`, `sort` and `grep`, and treating its tail as a path would
 * refuse ordinary reads.
 */
function optionValueParts(text: string): string[] {
  const out: string[] = [];
  const eq = text.indexOf("=");
  if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_-]*=/.test(text)) out.push(text.slice(eq + 1));
  if (PATH_OPTION_WORDS.has(text)) out.push(text);
  if (text.length > 3 && text.startsWith("-") && !text.startsWith("--")) {
    out.push(text.slice(2));
  }
  return out.filter((v) => v !== "" && v !== text);
}

/**
 * The options whose VALUE is a file the command opens, whatever the command is.
 *
 * The predicate is deliberately not command-specific: an option that names a file
 * to read is the read whichever tool takes it, and a table keyed by command is a
 * table with a gap in it. `--file` is the one that matters here — `git config
 * --file <path> -l` reads exactly that file, and `git` is no interpreter, so
 * nothing else in the judge would ever look at the value.
 */
const PATH_OPTION_WORDS = new Set(["--file", "--config", "--git-dir", "--work-tree"]);

/**
 * The words of a command whose option VALUE is a file it opens, each paired to
 * the directory that value resolves against: the command's own directory, which an
 * earlier `cd` or a `git -C` may have moved. A `key=VALUE` word is excluded — its
 * value half is already judged by `candidateWords`, and a `NAME=VALUE` argument is
 * an assignment to a tool, not an option of it.
 */
function optionValueWords(
  words: Word[],
  dir: string,
  homes: readonly string[],
): Array<{ text: string; dyn: boolean; raw?: string }> {
  const out: Array<{ text: string; dyn: boolean; raw?: string }> = [];
  for (let k = 0; k < words.length; k++) {
    const a = words[k];
    if (a === undefined || a.dyn || isKeyValue(a.text)) continue;
    if (PATH_OPTION_WORDS.has(a.text)) {
      const value = words[k + 1];
      // The value is judged BOTH where it was typed and under the directory this
      // command runs in: `git -C <home> config --file=.config/gh/hosts.yml` opens it
      // under `<home>`, while a bare `--file <abs>` names it where it stands.
      if (value !== undefined) {
        out.push({ text: value.text, dyn: value.dyn, raw: value.raw });
        out.push({ text: resolveAgainst(dir, value.text, homes), dyn: value.dyn });
      }
      continue;
    }
    const eq = a.text.indexOf("=");
    if (eq > 0 && PATH_OPTION_WORDS.has(a.text.slice(0, eq))) {
      const value = a.text.slice(eq + 1);
      out.push({ text: value, dyn: a.dyn, raw: a.raw });
      out.push({ text: resolveAgainst(dir, value, homes), dyn: a.dyn });
    }
  }
  return out;
}

/**
 * The operand of every `<` redirect in the token stream, attached to the simple
 * command it belongs to. A `<` is a redirect only when it opens an input file —
 * `<<` is a heredoc, and `<<<` a here-string, whose word is not a file the tool
 * opens (see `hereStringGroups` for how that word is still judged).
 */

function redirectOperands(toks: Tok[], subs: string[] = [], includeHereStrings = false): Word[][] {
  const groups: Word[][] = [[]];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === undefined) continue;
    if (t.kind === "op") {
      if (t.text === "<<") continue;
      if (t.text === "<" || t.text === "<<<") {
        const nx = toks[k + 1];
        if (nx?.kind === "word") {
          // `<<<` is a here-string and the lexer collapses it to ONE `<` token, so
          // the tell is the token's own text, not what precedes it — `while … done <
          // F` puts a word before a real input redirect too. A here-string's word is
          // data, not an input file, so it is never a read here: an interpreter fed a
          // program this way (`tclsh <<< 'puts [exec cat <F>]'`) execs what the word
          // names, and the caller judges it as inline code (see `hereStringGroups`).
          // Its substitutions DO run, so they are published for that judge.
          if (t.text === "<<<") {
            for (const sub of lexHereString(nx.word.text)) subs.push(sub);
            if (includeHereStrings) (groups[groups.length - 1] as Word[]).push(nx.word);
          } else {
            (groups[groups.length - 1] as Word[]).push(nx.word);
          }
          k++;
        }
        continue;
      }
      // Any other operator ends the command: the next word opens the next one.
      groups.push([]);
    }
  }
  return groups;
}

/**
 * The command substitutions a here-string word runs. The lexer marks a word that
 * carried one `dyn` and already published its body in `subs`; this recovers the
 * substitutions of a QUOTED here-string word, whose text survives verbatim and
 * whose `$(…)`/backticks the shell still expands and runs.
 */
function lexHereString(text: string): string[] {
  return heredocSubstitutions(text) ?? [];
}

/**
 * The words of every here-string (`<<<`) in the token stream, grouped by the simple
 * command they belong to (same grouping as `redirectOperands`, so the nth group
 * lines up with the nth command step).
 *
 * The lexer cannot tell a here-string's operand from an input redirect's — it emits
 * the operator as a single `<` and keeps the word verbatim — so the tell is the
 * operator appearing twice in a row. That is precise, and it does not need one: the
 * judge answers for ANY word that names a protected path, so a word read as a
 * here-string operand when it was an input file is still refused, just as its
 * counterpart would have been. What the split buys is the right reading of a
 * here-string's substitutions, whose bodies DO run and are published in `subs`.
 */
function hereStringGroups(toks: Tok[]): Word[][] {
  const groups: Word[][] = [[]];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === undefined) continue;
    if (t.kind === "op") {
      if (t.text === "<<") continue;
      if (t.text === "<<<") {
        const nx = toks[k + 1];
        if (nx?.kind === "word") {
          // The mirror of `redirectOperands`: only a here-string's word belongs here.
          if (t.text === "<<<") (groups[groups.length - 1] as Word[]).push(nx.word);
          k++;
        }
        continue;
      }
      groups.push([]);
    }
  }
  return groups;
}

/** The `NAME=` head of a `key=VALUE` word, lower-cased, or the word itself. */
function keyOf(text: string): string {
  const eq = text.indexOf("=");
  return eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text) ? text.slice(0, eq).toLowerCase() : text;
}

/**
 * The non-option operands of a simple command: everything after `--` counts, and
 * before it a word starting with `-` is an option rather than an operand (`-` alone
 * is stdin/stdout, so it counts).
 */
function nonOptionWords(words: Word[]): Word[] {
  const out: Word[] = [];
  let over = false;
  for (const w of words) {
    if (!over && w.text === "--") {
      over = true;
      continue;
    }
    if (!over && w.text.startsWith("-") && w.text !== "-") continue;
    out.push(w);
  }
  return out;
}

/** The command words that move the directory later words resolve against. */
function chdirTargetOf(name: string, args: Word[]): string | undefined {
  if (name !== "cd" && name !== "pushd") return undefined;
  const first = args.find((a) => !a.dyn && !a.text.startsWith("-"));
  return first?.text;
}

/**
 * The value of an option that names a directory to work in: `git -C <dir>`,
 * `git --git-dir=<dir>`, `git --work-tree=<dir>`. A command run with `-C` reads
 * and writes there, not in the child's cwd, so a relative operand of the same
 * command (`git -C <home> config --file=.config/gh/hosts.yml -l`) resolves under
 * THAT directory.
 */
function optionChdir(name: string, args: Word[]): string | undefined {
  for (const a of args) {
    if (a.dyn) continue;
    const t = a.text;
    if (t === "-C") {
      const value = args[args.indexOf(a) + 1];
      if (value !== undefined && !value.dyn) return value.text;
      continue;
    }
    if (t.length > 2 && t.startsWith("-C") && !t.startsWith("--")) return t.slice(2);
    for (const opt of ["--git-dir", "--work-tree"]) {
      if (t === opt) {
        const value = args[args.indexOf(a) + 1];
        if (value !== undefined && !value.dyn) return value.text;
        continue;
      }
      if (t.startsWith(`${opt}=`)) return t.slice(opt.length + 1);
    }
  }
  return undefined;
}

/**
 * The words of a heredoc body, as the fail-closed arm can see them: the body is
 * lexed as a command so its words arrive, and when it does not lex the arm cannot
 * rule out a config path in it, so the raw text is handed over for the component
 * test to answer as best it can.
 */
function bodyWords(body: string): string[] {
  const lexed = lex(body);
  if (lexed === undefined) return [body];
  const out: string[] = [];
  for (const step of simpleCommands(lexed.toks)) {
    if (step.kind !== "command") continue;
    for (const w of [...step.simple.words, ...step.simple.redirects]) out.push(w.text);
  }
  for (const group of redirectOperands(lexed.toks, [], true))
    for (const w of group) out.push(w.text);
  for (const b of lexed.bodies) out.push(b);
  for (const sub of lexed.subs) out.push(sub);
  return out;
}

/** The directory names the two CLIs keep their credentials in, by either host's spelling. */
const FORGE_CONFIG_DIR_NAMES = new Set(["gh", "glab", "glab-cli", "github", "gitlab"]);

/** The directories an XDG/`~/.config` credential tree sits under, whatever case it is spelled in. */
const CONFIG_DIR_NAMES = new Set([".config", "config"]);

/**
 * Does one word carry a forge config directory as a DIRECTORY of its path? Each
 * `/`-separated component is compared as a whole, so `…/gh/…` and `…/glab/…` count
 * and `…/ghost/…`, `…/target/` or a bare `gh` (the command, not a path) do not.
 *
 * The comparison is CASE-INSENSITIVE, as `matches` is: the protected set is
 * spelled in lower case by every resolver, and a case-sensitive filesystem lets
 * `.config/GH/hosts.yml` name the same credential layout through a name the
 * case-sensitive predicate would have passed.
 */
function namesForgeConfigDir(word: string): boolean {
  const parts = word.split("/");
  for (let i = 1; i < parts.length; i++) {
    // From 1, never 0: a leading empty component is the root of an absolute path,
    // and a word with no `/` at all is one component — the command word, an argv
    // head, or a bare name — which is never the directory this rule protects.
    const part = parts[i];
    if (part !== undefined && FORGE_CONFIG_DIR_NAMES.has(part.toLowerCase())) return true;
  }
  return false;
}

/**
 * Does one word name a config directory under one of the PARENT's homes? The
 * arm that has no protected set to match against still has to answer for
 * `~/.config/gh/hosts.yml` typed by a child whose own `HOME` is a scratch tree:
 * the `gh` component test catches it only once the `~` has been expanded, and
 * expanding it needs the homes the parent published, not this process's env.
 */
function namesHomeConfigDir(word: string, homes: readonly string[]): boolean {
  if (word !== "~" && !word.startsWith("~/")) return false;
  const rest = word === "~" ? "" : word.slice(2);
  for (const home of homes) {
    const joined = home.endsWith("/") ? home + rest : `${home}/${rest}`;
    const parts = joined.split("/");
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined || !CONFIG_DIR_NAMES.has(part.toLowerCase())) continue;
      const next = parts[i + 1];
      if (next !== undefined && FORGE_CONFIG_DIR_NAMES.has(next.toLowerCase())) return true;
    }
  }
  return false;
}

export {
  bodyWords,
  candidateWords,
  chdirTargetOf,
  hereStringGroups,
  keyOf,
  namesForgeConfigDir,
  namesHomeConfigDir,
  nonOptionWords,
  optionChdir,
  optionValueParts,
  optionValueWords,
  redirectOperands,
  resolveAgainst,
};

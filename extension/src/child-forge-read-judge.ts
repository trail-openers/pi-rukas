/**
 * child-forge-read-judge.ts — the pure judge of the #2638 forge-config read rule.
 *
 * Two questions, no Pi in either: which paths a command or a tool argument names,
 * and whether any of them is a protected forge config path. The hook in
 * `child-forge-read-guard.ts` binds the answer to `tool_call`; the wrapper in
 * `forge-cli-guard-wrapper.ts` prints the same verdict as text. One judge, so the
 * two voices cannot read the rule differently.
 *
 * The path set is HARNESS-OWNED (decision 4): it is computed once in the parent
 * from the parent's own environment plus the passwd home, serialised into
 * `PI_ENSEMBLE_FORGE_PROTECTED_PATHS`, and the child judges only what it was
 * handed. Nothing here reads the child's env for the set, so unsetting or
 * re-pointing `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` changes nothing the rule sees.
 *
 * What is judged:
 *   - every WORD of every simple command, after the wrappers (`env`, `sudo`,
 *     `timeout`, `xargs`, …) and the leading assignments are stripped — not only
 *     the operands a reader knows (decision 6: an unknown command naming a
 *     protected path is refused, because unknown means refused);
 *   - both the LEXICAL and the OS-resolved form of every word (decision 7), so a
 *     symlink whose target is a protected directory is refused whichever name the
 *     command spelled;
 *   - the BODY of a heredoc, as command text and as data. A heredoc is how a
 *     child hands a program to an interpreter, so the body is judged by the same
 *     rules as the line that carries it — quoted delimiter or not;
 *   - the OPERATOR that produced a word, not only the word: `--file=<F>`,
 *     `if=<F>` and `-f<F>` all name `<F>` to the tool that parses them, and an
 *     option value is the read when the option is what opens the file;
 *   - the effective directory the command runs in: `cd <dir> ; cat <rel>`,
 *     `(cd <dir>; cat <rel>)`, `git -C <dir> …` and `env -C <dir> …` all resolve
 *     a relative operand somewhere other than the child's cwd, so relative words
 *     resolve against THAT;
 *   - a `file://` URL, whose path is the file the tool opens;
 *   - the parent of a protected root: an archive or recursive copy of a PARENT
 *     directory carries the credential tree with it, so a source that CONTAINS a
 *     protected root is refused as readily as one inside it;
 *   - the `path` argument of a read-class tool call, with Pi's own expansion.
 *
 * A word the lexer marks `dyn` (a `$VAR` other than `$HOME`, a command
 * substitution, `~user`) cannot be resolved here, and is left to the sibling
 * rules rather than guessed: this rule's contract is the paths it can name.
 */

import os from "node:os";
import path from "node:path";
import {
  bodyWords,
  candidateWords,
  chdirTargetOf,
  hereStringGroups,
  namesForgeConfigDir,
  namesHomeConfigDir,
  nonOptionWords,
  optionChdir,
  optionValueParts,
  optionValueWords,
  redirectOperands,
  resolveAgainst,
} from "./child-forge-read-path-words.ts";
import {
  firstForgeReadInCopyLike,
  firstForgeReadInInlineCode,
  firstForgeReadInText,
} from "./child-forge-read-programs.ts";
import {
  type ForgeReadHit,
  type ProtectedDir,
  hits,
  isKeyValue,
} from "./child-forge-read-words.ts";
import { type Word, lex } from "./write-fence-bash-lex.ts";
import { commandName, simpleCommands, stripPrefix } from "./write-fence-bash-split.ts";
import { expandHome } from "./write-fence-path.ts";

// The word-level helpers (candidate words, redirect operands, config-dir naming)
// live in `child-forge-read-path-words.ts`; the two shapes are re-exported here so
// the judge stays the module a reader of this rule opens first, with one definition
// of each in `child-forge-read-words.ts`.
export type { ForgeReadHit, ProtectedDir };

/**
 * Every protected path a bash command names, as the first hit. `cwd` is the
 * directory the command runs in — the child's working directory, unless an
 * earlier `cd` on the same line moved it.
 */
export function firstForgeReadInCommand(
  command: string,
  cwd: string,
  dirs: readonly ProtectedDir[],
  homes: readonly string[] = [],
): ForgeReadHit | undefined {
  if (dirs.length === 0) return undefined;
  const lexed = lex(command);
  if (lexed === undefined) return undefined;
  const steps = simpleCommands(lexed.toks);
  // A here-string's word is DATA to the shell: it opens no file and runs no command
  // of its own, so the only thing it can do is NAME the credential path in the text
  // a tool then acts on. That reading is the one an INTERPRETER makes of the program
  // it was handed (`tclsh <<< 'puts [exec cat <F>]'`, `node <<< 'require("fs")…'`),
  // so the word is judged as an inline program whenever the command is one. The
  // word's `$(…)/…` bodies still run and are published in `subs` (see
  // `hereStringGroups`).
  {
    let stepIndex = 0;
    for (const group of hereStringGroups(lexed.toks)) {
      const cmd = steps[stepIndex];
      stepIndex++;
      if (cmd === undefined || cmd.kind !== "command") continue;
      const head = stripPrefix(cmd.simple.words).words[0];
      if (head === undefined || head.dyn) continue;
      for (const w of group) {
        const hit = firstForgeReadInInlineCode(commandName(head.text), [w], cwd, dirs);
        if (hit !== undefined) return hit;
      }
    }
  }
  // The `<` operands, in the same order as the command steps the splitter emits
  // (one group before each command, one after each separator), so the nth command
  // reads the nth group.
  const inputs = redirectOperands(lexed.toks, lexed.subs);
  let group = 0;
  let here = cwd;
  for (const step of steps) {
    if (step.kind !== "command") {
      group++;
      continue;
    }
    const mine = inputs[group] ?? [];
    group++;
    // EVERY word is judged, the command word and the redirect targets included:
    // an input redirect (`cat < F`, `sh < F`) reads the file it names, and a
    // word that spells a path — `/op/.config/gh/hosts.yml cat`, `ls <root>` —
    // is the read whatever command word leads the line. A bare command word
    // (`cat`, `gh`) can never name a protected directory: the roots are
    // absolute, so it is judged by the same rule and simply never matches.
    for (const w of candidateWords(step.simple, mine)) {
      if (isKeyValue(w.text)) continue;
      const hit = hits(w.text, here, dirs, homes, w.raw);
      if (hit !== undefined) return hit;
    }
    const { words, chdir } = stripPrefix(step.simple.words);
    const head = words[0];
    // A command that runs somewhere other than where the child is: `git -C <dir>`,
    // `env -C <dir>` and a `cd <dir>` all make a RELATIVE operand name a path the
    // judge would otherwise resolve against the child's own working directory.
    let cmdDir = here;
    for (const c of chdir) {
      if (!c.dyn) cmdDir = resolveAgainst(cmdDir, c.text, homes);
    }
    // An option that names the directory the COMMAND runs in (`git -C <dir>`,
    // `git --git-dir=<dir>`) moves that command's OWN operands, so it is applied
    // before the words below are resolved against it.
    // A command that runs somewhere other than where the child is moves every
    // NON-OPTION word of that command, its positional parameters included:
    // `git -C <home> config --file .config/gh/hosts.yml -l` opens the file under
    // `<home>`, not under the child's cwd. Only the bare words move — `optionValueParts`
    // has already judged the text of `--file=<value>` in the command's own cwd, and
    // guessing a second resolution for an option's value is how a rule starts
    // refusing ordinary flags.
    if (head !== undefined && !head.dyn) {
      const optDir = optionChdir(commandName(head.text), words.slice(1));
      if (optDir !== undefined) cmdDir = resolveAgainst(cmdDir, optDir, homes);
    }
    const moved: Word[] = [];
    for (const w of nonOptionWords(step.simple.words)) {
      moved.push({ text: resolveAgainst(cmdDir, w.text, homes), dyn: w.dyn });
    }
    if (head !== undefined && !head.dyn) {
      const name = commandName(head.text);
      const args = words.slice(1);
      // The interpreter's inline program: its OWN text is judged, since the paths it
      // names never appear as separate words (`python3 -c 'open("/op/…/hosts.yml")'`).
      const inline = firstForgeReadInInlineCode(name, args, cmdDir, dirs);
      if (inline !== undefined) return inline;
      const copy = firstForgeReadInCopyLike(name, args, cmdDir, dirs);
      if (copy !== undefined) return copy;
      const dir = chdirTargetOf(name, args);
      if (dir !== undefined) here = resolveAgainst(here, dir, homes);
    }
    // An option whose VALUE is a file the command opens (`git config --file <f>`,
    // `jq --file <f>`): the value is judged under the directory this command runs
    // in, so `git -C <home> config --file=.config/gh/hosts.yml` is refused whichever
    // spelling of the value it used.
    for (const w of optionValueWords(step.simple.words, cmdDir, homes)) {
      if (w.dyn) continue;
      const hit = hits(w.text, cmdDir, dirs, homes, w.raw);
      if (hit !== undefined) return hit;
    }
    if (cmdDir !== here || moved.length > 0) {
      // The same words again, this time resolved under the directory the command
      // runs in, so a relative operand of a `git -C` / `env -C` / post-`cd` command
      // is judged where the tool will actually open it.
      const movedHere = cmdDir;
      for (const w of moved) {
        if (w.dyn || isKeyValue(w.text)) continue;
        const hit = hits(w.text, movedHere, dirs, homes, w.raw);
        if (hit !== undefined) return hit;
      }
    } else if (chdir.length > 0) {
      here = cmdDir;
    }
  }
  for (const body of lexed.bodies) {
    // A heredoc body is the program a child hands an interpreter, and the paths it
    // opens live inside it. It is judged twice: as a COMMAND (so a `cat <F>` or a
    // `python3 -c …` inside the body meets every rule above) and as TEXT (so a bare
    // `open("<F>")` inside a quoted body — where nothing is a command — still names
    // the file). The quoted/unquoted distinction decides only what the SHELL
    // expands in the body, not what the child wrote into it.
    const hit = firstForgeReadInCommand(body, here, dirs, homes);
    if (hit !== undefined) return hit;
    const asText = firstForgeReadInText(body, here, dirs);
    if (asText !== undefined) return asText;
  }
  for (const sub of lexed.subs) {
    const hit = firstForgeReadInCommand(sub, here, dirs, homes);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The read-class tools whose path argument is a file the child asks to see. */
const READ_TOOLS = new Set(["read"]);

/**
 * Pi's own expansion of a read tool's `path`: a leading `@` is stripped and `~`
 * / `~/` expand to the home (the same rule `write-fence.ts`'s `piExpandPath`
 * applies, so the two rules judge one spelling).
 */
export function expandReadPath(p: string): string {
  return expandHome(p.startsWith("@") ? p.slice(1) : p);
}

/**
 * Could this call name a forge config directory at all? The question the fail-closed
 * arm asks before it refuses: a child whose spawn carried no protected set must not
 * have every `bash` call blocked, and must not have a credential read passed either.
 * "Names a config-dir spelling" is the narrow, honest predicate: a word that carries
 * one of the two CLIs' config directory NAMES (`gh`, `glab`, `glab-cli`, `github`,
 * `gitlab`) as a DIRECTORY of its own path — `/op/.config/gh/hosts.yml`, a link
 * named `glab`, an `~/.config/gh`. The CLI name as a word or an argv head is NOT
 * what the predicate looks for: `gh pr view 5` is the read every helper must keep,
 * and a gate that blocked it would be lifted the first time it broke a dispatch.
 * It needs no protected set to answer, which is exactly why it can gate the arm
 * whose set is missing.
 */
export function commandNamesForgePath(
  toolName: string,
  input: unknown,
  cwd: string,
  homes: readonly string[] = [],
): boolean {
  const words: string[] = [];
  const push = (text: string): void => {
    words.push(text);
    // An option VALUE is the path the tool opens (`--file=.config/gh/hosts.yml`,
    // `if=.config/gh/hosts.yml`, `-f.config/gh/hosts.yml`), so the predicate that
    // gates the fail-closed arm sees it too.
    for (const part of optionValueParts(text)) words.push(part);
  };
  if (toolName === "bash") {
    const command =
      typeof input === "object" && input !== null
        ? (input as { command?: unknown }).command
        : undefined;
    if (typeof command !== "string" || command === "") return false;
    const lexed = lex(command);
    // Unparsable text is the case the guard cannot judge, so it names whatever it
    // might name — refuse rather than guess.
    if (lexed === undefined) return true;
    // EVERY operand the lexer sees, in both redirect directions. The shared
    // splitter drops the target of a `<` because to a WRITE fence an input redirect
    // is not a write — and this arm's whole job is to catch the read that nothing
    // judged, so dropping it would pass `cat < <F>` exactly when there is no set to
    // judge it with.
    for (const step of simpleCommands(lexed.toks)) {
      if (step.kind !== "command") continue;
      for (const w of [...step.simple.words, ...step.simple.redirects]) push(w.text);
    }
    for (const group of redirectOperands(lexed.toks, [], true)) {
      for (const w of group) push(w.text);
    }
    // The heredoc bodies, judged by the same rules as the line that carries them:
    // the child wrote those words and the interpreter will run them.
    for (const body of lexed.bodies) {
      for (const w of bodyWords(body)) push(w);
    }
    for (const sub of lexed.subs) words.push(sub);
  } else {
    if (!READ_TOOLS.has(toolName)) return false;
    const args = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    if (typeof args.path !== "string") return false;
    push(args.path);
    // A `~` in a read path is every home the parent published, not just the home
    // this process's env names: a reviewer or explore child's `HOME` is a scratch
    // tree the harness itself set, and the operator's config never lives there.
    return words.some((w) => namesForgeConfigDir(w) || namesHomeConfigDir(w, homes));
  }
  return words.some((w) => namesForgeConfigDir(w));
}

/** Does a read-class tool call ask for a protected path? */
export function firstForgeReadInToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
  dirs: readonly ProtectedDir[],
  homes: readonly string[] = [],
): ForgeReadHit | undefined {
  if (dirs.length === 0 || !READ_TOOLS.has(toolName)) return undefined;
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  if (typeof args.path !== "string" || args.path === "") return undefined;
  // The RAW spelling is passed to `hits` as well as Pi's expansion: `hits` expands
  // a leading `~` against every home the parent published, which is what a child
  // with a redirected scratch `HOME` needs (see `tildeForms`).
  return (
    hits(args.path, cwd, dirs, homes, args.path) ??
    hits(expandReadPath(args.path), cwd, dirs, homes, args.path)
  );
}

/**
 * The wrapper's own question: does this argv name a protected path anywhere?
 * The `gh`/`glab` wrapper answers its refusal when it does — a CLI invoked with
 * an operator config path in its arguments is the read, whatever it execs next.
 */
export function firstForgeReadInArgv(
  argv: readonly string[],
  cwd: string,
  dirs: readonly ProtectedDir[],
): ForgeReadHit | undefined {
  if (dirs.length === 0) return undefined;
  for (const word of argv) {
    if (word === "") continue;
    const hit = hits(word, cwd, dirs);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
/**
 * Does this command word name the named CLI? (`/usr/bin/gh`, `./gh`, `gh`) The
 * wrapper asks it before judging an argv, so the rule that a program's BASE NAME
 * is what identifies it has one spelling.
 */
export function namesCli(word: string, cli: string): boolean {
  return commandName(word) === cli;
}

/**
 * write-fence-bash — the bash side of the /work write fence (#1655).
 *
 * Best-effort: it lists the paths a bash command would WRITE (or change into),
 * so write-fence.ts can judge each one with the same rule as the write tools.
 * It is not a shell. The lexer (write-fence-bash-lex.ts) keeps each word's text,
 * the splitter (write-fence-bash-split.ts) finds the simple commands, and the
 * writers (write-fence-bash-writers.ts) say what each command writes.
 *
 * Checked: output redirects (`>`, `>>`, `&>`, `>|`), `cd` and `pushd` (their
 * operand is the directory the rest of the command runs in), and the writes of the
 * commands in write-fence-bash-writers.ts, reached through wrappers (`env`,
 * `timeout`, `xargs`, …) and keywords (`if`, `then`, `do`, `{`). Every simple
 * command in a pipeline, chain, subshell, or `$(…)` / backtick substitution is
 * checked, including those in an unquoted heredoc body (bash runs them).
 *
 * Each target is judged from the directory in effect where it was written. A
 * `( … )` subshell restores the directory it began in at its `)`, and so does each
 * pipeline segment and a backgrounded list. `popd`, a bare or `+N` / `-N` `pushd`,
 * and a `cd -` or `cd` the fence cannot resolve leave the directory unknown: a
 * relative target after one is refused. A command substitution or a command string
 * the shell runs is judged from every directory the command may have reached,
 * because its position in the line is not tracked.
 *
 * The rule is one: what the fence can resolve statically, it judges; what it
 * cannot resolve at a write position, it refuses. A word the fence cannot resolve
 * (a `$VAR` other than `$HOME`, a `~user`, a substitution inside a path, a glob,
 * brace expansion) is refused where it is written, since its path is unknown. A
 * command that does not lex is refused whole: the fence does not guess its shape.
 *
 * A body the shell will run as its own command (`eval`, `sh -c`, `bash -c`, …) is
 * read as a command when its text is literal, so its writes are judged too. A
 * body built at run time is refused. Everything else is best-effort: an
 * unrecognised command contributes no targets, and the repo-root residue
 * detection is the backstop. See docs/troubleshooting.md for the categories not
 * checked.
 */

import path from "node:path";
import { type Word, lex } from "./write-fence-bash-lex.ts";
import { commandName, operands, simpleCommands, stripPrefix } from "./write-fence-bash-split.ts";
import {
  copyLikeTargets,
  embeddedBody,
  hardLinkSources,
  linkRootWords,
  symlinkNames,
  writtenOperands,
} from "./write-fence-bash-writers.ts";
import { homeDir, isInside, resolveLikeOs } from "./write-fence-path.ts";

/** One path a command writes, judged against the cwd it runs in. */
export interface BashTarget {
  path: string;
  cwd: string;
  /**
   * The path lies under a directory a command in this line may have filled with
   * links whose names it does not give (an archive extraction, a link-keeping
   * copy). A path that does not exist yet cannot be judged.
   */
  linkedCommand: boolean;
  /** Absolute lexical names of the symlinks this command creates (`ln -s`). */
  throughLinks: string[];
  /** Why this path cannot be judged, when it cannot. Undefined for a path the rule can judge. */
  opaque?: string;
}

/** Why a command is refused whole: it does not lex. */
export const UNPARSEABLE_REASON =
  "unparseable bash; refused by the write fence (the command does not lex, for example an unterminated quote)";

/** Why a body the shell runs is refused: its text is only known at run time. */
const DYNAMIC_BODY_REASON =
  "it runs a command string built at run time, so the fence cannot read what it writes";

/** Why a relative path is refused: an earlier command left the working directory unknown. */
const UNKNOWN_DIR_REASON =
  "it is relative, and an earlier command in this line (popd, a pushd with no operand or +N / -N, or a cd the fence cannot resolve) left the working directory unknown, so it cannot be judged. Use an absolute path";

/** A directory the fence can name, or undefined once it cannot. */
type Dir = string | undefined;

/** The directory a `(` or a pipeline segment restores at its end, with the statement state around it. */
interface Scope {
  here: Dir;
  base: Dir;
  piped: boolean;
}

/** A word a command writes. `link`: the command makes it a symbolic link's name. `creation`: it is the name the command creates. `dir`: the directory it was written from. */
interface RawTarget {
  word: Word;
  link: boolean;
  dir: Dir;
  creation?: boolean;
}

/** What the command's tools may have made, for every target it writes. */
interface LinkContext {
  /** Absolute lexical names of the symbolic links this command creates. */
  names: string[];
  /** Absolute directories a tool may create unnamed links under. */
  roots: string[];
  /** A root the fence cannot name: every target that does not exist yet is then refused. */
  unnamedRoot: boolean;
}

/** A target the fence cannot judge, with the reason it is refused. */
function opaqueTarget(cwd: string, why: string, what = "the command"): BashTarget {
  return { path: what, cwd, linkedCommand: false, throughLinks: [], opaque: why };
}

/** Redirect targets that are never a file write. */
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** Commands whose words are destinations, judged by writers.ts's copy rules. */
const COPY_LIKE = new Set(["cp", "mv", "install", "ln", "link"]);

/** Brace expansion (`{../..,src}/x`, `{1..3}`): several paths, none of them the literal word. */
const BRACE = /\{[^{}]*(,|\.\.)[^{}]*\}/;

/** Resolve a word from `base`, or undefined when it is dynamic or cannot be resolved (a symlink loop). */
function resolveFrom(base: string, w: Word): string | undefined {
  if (w.dyn) return undefined;
  try {
    return resolveLikeOs(path.isAbsolute(w.text) ? w.text : path.join(base, w.text));
  } catch {
    return undefined;
  }
}

/** `resolveFrom` for a working directory that may be unknown: a relative word cannot be resolved without it. */
function resolveFromDir(here: Dir, w: Word): string | undefined {
  if (here === undefined && !path.isAbsolute(w.text)) return undefined;
  return resolveFrom(here ?? "/", w);
}

/** The absolute lexical name of a word a command names, read from `dir`; undefined when the fence cannot name it. */
function lexicalFrom(dir: Dir, w: Word): string | undefined {
  if (w.dyn) return undefined;
  if (path.isAbsolute(w.text)) return path.resolve(w.text);
  return dir === undefined ? undefined : path.resolve(dir, w.text);
}

/** Why a word cannot be judged, or undefined when it can. */
function opaqueReason(w: Word): string | undefined {
  if (w.refusal !== undefined) return w.refusal;
  if (w.dyn) {
    return "it uses a shell expansion the fence cannot resolve (a variable, a substitution, or ~user), so the path cannot be judged";
  }
  if (w.glob) {
    return "it has a glob (*, ? or [), which expands to the files it matches; name each path literally";
  }
  if (BRACE.test(w.text)) {
    return "it uses brace expansion, which the fence does not expand. Name each path literally";
  }
  return undefined;
}

/** Why one raw word cannot be judged: the directory it was written from, or the word itself. */
function opaqueFor(r: RawTarget): string | undefined {
  if (r.dir === undefined && !r.word.dyn && !path.isAbsolute(r.word.text))
    return UNKNOWN_DIR_REASON;
  return opaqueReason(r.word);
}

/** The target a raw word is: judged from the directory it was written from, and marked when a tool in this line may have made a link on its path. */
function targetOf(r: RawTarget, cwd: string, ctx: LinkContext): BashTarget {
  const abs = lexicalFrom(r.dir, r.word);
  const underRoot = abs !== undefined && ctx.roots.some((root) => isInside(abs, root));
  return {
    path: r.word.text,
    cwd: r.dir ?? cwd,
    linkedCommand: !r.creation && (ctx.unnamedRoot || underRoot),
    throughLinks: ctx.names,
    opaque: opaqueFor(r),
  };
}

/**
 * The targets of a command string the shell runs from a directory the walk could
 * not track. A relative one cannot be judged there; an absolute one is unchanged.
 */
function unknownDirTargets(targets: BashTarget[], unknown: boolean): BashTarget[] {
  if (!unknown) return targets;
  return targets.map((t) =>
    t.opaque !== undefined || path.isAbsolute(t.path)
      ? t
      : opaqueTarget(t.cwd, UNKNOWN_DIR_REASON, t.path),
  );
}

/**
 * Every path the bash command would write or change into, each with a cwd it
 * may run under. `cwd` is the child's own working directory.
 */
export function bashWriteTargets(command: string, cwd: string): BashTarget[] {
  const lexed = lex(command);
  if (!lexed) return [opaqueTarget(cwd, UNPARSEABLE_REASON)];
  const raw: RawTarget[] = [];
  const roots: string[] = [];
  let unnamedRoot = false;
  // Every directory the command may be in. Used only for the command strings it runs, whose position is not tracked.
  const visited = new Set<string>([cwd]);
  // Command strings the shell runs as their own commands (`eval`, `sh -c`).
  const bodies: Word[] = [];
  // The directory the next command runs in; undefined once the fence cannot name it.
  let here: Dir = cwd;
  // The directory the current statement began in: each pipeline segment starts from it, and so does a list run in the background.
  let base: Dir = cwd;
  // Set once the current statement has a pipe.
  let piped = false;
  // Saved at each `(`, restored at its `)`.
  const scopes: Scope[] = [];
  // Set once any command left the directory unknown: a substitution or body may run from there.
  let unknownSeen = false;
  for (const step of simpleCommands(lexed.toks)) {
    if (step.kind === "sep") {
      if (step.text === "(") {
        scopes.push({ here, base, piped });
        base = here;
        piped = false;
      } else if (step.text === ")") {
        const saved = scopes.pop();
        if (saved) ({ here, base, piped } = saved);
      } else if (step.text === "|") {
        // Each pipeline segment runs in a subshell, so it starts from the statement's directory.
        here = base;
        piped = true;
      } else {
        // The end of a statement: a pipeline and a backgrounded list leave the directory they began in.
        if (piped || step.text === "&") here = base;
        // `a || b` runs b only when a failed, so a directory a moved into is not known after it.
        if (step.text === "||" && here !== base) here = undefined;
        base = here;
        piped = false;
      }
      if (here === undefined) unknownSeen = true;
      continue;
    }
    const { simple } = step;
    // A redirect is applied before the command runs, so it is written from the directory the command starts in.
    for (const r of simple.redirects) raw.push({ word: r, link: false, dir: here });
    const { words, chdir } = stripPrefix(simple.words);
    // `env -C` moves only the command it runs.
    let cmdDir: Dir = here;
    for (const c of chdir) {
      raw.push({ word: c, link: false, dir: here });
      cmdDir = resolveFromDir(cmdDir, c);
    }
    if (cmdDir !== undefined) visited.add(cmdDir);
    const first = words[0];
    if (first === undefined) continue;
    const name = commandName(first.text);
    const args = words.slice(1);
    if (name === "cd" || name === "pushd") {
      const dest =
        operands(args)[0] ?? (name === "cd" ? { text: homeDir(), dyn: false } : undefined);
      // A bare pushd swaps the top two directories, +N / -N rotate the stack, and `cd -` returns to the previous one: none names a directory the fence can read.
      if (dest === undefined || /^[+-]\d/.test(dest.text) || (dest.text === "-" && !dest.dyn)) {
        here = undefined;
        unknownSeen = true;
        continue;
      }
      raw.push({ word: dest, link: false, dir: here });
      here = resolveFromDir(here, dest);
      if (here === undefined) unknownSeen = true;
      else visited.add(here);
      continue;
    }
    if (name === "popd") {
      // popd moves to the directory on the stack, which the fence does not track.
      here = undefined;
      unknownSeen = true;
      continue;
    }
    const body = embeddedBody(name, args);
    if (body !== undefined) bodies.push(body);
    for (const w of linkRootWords(name, args)) {
      const root = lexicalFrom(cmdDir, w);
      if (root === undefined) unnamedRoot = true;
      else roots.push(root);
    }
    if (COPY_LIKE.has(name)) {
      // A destination is the name the command creates, so it is not judged as a path a link may redirect.
      const symbolic = symlinkNames(name, args).length > 0;
      for (const t of copyLikeTargets(name, args)) {
        raw.push({ word: t, link: symbolic, creation: true, dir: cmdDir });
      }
    }
    for (const s of hardLinkSources(name, args)) raw.push({ word: s, link: false, dir: cmdDir });
    for (const t of writtenOperands(name, args)) raw.push({ word: t, link: false, dir: cmdDir });
  }
  const names = raw
    .filter((r) => r.link && r.word.text !== "")
    .map((r) => lexicalFrom(r.dir, r.word))
    .filter((p): p is string => p !== undefined);
  const ctx: LinkContext = { names, roots, unnamedRoot };
  const out: BashTarget[] = [];
  for (const r of raw) {
    const text = r.word.text;
    if (!r.word.dyn && (text === "" || text === "-" || DEVICE_SINKS.has(text))) continue;
    out.push(targetOf(r, cwd, ctx));
  }
  // A substitution is a command of its own: judged from every directory this one may run in.
  for (const sub of lexed.subs) {
    for (const dir of visited) {
      out.push(...unknownDirTargets(bashWriteTargets(sub, dir), unknownSeen));
    }
  }
  // So is a body the shell runs. A literal one is judged; a dynamic one cannot be read.
  for (const body of bodies) {
    if (body.dyn) {
      out.push(opaqueTarget(cwd, DYNAMIC_BODY_REASON));
      continue;
    }
    for (const dir of visited) {
      out.push(...unknownDirTargets(bashWriteTargets(body.text, dir), unknownSeen));
    }
  }
  return out;
}

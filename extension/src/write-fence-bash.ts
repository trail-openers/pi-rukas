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
 * checked, including those in an unquoted heredoc body (bash runs them). A
 * subshell's `cd` does not end with the subshell, so each target is judged against
 * every directory the command may have reached. `popd`, and a bare or `+N` / `-N`
 * `pushd`, leave the directory unknown: a relative target after one is refused.
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
  makesLinks,
  symlinkNames,
  writtenOperands,
} from "./write-fence-bash-writers.ts";
import { homeDir, resolveLikeOs } from "./write-fence-path.ts";

/** One path a command writes, judged against the cwd it runs in. */
export interface BashTarget {
  path: string;
  cwd: string;
  /**
   * The command also creates links whose names are not in its arguments (an
   * archive, a recursive copy). A path that does not exist yet cannot be judged.
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
  "it is relative, and an earlier command in this line (popd, or a pushd with no operand or +N / -N) left the working directory unknown, so it cannot be judged. Use an absolute path";

/** A target the walk cannot judge, with the reason. */
function opaqueTarget(cwd: string, why: string, what = "the command"): BashTarget {
  return { path: what, cwd, linkedCommand: false, throughLinks: [], opaque: why };
}

/** A word a command writes. `link`: the command makes it a symbolic link's name. `creation`: it is the name the command creates. `known`: the working directory was known where it was written. */
interface RawTarget {
  word: Word;
  link: boolean;
  known: boolean;
  creation?: boolean;
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
function resolveFromDir(here: string | undefined, w: Word): string | undefined {
  if (here === undefined && !path.isAbsolute(w.text)) return undefined;
  return resolveFrom(here ?? "/", w);
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

/** Why one raw word cannot be judged: the working directory it was written from, or the word itself. */
function opaqueFor(r: RawTarget): string | undefined {
  if (!r.known && !r.word.dyn && !path.isAbsolute(r.word.text)) return UNKNOWN_DIR_REASON;
  return opaqueReason(r.word);
}

/** The targets of one command's raw words, judged from one directory it may run in. */
function targetsFrom(raw: RawTarget[], dir: string, linksAnywhere: boolean): BashTarget[] {
  const throughLinks = raw
    .filter((r) => r.link && !r.word.dyn && r.word.text !== "")
    .map((r) => path.resolve(dir, r.word.text));
  const out: BashTarget[] = [];
  for (const r of raw) {
    const text = r.word.text;
    if (!r.word.dyn && (text === "" || text === "-" || DEVICE_SINKS.has(text))) continue;
    out.push({
      path: text,
      cwd: dir,
      linkedCommand: linksAnywhere && !r.creation,
      throughLinks,
      opaque: opaqueFor(r),
    });
  }
  return out;
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
  // Every directory the command may be in: the start, and each cd or `env -C` it reaches.
  const visited = new Set<string>([cwd]);
  // Command strings the shell runs as their own commands (`eval`, `sh -c`).
  const bodies: Word[] = [];
  // The directory the next command runs in; undefined once popd or a bare pushd has left it unknown.
  let here: string | undefined = cwd;
  // Set once any command left the directory unknown: a substitution or body may run from there.
  let unknownSeen = false;
  let linksAnywhere = false;
  for (const simple of simpleCommands(lexed.toks)) {
    const known = here !== undefined;
    for (const r of simple.redirects) raw.push({ word: r, link: false, known });
    const { words, chdir } = stripPrefix(simple.words);
    for (const dir of chdir) {
      raw.push({ word: dir, link: false, known });
      const abs = resolveFromDir(here, dir);
      if (abs !== undefined) visited.add(abs);
    }
    const first = words[0];
    if (first === undefined) continue;
    const name = commandName(first.text);
    const args = words.slice(1);
    if (name === "cd" || name === "pushd") {
      const dest =
        operands(args)[0] ?? (name === "cd" ? { text: homeDir(), dyn: false } : undefined);
      // A bare pushd swaps the top two directories, and +N / -N rotate the stack: neither names a directory the fence can read.
      if (dest === undefined || /^[+-]\d/.test(dest.text)) {
        here = undefined;
        unknownSeen = true;
        continue;
      }
      if (dest.text === "-" && !dest.dyn) continue;
      raw.push({ word: dest, link: false, known });
      const abs = resolveFromDir(here, dest);
      if (abs !== undefined) {
        here = abs;
        visited.add(abs);
      }
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
    if (makesLinks(name, args)) linksAnywhere = true;
    if (COPY_LIKE.has(name)) {
      // A destination is the name the command creates, so it is not judged as a path a link may redirect.
      const symbolic = symlinkNames(name, args).length > 0;
      for (const t of copyLikeTargets(name, args)) {
        raw.push({ word: t, link: symbolic, creation: true, known });
      }
    }
    for (const s of hardLinkSources(name, args)) raw.push({ word: s, link: false, known });
    for (const t of writtenOperands(name, args)) raw.push({ word: t, link: false, known });
  }
  const out: BashTarget[] = [];
  for (const dir of visited) out.push(...targetsFrom(raw, dir, linksAnywhere));
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

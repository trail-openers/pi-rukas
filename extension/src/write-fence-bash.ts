/**
 * write-fence-bash — the bash side of the /work write fence (#1655).
 *
 * Best-effort: it lists the paths a bash command would WRITE (or change into),
 * so write-fence.ts can judge each one with the same rule as the write tools.
 * It is not a shell. The lexer (write-fence-bash-lex.ts) keeps each word's text,
 * the splitter (write-fence-bash-split.ts) finds the simple commands, and the
 * writers (write-fence-bash-writers.ts) say what each command writes.
 *
 * Checked: output redirects (`>`, `>>`, `&>`, `>|`), `cd`, and the writes of the
 * commands in write-fence-bash-writers.ts, reached through wrappers (`env`,
 * `timeout`, `xargs`, …) and keywords (`if`, `then`, `do`, `{`). Every simple
 * command in a pipeline, chain, subshell, or `$(…)` / backtick substitution is
 * checked. A subshell's `cd` does not end with the subshell, so each target is
 * judged against every directory the command may have reached.
 *
 * A word the fence cannot resolve (a `$VAR` other than `$HOME`, a `~user`, a
 * substitution inside a path) is refused where it is written, since its path is
 * unknown. A command that does not lex is refused whole: the fence does not
 * guess its shape.
 *
 * Not checked, by design: a body handed to `sh -c`, `bash -c` or `eval` (an
 * opaque string here; the after-the-fact residue detection stays the backstop),
 * `cd -` (OLDPWD is not known statically), and a command whose NAME is itself
 * an expansion. Unknown commands are allowed.
 */

import path from "node:path";
import { type Word, lex } from "./write-fence-bash-lex.ts";
import { commandName, operands, simpleCommands, stripPrefix } from "./write-fence-bash-split.ts";
import {
  copyLikeTargets,
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

/** A word a command writes. `link`: the command makes it a symbolic link's name. `creation`: it is the name the command creates. */
interface RawTarget {
  word: Word;
  link: boolean;
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

/** Why a word cannot be judged, or undefined when it can. */
function opaqueReason(w: Word): string | undefined {
  if (w.dyn) {
    return "it uses a shell expansion the fence cannot resolve (a variable, a substitution, or ~user), so the path cannot be judged";
  }
  if (BRACE.test(w.text)) {
    return "it uses brace expansion, which the fence does not expand. Name each path literally";
  }
  return undefined;
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
      opaque: opaqueReason(r.word),
    });
  }
  return out;
}

/**
 * Every path the bash command would write or change into, each with a cwd it
 * may run under. `cwd` is the child's own working directory.
 */
export function bashWriteTargets(command: string, cwd: string): BashTarget[] {
  const lexed = lex(command);
  if (!lexed) {
    return [
      {
        path: "the command",
        cwd,
        linkedCommand: false,
        throughLinks: [],
        opaque: UNPARSEABLE_REASON,
      },
    ];
  }
  const raw: RawTarget[] = [];
  // Every directory the command may be in: the start, and each cd or `env -C` it reaches.
  const visited = new Set<string>([cwd]);
  let here = cwd;
  let linksAnywhere = false;
  for (const simple of simpleCommands(lexed.toks)) {
    for (const r of simple.redirects) raw.push({ word: r, link: false });
    const { words, chdir } = stripPrefix(simple.words);
    for (const dir of chdir) {
      raw.push({ word: dir, link: false });
      const abs = resolveFrom(here, dir);
      if (abs !== undefined) visited.add(abs);
    }
    const first = words[0];
    if (first === undefined) continue;
    const name = commandName(first.text);
    const args = words.slice(1);
    if (name === "cd") {
      const dest = operands(args)[0] ?? { text: homeDir(), dyn: false };
      if (dest.text === "-" && !dest.dyn) continue;
      raw.push({ word: dest, link: false });
      const abs = resolveFrom(here, dest);
      if (abs !== undefined) {
        here = abs;
        visited.add(abs);
      }
      continue;
    }
    if (makesLinks(name, args)) linksAnywhere = true;
    if (COPY_LIKE.has(name)) {
      // A destination is the name the command creates, so it is not judged as a path a link may redirect.
      const symbolic = symlinkNames(name, args).length > 0;
      for (const t of copyLikeTargets(name, args)) {
        raw.push({ word: t, link: symbolic, creation: true });
      }
    }
    for (const s of hardLinkSources(name, args)) raw.push({ word: s, link: false });
    for (const t of writtenOperands(name, args)) raw.push({ word: t, link: false });
  }
  const out: BashTarget[] = [];
  for (const dir of visited) out.push(...targetsFrom(raw, dir, linksAnywhere));
  // A substitution is a command of its own: judged from every directory this one may run in.
  for (const body of lexed.subs) {
    for (const dir of visited) out.push(...bashWriteTargets(body, dir));
  }
  return out;
}

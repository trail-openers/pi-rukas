/**
 * write-fence-bash — the bash side of the /work write fence (#1655).
 *
 * Best-effort: it lists the paths a bash command would WRITE (or change into),
 * so write-fence.ts can judge each one with the same rule as the write tools.
 * It is not a shell. The existing tokenisers in bash-command-parser.ts replace
 * every quoted argument with a sentinel, so they cannot yield a target; this
 * module has its own small lexer instead. Per-command meaning (which operands
 * cp, tee, sed and friends write) lives in write-fence-bash-commands.ts.
 *
 * Checked: output redirects (`>`, `>>`, `&>`, `>|`), `cd`, and the operands of
 * the commands in write-fence-bash-commands.ts, reached through wrappers
 * (`env`, `timeout`, `xargs`, …) and keywords (`if`, `then`, `do`, `{`). Every
 * simple command in a pipeline, chain, subshell or `$(…)` is checked. A
 * subshell's `cd` does not end with the subshell, so each target is judged
 * against every directory the command may have reached.
 *
 * Not checked, by design: a body handed to `sh -c`, `bash -c` or `eval` (it is
 * an opaque string here; the after-the-fact residue detection stays the
 * backstop), a `$VAR` other than `$HOME`, `cd -` (OLDPWD is not known
 * statically). A command that does not lex (an unterminated quote) yields no
 * targets, so it is allowed.
 */

import os from "node:os";
import {
  commandName,
  copyLikeTargets,
  hardLinkSources,
  makesLinks,
  operands,
  stripPrefix,
  writtenOperands,
} from "./write-fence-bash-commands.ts";
import { resolveLikeOs } from "./write-fence-path.ts";

/** One path a command writes, judged against the cwd it runs in. */
export interface BashTarget {
  path: string;
  cwd: string;
  /**
   * The command also creates a link, and this path is not that link's own
   * name. The path cannot be judged before the command runs (a link it creates
   * may change what the path resolves to), so the fence refuses it.
   */
  linkedCommand: boolean;
}

type Tok = { kind: "word"; text: string } | { kind: "op"; text: string };

/** Lexer output where a `$(`/backtick/subshell is a `;` separator. Undefined when it does not lex. */
function lex(src: string): Tok[] | undefined {
  const toks: Tok[] = [];
  const heredocs: Array<{ delim: string; strip: boolean }> = [];
  let word: string | undefined;
  let i = 0;
  const n = src.length;
  const addWord = (s: string) => {
    word = (word ?? "") + s;
  };
  const endWord = () => {
    if (word !== undefined) toks.push({ kind: "word", text: word });
    word = undefined;
  };
  const op = (text: string) => {
    endWord();
    toks.push({ kind: "op", text });
  };
  while (i < n) {
    const ch = src[i] ?? "";
    const next = src[i + 1] ?? "";
    if (ch === "\\") {
      // `\<newline>` is a line continuation: it joins nothing and is not a word break.
      if (next !== "\n") addWord(next);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return undefined;
      addWord(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // Inside double quotes only `$(` and backticks still start a command.
      word ??= "";
      i++;
      let closed = false;
      while (i < n) {
        const c = src[i] ?? "";
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "\\" && i + 1 < n) {
          const nx = src[i + 1] ?? "";
          if (nx !== "\n") addWord(nx);
          i += 2;
          continue;
        }
        if (c === "$" && src[i + 1] === "(") {
          op(";");
          i += 2;
          continue;
        }
        if (c === "`") {
          op(";");
          i++;
          continue;
        }
        addWord(c);
        i++;
      }
      if (!closed) return undefined;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      i++;
      continue;
    }
    if (ch === "\n") {
      op("\n");
      i++;
      // A heredoc body runs from the line after its operator to the delimiter line; it is data, not commands.
      for (const doc of heredocs.splice(0)) {
        while (i < n) {
          const eol = src.indexOf("\n", i);
          const line = src.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        }
      }
      continue;
    }
    if (ch === "#" && word === undefined) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (ch === "&" && next === "&") {
      op("&&");
      i += 2;
      continue;
    }
    if (ch === "|" && next === "|") {
      op("||");
      i += 2;
      continue;
    }
    if (ch === "|") {
      op("|");
      i += next === "&" ? 2 : 1;
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      op(";");
      i++;
      continue;
    }
    if (ch === "$" && next === "(") {
      op(";");
      i += 2;
      continue;
    }
    if (ch === "`") {
      op(";");
      i++;
      continue;
    }
    if (ch === "&" && next === ">") {
      // `&>file` and `&>>file` write the file.
      const append = src[i + 2] === ">";
      op(">");
      i += append ? 3 : 2;
      continue;
    }
    if (ch === "&") {
      op("&");
      i++;
      continue;
    }
    if (ch === ">") {
      // A bare fd number before `>` (`2>file`) is the redirect's fd, not an argument.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      if (next === "&") {
        // `>&N` / `>&-` duplicate a descriptor; `>&file` writes the file.
        const after = src[i + 2] ?? "";
        if (/[\d-]/.test(after)) {
          op("dup");
          i += 2;
        } else {
          op(">");
          i += 2;
        }
        continue;
      }
      op(">");
      i += next === ">" || next === "|" ? 2 : 1;
      continue;
    }
    if (ch === "<") {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      if (next === "<" && src[i + 2] === "<") {
        op("<");
        i += 3;
        continue;
      }
      if (next === "<") {
        // A heredoc: the delimiter word is consumed here so it is not read as a command.
        let j = i + 2;
        const strip = src[j] === "-";
        if (strip) j++;
        while (src[j] === " " || src[j] === "\t") j++;
        let delim = "";
        while (j < n && !/[\s;&|()<>]/.test(src[j] ?? "")) {
          const c = src[j] ?? "";
          if (c === '"' || c === "'") {
            const close = src.indexOf(c, j + 1);
            if (close < 0) return undefined;
            delim += src.slice(j + 1, close);
            j = close + 1;
            continue;
          }
          if (c !== "\\") delim += c;
          j++;
        }
        heredocs.push({ delim, strip });
        op("<<");
        i = j;
        continue;
      }
      op("<");
      i++;
      continue;
    }
    addWord(ch);
    i++;
  }
  endWord();
  return toks;
}

/** A simple command: its words (assignments and wrappers not yet stripped) and its redirect targets. */
interface Simple {
  words: string[];
  redirects: string[];
}

/** Split the token stream at separators, collecting each command's redirect targets. */
function simpleCommands(toks: Tok[]): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], redirects: [] };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!t) continue;
    if (t.kind === "word") {
      cur.words.push(t.text);
      continue;
    }
    if (t.text === ">" || t.text === "<" || t.text === "dup") {
      // A redirect consumes the next word: its target for `>`, a discarded operand otherwise.
      const nx = toks[k + 1];
      if (nx?.kind === "word") {
        k++;
        if (t.text === ">") cur.redirects.push(nx.text);
      }
      continue;
    }
    if (t.text === "<<") continue;
    out.push(cur);
    cur = { words: [], redirects: [] };
  }
  out.push(cur);
  return out;
}

/** Redirect targets that are never a file write. */
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** `~` and a leading `$HOME` are the only expansions resolved statically. */
function expandHome(p: string): string {
  const home = os.homedir();
  if (p === "~" || p.startsWith("~/")) return home + p.slice(1);
  if (p.startsWith("$HOME/") || p === "$HOME") return home + p.slice("$HOME".length);
  if (p.startsWith("${HOME}")) return home + p.slice("${HOME}".length);
  return p;
}

/** Resolve `p` from `base`, or undefined when it cannot be resolved (a symlink loop). */
function resolveFrom(base: string, p: string): string | undefined {
  try {
    return resolveLikeOs(p.startsWith("/") ? p : `${base}/${p}`);
  } catch {
    return undefined;
  }
}

/** A path the command names, before it is judged against every cwd the command may reach. */
interface RawTarget {
  path: string;
  /** The path is the name of a link this command creates: not judged as a link-dependent write. */
  creation: boolean;
}

/**
 * Every path the bash command would write or change into, each with a cwd it
 * may run under. `cwd` is the child's own working directory.
 */
export function bashWriteTargets(command: string, cwd: string): BashTarget[] {
  const toks = lex(command);
  if (!toks) return [];
  const raw: RawTarget[] = [];
  // Every directory the command may be in: the start, and each cd or `env -C` it reaches.
  // A subshell's cd does not end with the subshell, so no single cwd is the true one.
  const visited = new Set<string>([cwd]);
  let here = cwd;
  let linksMade = false;
  for (const simple of simpleCommands(toks)) {
    for (const r of simple.redirects) raw.push({ path: expandHome(r), creation: false });
    const { words, chdir } = stripPrefix(simple.words);
    for (const dir of chdir) {
      raw.push({ path: expandHome(dir), creation: false });
      const abs = resolveFrom(here, expandHome(dir));
      if (abs !== undefined) visited.add(abs);
    }
    const first = words[0];
    if (first === undefined) continue;
    const name = commandName(first);
    const args = words.slice(1);
    if (name === "cd") {
      const dest = expandHome(operands(args)[0] ?? "~");
      if (dest === "-") continue;
      raw.push({ path: dest, creation: false });
      const abs = resolveFrom(here, dest);
      if (abs !== undefined) {
        here = abs;
        visited.add(abs);
      }
      continue;
    }
    if (makesLinks(name, args)) linksMade = true;
    if (name === "cp" || name === "mv" || name === "install" || name === "ln" || name === "link") {
      const creation = makesLinks(name, args);
      for (const t of copyLikeTargets(name, args)) {
        raw.push({ path: expandHome(t), creation });
      }
    }
    for (const s of hardLinkSources(name, args)) raw.push({ path: expandHome(s), creation: false });
    for (const t of writtenOperands(name, args)) raw.push({ path: expandHome(t), creation: false });
  }
  const out: BashTarget[] = [];
  for (const r of raw) {
    if (r.path === "" || DEVICE_SINKS.has(r.path)) continue;
    for (const dir of visited) {
      out.push({
        path: r.path,
        cwd: dir,
        linkedCommand: linksMade && !r.creation,
      });
    }
  }
  return out;
}

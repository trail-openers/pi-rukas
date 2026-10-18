/**
 * write-fence-bash — the bash side of the /work write fence (#1655).
 *
 * Best-effort: it lists the paths a bash command would WRITE (or change into),
 * so write-fence.ts can judge each one with the same rule as the write tools.
 * It is not a shell. The existing tokenisers in bash-command-parser.ts replace
 * every quoted argument with a sentinel, so they cannot yield a target; this
 * module has its own small lexer instead.
 *
 * Checked: output redirects (`>`, `>>`, `&>`, `>|`), `cd`, and the operands that
 * name a file a command writes, moves or removes (cp/mv/install/ln, tee, touch,
 * mkdir, rm/rmdir, sed/perl -i, `git -C` / `--git-dir` / `--work-tree`).
 * Every simple command in a pipeline, chain, subshell or `$(…)` is checked.
 *
 * Not checked, by design: a body handed to `sh -c`, `bash -c` or `eval` (it is
 * an opaque string here; the after-the-fact residue detection stays the
 * backstop), a `$VAR` other than `$HOME`, `cd -` (OLDPWD is not known
 * statically), and `dd of=` (not in the checked set). A command that does not lex (an unterminated quote) yields no
 * targets, so it is allowed.
 */

import os from "node:os";
import { resolveLikeOs } from "./write-fence-path.ts";

/** One path a command writes, judged against the cwd it runs in. */
export interface BashTarget {
  path: string;
  cwd: string;
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

/** Shell-level names that run their operand as the command: skipped to reach the real one. */
const WRAPPERS = new Set(["env", "nohup", "exec", "command", "builtin", "time", "!"]);

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

/** Non-option operands: `--` ends the options and `-` alone is stdin/stdout. */
function operands(args: string[]): string[] {
  const out: string[] = [];
  let optionsOver = false;
  for (const a of args) {
    if (!optionsOver && a === "--") {
      optionsOver = true;
      continue;
    }
    if (!optionsOver && a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

/** The value of `-t DIR` / `--target-directory=DIR`, when present. */
function targetDirectory(args: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "-t" || a === "--target-directory") return args[k + 1];
    if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
  }
  return undefined;
}

/** Targets of cp / mv / install / ln: the destination, or every operand when moving or creating directories. */
function copyLikeTargets(name: string, args: string[]): string[] {
  const ops = operands(args);
  const dir = targetDirectory(args);
  if (dir !== undefined) {
    // With -t the operands are sources: mv removes them, so they are writes too; cp, install and ln only read them.
    return name === "mv" ? [dir, ...ops] : [dir];
  }
  if (name === "mv") return ops;
  if (name === "install" && args.some((a) => /^-[A-Za-z]*d/.test(a) || a === "--directory")) {
    return ops;
  }
  const last = ops[ops.length - 1];
  return last === undefined ? [] : [last];
}

/** `sed -i` / `perl -i`: the files are the operands after the script (or all of them under -e/-f). */
function inPlaceTargets(args: string[]): string[] {
  const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"));
  if (!inPlace) return [];
  const files: string[] = [];
  let scriptGiven = false;
  const positional: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (
      a === "-e" ||
      a === "-f" ||
      a === "--expression" ||
      a === "--file" ||
      /^-[A-Za-z]*[ef]$/.test(a)
    ) {
      scriptGiven = true;
      k++;
      continue;
    }
    if (a.startsWith("-") && a !== "-") continue;
    positional.push(a);
  }
  files.push(...(scriptGiven ? positional : positional.slice(1)));
  return files;
}

/** `git -C DIR`, `--git-dir=DIR`, `--work-tree=DIR` — the global options that point git at another tree. */
function gitTreeTargets(args: string[]): string[] {
  const out: string[] = [];
  let k = 0;
  while (k < args.length && (args[k] ?? "").startsWith("-")) {
    const a = args[k] ?? "";
    if (a === "-C") {
      if (args[k + 1] !== undefined) out.push(args[k + 1] ?? "");
      k += 2;
      continue;
    }
    if (a === "-c") {
      k += 2;
      continue;
    }
    for (const flag of ["--git-dir", "--work-tree"]) {
      if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
      else if (a === flag && args[k + 1] !== undefined) out.push(args[k + 1] ?? "");
    }
    k++;
  }
  return out;
}

/** Names a command as the basename of its path (`/bin/cp` is `cp`). */
function commandName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/**
 * Every path the bash command would write or change into, in source order,
 * each with the cwd it runs under. `cwd` is the child's own working directory.
 */
export function bashWriteTargets(command: string, cwd: string): BashTarget[] {
  const toks = lex(command);
  if (!toks) return [];
  const out: BashTarget[] = [];
  let here = cwd;
  for (const simple of simpleCommands(toks)) {
    const push = (p: string) => {
      const target = expandHome(p);
      if (target !== "" && !DEVICE_SINKS.has(target)) out.push({ path: target, cwd: here });
    };
    for (const r of simple.redirects) push(r);
    let words = simple.words;
    while (
      words.length > 0 &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "") || WRAPPERS.has(words[0] ?? ""))
    ) {
      words = words.slice(1);
    }
    const first = words[0];
    if (first === undefined) continue;
    const name = commandName(first);
    const args = words.slice(1);
    if (name === "cd") {
      const dest = operands(args)[0] ?? "~";
      if (dest === "-") continue;
      const target = expandHome(dest);
      out.push({ path: target, cwd: here });
      try {
        here = resolveLikeOs(target.startsWith("/") ? target : `${here}/${target}`);
      } catch {
        // An unresolvable cd is refused by the target just pushed; the cwd after it is moot.
      }
      continue;
    }
    if (name === "cp" || name === "mv" || name === "install" || name === "ln") {
      for (const t of copyLikeTargets(name, args)) push(t);
    } else if (
      name === "tee" ||
      name === "touch" ||
      name === "mkdir" ||
      name === "rm" ||
      name === "rmdir"
    ) {
      for (const t of operands(args)) push(t);
    } else if (name === "sed" || name === "perl") {
      for (const t of inPlaceTargets(args)) push(t);
    } else if (name === "git") {
      for (const t of gitTreeTargets(args)) push(t);
    }
  }
  return out;
}

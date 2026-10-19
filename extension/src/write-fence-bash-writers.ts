/**
 * write-fence-bash-writers — what each known command writes, moves, removes or
 * links (#1655): which operands it writes, which names it creates as symbolic
 * links, and which it reads only.
 *
 * write-fence-bash.ts owns the walk over the commands; this module owns the
 * per-command meaning (git is in write-fence-bash-git.ts). Best-effort by design:
 * an unrecognised command contributes no targets, and the gaps are listed in
 * docs/troubleshooting.md.
 */

import { gitTargets } from "./write-fence-bash-git.ts";
import type { Word } from "./write-fence-bash-lex.ts";
import { operands, operandsWith, optionValues } from "./write-fence-bash-split.ts";

/** `.`: the working directory, for a tool that writes into it when given no directory. */
const DOT: Word = { text: ".", dyn: false };

/** Shells whose `-c` argument is a command string the shell then runs as its own. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * The command text a command runs as a body of its own: `eval`'s words, joined as
 * the shell joins them, or a shell's `-c` argument. Undefined when it runs none.
 * The body is read by the caller as a command, so its own writes are judged.
 */
export function embeddedBody(name: string, args: Word[]): Word | undefined {
  if (name === "eval") {
    return args.length === 0
      ? undefined
      : { text: args.map((a) => a.text).join(" "), dyn: args.some((a) => a.dyn) };
  }
  if (!SHELLS.has(name)) return undefined;
  const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
  return k < 0 ? undefined : args[k + 1];
}

/** Options of `cp`/`mv`/`install`/`ln` that take the destination directory as their value. */
const TARGET_DIR_OPTIONS = ["-t", "--target-directory"];

/** `cp` options that copy a symbolic link as a link (recursive, archive, no-dereference). */
const COPY_LINKS_LONG = new Set(["--recursive", "--archive", "--no-dereference"]);

/** The destination directory of `-t DIR` / `--target-directory=DIR`, when present. */
function targetDirectory(args: Word[]): Word | undefined {
  return optionValues(args, TARGET_DIR_OPTIONS)[0];
}

/** Targets of cp / mv / install / ln / link: the destination, or every operand when moving or creating directories. */
export function copyLikeTargets(name: string, args: Word[]): Word[] {
  const dir = targetDirectory(args);
  if (dir !== undefined) {
    // With -t the operands are sources: mv removes them, so they are writes too; cp, install and ln only read them.
    const sources = operandsWith(args, TARGET_DIR_OPTIONS);
    return name === "mv" ? [dir, ...sources] : [dir];
  }
  const ops = operands(args);
  if (name === "mv") return ops;
  if (
    name === "install" &&
    args.some((a) => /^-[A-Za-z]*d/.test(a.text) || a.text === "--directory")
  ) {
    return ops;
  }
  const last = ops[ops.length - 1];
  return last === undefined ? [] : [last];
}

/**
 * The operands a hard link would share an inode with: the existing file that
 * `ln` (without -s), `link` or `cp -l` names before the new name. Refused when
 * the source is outside the root, because the new name would write to it.
 */
export function hardLinkSources(name: string, args: Word[]): Word[] {
  const hard =
    (name === "ln" && !args.some((a) => a.text === "--symbolic" || /^-[^-]*s/.test(a.text))) ||
    name === "link" ||
    (name === "cp" && args.some((a) => a.text === "--link" || /^-[^-]*l/.test(a.text)));
  if (!hard) return [];
  return targetDirectory(args) !== undefined
    ? operandsWith(args, TARGET_DIR_OPTIONS)
    : operands(args).slice(0, -1);
}

/**
 * The names a command creates as SYMBOLIC links (`ln -s`, `cp -s`). A path under
 * one of them, written later in the same command, cannot be judged before the
 * link exists, so the walk refuses it.
 */
export function symlinkNames(name: string, args: Word[]): Word[] {
  if (name === "ln" && args.some((a) => a.text === "--symbolic" || /^-[^-]*s/.test(a.text))) {
    return copyLikeTargets(name, args);
  }
  if (name === "cp" && args.some((a) => a.text === "--symbolic-link" || /^-[^-]*s/.test(a.text))) {
    return copyLikeTargets(name, args);
  }
  return [];
}

/**
 * The directories a command may create symbolic links in under names its
 * arguments do not give: an extraction or sync INTO a path (tar -x, unzip, pax
 * -r, rsync), or a copy that keeps links (cp -R/-a/-P, ditto). A path under one
 * of them that does not exist yet cannot be judged before the command runs.
 * Empty for a command that creates no such link: an archive written, a link named.
 */
export function linkRootWords(name: string, args: Word[]): Word[] {
  switch (name) {
    case "tar":
    case "bsdtar":
      return tarTargets(args);
    case "unzip":
      return unzipTargets(args);
    case "pax":
      return args.some((a) => /^-[^-]*r/.test(a.text)) ? [DOT] : [];
    case "rsync":
    case "ditto": {
      const ops = operands(args);
      const dest = ops[ops.length - 1];
      return ops.length >= 2 && dest !== undefined ? [dest] : [];
    }
    case "cp":
      return args.some((a) => /^-[^-]*[rRadP]/.test(a.text) || COPY_LINKS_LONG.has(a.text))
        ? copyLikeTargets(name, args)
        : [];
    default:
      return [];
  }
}

/** `sed -i` / `perl -i`: the files are the operands after the script (or all of them under -e/-f). */
function inPlaceTargets(args: Word[]): Word[] {
  const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a.text) || a.text.startsWith("--in-place"));
  if (!inPlace) return [];
  let scriptGiven = false;
  const positional: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined) continue;
    if (
      a.text === "-e" ||
      a.text === "-f" ||
      a.text === "--expression" ||
      a.text === "--file" ||
      /^-[A-Za-z]*[ef]$/.test(a.text)
    ) {
      scriptGiven = true;
      k++;
      continue;
    }
    if (a.text.startsWith("-") && a.text !== "-") continue;
    positional.push(a);
  }
  return scriptGiven ? positional : positional.slice(1);
}

/** `chmod`, `chown`, `chgrp`: every operand but the mode or owner, unless a reference file supplies it. */
function modeTargets(args: Word[]): Word[] {
  const ops = operands(args);
  return args.some((a) => a.text.startsWith("--reference")) ? ops : ops.slice(1);
}

/** `tar`: an extraction writes into `-C DIR` (or the working directory). Creating an archive writes nothing. */
function tarTargets(args: Word[]): Word[] {
  const extracts = args.some(
    (a) =>
      a.text === "--extract" ||
      a.text === "--get" ||
      (!a.text.startsWith("--") && /^-?[A-Za-z]+$/.test(a.text) && a.text.includes("x")),
  );
  if (!extracts) return [];
  const dirs = optionValues(args, ["-C", "--directory"]);
  return dirs.length > 0 ? dirs : [DOT];
}

/** `unzip`: extraction writes into `-d DIR` (or the working directory); a listing writes nothing. */
function unzipTargets(args: Word[]): Word[] {
  if (args.some((a) => ["-l", "-t", "-Z", "-v"].includes(a.text))) return [];
  const dirs = optionValues(args, ["-d"]);
  return dirs.length > 0 ? dirs : [DOT];
}

/**
 * `find`: `-delete` removes the start paths (or the working directory when there
 * are none), and `-fprint`-family actions write their file operand.
 */
function findTargets(args: Word[]): Word[] {
  let from = 0;
  while (from < args.length && /^-[HLP]$/.test(args[from]?.text ?? "")) from++;
  let to = from;
  while (to < args.length && !/^[-(!]/.test(args[to]?.text ?? "")) to++;
  const starts = args.slice(from, to);
  const expr = args.slice(to);
  const out: Word[] = [];
  if (expr.some((a) => a.text === "-delete")) out.push(...(starts.length > 0 ? starts : [DOT]));
  expr.forEach((a, i) => {
    const file = expr[i + 1];
    if (file !== undefined && ["-fprint", "-fprint0", "-fls", "-fprintf"].includes(a.text)) {
      out.push(file);
    }
  });
  return out;
}

/** The file operands a command writes, removes or changes in place. Empty for commands not listed. */
export function writtenOperands(name: string, args: Word[]): Word[] {
  switch (name) {
    case "tee":
    case "touch":
    case "mkdir":
    case "rm":
    case "rmdir":
      return operands(args);
    case "sed":
    case "perl":
      return inPlaceTargets(args);
    case "git":
      return gitTargets(args);
    case "dd":
      return args
        .filter((a) => a.text.startsWith("of="))
        .map((a) => ({ text: a.text.slice(3), dyn: a.dyn }));
    case "truncate":
      return operandsWith(args, ["-s", "--size", "-r", "--reference"]);
    case "chmod":
    case "chown":
    case "chgrp":
      return modeTargets(args);
    case "curl":
      return [
        ...optionValues(args, ["-o", "--output"]),
        ...(args.some((a) => a.text === "-O" || a.text === "--remote-name") ? [DOT] : []),
      ];
    case "wget": {
      const outs = optionValues(args, ["-O", "--output-document"]);
      const dirs = optionValues(args, ["-P", "--directory-prefix"]);
      return [...outs, ...dirs, ...(outs.length === 0 && dirs.length === 0 ? [DOT] : [])];
    }
    case "tar":
      return tarTargets(args);
    case "unzip":
      return unzipTargets(args);
    case "find":
      return findTargets(args);
    case "sort":
      return optionValues(args, ["-o", "--output"]);
    case "go": {
      const sub = args[0]?.text;
      return sub === "build" || sub === "install" ? optionValues(args.slice(1), ["-o"]) : [];
    }
    case "rsync": {
      const ops = operands(args);
      const dest = ops[ops.length - 1];
      return ops.length >= 2 && dest !== undefined ? [dest] : [];
    }
    default:
      return [];
  }
}

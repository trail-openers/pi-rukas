/**
 * write-fence-bash-git — what a `git` command writes (#1655).
 *
 * The trees a write-capable subcommand points at (`-C`, `--git-dir`,
 * `--work-tree`), the files it writes (`config --file`, the directory `clone`
 * and `init` create), and the files ANY subcommand writes when given an output
 * option (`diff --output`, `format-patch -o`, `archive -o`, `bundle create`).
 * A read-only subcommand writes nothing else, wherever it points: `git -C /repo
 * log` is not a write (review finding D). A `config` write with no `--file`
 * writes the repo's shared config, which is refused outright; `--global` and
 * `--system` writes are outside the repo and are not judged here.
 */

import type { Word } from "./write-fence-bash-lex.ts";
import { operands, operandsWith, optionValues } from "./write-fence-bash-split.ts";

/** Why a `git config` write without `--file` is refused: its target is the repo's shared config, which the fence cannot name. */
const SHARED_CONFIG_REFUSAL =
  "git config without --file writes the repository's shared config, which is outside the write root. Name the file with --file";

/** `git config` modes that write: an edit, an add, an unset, a replace, or a section change. */
const CONFIG_WRITE_MODES = [
  "--add",
  "--unset",
  "--unset-all",
  "--replace-all",
  "--remove-section",
  "--rename-section",
  "--edit",
  "-e",
];

/** `git config` modes that only read. */
const CONFIG_READ_MODES = [
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "--list",
  "-l",
];

/** Scopes and sources that are not the repo's shared config: a file the fence judges as a path, `--global` / `--system` (outside the repo, not this fence's concern), and `--blob` (read-only). */
const CONFIG_NOT_SHARED = ["--global", "--system", "--file", "-f", "--blob"];

/** `git config` options that take a separate value, so the value is not a key or a value operand. */
const CONFIG_VALUED = ["--type", "--default", "--comment", "--file", "-f", "--blob"];

/** Whether `args` carries `name`, as `--name` or `--name=value`. */
function hasOption(args: Word[], name: string): boolean {
  return args.some(
    (a) => a.text === name || (name.startsWith("--") && a.text.startsWith(`${name}=`)),
  );
}

/**
 * Whether a `git config` invocation writes the repo's shared config: a write mode, or a
 * key and a value, with no scope or file that names another target. Read forms pass.
 */
function configWritesShared(rest: Word[]): boolean {
  if (CONFIG_NOT_SHARED.some((f) => hasOption(rest, f))) return false;
  if (CONFIG_WRITE_MODES.some((f) => hasOption(rest, f))) return true;
  if (CONFIG_READ_MODES.some((f) => hasOption(rest, f))) return false;
  return operandsWith(rest, CONFIG_VALUED).length >= 2;
}

/** Git subcommands that only read. A `git -C <dir>` running one of these writes nothing. */
const READ_ONLY_GIT = new Set([
  "log",
  "status",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "cat-file",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "ls-tree",
  "rev-list",
  "name-rev",
  "show-ref",
]);

/** The files a subcommand writes through an output option, read-only or not. */
function outputFiles(sub: string, rest: Word[]): Word[] {
  switch (sub) {
    case "diff":
    case "show":
    case "log":
    case "whatchanged":
      return optionValues(rest, ["--output"]);
    case "format-patch":
      return optionValues(rest, ["-o", "--output-directory", "--output"]);
    case "archive":
      return optionValues(rest, ["-o", "--output"]);
    case "bundle": {
      const ops = operands(rest);
      return ops[0]?.text === "create" && ops[1] !== undefined ? [ops[1]] : [];
    }
    default:
      return [];
  }
}

/** The directory git runs in: each `-C` applied in turn, as git applies them. */
function gitDirectory(dirs: Word[]): Word | undefined {
  let base: Word | undefined;
  for (const d of dirs) {
    base =
      base === undefined || d.text.startsWith("/")
        ? d
        : { text: `${base.text}/${d.text}`, dyn: base.dyn || d.dyn };
  }
  return base;
}

/** A path git writes, named relative to the directory git ran in (the `-C` it was given). */
function inGitDir(w: Word, base: Word | undefined): Word {
  if (base === undefined || w.text.startsWith("/")) return w;
  return { text: `${base.text}/${w.text}`, dyn: base.dyn || w.dyn, glob: w.glob };
}

/** The paths a `git` invocation writes. A read-only subcommand writes only what an output option names. */
export function gitTargets(args: Word[]): Word[] {
  const trees: Word[] = [];
  const dirs: Word[] = [];
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a === undefined) break;
    if (a.text === "-C" || a.text === "--git-dir" || a.text === "--work-tree") {
      const dir = args[k + 1];
      if (dir !== undefined) {
        trees.push(dir);
        if (a.text === "-C") dirs.push(dir);
      }
      k += 2;
      continue;
    }
    if (a.text.startsWith("-C") && a.text.length > 2) {
      // `-C<dir>`: the directory attached to the option.
      const dir = { text: a.text.slice(2), dyn: a.dyn };
      trees.push(dir);
      dirs.push(dir);
      k++;
      continue;
    }
    if (a.text.startsWith("--git-dir=") || a.text.startsWith("--work-tree=")) {
      trees.push({ text: a.text.slice(a.text.indexOf("=") + 1), dyn: a.dyn });
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
  const sub = args[k]?.text;
  if (sub === undefined) return [];
  const rest = args.slice(k + 1);
  const base = gitDirectory(dirs);
  const outs = outputFiles(sub, rest).map((w) => inGitDir(w, base));
  if (READ_ONLY_GIT.has(sub)) return outs;
  const out = [...trees, ...outs];
  if (sub === "config") {
    out.push(...optionValues(rest, ["--file", "-f"]).map((w) => inGitDir(w, base)));
    if (configWritesShared(rest)) {
      out.push({ text: "git config", dyn: false, refusal: SHARED_CONFIG_REFUSAL });
    }
  }
  const ops = operands(rest);
  const last = ops[ops.length - 1];
  const creates = (sub === "clone" && ops.length >= 2) || (sub === "init" && ops.length >= 1);
  if (last !== undefined && creates) out.push(inGitDir(last, base));
  return out;
}

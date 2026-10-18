/**
 * write-fence-bash-git — what a `git` command writes (#1655).
 *
 * The trees a write-capable subcommand points at (`-C`, `--git-dir`,
 * `--work-tree`), and the files it writes (`config --file`, the directory `clone`
 * and `init` create). A read-only subcommand writes nothing, wherever it points:
 * `git -C /repo log` is not a write (review finding D).
 */

import type { Word } from "./write-fence-bash-lex.ts";
import { operands, optionValues } from "./write-fence-bash-split.ts";

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

/** The paths a write-capable `git` invocation writes, or none for a read-only subcommand. */
export function gitTargets(args: Word[]): Word[] {
  const trees: Word[] = [];
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a === undefined) break;
    if (a.text === "-C" || a.text === "--git-dir" || a.text === "--work-tree") {
      const dir = args[k + 1];
      if (dir !== undefined) trees.push(dir);
      k += 2;
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
  if (sub === undefined || READ_ONLY_GIT.has(sub)) return [];
  const rest = args.slice(k + 1);
  const out = [...trees];
  if (sub === "config") out.push(...optionValues(rest, ["--file", "-f"]));
  const ops = operands(rest);
  const last = ops[ops.length - 1];
  const creates = (sub === "clone" && ops.length >= 2) || (sub === "init" && ops.length >= 1);
  if (last !== undefined && creates) out.push(last);
  return out;
}

/**
 * write-fence-bash-commands — what each known command does to the filesystem
 * (#1655): which operands it writes, moves, removes, or links, and which
 * keywords and wrapper commands sit in front of it.
 *
 * write-fence-bash.ts owns the lexer and the statement walk; this module owns
 * the per-command meaning. Everything here is best-effort by design: an
 * unrecognised command contributes no targets.
 */

/** Shell keywords that precede a simple command without being the command. */
const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "{",
  "}",
  "!",
  "time",
]);

/** Commands that run their operand as the command. Their own options are skipped to reach it. */
const WRAPPERS = new Set([
  "env",
  "nohup",
  "exec",
  "command",
  "builtin",
  "nice",
  "ionice",
  "timeout",
  "xargs",
  "stdbuf",
]);

/** Options of each wrapper that take a separate value (`nice -n 5`, `timeout -s KILL`). */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-S", "--split-string"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: [
    "-I",
    "-n",
    "-P",
    "-L",
    "-d",
    "-E",
    "-s",
    "-a",
    "--max-args",
    "--max-procs",
    "--max-lines",
    "--delimiter",
    "--arg-file",
  ],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/** A simple command with its keywords, assignments and wrappers removed, and any `env -C` directories. */
export interface Prefixed {
  words: string[];
  chdir: string[];
}

/** The basename of a command word (`/bin/cp` is `cp`). */
export function commandName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Skip the options (and any value or duration) a wrapper takes before the command it runs. */
function wrapperArgCount(name: string, args: string[], chdir: string[]): number {
  const valued = VALUE_OPTIONS[name] ?? [];
  let k = 0;
  while (k < args.length) {
    const a = args[k] ?? "";
    if (name === "env" && ASSIGNMENT.test(a)) {
      k++;
      continue;
    }
    if (a === "--") {
      k++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    if (name === "env" && (a === "-C" || a === "--chdir")) {
      chdir.push(args[k + 1] ?? "");
      k += 2;
      continue;
    }
    if (name === "env" && a.startsWith("--chdir=")) {
      chdir.push(a.slice("--chdir=".length));
      k++;
      continue;
    }
    k += valued.includes(a) ? 2 : 1;
  }
  if (name === "timeout" && DURATION.test(args[k] ?? "")) k++;
  return k;
}

/** Strip keywords, assignments and wrapper commands from the front of a simple command. */
export function stripPrefix(words: string[]): Prefixed {
  const chdir: string[] = [];
  let w = words;
  for (;;) {
    const head = w[0];
    if (head === undefined) break;
    if (ASSIGNMENT.test(head) || KEYWORDS.has(head)) {
      w = w.slice(1);
      continue;
    }
    const name = commandName(head);
    if (!WRAPPERS.has(name)) break;
    w = w.slice(1 + wrapperArgCount(name, w.slice(1), chdir));
  }
  return { words: w, chdir };
}

/** Non-option operands: `--` ends the options and `-` alone is stdin/stdout. */
export function operands(args: string[]): string[] {
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

/** Targets of cp / mv / install / ln / link: the destination, or every operand when moving or creating directories. */
export function copyLikeTargets(name: string, args: string[]): string[] {
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

/**
 * The operands a hard link would share an inode with: the existing file that
 * `ln` (without -s), `link` or `cp -l` names before the new name. Refused when
 * the source is outside the root, because the new name would write to it.
 */
export function hardLinkSources(name: string, args: string[]): string[] {
  const hard =
    (name === "ln" && !args.some((a) => a === "--symbolic" || /^-[^-]*s/.test(a))) ||
    name === "link" ||
    (name === "cp" && args.some((a) => a === "--link" || /^-[^-]*l/.test(a)));
  if (!hard) return [];
  return targetDirectory(args) !== undefined ? operands(args) : operands(args).slice(0, -1);
}

const LINK_LONG = new Set([
  "--recursive",
  "--archive",
  "--link",
  "--symbolic-link",
  "--no-dereference",
]);
const LINK_TOOLS = new Set(["ln", "link", "tar", "bsdtar", "rsync", "unzip", "ditto", "pax"]);

/**
 * True when the command can create a link (symbolic or hard), or copy one
 * unchanged. Such a command makes a path's resolution differ from its lexical
 * reading, so a write under the links it creates cannot be judged in advance.
 */
export function makesLinks(name: string, args: string[]): boolean {
  if (LINK_TOOLS.has(name)) return true;
  if (name !== "cp") return false;
  return args.some((a) => /^-[^-]*[rRadPsl]/.test(a) || LINK_LONG.has(a));
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
export function gitTreeTargets(args: string[]): string[] {
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

/** The file operands a command writes, removes or changes in place. Empty for commands not listed. */
export function writtenOperands(name: string, args: string[]): string[] {
  if (name === "tee" || name === "touch" || name === "mkdir" || name === "rm" || name === "rmdir") {
    return operands(args);
  }
  if (name === "sed" || name === "perl") return inPlaceTargets(args);
  if (name === "git") return gitTreeTargets(args);
  return [];
}

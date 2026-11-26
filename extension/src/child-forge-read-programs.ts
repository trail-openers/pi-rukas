/**
 * child-forge-read-programs.ts — the part of the #2638 read rule that reads a
 * command's ARGUMENTS AS TEXT rather than as paths.
 *
 * Two shapes defeat the word-by-word judge in `child-forge-read-judge.ts`, and
 * neither is a path the shell opens:
 *
 *  - a COPY verb whose SOURCE is an ANCESTOR of a protected root
 *    (`tar czf a.tgz <home>/.config`, `cp -r <home>/.config /tmp`). No protected
 *    path is named anywhere; the credential tree is carried out by containment.
 *    The verb decides which operands are sources, because `cp` ends its copy with
 *    a destination and `tar` ends an archive with a member.
 *  - an INTERPRETER's program word (`python3 -c 'open("<F>")'`,
 *    `awk 'BEGIN{while((getline l < "<F>")>0)}'`, a here-string fed to `tclsh`).
 *    The paths live inside a string the interpreter will act on, so the word is
 *    judged as text and every path-shaped run in it is asked the same question.
 *
 * Both need the judge's own path primitives, so this module imports them rather
 * than restating a second matcher that can drift from the first.
 */

import {
  type ForgeReadHit,
  type ProtectedDir,
  formsOf,
  hits,
  isKeyValue,
  isUnder,
  rootsOf,
  untrail,
} from "./child-forge-read-words.ts";
import type { Word } from "./write-fence-bash-lex.ts";
import { commandName } from "./write-fence-bash-split.ts";

/** The words of a command that COPY a tree: the verbs whose SOURCE operands are read. */
const COPY_LIKE = new Set(["tar", "bsdtar", "star", "cp", "rsync", "ditto", "scp", "rcp", "pax"]);

/** True for the archivers, which name their MEMBERS as operands and their archive as an option. */
function isArchiver(name: string): boolean {
  return name === "tar" || name === "bsdtar" || name === "star";
}

/**
 * The options of each copy verb whose next word is that option's VALUE, checked
 * per verb because one name means different things to two of them: `--file` is
 * `tar`'s ARCHIVE and `git config`'s credential file, and a single table would
 * either swallow `git config`'s value before the option-value rule ever saw it or
 * treat `tar`'s archive as a source and refuse every ordinary backup.
 */
const COPY_VALUE_OPTIONS: Record<string, readonly string[]> = {
  tar: [
    "-C",
    "--directory",
    "-f",
    "--file",
    "-T",
    "--files-from",
    "--exclude-from",
    "-b",
    "--backup",
    "--backup-dir",
    "--suffix",
  ],
  cp: ["-t", "--target-directory", "--backup", "--suffix", "-b"],
  rsync: [
    "-e",
    "--rsh",
    "--rsync-path",
    "--files-from",
    "--exclude-from",
    "--backup-dir",
    "--suffix",
    "-b",
    "--max-size",
    "--max-verify",
  ],
  scp: ["-P", "-i", "-l", "-o"],
  ditto: [],
  pax: ["-x"],
};

/** The value-taking options of one copy verb (`tar` covers its three spellings). */
function copyValueOptions(name: string): readonly string[] {
  if (isArchiver(name)) return COPY_VALUE_OPTIONS.tar ?? [];
  return COPY_VALUE_OPTIONS[name] ?? [];
}

/**
 * The words of one copy-like command, with each option that takes a value paired
 * to THAT value (`-C DIR`, `--files-from F`, `-f ARCHIVE`).
 *
 * The pairs are what makes the source list honest. `tar czf <archive> . -C <dir>`
 * and `tar czf x -C <dir> .` put the directory the archive is READ from in
 * different positions, and a rule that treated every non-option word as a source
 * would read `<archive>` as one — refusing ordinary backups — while a rule that
 * dropped option words entirely would miss the `-C` directory, the spelling that
 * reads a whole credential tree out of the protected root.
 */
interface CopyArgs {
  /** Bare operands: what the tool receives that is neither an option nor an option's value. */
  operands: Word[];
  /** The value of `-C` / `--directory`, when the command gave one. */
  directory?: Word;
  /** The archive `tar` writes or reads (`-f` / `--file`), never judged as a source. */
  archive?: Word;
}

function copyArgs(name: string, args: Word[]): CopyArgs {
  const out: CopyArgs = { operands: [] };
  const valued = copyValueOptions(name);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined) continue;
    const t = a.text;
    const valueAfter = (opt: string): Word | undefined => {
      if (t === opt) return args[k + 1];
      return t.startsWith(`${opt}=`) ? { text: t.slice(opt.length + 1), dyn: a.dyn } : undefined;
    };
    const dir = valueAfter("-C") ?? valueAfter("--directory");
    if (dir !== undefined) {
      out.directory = dir;
      k++;
      continue;
    }
    if (t.length > 2 && t.startsWith("-C") && !t.startsWith("--")) {
      out.directory = { text: t.slice(2), dyn: a.dyn };
      continue;
    }
    // The archiver's archive is an option value, never a source operand.
    if (isArchiver(name)) {
      const archive = valueAfter("-f") ?? valueAfter("--file");
      if (archive !== undefined) {
        out.archive = archive;
        k++;
        continue;
      }
      // A tar mode bundle (`czf`, `zxf`) carries `f` among its letters, so its
      // ARCHIVE is the next word; the bundle itself is flags, not a path.
      if (/^-?[A-Za-z]*[cxt][A-Za-z]*f[A-Za-z]*$/.test(t)) {
        const next = args[k + 1];
        if (next !== undefined && !next.text.startsWith("-")) {
          out.archive = next;
          k++;
        }
        continue;
      }
    }
    if (t.startsWith("-") && valued.includes(t)) {
      // A value-taking option AND its value: the walk must not mistake the value
      // for a member or a source operand. `-C` is collected rather than dropped,
      // above, because it names the directory the archive is READ from.
      k++;
      continue;
    }
    const eq = t.indexOf("=");
    if (t.startsWith("--") && eq > 0 && valued.includes(t.slice(0, eq))) continue;
    if (t.startsWith("-")) continue;
    out.operands.push(a);
  }
  return out;
}

/**
 * Whether an operand of one copy-like command carries a credential tree out of the
 * protected directory. A source that CONTAINS a protected root does, and so does
 * the root itself or anything beneath it — the archive of a PARENT directory is
 * the read, and no spelling of the root has to appear for it.
 *
 * The verb decides which operands count. `cp -a <home>/.config /tmp/x` is ONE
 * copy: its single operand is a source, and the destination is the argument after
 * it. `tar czf a.tgz <home>/.config` takes its members as trailing operands after
 * the archive, so there the last word is a source and not a destination — a rule
 * that dropped the last operand for every verb would pass the tar form, and one
 * that kept it for every verb would refuse ordinary `cp` backups.
 */
function copySourceHits(
  name: string,
  args: Word[],
  cwd: string,
  dirs: readonly ProtectedDir[],
): ForgeReadHit | undefined {
  const { operands, directory } = copyArgs(name, args);
  const sources = isArchiver(name) ? operands : operands.slice(0, 1);
  const candidates = directory === undefined ? sources : [directory, ...sources];
  for (const w of candidates) {
    if (w.dyn || isKeyValue(w.text)) continue;
    for (const form of formsOf(w.text, cwd)) {
      const f = untrail(form).toLowerCase();
      if (f === "") continue;
      for (const d of dirs) {
        for (const root of rootsOf(d)) {
          const r = root.toLowerCase();
          if (isUnder(r, f) || f === r || isUnder(f, r)) return { forge: d.forge };
        }
      }
    }
  }
  return undefined;
}

/**
 * The protected paths a copy-like command reads, including the case the ordinary
 * word rule cannot see: a source that is an ANCESTOR of a protected root. See
 * `copySourceHits`.
 */
export function firstForgeReadInCopyLike(
  name: string,
  args: Word[],
  cwd: string,
  dirs: readonly ProtectedDir[],
): ForgeReadHit | undefined {
  if (!COPY_LIKE.has(name)) return undefined;
  return copySourceHits(name, args, cwd, dirs);
}

/**
 * The inline-code question: an interpreter runs a word of its argv as a PROGRAM,
 * and that program's own string can name the credential file
 * (`python3 -c 'open("/op/.config/gh/hosts.yml")'`,
 * `awk 'BEGIN{while((getline l < "<F>")>0) print l}'`,
 * `deno eval 'Deno.readFile("<F>")'`). The word is judged as TEXT — every path
 * inside it is extracted and judged — because the interpreter resolves nothing the
 * judge can follow.
 *
 * TWO positions carry the program. The first is an option that says "this word is
 * code", decided by its letters, so `node -e` and `perl -e` are read and `node -v`
 * / `perl -v` (print the version) are not: a cluster carries the code only where a
 * letter of it takes one (`sh -c`, `bash -ic`, `perl -e`, `ruby -e`, `php -r`,
 * `deno eval`, `bun -e`). The second is the BARE POSITIONAL WORD of an interpreter
 * that takes its program positionally — `awk '<prog>'`, `sed '<prog>'`,
 * `jq '<filter>'`, `lua <file>`, `tclsh <file>` — which is why the whole word set
 * of an interpreter command is scanned, not only what follows an option letter.
 */
const CODE_LETTERS = /^-[A-Za-z]*([ceri])[A-Za-z]*$/;
/** Options whose next word is code, spelled in full (`deno eval`, `bun run`, `node --eval`). */
const CODE_WORDS = new Set(["eval", "--eval", "--print", "run", "-e", "-c", "--command"]);
const INTERPRETERS = new Set([
  "python",
  "python3",
  "python2",
  "perl",
  "ruby",
  "node",
  "deno",
  "bun",
  "php",
  "sh",
  "bash",
  "zsh",
  "dash",
  "awk",
  "gawk",
  "mawk",
  "sed",
  "jq",
  "lua",
  "tclsh",
  "expect",
  "osascript",
  "Rscript",
]);

/**
 * Paths named inside an interpreter's program text: absolute paths, and any
 * quoted string that reads as a path (`open('.config/gh/hosts.yml')`, whose
 * RELATIVE spelling resolves against the directory the command runs in). An
 * interpreter can build a path at run time and no text rule can follow that —
 * the docs name that class as uncovered — but a literal it typed is judgeable.
 */
function pathsInText(text: string): string[] {
  const out: string[] = text.match(/\/[^\s'"`,;:()\[\]{}<>]*/g) ?? [];
  for (const m of text.matchAll(/[`'"]([^`'"]{2,})[`"]/g)) {
    const candidate = m[1] as string | undefined;
    if (candidate !== undefined && /\/(?:\.config\/)?[^/]+\/[\w.+-]+$/.test(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

/** Does an interpreter's inline code name a protected path? */
export function firstForgeReadInInlineCode(
  name: string,
  args: readonly Word[],
  cwd: string,
  dirs: readonly ProtectedDir[],
): ForgeReadHit | undefined {
  if (dirs.length === 0 || !INTERPRETERS.has(name)) return undefined;
  const scan = (text: string): ForgeReadHit | undefined => {
    for (const p of pathsInText(text)) {
      const hit = hits(p, cwd, dirs);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined || a.dyn) continue;
    const takesCode = CODE_LETTERS.test(a.text) || CODE_WORDS.has(a.text);
    if (takesCode && /[0-9]/.test(a.text)) continue;
    // A bare positional word of an interpreter that takes its program positionally
    // is code too, so every non-option word is scanned; an option word is scanned
    // only where the option says its value is code.
    const positional = !a.text.startsWith("-");
    if (!takesCode && !positional) continue;
    const texts = takesCode ? [a.text, args[k + 1]?.text ?? ""] : [a.text];
    for (const t of texts) {
      if (t === "") continue;
      const hit = scan(t);
      if (hit !== undefined) return hit;
    }
    if (takesCode) k++;
  }
  return undefined;
}

/** Does a block of text the child wrote (a heredoc body) name a protected path? */
export function firstForgeReadInText(
  text: string,
  cwd: string,
  dirs: readonly ProtectedDir[],
): ForgeReadHit | undefined {
  if (dirs.length === 0) return undefined;
  for (const p of pathsInText(text)) {
    const hit = hits(p, cwd, dirs);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Does this command word name the named CLI? (`/usr/bin/gh`, `./gh`, `gh`) */

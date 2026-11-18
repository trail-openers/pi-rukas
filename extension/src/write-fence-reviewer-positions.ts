/**
 * write-fence-reviewer-positions — the WRITE side of the reviewer confinement's
 * read: which words of a command are write positions, and which of them the judge
 * cannot resolve (#2352). This is the reader half of `write-fence-reviewer.ts`; the
 * verdict and the hook live there.
 *
 * The recognised forms are never re-derived here. They are the write fence's own
 * table — `bashWriteTargets()` for the walk (redirects, `cd`/`pushd`, wrappers,
 * subshells) plus, per simple command, `writtenOperands()`/`copyLikeTargets()`/
 * `hardLinkSources()`/`symlinkNames()` from write-fence-bash-writers.ts — and the
 * deletion rule's delete-position reader. Asking the same readers is what keeps
 * this rule's criteria from drifting from the judges it borrows, and the deletion
 * reader stays out of the shared writers table so a developer's write-fence
 * verdicts do not change.
 *
 * The three verdict classes the issue settles (R4) are decided here, and the arm
 * that makes them compatible with "a reviewer must still be able to review" is
 * `GUARDED_COMMANDS`: an UNRESOLVABLE word (class c) is reported only for a verb
 * this list names. `git status --porcelain`, a `grep` with a glob and `make -j`
 * name no write verb, so an ordinary review command never meets that arm, while a
 * probe that hides its destination behind a glob cannot.
 */

import path from "node:path";
import type { Word } from "./write-fence-bash-lex.ts";
import { lex } from "./write-fence-bash-lex.ts";
import { commandName, simpleCommands, stripPrefix } from "./write-fence-bash-split.ts";
import {
  copyLikeTargets,
  hardLinkSources,
  symlinkNames,
  writtenOperands,
} from "./write-fence-bash-writers.ts";
import { type BashTarget, bashWriteTargets } from "./write-fence-bash.ts";
import { deletePositions } from "./write-fence-deletion-positions.ts";
import { GIT_CLEAN_LOG_TOKEN } from "./write-fence-deletion-tokens.ts";
import { interpreterBody, interpreterFlags } from "./write-fence-interpreter-flags.ts";
import { expandHome, safeResolve } from "./write-fence-path.ts";

/** The `find` actions that run their words as a command, once per match. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** The commands whose DESTINATIONS the copy rules name (their sources stay reads). */
export const COPY_LIKE = new Set(["cp", "mv", "install", "ln", "link"]);

/**
 * The commands whose words this rule treats as write positions.
 *
 * `rm`/`rmdir`/`unlink`/`shred` are NOT listed: the deletion rule (#2200) already
 * refuses a delete outside the child's roots with its own reason, and a second
 * verdict on the same command would only duplicate the message. Their positions are
 * still read from that rule's reader below, so a line that both deletes and writes
 * is judged as one command.
 *
 * The interpreters are listed for the class-(c) arm. The deletion rule's reader is
 * a DELETE reader — its call shapes look for `rm`/`unlink`/`unlinkSync` — so an
 * interpreter one-liner that WRITES (`python3 -c "open(p,'w')"`, node's
 * `writeFileSync`, perl's `open F, ">"`) names no delete and is inert for it, and
 * the walk sees only `-c` and a quoted body. For a guarded verb, a body that claims
 * a write this rule cannot aim is a class-(c) word, not a pass.
 */
export const GUARDED_COMMANDS = new Set([
  ...COPY_LIKE,
  "touch",
  "mkdir",
  "tee",
  "find",
  "dd",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "sort",
  "tar",
  "unzip",
  "rsync",
  "sed",
  "perl",
  "curl",
  "wget",
  "go",
  "bun",
  "node",
  "python",
  "python3",
  "ruby",
]);

/**
 * The shapes in an interpreter body that claim a write. Deliberately narrower than
 * the deletion rule's reader, which fires only on a delete call: a body with none
 * of these shapes writes nothing, so `node -e "console.log(…)"` and a
 * parse-and-print review probe run. The read-only `open`/`readFileSync` forms are
 * excluded for the same reason — a reviewer reads the project it is auditing.
 */
const INTERPRETER_WRITE_SHAPES: Record<string, RegExp> = {
  python:
    /\bopen\s*\([^)]*,\s*['"][wax]|\bwritelines?\s*\(|\bos\.(?:remove|rename|mkdir|rmdir|makedirs|system)\b|\bshutil\.|\bpathlib\b|\.write_text\s*\(|\.touch\s*\(/,
  python3:
    /\bopen\s*\([^)]*,\s*['"][wax]|\bwritelines?\s*\(|\bos\.(?:remove|rename|mkdir|rmdir|makedirs|system)\b|\bshutil\.|\bpathlib\b|\.write_text\s*\(|\.touch\s*\(/,
  ruby: /\bFile\.(?:open|write|delete|unlink|rename)\b|\bIO\.write\b|\bDir\.(?:mkdir|delete)|\bFileUtils\./,
  // Perl opens for write with the mode in its own argument (`open F, ">", $p`) or the
  // two-argument form (`open F, "> $p"`); a `<`-only open is a read and runs.
  perl: /\bopen\s*[<(][^)]*["'>]\s*["'>]|\bopen\s+\w+\s*,\s*["'][^"']*[wax+>|]|\bunlink\b|\bsystem\b|\bmkdir\b|\brmdir\b/,
  node: /\b(?:write|append)FileSync\b|\b(?:rm|rmSync|rename|renameSync|mkdir|mkdirSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|chmod|chmodSync|chown|chownSync)(?:Sync)?\b|\bchild_process\b|\bexec(?:Sync)?\b|\bspawn(?:Sync)?\b/,
  // bun runs the same JS dialect as node, so the same shapes are a write there.
  bun: /\b(?:write|append)FileSync\b|\b(?:rm|rmSync|rename|renameSync|mkdir|mkdirSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|chmod|chmodSync|chown|chownSync)(?:Sync)?\b|\bchild_process\b|\bexec(?:Sync)?\b|\bspawn(?:Sync)?\b/,
};

/** The shells whose operand list is a program the shell will read and run. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * Whether the words in front of one simple command are `xargs` — read from the RAW
 * words, because `stripPrefix` consumes the wrapper and leaves only the command it runs.
 * That is what makes `ls | xargs touch` a segment whose name is `touch`, so "the command
 * is `xargs`" has to be asked of what the wrapper stripped, exactly as the deletion rule
 * (#2200) asks it (`write-fence-deletion-positions.ts` reads the same raw words).
 */
function fedByXargs(seg: Segment): boolean {
  return seg.raw.some((w) => commandName(w.text) === "xargs");
}

/**
 * Whether one simple command is a shell taking its PROGRAM from elsewhere, which the
 * guard has not read: `sh`, `bash`, `sh -s` and friends with no `-c` body on the line
 * (`write-fence-bash.ts` reads a literal `-c` body as a command of its own, so that arm
 * is judged and needs nothing here). What such a shell runs arrives on stdin — the
 * classic `curl … | sh`, and the same shape with the program piped from a file — so the
 * writes it makes are nowhere in the text the readers see. For a guarded role that is an
 * unresolvable word rather than a pass: a reviewer has no reason to execute a program it
 * cannot show the guard, and `sh -c "cat"` still runs.
 */
function shellReadsItsProgram(name: string, args: Word[]): boolean {
  if (!SHELLS.has(commandName(name))) return false;
  return !args.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
}

/**
 * Whether one simple command is a guarded write verb that `xargs` will run over names it
 * received on stdin. The splitter has already stripped the wrapper, so the operands this
 * rule can see are the ones the child typed — and the ones that decide the target are the
 * ones stdin supplies (`xargs touch`, `xargs -I{} mv {} <dir>`). The deletion rule refuses
 * `xargs rm` for exactly this reason; this is its write side. A `xargs grep` names no
 * write verb, so the ordinary use still runs.
 */
function xargsRunsGuardedVerb(segs: Segment[]): boolean {
  return segs.some((s) => fedByXargs(s) && GUARDED_COMMANDS.has(s.name));
}

/** One simple command of the line, as the walk's own splitter and strip name it. */
interface Segment {
  name: string;
  args: Word[];
  /** The words before the keywords/wrappers were stripped, which is what names an `xargs`. */
  raw: Word[];
  /** The words the walk attributed to this command's `>`/`>>` redirects. */
  redirects: Word[];
}

/** A position this rule found: an absolute path to judge, or a reason it cannot be judged. */
export interface WritePosition {
  /** The resolved absolute path, or undefined when the word could not be resolved. */
  path: string | undefined;
  /** Why the position is refused outright; "" when the path is what must be judged. */
  reason: string;
  /** The log token the refusal is recorded under. */
  token: string;
}

/** The line's simple commands. A line that does not lex gives none, which is itself the fail-closed case. */
function segments(command: string): Segment[] {
  const lexed = lex(command);
  if (lexed === undefined) return [];
  const out: Segment[] = [];
  for (const step of simpleCommands(lexed.toks)) {
    if (step.kind !== "command") continue;
    const { words, redirects } = step.simple;
    const stripped = stripPrefix(words).words;
    const first = stripped[0];
    if (first === undefined) continue;
    out.push({
      name: commandName(first.text),
      args: stripped.slice(1),
      raw: words,
      redirects,
    });
  }
  return out;
}

/** Whether a word is a path this rule may aim, rather than an option or an empty word. */
function isPathWord(w: Word): boolean {
  return w.text !== "" && !w.text.startsWith("-");
}

/** The word `find` substitutes for each matched path. */
const FIND_PLACEHOLDER = "{}";

/** Whether one word is the `find` action that opens a command. */
function opensExec(w: Word | undefined): boolean {
  return w !== undefined && FIND_EXEC.has(w.text);
}

/**
 * The commands a `find` will exec, one per `-exec`/`-execdir`/`-ok`/`-okdir`: the words
 * between the action and its own `;` or `+` terminator. Scanning resumes past each
 * terminator, so a chained clause is read too and nothing between two clauses is taken
 * for a command.
 */
function execClauses(args: Word[]): Word[][] {
  const clauses: Word[][] = [];
  for (let at = 0; at < args.length; at++) {
    if (!opensExec(args[at])) continue;
    const body = args.slice(at + 1);
    const end = body.findIndex((w) => w.text === ";" || w.text === "+");
    clauses.push(end < 0 ? body : body.slice(0, end));
    if (end >= 0) at += end + 1;
  }
  return clauses;
}

/**
 * The guarded words one exec'd command writes: the same read a top-level segment gets
 * (the writers table and the interpreter arm), so an `-exec` is judged by the rules of
 * the verb it runs and not by a second table of `find` shapes.
 */
function execWrittenWords(command: Word[], cwd: string): WritePosition[] {
  const stripped = stripPrefix(command).words;
  const first = stripped[0];
  if (first === undefined) return [];
  const name = commandName(first.text);
  if (!GUARDED_COMMANDS.has(name)) return [];
  const args = stripped.slice(1);
  // An option is not a program, so an `-exec -x rm …` / `-exec -- rm …` names a command
  // this rule cannot read — the same fail-closed answer the deletion rule gives it.
  if (first.text.startsWith("-")) {
    return [{ path: undefined, reason: POSITION_UNJUDGED_REASON, token: "(reviewer write)" }];
  }
  const out = writtenWords(name, args)
    .filter(isPathWord)
    .map((w) => fromWord(w, cwd));
  if (interpreterWriteIsOpaque(name, args)) {
    out.push({ path: undefined, reason: POSITION_UNJUDGED_REASON, token: "(reviewer write)" });
  }
  return out;
}

/**
 * The words the table says one guarded command writes, moves or links: the copy
 * rules for the copy-like commands (destination, hard-link sources, link names) and
 * the operand table for everything else — the same calls the walk makes.
 */
function writtenWords(name: string, args: Word[]): Word[] {
  if (COPY_LIKE.has(name)) {
    return [
      ...copyLikeTargets(name, args),
      ...hardLinkSources(name, args),
      ...symlinkNames(name, args),
    ];
  }
  return writtenOperands(name, args);
}

/** Resolve a target the way the child's shell would, from the directory it was written in. */
export function absolutiseTarget(text: string, from: string): string {
  const expanded = expandHome(text);
  return path.isAbsolute(expanded) ? expanded : path.resolve(from, expanded);
}

/** Why a word at a write position cannot be judged (the guard's class-(c) arm). */
export const POSITION_UNJUDGED_REASON =
  "its path comes from a glob, a brace list or a shell expansion the guard cannot resolve, so it is refused rather than guessed. Name each path literally, inside your own roots";

/** A character the shell gives a meaning to that the lexer reported as plain text. */
const SHELL_METACHARS = /[$`\\]/;

/**
 * Whether a word is a glob, a brace list, or an expansion the judge cannot resolve.
 *
 * The `dyn` flag covers every expansion the lexer SAW. It cannot cover the ones the
 * lexer faithfully reported as text: a single-quoted word is literal to the lexer and
 * `$`, a backtick and a backslash survive it verbatim, so `cp x '$T/pwned'` arrives
 * here as the text `$T/pwned` with `dyn` false — and the shell then expands `$T`, so
 * the file lands wherever `T` points, not where the judge resolved the text to. A
 * backslash is the same trap in the other direction: `\$T` is literal to the lexer and
 * expansion to the shell. So a word that still carries one of those characters at a
 * write position names no path this rule can aim.
 *
 * The quoted form is what makes this safe to apply to every write-position word: a
 * double-quoted or unquoted expansion already set `dyn`, and a single-quoted path with
 * none of these characters in it — `'src/a b,c.md'` — is exactly as literal as the
 * shell will make it.
 */
function unresolvable(w: Word): boolean {
  return (
    w.dyn ||
    w.glob === true ||
    SHELL_METACHARS.test(w.text) ||
    /\{[^{}]*(,|\.\.)[^{}]*\}/.test(w.text)
  );
}

/**
 * Whether a guarded interpreter one-liner claims a write this rule cannot aim. The
 * rule only ever refuses, so a body that claims a write and whose path the reader
 * cannot lift out is reported rather than trusted: the field's probe named its
 * target on the same line as the write, and a reader that hoped to see a literal
 * would have let it run.
 *
 * The flags are the shared table (`write-fence-interpreter-flags.ts`) — the same one
 * the deletion reader reads — because each spelling is a body the runtime runs: a
 * table that named only `-e` let `node --print 'require("fs").writeFileSync(…)'`
 * through as an ordinary word.
 */
function interpreterWriteIsOpaque(name: string, args: Word[]): boolean {
  const flags = interpreterFlags(name);
  const shape = INTERPRETER_WRITE_SHAPES[name];
  if (flags === undefined || shape === undefined) return false;
  const body = interpreterBody(args, flags);
  if (body === undefined) return false;
  // `body.dyn` is the double-quoted spelling (`python3 -c "open(p,'w')"`, where the
  // quote inside made the lexer give up on the text). A single-quoted body is literal,
  // so its write shapes are matched on the text itself — the same shapes, which is the
  // point: the quoting must not decide whether the guard reads the body.
  return body.dyn || SHELL_METACHARS.test(body.text) || shape.test(body.text);
}

/** One walk target as a position. Its opaque verdict carries its own reason. */
function fromWalk(t: BashTarget, cwd: string): WritePosition {
  return {
    path: t.opaque === undefined ? absolutiseTarget(t.path, t.cwd ?? cwd) : undefined,
    reason: t.opaque ?? "",
    token: "(reviewer write)",
  };
}

/** One table word at a guarded command's write position. */
function fromWord(w: Word, cwd: string): WritePosition {
  if (w.refusal !== undefined)
    return { path: undefined, reason: w.refusal, token: "(reviewer write)" };
  // The matched name `find` substitutes for `{}` is not a path the guard can aim, so a
  // write position holding it is refused rather than judged on the cwd it might land in.
  if (w.text === FIND_PLACEHOLDER) {
    return {
      path: undefined,
      reason: `its path is \`${FIND_PLACEHOLDER}\`, the name \`find\` substitutes for each match, so the target cannot be judged. Name each path literally, inside your own roots`,
      token: "(reviewer write)",
    };
  }
  if (unresolvable(w)) {
    return { path: undefined, reason: POSITION_UNJUDGED_REASON, token: "(reviewer write)" };
  }
  return { path: absolutiseTarget(w.text, cwd), reason: "", token: "(reviewer write)" };
}

/**
 * Every write position in the command, as paths to judge and reasons to refuse.
 *
 * (1) the bash walk's targets — redirects for EVERY command (`printf … > <home>` is
 *     a write whatever ran), plus `cd`/`pushd`, wrappers and subshells;
 * (2) for each guarded simple command, the words the writers table names, plus its
 *     redirect words, plus the interpreter arm, plus each `find -exec` clause read as
 *     the command `find` will run;
 * (3) the deletion rule's positions, so a line that both deletes and writes is
 *     judged as one command (that rule's hook still refuses them for every child).
 *
 * An unresolvable word is reported only where a guarded command named it, or where
 * the whole line failed to lex — which is class (c) as the issue settles it, and
 * the reason a reviewer's `grep … *.ts` still runs.
 */
export function writePositions(command: string, cwd: string): WritePosition[] {
  const segs = segments(command);
  const out: WritePosition[] = [];
  const anyGuarded = segs.some((s) => GUARDED_COMMANDS.has(s.name));

  for (const t of bashWriteTargets(command, cwd)) {
    // The `cd`/`pushd` operand is the directory the rest of the line RUNS in, not a
    // path the command writes — the walk reports it as a target because that is what
    // makes a later relative write judgeable, and the relative targets below carry it
    // as their own `cwd`. For this rule the operand itself is not a write position:
    // a reviewer must be able to `cd <reviewed> && make`, and the tree it is auditing
    // is never writable. A write that only becomes reachable by the cd is still
    // reported, because it is judged from the cd's directory (`cd <state> && cp x .`).
    if (t.cwd === undefined || t.cwd === cwd) {
      const dir = safeResolve(t.path);
      const entered =
        dir !== undefined &&
        segs.some(
          (s) =>
            (s.name === "cd" || s.name === "pushd") &&
            s.args[0] !== undefined &&
            safeResolve(absolutiseTarget(s.args[0].text, cwd)) === dir,
        );
      if (entered) continue;
    }
    // A resolved path is judged whatever named it; an opaque verdict is a class-(c)
    // word and belongs to this rule only when a guarded verb is on the line — or
    // when nothing lexed at all, which is the same case in another spelling.
    if (t.opaque !== undefined && !anyGuarded && segs.length > 0) continue;
    out.push(fromWalk(t, cwd));
  }

  for (const seg of segs) {
    // A shell that reads its program from a pipe writes whatever the pipe says, which
    // no reader has seen; `xargs` writes whatever stdin names. Both are class (c).
    if (shellReadsItsProgram(seg.name, seg.args) || xargsRunsGuardedVerb(segs)) {
      out.push({ path: undefined, reason: POSITION_UNJUDGED_REASON, token: "(reviewer write)" });
    }
    if (!GUARDED_COMMANDS.has(seg.name)) continue;
    for (const w of [...writtenWords(seg.name, seg.args), ...seg.redirects]) {
      if (isPathWord(w)) out.push(fromWord(w, cwd));
    }
    // An `-exec` clause runs a command of its own once per match, and the words behind
    // the action are the only place its destinations are named: `find . -exec cp {} <out>/x \;`
    // writes nothing until find hands `cp` that argument, so the clause is judged as the
    // simple command it is. A read-only clause (`-exec grep`, `-exec cat`) names no write
    // position and runs.
    for (const clause of execClauses(seg.args)) {
      out.push(...execWrittenWords(clause, cwd));
    }
    if (interpreterWriteIsOpaque(seg.name, seg.args)) {
      out.push({ path: undefined, reason: POSITION_UNJUDGED_REASON, token: "(reviewer write)" });
    }
  }

  for (const h of deletePositions(command, cwd)) {
    // `git clean` is the deletion rule's own carve-out; it is not this rule's to
    // re-judge, and re-judging it would give a legal build step a second refusal.
    if (h.token === GIT_CLEAN_LOG_TOKEN) continue;
    out.push({ path: h.path, reason: h.reason, token: h.token });
  }
  return out;
}

/**
 * write-fence-deletion — the `tool_call` hook that keeps a child's DELETIONS
 * inside its own trees (#2200).
 *
 * The field evidence: a /work develop child hit a disk-quota error in the shared
 * temp root and cleared it itself — about fifty commands, `rm -rf` and `rmdir` on
 * literal paths, a `find … -print0 | xargs -0 -r rm -rf` sweep across thirty name
 * prefixes (other projects' temp dirs, test-runner dirs, other cycles' live
 * reviewer trees), and an `rm -rf` of a VCS root the operator kept under that
 * root. About 9.8 GB went. The write fence refused only the glob and
 * unresolvable-expansion forms: every LITERAL `rm -rf` outside the child's
 * worktree went through, because the write rule lets anything land under the OS
 * temp dirs (a build must be able to write there), and an interpreter one-liner
 * was not read at all.
 *
 * So the deletion rule is a second one, with a different allowance, registered
 * beside the fence but NOT gated on it:
 *
 *   - the allowed roots are the worktree, the cycle scratch dir and the child's
 *     OWN per-child temp root — never the shared temp root, whatever its name.
 *     They come from the raw env, never from `loadFenceConfig`: that returns
 *     undefined for exactly the reviewer (no `PI_ENSEMBLE_WRITE_ROOT`) and the
 *     `PI_ENSEMBLE_WRITE_FENCE=0` cases this hook must still refuse.
 *   - it has no opt-out. The hatch is the developer whole-tree fence's switch; an
 *     operator who needs a deletion outside the roots runs it from the parent
 *     session, which this child-only hook does not cover.
 *   - what cannot be resolved at a delete position is refused, in the bash fence's
 *     own fail-closed vocabulary rather than a second invented verdict.
 *
 * One reader, three sources — and the rule for every one of them is the same: a
 * word counts as a deleted path only when a command this rule owns named it.
 *
 *   - the bash walk (write-fence-bash.ts) resolves each simple command's words
 *     and the directory it runs in, tracking `cd`, pipes, subshells and the
 *     `xargs` wrapper; its own verdict (`opaque`) is the refusal for a glob, a
 *     `$VAR` or a run-time-built body, so the incident's prefix-sweep pipe is
 *     refused on evidence the fence already computes;
 *   - the operand table (write-fence-bash-writers.ts) says which words of a
 *     command the child NAMED are paths — it has no entry for `unlink` or
 *     `shred`, which is why those two carry their own read here;
 *   - the interpreter reader covers `bun -e`, `node -e`, `node --eval`,
 *     `python -c`, `python3 -c`, `perl -e` and `ruby -e` (#2200 D7), which the
 *     writers table cannot see at all.
 *
 * The interpreter reader lives HERE and not in the writers table deliberately: an
 * interpreter one-liner is the documented gap the incident drove through, but
 * putting `bun`/`node`/`python` into the general write list would change what the
 * WRITE fence refuses for every dispatch, which is not what this issue asks.
 *
 * `git clean` is the one overlap. The destructive-git guard owns it and has its own
 * opt-out; a forcing clean (`-f`/`--force`, never `-n`) aimed OUTSIDE the child's
 * roots is refused here whatever that opt-out says, because that opt-out is about
 * the child's own working tree. Aimed inside, nothing here refuses it, so the
 * guard's rule and its hatch stay the only answer for the in-tree case and that
 * guard's test rows stay green. No `git clean` verb is added to the writers table.
 *
 * The refusal names the rule and the allowed roots and NEVER the target — a target
 * is an operator path and the handoff is public. Like the dependency rule (#1879)
 * this is a guardrail against an agent's own bad judgement, not a security
 * boundary: a command that names no path this scanner reads stays outside it, and
 * the categories it does not reach are listed in docs/troubleshooting.md.
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace, traceWarn } from "./trace.ts";
import { type Lexed, type Word, lex } from "./write-fence-bash-lex.ts";
import { commandName, isRemover, removalOperands, stripPrefix } from "./write-fence-bash-split.ts";
import { writtenOperands } from "./write-fence-bash-writers.ts";
import { type BashTarget, bashWriteTargets } from "./write-fence-bash.ts";
import { findRemovals } from "./write-fence-deletion-find.ts";
import {
  INTERPRETER_TARGET_REASON,
  interpreterDeletions,
  isInterpreter,
} from "./write-fence-deletion-interpreter.ts";
import { appendWriteFenceRefusal } from "./write-fence-log.ts";
import { expandHome, isInside, safeResolve } from "./write-fence-path.ts";

/** The env names this rule reads: the fence's three plus the child's own temp root. */
export const DELETION_GUARD_ENV = [
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_REPO",
  "PI_ENSEMBLE_WRITE_SCRATCH",
] as const;

/** The log line's `path` field for a deletion. Never the target: the handoff is public. */
export const DELETION_LOG_TOKEN = "(deletion)";
/** The log line's `path` field for a `git clean` outside the child's roots. */
export const GIT_CLEAN_LOG_TOKEN = "(git clean)";
/** The log line's `path` field for a call the rule could not judge at all. */
export const NOT_JUDGED_LOG_TOKEN = "(not judged)";

/** Why a target inside no allowed root is refused. Names the rule, never the target. */
export const OUTSIDE_REASON =
  "it deletes outside your worktree, your scratch dir and your own temp dir. A shared temp root is never a delete target: report a quota or ENOSPC/EDQUOT failure instead of clearing it";

/** Why a command that does not lex is refused whole. */
const UNREADABLE_REASON =
  "the command does not lex, so what it deletes cannot be judged. Run the deletion as its own command with literal paths";
/** Why a target that cannot be resolved is refused. */
const UNRESOLVED_REASON =
  "its path could not be resolved (a symbolic link loop, or a parent this child cannot read), so the target cannot be judged";
/** Why a glob or brace list at a delete position is refused. */
const GLOB_TARGET_REASON =
  "its path has a glob or a brace list, which expands to files this rule cannot check. Name each path literally";
/** Why an expansion at a delete position is refused. */
const DYNAMIC_TARGET_REASON =
  "its path comes from a variable, a substitution or ~user, so the target cannot be judged. Name the path literally";

/** What the hook may delete into, as the child's env named it. */
export interface DeletionRoots {
  /** The child's working directory: the base for a target the command left relative. */
  cwd: string;
  /** The worktree, scratch dir and per-child temp root, exactly as the env named them. */
  labels: string[];
  /** The same roots as realpaths; an unusable one is absent, never guessed at. */
  allowed: string[];
}

/** A refused delete position: the log's `path` token, and the reason clause. */
export interface DeletionHit {
  token: string;
  reason: string;
}

/** One delete position, ready to judge: `path` set means judge it, `reason` means refuse it. */
interface RawHit {
  token: string;
  reason: string;
  path?: string;
  /** The directory to resolve `path` from — the directory its command ran in. */
  dir?: string;
}

/** One simple command: its words (wrappers and shell keywords stripped) and where it runs. */
interface Command {
  name: string;
  args: Word[];
  dir: string;
}

/** Resolve a deletion word the way the child's shell would, from `dir`. */
function absolutise(text: string, dir: string): string {
  const expanded = expandHome(text);
  return path.isAbsolute(expanded) ? expanded : path.resolve(dir, expanded);
}

/**
 * The simple commands of the line, each with the directory it runs in. The walk
 * owns that tracking (`cd`, `pushd`, subshells, `xargs`, `env -C`), so the
 * directories are read back out of its targets rather than re-derived here; the
 * words come from the lexer, which is the only thing that keeps each word's text.
 * A command the walk named no target for keeps the child's cwd, which is what the
 * walk reports for a `git -C` or an interpreter call anyway.
 */
function commands(command: string, cwd: string): { parsed: boolean; list: Command[] } {
  const lexed = lex(command);
  if (!lexed) return { parsed: false, list: [] };
  const dirs = walkDirs(command, cwd);
  const list: Command[] = [];
  let cur: Word[] = [];
  let index = 0;
  const flush = (): void => {
    const words = stripPrefix(cur).words;
    const first = words[0];
    if (first !== undefined) {
      list.push({
        name: commandName(first.text),
        args: words.slice(1),
        dir: dirs[index] ?? cwd,
      });
    }
    index++;
    cur = [];
  };
  for (const tok of lexed.toks) {
    if (tok.kind === "word") cur.push(tok.word);
    else flush();
  }
  flush();
  for (const sub of lexed.subs) {
    const inner = commands(sub, cwd);
    list.push(...inner.list);
  }
  return { parsed: true, list };
}

/**
 * The directory each simple command of the line runs in, indexed by SEGMENT as the
 * walk's own splitter cuts them (so it has a slot per separator, empty or not).
 * Read back out of the walk's targets, which each carry the directory they were
 * written from; a segment with no target of its own (a `git clean`, an interpreter
 * call, an `xargs` whose paths come from stdin) keeps the last directory the line
 * had reached — the `cd` the walk already tracked, which is the point: `cd <shared
 * temp root> && git clean -fdx` is the incident's shape, and the command that does
 * the deleting names no path for the walk to carry a directory on.
 */
function walkDirs(command: string, cwd: string): string[] {
  const reached = bashWriteTargets(command, cwd).map((t) => t.cwd);
  const out: string[] = [];
  for (let at = 0; at <= reached.length; at++) {
    out[at] = reached[at] ?? reached[at - 1] ?? cwd;
  }
  return out;
}

/**
 * A `find` that removes things. `-delete` removes its start paths (or its
 * directory when it named none); `-exec`/`-execdir`/`-ok` run their words once per
 * MATCH, so what they remove cannot be named before the match exists — the same
 * fail-closed shape as an unresolvable expansion, and the form a prefix sweep uses.
 */

/** The `find` actions that run their words as a command, once per match. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * The tree a forcing `git clean` would remove, or undefined when the command is not
 * one. A forcing clean (`-f`/`--force`, never `-n`) is judged by the tree it removes
 * in — the last `-C`/`--work-tree` it names, or the directory the command runs in —
 * which is what makes `git clean -fdx` under the shared temp root a deletion rather
 * than a git command (#2200 D1).
 */
function gitCleanTree(args: Word[]): Word | undefined {
  let base: Word | undefined;
  let k = 0;
  const take = (v: Word): void => {
    base =
      base === undefined || v.text.startsWith("/")
        ? v
        : { text: `${base.text}/${v.text}`, dyn: base.dyn || v.dyn };
  };
  while (k < args.length) {
    const a = args[k] as Word;
    if (a.text === "-C" || a.text === "--git-dir" || a.text === "--work-tree") {
      const v = args[k + 1];
      if (v !== undefined) take(v);
      k += 2;
      continue;
    }
    if (a.text.startsWith("-C") && a.text.length > 2) {
      take({ text: a.text.slice(2), dyn: a.dyn });
      k++;
      continue;
    }
    if (a.text.startsWith("--git-dir=") || a.text.startsWith("--work-tree=")) {
      take({ text: a.text.slice(a.text.indexOf("=") + 1), dyn: a.dyn });
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
  if (args[k]?.text !== "clean") return undefined;
  const rest = args.slice(k + 1);
  const forcing =
    rest.some((a) => a.text === "--force" || (/^-[^-]/.test(a.text) && a.text.includes("f"))) &&
    !rest.some((a) => a.text === "-n" || a.text === "--dry-run");
  return forcing ? (base ?? { text: ".", dyn: false }) : undefined;
}

/**
 * A remover that names no path — `xargs … rm -rf`, whose targets arrive on
 * standard input as the matched names, or a bare `rm` — cannot be judged, so it is
 * refused. The splitter strips the `xargs` wrapper, so by the time this rule sees
 * the command the wrapper is gone and only the empty operand list distinguishes it
 * from a remover that simply had nothing to remove; `xargs`' own options (`-0`,
 * `-r`, `-I`) are options too, so the read is the non-option operands, not the
 * argument count. This is the incident's shape: thirty name prefixes swept out of
 * the shared temp root through exactly this pipe.
 */
const REMOVED_UNKNOWN_REASON =
  "it removes paths the command does not name (they arrive on standard input, or from a match), so the target cannot be judged. Name each path literally";

function unnamedRemoval(cmd: Command): RawHit[] {
  if (!isRemover(cmd.name) || removalOperands(cmd.args).length > 0) return [];
  return [{ token: DELETION_LOG_TOKEN, reason: REMOVED_UNKNOWN_REASON }];
}

/** The words one command deletes, as it named them; empty when it deletes nothing. */
function deletedWords(cmd: Command): Word[] {
  if (isRemover(cmd.name)) {
    const tabled = writtenOperands(cmd.name, cmd.args);
    // The table has no entry for `unlink` or `shred`; their operands are their targets.
    return tabled.length > 0 ? tabled : removalOperands(cmd.args);
  }
  if (cmd.name === "find") return findRemovals(cmd.args);
  if (cmd.name === "git") {
    const tree = gitCleanTree(cmd.args);
    return tree === undefined ? [] : [tree];
  }
  return [];
}

/** Is this command one whose words this rule reads at all? */
function owned(name: string): boolean {
  return isRemover(name) || name === "find" || name === "git" || isInterpreter(name);
}

/** A word the rule refuses outright, or a path it can judge, resolved from `dir`. */
function hitFor(w: Word, dir: string, token: string): RawHit {
  if (w.refusal !== undefined) return { token, reason: w.refusal, dir };
  if (w.dyn) return { token, reason: DYNAMIC_TARGET_REASON, dir };
  if (w.glob || /\{[^{}]*(,|\.\.)[^{}]*\}/.test(w.text)) {
    return { token, reason: GLOB_TARGET_REASON, dir };
  }
  return { token, reason: "", path: absolutise(w.text, dir), dir };
}

/**
 * Every delete position in the command: each word a command this rule owns names,
 * judged from the directory that command ran in, plus every verdict the walk
 * itself refused at a write position inside a removal command — which is how a
 * glob, a `$VAR` or a run-time body is refused without this module re-implementing
 * the pipe, the subshell or the `xargs` wrapper.
 */
function deletePositions(command: string, cwd: string): RawHit[] {
  const parsed = commands(command, cwd);
  if (!parsed.parsed) return [{ token: NOT_JUDGED_LOG_TOKEN, reason: UNREADABLE_REASON }];
  const hits: RawHit[] = [];
  const ownedCommands = parsed.list.filter((c) => owned(c.name));
  for (const cmd of ownedCommands) {
    hits.push(...unnamedRemoval(cmd));
    for (const w of deletedWords(cmd)) hits.push(hitFor(w, cmd.dir, tokenFor(cmd.name)));
    const interp = interpreterDeletions(cmd.name, cmd.args, cmd.dir);
    if ("reason" in interp) hits.push({ token: DELETION_LOG_TOKEN, reason: interp.reason });
    else for (const d of interp) hits.push({ token: DELETION_LOG_TOKEN, reason: "", path: d.path });
  }
  for (const t of bashWriteTargets(command, cwd)) {
    if (t.opaque === undefined) continue;
    if (!ownedCommands.some((c) => c.dir === t.cwd)) continue;
    hits.push({ token: DELETION_LOG_TOKEN, reason: t.opaque });
  }
  return hits;
}

/** The log token a command's own deletion carries. */
function tokenFor(name: string): string {
  return name === "git" ? GIT_CLEAN_LOG_TOKEN : DELETION_LOG_TOKEN;
}

/** Resolve a target and judge it against the allowed roots; undefined when it lies inside one. */
function judge(abs: string, roots: DeletionRoots, token: string): DeletionHit | undefined {
  const real = safeResolve(abs);
  if (real === undefined) return { token, reason: UNRESOLVED_REASON };
  if (roots.allowed.some((allowed) => isInside(real, allowed))) return undefined;
  return { token, reason: OUTSIDE_REASON };
}

/**
 * The first delete position this child may not take, or undefined when every one
 * lies inside its roots.
 */
export function firstDeletionOutside(
  command: string,
  roots: DeletionRoots,
): DeletionHit | undefined {
  for (const hit of deletePositions(command, roots.cwd)) {
    if (hit.reason !== "") return { token: hit.token, reason: hit.reason };
    const judged = judge(hit.path ?? "", roots, hit.token);
    if (judged !== undefined) return judged;
  }
  return undefined;
}

/** The per-child temp root the spawn layer names for one child (#2200), as
 * `writeRolePromptFile` creates it. Read as a NAME and not as a property, so the
 * env inventory in headless/inputs.ts stays the single list of what the build honours. */
export const CHILD_TMP_ENV = "PI_ENSEMBLE_CHILD_TMP";

/** One usable absolute root from the env, as the label it was named by and its realpath. */
function usableRoot(raw: string | undefined): { label: string; real: string } | undefined {
  if (raw === undefined || raw === "" || !path.isAbsolute(raw)) return undefined;
  try {
    if (!statSync(raw).isDirectory()) return undefined;
  } catch {
    // Any stat failure (ENOENT, EACCES on a parent) means the root is not usable.
    return undefined;
  }
  const real = safeResolve(raw);
  return real === undefined ? undefined : { label: raw, real };
}

/**
 * The roots this child may delete into, from the RAW env. Every role receives a
 * per-child temp root; a fenced dispatch also has its worktree and its scratch
 * dir. Never `loadFenceConfig` — it is undefined for exactly the reviewer and the
 * hatch cases this rule must still judge. A root the env names that is not a
 * usable directory is left out, so a child the driver gave nothing has NO allowed
 * root and every deletion it attempts is refused.
 */
export function deletionRootsFrom(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): DeletionRoots {
  const usable = [
    usableRoot(env.PI_ENSEMBLE_WRITE_ROOT),
    usableRoot(env.PI_ENSEMBLE_WRITE_SCRATCH),
    usableRoot(env[CHILD_TMP_ENV]),
  ].filter((r): r is { label: string; real: string } => r !== undefined);
  return { cwd, labels: usable.map((r) => r.label), allowed: usable.map((r) => r.real) };
}

/** The refusal the child sees: the rule, the allowed roots, and never the target. */
export function deletionRefusalText(roots: DeletionRoots, why: string): string {
  const allowed = roots.labels.length > 0 ? roots.labels.join(", ") : "none";
  return `Refused: ${why}. Allowed roots: ${allowed}. Delete inside those, or report the need to the PM; a shared temp root, the main checkout, a sibling worktree and $HOME are not yours to remove.`;
}

/**
 * Register the deletion guard for this child. It registers for EVERY child in
 * every mode and role: no env switch is consulted, so neither a missing
 * `PI_ENSEMBLE_WRITE_ROOT` (a reviewer) nor the operator's
 * `PI_ENSEMBLE_WRITE_FENCE=0` (the developer hatch) can disarm it (#2200 D5).
 *
 * `roots` is injectable so the tests can point the rule at a fixture; production
 * reads the env and the cwd at registration, which is what the child's dispatch
 * decided for it.
 */
export function registerDeletionGuard(
  pi: ExtensionAPI,
  deps: { roots?: DeletionRoots; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): void {
  const env = deps.env ?? process.env;
  const roots = deps.roots ?? deletionRootsFrom(env, deps.cwd ?? process.cwd());
  const role = env.PI_ENSEMBLE_ROLE;
  const log = { scratch: env.PI_ENSEMBLE_WRITE_SCRATCH, repo: env.PI_ENSEMBLE_WRITE_REPO };
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown } | undefined | null)?.command;
    if (typeof command !== "string") return;
    let hit: DeletionHit | undefined;
    try {
      hit = firstDeletionOutside(command, roots);
    } catch (err) {
      // An internal fault is a refusal too: the call was not judged, so it does not run.
      const reason = `deletion guard could not judge this call: ${(err as Error).message}`;
      trace(`write-fence-deletion: ${reason}`);
      recordRefusal(log, NOT_JUDGED_LOG_TOKEN, reason, role);
      return { block: true, reason };
    }
    if (hit === undefined) return;
    const reason = deletionRefusalText(roots, hit.reason);
    recordRefusal(log, hit.token, reason, role);
    return { block: true, reason };
  });
}

/**
 * Record one refusal. A child with a scratch dir appends through the write fence's
 * own channel, so the driver counts it beside the fence's refusals. A child with
 * none — a reviewer, which the driver never fences — has no scratch to append to,
 * so the refusal reaches the ungated warn and is declared uncounted (#2200 D2):
 * the pinned refusal totals cover fenced children only.
 */
function recordRefusal(
  log: { scratch?: string; repo?: string },
  token: string,
  reason: string,
  role: string | undefined,
): void {
  if (log.scratch !== undefined && log.scratch !== "") {
    appendWriteFenceRefusal(
      log.scratch,
      { tool: "bash", path: token, reason, at: Date.now() },
      log.repo,
    );
    trace(`write-fence-deletion: refused a deletion (${token})`);
    return;
  }
  traceWarn(
    `write-fence-deletion: refused a deletion (${token}) for the ${role ?? "unroled"} child — not counted, it has no scratch dir`,
  );
}

/** Re-exported so the deletion tests read the same shapes the hook itself uses. */
export { isRemover, removalOperands } from "./write-fence-bash-split.ts";
export { interpreterLiterals, isInterpreter } from "./write-fence-deletion-interpreter.ts";
export { type BashTarget, writtenOperands };

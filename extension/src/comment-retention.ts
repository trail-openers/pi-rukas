/**
 * comment-retention — mechanical guard against deleted comments (#948).
 *
 * Developers repeatedly delete or compress pre-existing comments to get
 * under the 500-line file cap. This module finds comment lines REMOVED between
 * base and head whose text does not reappear under `paths` at head, and
 * classifies each removed block as retained, exempt or lost (the rules live in
 * comment-retention-hunks.ts). It returns STRUCTURED DATA only; rendering for
 * the develop note, the report line and the reviewer prompts is in
 * comment-evidence.ts.
 *
 * A LOST comment is evidence, not a failure. Infra errors (unreadable base, git
 * failure, an unparseable hunk header) make the check return `ok: false`, which
 * callers must surface as NOT CHECKED — never as silence.
 *
 * `paths` scopes ALL operations (the diff, the head-tree read). `timeoutMs` is
 * supplied by the caller for every git invocation.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { type LostComment, classifyHunk, hasWord, parseHunks } from "./comment-retention-hunks.ts";
import { countPrCommits, prRange } from "./git-range.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * A real shell `ExecFn` built on `promisify(exec)`, for callers (the adversarial
 * round and the lens review) that have no injected seam. The driver's gates use
 * an injected `ExecFn` instead; this one is the production default.
 */
export function makeExecFn(): ExecFn {
  const shell = promisify(exec);
  const file = promisify(execFile);
  return (cmd, opts) => {
    const common = { cwd: opts?.cwd, timeout: opts?.timeout, maxBuffer: opts?.maxBuffer };
    // #1134 — the argv form runs the executable directly, with no shell re-parse.
    if (opts?.argv) return file(cmd, opts.argv, { ...common, encoding: "utf8" });
    return shell(cmd, common);
  };
}

/** The paths the diff / existence / exemption searches are scoped to. */
export const COMMENT_RETENTION_PATHS = ["extension/src", "extension/smoke-tests", "agents-base"];

/** Per-git-call timeout when the caller does not pass one. */
export const DEFAULT_COMMENT_TIMEOUT_MS = 10 * 60_000;

const VALID_SHA_RE = /^[0-9a-f]{40}$/;
/** Strict refname allowlist (no leading `-`) for non-SHA refs. */
const VALID_REFNAME_RE = /^[A-Za-z0-9._/-]+$/;

function isSafeRef(ref: string): boolean {
  if (!ref || ref.startsWith("-")) return false;
  return VALID_SHA_RE.test(ref) || VALID_REFNAME_RE.test(ref);
}

/**
 * Path tokens are interpolated into the ExecFn's shell string (the same
 * injection class the harness already guards for refs — PR338 / `isSafeRef`).
 * Every token is validated BEFORE any exec. No leading `-` (git option
 * injection), no whitespace or shell metacharacters.
 */
const VALID_PATH_RE = /^[A-Za-z0-9._/-]+$/;

function isSafePathList(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => !p.startsWith("-") && VALID_PATH_RE.test(p));
}

export type LostCommentResult =
  | { ok: true; lost: LostComment[]; exempt: number }
  | { ok: false; reason: string };

/** The exit code of a child-process failure, or undefined for any other value. */
function execExitCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
}

/**
 * Read every file under `paths` at `ref` (one `git grep -e ""` read, not N
 * per-file greps) and return the line contents present at that ref as a trimmed
 * set (for the O(1) exact lookup). Returns `undefined` when the read itself
 * fails (an infra error; callers render NOT CHECKED). `git grep` exits 1 when
 * nothing matches: that is an empty head tree under `paths` only when the ref
 * resolves; otherwise the read is unreadable.
 */
async function readLinesAtRef(
  execFn: ExecFn,
  cwd: string,
  ref: string | undefined,
  paths: string[],
  timeoutMs: number,
): Promise<Set<string> | undefined> {
  // No ref = the working tree (tracked files): the uncommitted /work diff.
  try {
    // `-z` ends the file name with a NUL, so a `:` inside a path cannot shift
    // the slice: `ref:file\0content` (or `file\0content` with no ref).
    // argv (#1134): the ref and paths are never shell-parsed.
    const { stdout } = await execFn("git", {
      argv: ["grep", "-z", "-e", "", ...(ref ? ["--end-of-options", ref] : []), "--", ...paths],
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = new Set<string>();
    for (const line of stdout.split("\n")) {
      const at = line.indexOf("\0");
      if (at < 0) continue;
      out.add(line.slice(at + 1).trim());
    }
    return out;
  } catch (err) {
    if (execExitCode(err) === 1 && (!ref || (await refResolves(execFn, cwd, ref, timeoutMs))))
      return new Set<string>();
    trace(
      `comment-retention: readLinesAtRef failed at ${ref ?? "the worktree"}: ${errText(err).slice(0, 120)}`,
    );
    return undefined;
  }
}

/** Does `ref` resolve to a commit? Any error counts as unresolved. */
async function refResolves(
  execFn: ExecFn,
  cwd: string,
  ref: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await execFn("git", {
      argv: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/** Empty diff: establish "nothing changed" POSITIVELY (#384 pattern). */
async function confirmEmptyDiff(
  execFn: ExecFn,
  cwd: string,
  baseRef: string,
  headRef: string,
  paths: string[],
  timeoutMs: number,
): Promise<LostCommentResult> {
  // An empty diff under the pathspec is legitimate (no changes under paths), but
  // a truncated or mis-invoked read could also yield one; cross-check the range
  // scoped to THE SAME validated paths and, if non-empty, report it rather than
  // silently passing as "nothing lost".
  let changedInRange = Number.NaN;
  try {
    // The PR's own commits under paths, from the merge base (#1134: a base that
    // moved after the branch was cut must not count here).
    changedInRange = await countPrCommits(execFn, cwd, baseRef, headRef, {
      pathspec: paths,
      timeout: timeoutMs,
    });
  } catch {
    changedInRange = Number.NaN; // unreadable — note, not pass
  }
  if (Number.isNaN(changedInRange)) {
    return {
      ok: false,
      reason: `diff empty and range ${baseRef}...${headRef} (under paths) unreadable — cannot establish "nothing changed"`,
    };
  }
  if (changedInRange > 0) {
    return {
      ok: false,
      reason: `diff empty but range ${baseRef}...${headRef} (under paths) has ${changedInRange} commit(s) (misread) — cannot trust an empty diff`,
    };
  }
  return { ok: true, lost: [], exempt: 0 };
}

/** Message of a caught value, whatever it is (an `Error`, a string, or junk). */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find comment lines removed between base and head that are not retained
 * (their trimmed text reappears under `paths` at head) and not exempt (their
 * nearest following removed code line is also gone). Two inputs: a range
 * (`baseRef`..`headRef`, the develop gate and the lens review), or a diff STRING
 * (the adversarial round), with `headRef` undefined meaning the WORKING TREE
 * (the uncommitted /work diff). Uses a normal-context diff (not `-U0`) so
 * multi-line comment blocks stay in one hunk. Reads the head tree under `paths`
 * ONCE and searches in memory. `paths` scopes ALL THREE operations (the diff,
 * the "still exists at head" search, and the exemption's code-reappearance
 * check). Every ref and path is validated here, once, before any shell
 * interpolation. Returns `ok: false` on a validation failure; callers that need
 * a guarantee against exceptions use `checkComments`.
 */
export async function findLostComments(
  execFn: ExecFn,
  cwd: string,
  baseRef: string | undefined,
  headRef: string | undefined,
  paths: string[],
  timeoutMs: number = DEFAULT_COMMENT_TIMEOUT_MS,
  diff?: string,
): Promise<LostCommentResult> {
  if (baseRef === undefined && diff === undefined) {
    return { ok: false, reason: "no base ref or diff to check" };
  }
  if (baseRef !== undefined && !isSafeRef(baseRef)) {
    return {
      ok: false,
      reason: `unsafe ref (${baseRef}) — refusing shell interpolation`,
    };
  }
  if (headRef !== undefined && !isSafeRef(headRef)) {
    return {
      ok: false,
      reason: `unsafe ref (${headRef}) — refusing shell interpolation`,
    };
  }
  if (!isSafePathList(paths)) {
    return { ok: false, reason: "unsafe path — refusing shell interpolation" };
  }
  if (diff !== undefined) {
    if (!diff.trim()) return { ok: true, lost: [], exempt: 0 };
    return classifyDiff(execFn, cwd, diff, headRef, paths, timeoutMs);
  }
  // Range mode: both ends are required. (`baseRef` is defined by the guard above.)
  if (baseRef === undefined || headRef === undefined) {
    return {
      ok: false,
      reason: "range check needs both a base and a head ref",
    };
  }
  let rangeDiff: string;
  // 1. The diff (normal context, so comment blocks stay contiguous).
  try {
    const { stdout } = await execFn("git", {
      argv: ["diff", "--end-of-options", prRange(baseRef, headRef), "--", ...paths],
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    rangeDiff = stdout;
  } catch (err) {
    trace(`comment-retention: git diff failed: ${errText(err).slice(0, 120)}`);
    return { ok: false, reason: "git diff failed" };
  }
  if (!rangeDiff.trim()) {
    return confirmEmptyDiff(execFn, cwd, baseRef, headRef, paths, timeoutMs);
  }
  return classifyDiff(execFn, cwd, rangeDiff, headRef, paths, timeoutMs);
}

/**
 * Classify a diff's removed comments against the head tree. `headRef`
 * undefined reads the WORKING TREE (tracked files) — the uncommitted /work diff.
 */
async function classifyDiff(
  execFn: ExecFn,
  cwd: string,
  diff: string,
  headRef: string | undefined,
  paths: string[],
  timeoutMs: number,
): Promise<LostCommentResult> {
  const parsed = parseHunks(diff);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  // Nothing removed a comment: nothing can be lost, so skip the head-tree read.
  const removedComment = parsed.hunks.some((h) =>
    h.lines.some((l) => l.kind === "removed" && l.isComment),
  );
  if (!removedComment) return { ok: true, lost: [], exempt: 0 };

  // 2. Read the head tree under paths ONCE and search in memory.
  const headSet = await readLinesAtRef(execFn, cwd, headRef, paths, timeoutMs);
  if (headSet === undefined) {
    return {
      ok: false,
      reason: "head tree unreadable",
    };
  }
  // Retained = the trimmed line reappears verbatim, or as a substring of a head
  // line (a comment moved onto a code line, with or without trailing text, or
  // re-wrapped onto a longer line). Only word-bearing text is matched in part:
  // `}`, `*/` or `/**` must not be retained by any head line that contains them.
  // Scanned only for removed comments with no verbatim match, so the cost is
  // bounded by the number of removed comments, not by the tree size.
  const containsCache = new Map<string, boolean>();
  const presentAtHead = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    if (headSet.has(t)) return true;
    if (!hasWord(t)) return false;
    const cached = containsCache.get(t);
    if (cached !== undefined) return cached;
    let found = false;
    for (const line of headSet) {
      if (line.includes(t)) {
        found = true;
        break;
      }
    }
    containsCache.set(t, found);
    return found;
  };

  const lost: LostComment[] = [];
  let exempt = 0;
  for (const hunk of parsed.hunks) {
    const v = classifyHunk(hunk, presentAtHead);
    lost.push(...v.lost);
    exempt += v.exempt;
  }
  return { ok: true, lost, exempt };
}

/**
 * Never throws: any exception becomes `ok: false`, so a crashed check is shown
 * to the reviewers as NOT CHECKED rather than as a clean diff.
 */
export async function checkComments(
  execFn: ExecFn,
  cwd: string,
  baseRef: string | undefined,
  headRef: string | undefined,
  paths: string[],
  timeoutMs: number,
  diff?: string,
): Promise<LostCommentResult> {
  try {
    return await findLostComments(execFn, cwd, baseRef, headRef, paths, timeoutMs, diff);
  } catch (err) {
    trace(`comment-retention: check threw: ${errText(err).slice(0, 120) || "error"}`);
    return { ok: false, reason: "check threw" };
  }
}

/** Escape-hatch gate. Honours `PI_ENSEMBLE_COMMENT_RETENTION=0`. */
export function commentRetentionEnabled(): boolean {
  return process.env.PI_ENSEMBLE_COMMENT_RETENTION !== "0";
}

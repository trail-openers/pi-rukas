/**
 * comment-retention — mechanical guard against deleted comments (#948).
 *
 * Developers repeatedly delete or compress pre-existing comments to get
 * under the 500-line file cap. This module detects, from a diff, comment
 * lines that are REMOVED at base but whose (trimmed) text does not reappear
 * anywhere under `paths` at the head ref, and treats such lines as "lost".
 *
 * Exemption (the one rule, per the PM decision): a removed comment is
 * EXEMPT iff the nearest following removed line in the same hunk that is not
 * a comment line is a CODE line AND that code line's trimmed text does not
 * appear under `paths` at headRef (the code it documented was deleted too).
 * Multi-line block comments share the block's exemption status.
 *
 * `paths` scopes ALL THREE operations (the diff, the "still exists at head"
 * search, and the exemption's code-reappearance check).
 *
 * Infra errors (unreadable base, git failure) degrade to a NOTE — callers
 * turn this module's failure union into a note, never a failure.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFn } from "./worktree.ts";

/**
 * A real shell `ExecFn` built on `promisify(exec)`, for callers (e.g. the
 * adversarial report line) that have no injected seam. The driver's gates use
 * an injected `ExecFn` instead; this one is the production default.
 */
export function makeExecFn(): ExecFn {
  const execp = promisify(exec);
  return (cmd, opts) =>
    execp(cmd, { cwd: opts?.cwd, timeout: opts?.timeout, maxBuffer: opts?.maxBuffer });
}

/** The paths the diff / existence / exemption searches are scoped to. */
export const COMMENT_RETENTION_PATHS = ["extension/src", "extension/smoke-tests", "agents-base"];

const VALID_SHA_RE = /^[0-9a-f]{40}$/;
/** Strict refname allowlist (no leading `-`) for non-SHA refs. */
const VALID_REFNAME_RE = /^[A-Za-z0-9._/-]+$/;

function isSafeRef(ref: string): boolean {
  if (!ref || ref.startsWith("-")) return false;
  return VALID_SHA_RE.test(ref) || VALID_REFNAME_RE.test(ref);
}

export type LostCommentResult =
  | { ok: true; lost: string[]; exempt: number }
  | { ok: false; reason: string };

// Leading-`*` line forms. Bare `*` or `**` are always a block-closer comment.
// A prose `* text` line is a block continuation ONLY when the previous line was
// also a comment (we are inside a block). An arithmetic continuation (` * b;`
// after `const y = a`) has a non-comment predecessor and is NOT a comment.
const STAR_BARE_RE = /^\*(\*)?$/;
const STAR_PROSE_RE = /^\*(\*\/?)?\s\S/;

/**
 * A whole-line comment: a double-slash line, a block-open line, a block-close
 * line, or a block-continuation star line.
 *
 * `inBlock` is `true` when the previous line was also a comment (we are
 * inside a block comment). A prose `* text` line is a comment only when
 * `inBlock` is true; a bare `*` or `**` is always a comment (block closer).
 * This stops an arithmetic continuation (` * b;` after `const y = a`) from
 * being misread as a JSDoc continuation.
 */
function isCommentLine(raw: string, inBlock: boolean): boolean {
  const t = raw.trim();
  if (t.startsWith("//") || t.startsWith("/*")) return true;
  if (t.startsWith("*")) {
    if (STAR_BARE_RE.test(t)) return true;
    return inBlock && STAR_PROSE_RE.test(t);
  }
  return t.endsWith("*/") && t.length > 2; // closing of a block comment
}

/**
 * Read every file under `paths` at `ref` (one `git grep -e ""` read, not N
 * per-file greps) and return the set of line contents present at that ref.
 * Returns `undefined` when the read itself fails (an infra error the caller
 * turns into a NOTE).
 */
async function readLinesAtRef(
  execFn: ExecFn,
  cwd: string,
  ref: string,
  paths: string[],
): Promise<Set<string> | undefined> {
  const pathArg = paths.join(" ");
  try {
    const { stdout } = await execFn(`git grep -e "" ${ref} -- ${pathArg}`, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    const set = new Set<string>();
    for (const line of stdout.split("\n")) {
      // `git grep -e "" <ref> -- <paths>` emits `ref:file:line`. The first
      // colon after the ref marks the path; the line content is what follows
      // the SECOND colon.
      const first = line.indexOf(":");
      if (first < 0) continue;
      const second = line.indexOf(":", first + 1);
      if (second < 0) continue;
      set.add(line.slice(second + 1));
    }
    return set;
  } catch {
    return undefined;
  }
}

/**
 * Find comment lines removed between base and head that are not retained
 * (their trimmed text reappears under `paths` at head) and not exempt (their
 * nearest following removed code line is also gone).
 *
 * Uses a normal-context diff (not `-U0`) so multi-line comment blocks stay in
 * one hunk. Reads the head tree under `paths` ONCE and searches in memory.
 */
export async function findLostComments(
  execFn: ExecFn,
  cwd: string,
  baseRef: string,
  headRef: string,
  paths: string[],
): Promise<LostCommentResult> {
  if (!isSafeRef(baseRef) || !isSafeRef(headRef)) {
    return {
      ok: false,
      reason: `unsafe ref (${baseRef} / ${headRef}) — refusing shell interpolation`,
    };
  }
  const pathArg = paths.join(" ");

  // 1. The diff (normal context, so comment blocks stay contiguous).
  let diff: string;
  try {
    const { stdout } = await execFn(`git diff ${baseRef}...${headRef} -- ${pathArg}`, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    diff = stdout;
  } catch (err) {
    return {
      ok: false,
      reason: `git diff failed: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
    };
  }
  if (!diff.trim()) return { ok: true, lost: [], exempt: 0 };

  // 2. Read the head tree under paths ONCE and search in memory.
  const headLines = await readLinesAtRef(execFn, cwd, headRef, paths);
  if (headLines === undefined) {
    return {
      ok: false,
      reason: `could not read head tree at ${headRef} under ${pathArg}`,
    };
  }
  const presentAtHead = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    for (const line of headLines) if (line.includes(t)) return true;
    return false;
  };

  // 3. Walk removed lines, tagging each with `isComment`. A prose `* text`
  // line is a comment only when the previous removed line was also a comment
  // (we are inside a block); `inBlock` tracks that.
  const removed: Array<{ raw: string; isComment: boolean }> = [];
  let inBlock = false;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("-") || line.startsWith("---")) continue;
    const raw = line.slice(1);
    const isComment = isCommentLine(raw, inBlock);
    removed.push({ raw, isComment });
    inBlock = isComment;
  }

  const lost: string[] = [];
  let exempt = 0;
  let i = 0;
  while (i < removed.length) {
    const cur = removed[i];
    if (!cur?.isComment) {
      i++;
      continue;
    }
    // Collect the comment block (consecutive removed comment lines).
    const block: string[] = [];
    while (i < removed.length) {
      const c = removed[i];
      if (!c?.isComment) break;
      block.push(c.raw);
      i++;
    }
    // Nearest following removed non-comment line (the exemption's code line).
    let followIdx = -1;
    for (let j = i; j < removed.length; j++) {
      const c = removed[j];
      if (c && !c.isComment) {
        followIdx = j;
        break;
      }
    }
    // Exemption: the nearest following removed code line's text does NOT
    // reappear at head — the code the comment documented was deleted too.
    if (followIdx >= 0) {
      const follow = removed[followIdx]?.raw;
      if (follow?.trim() && !presentAtHead(follow)) {
        exempt += block.length;
        continue;
      }
    }
    // Otherwise a comment line is lost iff its trimmed text is not retained.
    for (const line of block) {
      if (presentAtHead(line)) continue;
      lost.push(line.trim());
    }
  }
  return { ok: true, lost, exempt };
}

/** Escape-hatch gate. Honours `PI_ENSEMBLE_COMMENT_RETENTION=0`. */
export function commentRetentionEnabled(): boolean {
  return process.env.PI_ENSEMBLE_COMMENT_RETENTION !== "0";
}

/** Max lost-comment lines listed in a failure row before "N more". */
export const MAX_LISTED_LOST = 20;

/** Build the gate failure row (up to 20 lost lines + "N more"). */
export function formatLostComments(lost: string[], exempt: number): string {
  const shown = lost.slice(0, MAX_LISTED_LOST);
  const more = lost.length - shown.length;
  const lines = shown.map((l) => `    ${l}`).join("\n");
  const tail = more > 0 ? `\n    … and ${more} more` : "";
  return `comment-retention: ${lost.length} pre-existing comment line(s) deleted without reappearing (exempt: ${exempt})\n${lines}${tail}`;
}

/** Build the `comments:` line appended to an adversarial report. */
export function formatReportLine(lost: string[], exempt: number): string {
  if (lost.length === 0) return `comments: lost=0 (exempt: ${exempt})`;
  const shown = lost.slice(0, MAX_LISTED_LOST);
  const more = lost.length - shown.length;
  const lines = shown.map((l) => `  - ${l}`).join("\n");
  const tail = more > 0 ? `  … and ${more} more` : "";
  return `comments: lost=${lost.length} (exempt: ${exempt})\n${lines}${tail}`;
}

/**
 * #948 — compute the comment-retention report line for the adversarial loop.
 * With a ref range, runs the check in `cwd` against `range.base`...`range.head`
 * (a real `ExecFn`); a git/ref error degrades to `not-run` (infra errors are
 * never a failure here — the /work develop gate is what fails on lost
 * comments). Without a range, the check cannot run (no base ref).
 */
export async function buildCommentsLine(
  range: { base: string; head: string } | null,
  cwd: string,
  execFn: ExecFn = makeExecFn(),
  paths: string[] = COMMENT_RETENTION_PATHS,
): Promise<string> {
  if (!range) return "comments: not-run (no base ref)";
  try {
    const res = await findLostComments(execFn, cwd, range.base, range.head, paths);
    if (!res.ok) return `comments: not-run (${res.reason})`;
    return formatReportLine(res.lost, res.exempt);
  } catch (err) {
    return `comments: not-run (${(err as Error).message?.slice(0, 80) ?? "error"})`;
  }
}

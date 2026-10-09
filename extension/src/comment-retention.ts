/**
 * comment-retention — mechanical guard against deleted comments (#948).
 *
 * Developers repeatedly delete or compress pre-existing comments to get
 * under the 500-line file cap. This module detects, from a diff, comment
 * lines that are REMOVED at base but whose (trimmed) text does not reappear
 * anywhere under `paths` at the head ref, and treats such lines as "lost".
 *
 * Exemption (per the PM decision): a removed comment is EXEMPT iff the
 * nearest following removed line in the same hunk that is not a comment line
 * is a CODE line AND that code line's trimmed text does not appear under
 * `paths` at headRef (the code it documented was deleted too). Multi-line
 * block comments share the block's exemption status.
 *
 * Replacement (the #1017 false-positive fix): a removed comment is
 * REPLACED (reported in a separate `replaced` bucket — a note, never a
 * failure) when BOTH conditions hold within the SAME hunk: (a) the comment
 * annotated code that was deleted or changed — i.e. the nearest following
 * removed line in the hunk is a code line that no longer exists at head (the
 * same hunk-local test as the exemption, but the annotation code's OLD FORM
 * is gone, whether deleted or rewritten); AND (b) at least one new comment
 * line was added in that same hunk. An added comment in a NEARBY but
 * different hunk does not count — the added-comment signal is hunk-local.
 * The replaced bucket is disjoint from `exempt` and `lost`: a block is
 * counted in exactly one bucket, and the report never lists a line as both.
 *
 * `paths` scopes ALL THREE operations (the diff, the "still exists at head"
 * search, and the exemption's code-reappearance check).
 *
 * Infra errors (unreadable base, git failure) degrade to a NOTE — callers
 * turn this module's failure union into a note, never a failure.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
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

/**
 * Path tokens are interpolated into the ExecFn's shell string (the same
 * injection class the harness already guards for refs — PR338 / `isSafeRef`).
 * A path may be `PI_ENSEMBLE_COMMENT_RETENTION_PATHS`-shaped env input, so
 * every token is validated BEFORE any exec; a failing token makes the whole
 * call an infra note (never a failure, never an exec). No leading `-` (git
 * option injection), no whitespace or shell metacharacters (word splitting /
 * injection — a whitespace-split token also made `git diff` silently match
 * nothing, a gate no-op that passed without a note).
 */
const VALID_PATH_RE = /^[A-Za-z0-9._/-]+$/;

function isSafePathList(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => !p.startsWith("-") && VALID_PATH_RE.test(p));
}

export type LostCommentResult =
  | { ok: true; lost: string[]; replaced: string[]; exempt: number }
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
 * per-file greps) and return the line contents present at that ref as both
 * the raw lines (for the substring fallback) and a trimmed set (for the O(1)
 * exact lookup).
 * Returns `undefined` when the read itself fails (an infra error the caller
 * turns into a NOTE).
 */
async function readLinesAtRef(
  execFn: ExecFn,
  cwd: string,
  ref: string,
  paths: string[],
): Promise<{ lines: Set<string>; trimmed: Set<string> } | undefined> {
  const pathArg = paths.join(" ");
  try {
    const { stdout } = await execFn(`git grep -e "" ${ref} -- ${pathArg}`, {
      cwd,
      timeout: verifyTimeoutMs(),
      maxBuffer: 64 * 1024 * 1024,
    });
    const set = new Set<string>();
    const trimmed = new Set<string>();
    for (const line of stdout.split("\n")) {
      // `git grep -e "" <ref> -- <paths>` emits `ref:file:line`. The first
      // colon after the ref marks the path; the line content is what follows
      // the SECOND colon.
      const first = line.indexOf(":");
      if (first < 0) continue;
      const second = line.indexOf(":", first + 1);
      if (second < 0) continue;
      const content = line.slice(second + 1);
      set.add(content);
      trimmed.add(content.trim());
    }
    return { lines: set, trimmed };
  } catch (err) {
    trace(
      `comment-retention: readLinesAtRef failed at ${ref}: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
    );
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
  if (!isSafePathList(paths)) {
    return {
      ok: false,
      reason: `unsafe path — refusing shell interpolation (${paths.join(", ").slice(0, 80)})`,
    };
  }
  const pathArg = paths.join(" ");

  // 1. The diff (normal context, so comment blocks stay contiguous).
  let diff: string;
  try {
    const { stdout } = await execFn(`git diff ${baseRef}...${headRef} -- ${pathArg}`, {
      cwd,
      timeout: verifyTimeoutMs(),
      maxBuffer: 16 * 1024 * 1024,
    });
    diff = stdout;
  } catch (err) {
    return {
      ok: false,
      reason: `git diff failed: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
    };
  }
  if (!diff.trim()) {
    // #384 pattern — establish empty POSITIVELY. An empty diff under the
    // pathspec is legitimate (no changes under paths), but a truncated or
    // mis-invoked read could also yield one; cross-check the range scoped to
    // THE SAME validated paths (a mis-invocation that makes the diff read
    // empty usually affects the pathspec, and an unscoped range would count
    // out-of-scope commits and skip the gate with a misleading note) and,
    // if the scoped range is non-empty, report it rather than silently
    // passing as "nothing lost".
    let changedInRange = -1;
    try {
      const { stdout } = await execFn(`git rev-list --count ${baseRef}..${headRef} -- ${pathArg}`, {
        cwd,
        timeout: verifyTimeoutMs(),
        maxBuffer: 1 * 1024 * 1024,
      });
      changedInRange = Number.parseInt(stdout.trim(), 10);
    } catch {
      changedInRange = -1; // unreadable — note, not pass
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
    return { ok: true, lost: [], replaced: [], exempt: 0 };
  }

  // 2. Read the head tree under paths ONCE and search in memory.
  const headLines = await readLinesAtRef(execFn, cwd, headRef, paths);
  if (headLines === undefined) {
    return {
      ok: false,
      reason: `could not read head tree at ${headRef} under ${pathArg}`,
    };
  }
  // An exact (trimmed) line lookup first — the common "retained verbatim"
  // case is O(1); the substring scan below stays only as a fallback (e.g. a
  // removed line that reappears as part of a longer line at head).
  const presentAtHead = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    if (headLines.trimmed.has(t)) return true;
    for (const line of headLines.lines) if (line.includes(t)) return true;
    return false;
  };

  // 3. Walk the diff, grouping lines by (file, hunk) BEFORE any adjacency or
  // "same hunk" test. A `@@` hunk header resets the block state; a `---` file
  // header is never content and never an annotated code line. `removed` holds
  // the removed lines; `added` holds the added lines (the hunk-local signal
  // the replacement rule needs — an added comment in a different hunk must
  // not satisfy it). The replacement rule's condition (a) uses the HUNK-LOCAL
  // signal: a removed code line in the hunk whose trimmed text does not appear
  // as an added code line in the same hunk means the annotated code's old form
  // is gone (deleted or changed). `presentAtHead` is used only for the
  // verbatim-retention check and the code-deleted exemption, not for (a).
  type HunkState = {
    addedComments: number;
    lastRemoved: { raw: string; isComment: boolean }[];
    addedCodeLines: Set<string>;
  };
  const hunkStates = new Map<string, HunkState>();
  const hunkKeyOf = (file: string, hunkSeq: number) => `${file}\x00${hunkSeq}`;
  let curFile: string | null = null;
  let hunkSeq = 0;
  let curHunkKey: string | null = null;
  let inBlock = false;
  const diffLines = diff.split("\n");
  for (let index = 0; index < diffLines.length; index++) {
    const line = diffLines[index] ?? "";
    if (line.startsWith("@@")) {
      hunkSeq++;
      curHunkKey = curFile !== null ? hunkKeyOf(curFile, hunkSeq) : null;
      if (curHunkKey !== null) {
        hunkStates.set(curHunkKey, {
          addedComments: 0,
          lastRemoved: [],
          addedCodeLines: new Set<string>(),
        });
      }
      inBlock = false; // block state does not span a hunk boundary
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim().split("\t")[0];
      curFile = p ?? "?";
      hunkSeq = 0;
      continue;
    }
    // A `---` header (the old path, right before its `+++` pair) — never
    // content, never an annotated code line. It can only appear where the
    // next line is a `+++ ` header, so we detect it by looking ahead.
    if (line.startsWith("---")) {
      const next = diffLines[index + 1];
      if (next?.startsWith("+++ ")) continue; // file header — skip
      // Otherwise it is a removed line whose content starts with `--`.
    }
    if (!line.startsWith("-")) {
      if (line.startsWith("+") && curHunkKey !== null) {
        const raw = line.slice(1);
        const st = hunkStates.get(curHunkKey);
        if (st) {
          const prevIsComment =
            st.lastRemoved.length > 0 && st.lastRemoved.at(-1)?.isComment === true;
          if (isCommentLine(raw, prevIsComment)) {
            st.addedComments++;
          } else {
            st.addedCodeLines.add(raw.trim());
          }
        }
      }
      continue;
    }
    const raw = line.slice(1);
    const isComment = isCommentLine(raw, inBlock);
    if (curHunkKey !== null) {
      const st = hunkStates.get(curHunkKey);
      if (st) {
        st.lastRemoved.push({ raw, isComment });
      }
    }
    inBlock = isComment;
  }

  const lost: string[] = [];
  const replaced: string[] = [];
  let exempt = 0;
  for (const [file, hunk] of hunkStates.entries()) {
    const removed = hunk.lastRemoved;
    const hunkHasAddedComment = hunk.addedComments > 0;
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
      // Since #1040 this search is hunk-local: it never crosses a hunk boundary.
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
      // Since #1040 such a block is reported as replaced (not exempt) when its
      // hunk also adds a comment line. (Code-deleted exemption, keeps #1019 / #948 case (c).)
      if (followIdx >= 0) {
        const follow = removed[followIdx]?.raw;
        if (follow?.trim() && !presentAtHead(follow)) {
          if (hunkHasAddedComment) replaced.push(...block.map((l) => l.trim()));
          else exempt += block.length;
          continue;
        }
      }
      // Replacement rule (the #1017 fix): condition (a) — the block's nearest
      // following removed code line (if any) was CHANGED in this hunk (its
      // trimmed text is not among the added code lines in the same hunk;
      // the exemption above already handles the deleted case, so by here the
      // code line still exists at head in a new form). Condition (b) — a new
      // comment line was added in the same hunk. Both must hold.
      const blockCodeChanged =
        followIdx >= 0 &&
        (() => {
          const follow = removed[followIdx]?.raw;
          if (!follow?.trim()) return false;
          return !hunk.addedCodeLines.has(follow.trim());
        })();
      if (hunkHasAddedComment && blockCodeChanged) {
        replaced.push(...block.map((l) => l.trim()));
        continue;
      }
      // Otherwise a comment line is lost iff its trimmed text is not retained.
      // (verbatim or substring) anywhere under `paths` at head. An added
      // comment with the annotated code unchanged does NOT make the drop a
      // replacement (that keeps the #1019 true positive).
      for (const line of block) {
        if (presentAtHead(line)) continue;
        lost.push(line.trim());
      }
    }
  }
  return { ok: true, lost, replaced, exempt };
}

/** Escape-hatch gate. Honours `PI_ENSEMBLE_COMMENT_RETENTION=0`. */
export function commentRetentionEnabled(): boolean {
  return process.env.PI_ENSEMBLE_COMMENT_RETENTION !== "0";
}

/** Max lost-comment lines listed in a failure row before "N more". */
export const MAX_LISTED_LOST = 20;

/** Build the gate failure row (up to 20 lost lines + "N more"). */
export function formatLostComments(lost: string[], exempt: number, replaced = 0): string {
  const shown = lost.slice(0, MAX_LISTED_LOST);
  const more = lost.length - shown.length;
  const lines = shown.map((l) => `    ${l}`).join("\n");
  const tail = more > 0 ? `\n    … and ${more} more` : "";
  return `comment-retention: ${lost.length} pre-existing comment line(s) deleted without reappearing (replaced: ${replaced}, exempt: ${exempt})\n${lines}${tail}`;
}

/** Build the note row for comments that were replaced, not lost. */
export function formatReplacedComments(replaced: string[]): string {
  const shown = replaced.slice(0, MAX_LISTED_LOST);
  const more = replaced.length - shown.length;
  const lines = shown.map((l) => `    ${l}`).join("\n");
  const tail = more > 0 ? `\n    … and ${more} more` : "";
  return `comment-retention: ${replaced.length} comment line(s) replaced in the same hunk (not a loss)\n${lines}${tail}`;
}

/** Build the `comments:` line appended to an adversarial report. */
export function formatReportLine(lost: string[], replaced: string[], exempt: number): string {
  const head = `comments: lost=${lost.length} (replaced: ${replaced.length}, exempt: ${exempt})`;
  const parts = [head];
  if (lost.length > 0) {
    const shown = lost.slice(0, MAX_LISTED_LOST);
    const more = lost.length - shown.length;
    parts.push(...shown.map((l) => `  - ${l}`));
    if (more > 0) parts.push(`  … and ${more} more`);
  }
  if (replaced.length > 0) {
    parts.push(`  replaced: ${replaced.map((l) => `"${l}"`).join(", ")}`);
  }
  return parts.join("\n");
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
    return formatReportLine(res.lost, res.replaced, res.exempt);
  } catch (err) {
    return `comments: not-run (${(err as Error).message?.slice(0, 80) ?? "error"})`;
  }
}

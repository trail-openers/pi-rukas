/**
 * comment-retention — mechanical guard against deleted comments (#948).
 *
 * Developers repeatedly delete or compress pre-existing comments to get
 * under the 500-line file cap. This module finds comment lines REMOVED between
 * base and head whose text does not reappear under `paths` at head, and
 * classifies each removed block as lost, replaced (a note) or exempt. The
 * per-hunk rules live in comment-retention-hunks.ts; this module runs the git
 * reads, the orchestration and the report formatting.
 *
 * `paths` scopes ALL operations (the diff, the head-tree read).
 *
 * Infra errors (unreadable base, git failure, an unparseable hunk header)
 * degrade to a NOTE — callers turn this module's failure union into a note,
 * never a failure.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyHunk, parseHunks } from "./comment-retention-hunks.ts";
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
    execp(cmd, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
      maxBuffer: opts?.maxBuffer,
    });
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
 * Every token is validated BEFORE any exec. No leading `-` (git option
 * injection), no whitespace or shell metacharacters.
 */
const VALID_PATH_RE = /^[A-Za-z0-9._/-]+$/;

function isSafePathList(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => !p.startsWith("-") && VALID_PATH_RE.test(p));
}

export type LostCommentResult =
  | { ok: true; lost: string[]; replaced: string[]; exempt: number }
  | { ok: false; reason: string };

/**
 * Read every file under `paths` at `ref` (one `git grep -e ""` read) and return
 * the trimmed line contents. Returns `undefined` when the read itself fails.
 */
async function readLinesAtRef(
  execFn: ExecFn,
  cwd: string,
  ref: string,
  paths: string[],
): Promise<string[] | undefined> {
  const pathArg = paths.join(" ");
  try {
    const { stdout } = await execFn(`git grep -e "" ${ref} -- ${pathArg}`, {
      cwd,
      timeout: verifyTimeoutMs(),
      maxBuffer: 64 * 1024 * 1024,
    });
    const out: string[] = [];
    for (const line of stdout.split("\n")) {
      // `git grep -e "" <ref> -- <paths>` emits `ref:file:line`; the line
      // content is what follows the SECOND colon.
      const first = line.indexOf(":");
      if (first < 0) continue;
      const second = line.indexOf(":", first + 1);
      if (second < 0) continue;
      out.push(line.slice(second + 1).trim());
    }
    return out;
  } catch (err) {
    // `git grep` exits 1 when nothing matches: an empty head tree under paths
    // (every in-scope file deleted), not an infra failure.
    if ((err as { code?: unknown }).code === 1) return [];
    trace(
      `comment-retention: readLinesAtRef failed at ${ref}: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
    );
    return undefined;
  }
}

/** Empty diff: establish "nothing changed" POSITIVELY (#384 pattern). */
async function confirmEmptyDiff(
  execFn: ExecFn,
  cwd: string,
  baseRef: string,
  headRef: string,
  pathArg: string,
): Promise<LostCommentResult> {
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

/**
 * Find comment lines removed between base and head that are not retained and
 * not exempt or replaced. Uses a normal-context diff (not `-U0`) so comment
 * blocks stay in one hunk. Reads the head tree under `paths` ONCE.
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
  if (!diff.trim()) return confirmEmptyDiff(execFn, cwd, baseRef, headRef, pathArg);

  const parsed = parseHunks(diff);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const headList = await readLinesAtRef(execFn, cwd, headRef, paths);
  if (headList === undefined) {
    return {
      ok: false,
      reason: `could not read head tree at ${headRef} under ${pathArg}`,
    };
  }
  const headSet = new Set(headList);
  // Retained = the trimmed line reappears verbatim, or as the trailing part of
  // a head line (a comment moved to the end of a code line). A comment that
  // merely prefixes a longer comment at head is NOT retained.
  const presentAtHead = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    if (headSet.has(t)) return true;
    return headList.some((l) => l.endsWith(t));
  };

  const lost: string[] = [];
  const replaced: string[] = [];
  let exempt = 0;
  for (const hunk of parsed.hunks) {
    const v = classifyHunk(hunk, presentAtHead);
    lost.push(...v.lost);
    replaced.push(...v.replaced);
    exempt += v.exempt;
  }
  return { ok: true, lost, replaced, exempt };
}

/** Escape-hatch gate. Honours `PI_ENSEMBLE_COMMENT_RETENTION=0`. */
export function commentRetentionEnabled(): boolean {
  return process.env.PI_ENSEMBLE_COMMENT_RETENTION !== "0";
}

/** Max lost-comment lines listed in a failure row before "N more". */
export const MAX_LISTED_LOST = 20;

type RetentionCounts = { lost: string[]; replaced: string[]; exempt: number };

/** Build the gate failure row (up to 20 lost lines + "N more"). */
export function formatLostComments(res: RetentionCounts): string {
  const shown = res.lost.slice(0, MAX_LISTED_LOST);
  const more = res.lost.length - shown.length;
  const lines = shown.map((l) => `    ${l}`).join("\n");
  const tail = more > 0 ? `\n    … and ${more} more` : "";
  return `comment-retention: ${res.lost.length} lost, ${res.replaced.length} replaced (exempt: ${res.exempt})\n${lines}${tail}`;
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
export function formatReportLine(res: RetentionCounts): string {
  const head = `comments: lost=${res.lost.length} (replaced: ${res.replaced.length}, exempt: ${res.exempt})`;
  const parts = [head];
  if (res.lost.length > 0) {
    const shown = res.lost.slice(0, MAX_LISTED_LOST);
    const more = res.lost.length - shown.length;
    parts.push(...shown.map((l) => `  - ${l}`));
    if (more > 0) parts.push(`  … and ${more} more`);
  }
  if (res.replaced.length > 0) {
    parts.push(`  replaced: ${res.replaced.map((l) => `"${l}"`).join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * #948 — compute the comment-retention report line for the adversarial loop.
 * Without a range the check cannot run; a git/ref error degrades to `not-run`.
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
    return formatReportLine(res);
  } catch (err) {
    return `comments: not-run (${(err as Error).message?.slice(0, 80) ?? "error"})`;
  }
}

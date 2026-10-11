/**
 * comment-retention — mechanical guard against deleted comments (#948).
 *
 * Developers repeatedly delete or compress pre-existing comments to get
 * under the 500-line file cap. This module finds comment lines REMOVED between
 * base and head whose text does not reappear under `paths` at head, and
 * classifies each removed block as retained, exempt or lost (the rules live in
 * comment-retention-hunks.ts).
 *
 * A LOST comment is evidence, not a failure: the develop gate records it as a
 * note, and the adversarial reviewer and the six-lens review receive it as a
 * "Comments removed by this change" section to judge (`lostCommentsSection`).
 * Infra errors (unreadable base, git failure, an unparseable hunk header) make
 * this module return `ok: false`; callers turn those into a note as well.
 *
 * `paths` scopes ALL operations (the diff, the head-tree read).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { type LostComment, classifyHunk, parseHunks, wordsOf } from "./comment-retention-hunks.ts";
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
  | { ok: true; lost: LostComment[]; exempt: number }
  | { ok: false; reason: string };

/** The exit code of a child-process failure, or undefined for any other value. */
function execExitCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
}

/**
 * Read every file under `paths` at `ref` (one `git grep -e ""` read) and return
 * the set of trimmed line contents. Returns `undefined` when the read itself
 * fails. `git grep` exits 1 when nothing matches: that is an empty head tree
 * under `paths` only when the ref resolves; otherwise the read is unreadable.
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
      timeout: verifyTimeoutMs(),
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = new Set<string>();
    for (const line of stdout.split("\n")) {
      // `git grep -e "" <ref> -- <paths>` emits `ref:file:line`; the line
      // content is what follows the SECOND colon.
      const first = line.indexOf(":");
      if (first < 0) continue;
      const second = line.indexOf(":", first + 1);
      if (second < 0) continue;
      out.add(line.slice(second + 1).trim());
    }
    return out;
  } catch (err) {
    if (execExitCode(err) === 1 && (await refResolves(execFn, cwd, ref))) return new Set<string>();
    trace(
      `comment-retention: readLinesAtRef failed at ${ref}: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
    );
    return undefined;
  }
}

/** Does `ref` resolve to a commit? Any error counts as unresolved. */
async function refResolves(execFn: ExecFn, cwd: string, ref: string): Promise<boolean> {
  try {
    await execFn(`git rev-parse --verify "${ref}^{commit}"`, {
      cwd,
      timeout: verifyTimeoutMs(),
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
  pathArg: string,
): Promise<LostCommentResult> {
  // #384 pattern — establish empty POSITIVELY. An empty diff under the
  // pathspec is legitimate (no changes under paths), but a truncated or
  // mis-invoked read could also yield one; cross-check the range scoped to
  // THE SAME validated paths (a mis-invocation that makes the diff read
  // empty usually affects the pathspec, and an unscoped range would count
  // out-of-scope commits and skip the gate with a misleading note) and,
  // if the scoped range is non-empty, report it rather than silently
  // passing as "nothing lost".
  let changedInRange = Number.NaN;
  try {
    const { stdout } = await execFn(`git rev-list --count ${baseRef}..${headRef} -- ${pathArg}`, {
      cwd,
      timeout: verifyTimeoutMs(),
      maxBuffer: 1 * 1024 * 1024,
    });
    changedInRange = Number.parseInt(stdout.trim(), 10);
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

/**
 * Find comment lines removed between base and head that are neither retained
 * nor exempt. Uses a normal-context diff (not `-U0`) so comment blocks stay in
 * one hunk. Reads the head tree under `paths` ONCE, and only when a hunk
 * actually removed a comment line.
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

  // Nothing removed a comment: nothing can be lost, so skip the head-tree read.
  const removedComment = parsed.hunks.some((h) =>
    h.lines.some((l) => l.kind === "removed" && l.isComment),
  );
  if (!removedComment) return { ok: true, lost: [], exempt: 0 };

  const headSet = await readLinesAtRef(execFn, cwd, headRef, paths);
  if (headSet === undefined) {
    return {
      ok: false,
      reason: `could not read head tree at ${headRef} under ${pathArg}`,
    };
  }
  // Retained = the trimmed line reappears verbatim, or as the trailing part of
  // a head line (a comment moved to the end of a code line). A comment that
  // merely prefixes a longer comment at head is NOT retained.
  const presentAtHead = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    if (headSet.has(t)) return true;
    // Trailing-part retention needs a word-bearing tail: `}`, `*/` or `/**`
    // must not be "retained" by any head line that happens to end in them.
    if (!/[\p{L}\p{N}]/u.test(t)) return false;
    // Trailing-part retention needs real words: `}` or `*/` must not match.
    return wordsOf(t).length >= 2 && [...headSet].some((l) => l.endsWith(t));
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

/** Escape-hatch gate. Honours `PI_ENSEMBLE_COMMENT_RETENTION=0`. */
export function commentRetentionEnabled(): boolean {
  return process.env.PI_ENSEMBLE_COMMENT_RETENTION !== "0";
}

/** Max lost-comment lines listed in a note or report before "N more". */
export const MAX_LISTED_LOST = 20;

/** The lost lines, each with the added comment lines of its hunk as context. */
function renderLost(lost: LostComment[]): string[] {
  const shown = lost.slice(0, MAX_LISTED_LOST);
  const out: string[] = [];
  for (const l of shown) {
    out.push(`    ${l.file}: ${l.text}`);
    if (l.addedNearby.length > 0) {
      out.push(`      added nearby: ${l.addedNearby.slice(0, 3).join(" | ")}`);
    }
  }
  const more = lost.length - shown.length;
  if (more > 0) out.push(`    … and ${more} more`);
  return out;
}

/**
 * The develop-gate note for lost comments. Evidence for the reviewers — never a
 * failure, so it carries no verdict.
 */
export function formatLostComments(res: { lost: LostComment[]; exempt: number }): string {
  return [
    `comment-retention: ${res.lost.length} comment line(s) removed and not retained (exempt: ${res.exempt}) — evidence for the reviewers, not a failure`,
    ...renderLost(res.lost),
  ].join("\n");
}

/** Build the `comments:` line appended to an adversarial report. */
export function formatReportLine(res: { lost: LostComment[]; exempt: number }): string {
  return [
    `comments: lost=${res.lost.length} (exempt: ${res.exempt})`,
    ...renderLost(res.lost),
  ].join("\n");
}

/**
 * The "Comments removed by this change" section handed to the adversarial
 * reviewer and the six-lens review. Empty string when nothing was lost or the
 * check could not run — the section never claims a comment it did not see.
 */
export async function lostCommentsSection(
  range: { base: string; head: string } | null,
  cwd: string,
  execFn: ExecFn = makeExecFn(),
  paths: string[] = COMMENT_RETENTION_PATHS,
): Promise<string> {
  if (!range) return "";
  try {
    const res = await findLostComments(execFn, cwd, range.base, range.head, paths);
    if (!res.ok || res.lost.length === 0) return "";
    return [
      "",
      'Comments removed by this change (mechanical scan — each line below was deleted and its text does not survive at head; "added nearby" lists the comment lines this change wrote in the same hunk):',
      ...renderLost(res.lost),
      "",
      "Judge each removal. LEGITIMATE: the code the comment described was removed or rewritten, or the comment was replaced by an equivalent. LOSS: the comment still documents code that exists at head, or it carried a constraint or rationale nothing else records. Report an unjustified loss as an ISSUES finding; do not report a legitimate removal.",
    ].join("\n");
  } catch (err) {
    trace(`comment-retention: lostCommentsSection failed: ${(err as Error).message?.slice(0, 80)}`);
    return "";
  }
}

/**
 * #948 — compute the comment-retention report line for the adversarial loop.
 * With a ref range, runs the check in `cwd` against `range.base`...`range.head`
 * (a real `ExecFn`); a git/ref error degrades to `not-run` (infra errors are
 * never a failure here — lost comments are evidence, not a verdict). Without a
 * range, the check cannot run (no base ref).
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

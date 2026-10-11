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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type LostComment,
  classifyHunk,
  hasWord,
  parseHunks,
  wordsOf,
} from "./comment-retention-hunks.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * A real shell `ExecFn` built on `promisify(exec)`. The driver's gates use an
 * injected `ExecFn`; this one is the production default.
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

/** Fallback per-git-call timeout for callers that do not pass one. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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
  ref: string | undefined,
  paths: string[],
  timeoutMs: number,
): Promise<Set<string> | undefined> {
  const pathArg = paths.join(" ");
  // No ref = the working tree (tracked files): the uncommitted /work diff.
  const refArg = ref ? `${ref} ` : "";
  try {
    const { stdout } = await execFn(`git grep -e "" ${refArg}-- ${pathArg}`, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = new Set<string>();
    for (const line of stdout.split("\n")) {
      // `git grep -e "" <ref> -- <paths>` emits `ref:file:line`; the line
      // content is what follows the SECOND colon.
      // With a ref the prefix is `ref:file:`; without one it is `file:`.
      let from = 0;
      for (let k = 0; k < (ref ? 2 : 1) && from >= 0; k++) {
        const at = line.indexOf(":", from);
        from = at < 0 ? -1 : at + 1;
      }
      if (from < 0) continue;
      out.add(line.slice(from).trim());
    }
    return out;
  } catch (err) {
    if (execExitCode(err) === 1 && (!ref || (await refResolves(execFn, cwd, ref, timeoutMs))))
      return new Set<string>();
    trace(
      `comment-retention: readLinesAtRef failed at ${ref ?? "the worktree"}: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
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
    await execFn(`git rev-parse --verify "${ref}^{commit}"`, {
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
  pathArg: string,
  timeoutMs: number,
): Promise<LostCommentResult> {
  // An empty diff under the pathspec is legitimate (no changes under paths), but
  // a truncated or mis-invoked read could also yield one; cross-check the range
  // scoped to THE SAME validated paths and, if non-empty, report it rather than
  // silently passing as "nothing lost".
  let changedInRange = Number.NaN;
  try {
    const { stdout } = await execFn(`git rev-list --count ${baseRef}..${headRef} -- ${pathArg}`, {
      cwd,
      timeout: timeoutMs,
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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
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
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    diff = stdout;
  } catch (err) {
    return {
      ok: false,
      reason: `git diff failed: ${(err as Error).message?.slice(0, 120) ?? "error"}`,
    };
  }
  if (!diff.trim()) return confirmEmptyDiff(execFn, cwd, baseRef, headRef, pathArg, timeoutMs);
  return classifyDiff(execFn, cwd, diff, headRef, paths, timeoutMs);
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

  const headSet = await readLinesAtRef(execFn, cwd, headRef, paths, timeoutMs);
  if (headSet === undefined) {
    return {
      ok: false,
      reason: `could not read head tree at ${headRef ?? "the worktree"} under ${paths.join(" ")}`,
    };
  }
  // Built ONCE per check, not per lookup: the trailing-part scan walks it.
  const headLines = [...headSet];
  // Retained = the trimmed line reappears verbatim, or as the trailing part of
  // a head line (a comment moved to the end of a code line). A comment that
  // merely prefixes a longer comment at head is NOT retained.
  const presentAtHead = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    if (headSet.has(t)) return true;
    // Trailing-part retention needs a word-bearing tail: `}`, `*/` or `/**`
    // must not be "retained" by any head line that happens to end in them.
    if (!hasWord(t)) return false;
    return wordsOf(t).length >= 2 && headLines.some((l) => l.endsWith(t));
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
 * Evidence for a diff STRING (the /work adversarial diff has no base...head
 * range to re-derive). Refs and paths are validated as in findLostComments.
 */
export async function lostCommentsFromDiff(
  execFn: ExecFn,
  cwd: string,
  diff: string,
  headRef: string | undefined,
  paths: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LostCommentResult> {
  if (headRef !== undefined && !isSafeRef(headRef)) {
    return { ok: false, reason: `unsafe ref (${headRef}) — refusing shell interpolation` };
  }
  if (!isSafePathList(paths)) {
    return { ok: false, reason: "unsafe path — refusing shell interpolation" };
  }
  if (!diff.trim()) return { ok: true, lost: [], exempt: 0 };
  return classifyDiff(execFn, cwd, diff, headRef, paths, timeoutMs);
}

/**
 * Never throws: any exception becomes `ok: false`, so a crashed check is shown
 * to the reviewers as NOT CHECKED rather than as a clean diff.
 */
export async function checkDiffComments(
  diff: string,
  headRef: string | undefined,
  cwd: string,
  timeoutMs: number,
  execFn: ExecFn = makeExecFn(),
  paths: string[] = COMMENT_RETENTION_PATHS,
): Promise<LostCommentResult> {
  try {
    return await lostCommentsFromDiff(execFn, cwd, diff, headRef, paths, timeoutMs);
  } catch (err) {
    const reason = (err as Error).message?.slice(0, 120) || "error";
    trace(`comment-retention: checkDiffComments failed: ${reason}`);
    return { ok: false, reason: `check threw: ${reason}` };
  }
}

/** Escape-hatch gate. Honours `PI_ENSEMBLE_COMMENT_RETENTION=0`. */
export function commentRetentionEnabled(): boolean {
  return process.env.PI_ENSEMBLE_COMMENT_RETENTION !== "0";
}

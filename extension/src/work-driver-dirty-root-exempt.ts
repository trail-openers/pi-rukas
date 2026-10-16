/**
 * work-driver-dirty-root-exempt — #1362: the project's opt-in list of
 * repo-root paths that the /work driver's dirty-root checks and repo-root
 * staging ignore.
 *
 * The problem it solves: a tool-local file in the main checkout —
 * `.claude/settings.local.json`, an editor's workspace file — is dirt to
 * every dirty-root gate (branch step, preflight, consolidated verify,
 * integrate, restore claim), so it blocks a cycle over a file that is
 * neither the operator's work nor the driver's.
 *
 * The shape, per the issue's 2026-10-15 Settlements:
 *
 *  - **Opt-in.** No file → an empty list → every consumer behaves exactly as
 *    it did before this module existed. Nothing is exempt by default, not
 *    even `.claude/`.
 *  - **Untracked (`??`) entries only.** A modified, staged or deleted tracked
 *    file under an exempt prefix is still dirt. This is what keeps the list
 *    from hiding real uncommitted source.
 *  - **Protected paths cannot be exempted.** An entry matching
 *    `isProtectedPath` (`.github/`, `.pi/`, `CODEOWNERS`, `agents.json`) is
 *    rejected with a trace and contributes nothing — a project cannot list
 *    away the files that define how its own cycle is judged.
 *  - **Repo root only.** The list applies to dirt and staging reads at
 *    repoRoot. Workstream worktrees stage their output exactly as before, so
 *    a deliverable inside an exempt prefix is still committed.
 *  - **Renames never exempt.** A rename is never an untracked entry, so it is
 *    dirt whether the configured path is its destination or its origPath.
 *
 * The parsed list travels on the cycle context (`dirtyRootExempt` on
 * `DriverContext`) and is a plain parameter everywhere below it. It is never
 * held at module scope: up to `PI_ENSEMBLE_PARALLEL_GROUPS` cycles run
 * concurrently in one process and each has its own project.
 *
 * Matching lives ONLY in `matchesConfiguredExempt` — one place owns the
 * prefix rule, so the six consumers cannot disagree about what is exempt.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { traceWarn } from "./trace.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";

/** The config file, read from repoRoot's working tree once per cycle. */
export const DIRTY_ROOT_EXEMPT_FILE = ".pi/dirty-root-exempt";

/** Why an entry contributes nothing to the list. */
export type ExemptRejectReason = "absolute" | "parent-dir" | "glob" | "empty" | "protected";

/** The result of parsing the config file's content. */
export interface ExemptParseResult {
  /** The accepted entries, normalised (repo-relative, `/`-separated, no trailing `/`). */
  entries: string[];
  /** Every rejected line with the reason, for the trace. */
  rejected: { line: string; reason: ExemptRejectReason }[];
}

/**
 * The comparison form of one path: repo-relative, forward slashes, `./` and
 * empty segments dropped, no trailing slash, git's porcelain C-quoting
 * removed. Quoting is stripped here so every consumer hands the matcher the
 * same string regardless of the porcelain format it read (`--porcelain`,
 * `-uall`, or `-z` with its separate rename field).
 *
 * Shared with `unquotePorcelainPath`: an entry and a path must normalise
 * identically or a `"quoted"` name would never match a bare entry.
 */
export function normaliseRepoPath(p: string): string {
  let s = p.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== ".")
    .join("/");
}

/** A porcelain path with git's C-quoting removed (see `normaliseRepoPath`). */
export const unquotePorcelainPath = normaliseRepoPath;

/**
 * Is this `git status --porcelain` line an untracked (`??`) entry? `--porcelain
 * -z` and the plain form both put the two-character code first, so this holds
 * for every reader below. Shared so the dirt gates and the stager agree on what
 * "untracked" means.
 */
export function isUntrackedPorcelainLine(line: string): boolean {
  return line.trimStart().startsWith("??");
}

/**
 * #1362 — is this dirt line exempted by the project's configured list?
 *
 * Untracked entries only: a modified, staged or deleted tracked file under an
 * exempt prefix is still dirt, and a rename never is (its code is `R`/`C`, never
 * `??`), so a rename from a non-exempt path into `.claude/` still counts. The
 * line's own path — its destination, for a rename — is what is matched, with
 * git's quoting removed. An empty list (no config file) makes every call false,
 * which is what keeps the no-config behaviour byte-identical to before.
 *
 * Lives here, next to the matcher, rather than beside `isDriverManagedDirtLine`
 * in work-driver-branch-residue.ts: six consumers import it and none of them
 * should have to depend on the residue pass to ask a question about a path.
 */
export function isConfiguredExemptDirtLine(
  line: string,
  exempt: readonly string[] | undefined,
): boolean {
  if (exempt === undefined || exempt.length === 0) return false;
  if (!isUntrackedPorcelainLine(line)) return false;
  return matchesConfiguredExempt(unquotePorcelainPath(line.slice(3)), exempt);
}

/** Does a normalised path begin with one of the configured prefixes? */
export function matchesConfiguredExempt(
  path: string,
  entries: readonly string[] | undefined,
): boolean {
  if (entries === undefined || entries.length === 0) return false;
  const norm = normaliseRepoPath(path);
  if (norm.length === 0) return false;
  return entries.some((e) => norm === e || norm.startsWith(`${e}/`));
}

/**
 * Parse the config file's content. One repo-relative prefix per line; blank
 * lines and `#` comments are ignored; a leading `./` is stripped and a
 * trailing `/` normalised away.
 *
 * Rejections (each traced by the caller, each contributing nothing): an
 * absolute path, a line carrying a `..` segment, a line with any glob
 * character, anything that normalises to nothing (`.`, `./`, `/`), and an
 * entry naming a protected path.
 */
export function parseDirtyRootExempt(content: string): ExemptParseResult {
  const entries: string[] = [];
  const rejected: { line: string; reason: ExemptRejectReason }[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // A leading `/` is absolute — including a bare `/`, which also normalises
    // to nothing. The order of these two checks is what makes the two
    // distinct rejections observable rather than one of them dead code.
    if (line.startsWith("/")) {
      rejected.push({ line, reason: "absolute" });
      continue;
    }
    if (line.split(/[\\/]/).includes("..")) {
      rejected.push({ line, reason: "parent-dir" });
      continue;
    }
    if (/[*?[\]]/.test(line)) {
      rejected.push({ line, reason: "glob" });
      continue;
    }
    const norm = normaliseRepoPath(line);
    if (norm.length === 0) {
      rejected.push({ line, reason: "empty" });
      continue;
    }
    // An entry is a PREFIX, so a bare directory name stands for everything
    // under it. `isProtectedPath` only flags a path whose BASE is a protected
    // file or whose ANCESTORS include a protected dir, so a protected
    // directory named on its own — `.github`, `.pi` — has to be refused here
    // as well, or listing `.pi` would hide a self-written `.pi/` edit from the
    // dirty-root gate while `isProtectedPath(".pi")` answered false.
    if (isProtectedPath(norm) || isProtectedPath(`${norm}/x`)) {
      rejected.push({ line, reason: "protected" });
      continue;
    }
    if (!entries.includes(norm)) entries.push(norm);
  }
  return { entries, rejected };
}

/**
 * A trace line naming what the config read did, so the cycle says so.
 *
 * `traceWarn`, not `trace`: every line here reports a config the operator
 * wrote that the driver did NOT apply — a rejected entry or an unreadable
 * file — and each one silently changes which files block a cycle. An outcome
 * changing a fault is exactly what traceWarn exists for (unlike `trace`, it is
 * not gated on PI_ENSEMBLE_DEBUG, so the operator sees it in a normal run).
 */
function traceConfigRead(repoRoot: string, detail: string): void {
  traceWarn(`work-driver: ${DIRTY_ROOT_EXEMPT_FILE} (${repoRoot}) — ${detail}`);
}

/**
 * Read the cycle's exemption list: `.pi/dirty-root-exempt` in repoRoot's
 * working tree, once per cycle, before the branch step.
 *
 * Both degradation paths yield an empty list, and only one of them says so:
 *  - no file (ENOENT/ENOTDIR — the default for every project) → empty, silently;
 *  - any other read error (EACCES, EIO, a directory in the way) → empty **plus
 *    a trace**, because a broken config must not block a cycle that is
 *    otherwise clean, and must not fail silently either.
 *
 * Every rejection is traced with its reason, so a line the operator wrote and
 * the driver ignored is visible in the cycle log.
 */
export async function readDirtyRootExempt(repoRoot: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(path.join(repoRoot, DIRTY_ROOT_EXEMPT_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      traceConfigRead(
        repoRoot,
        `could not be read (${code ?? String(err)}), so nothing is exempt — fix the file or remove it`,
      );
    }
    return [];
  }
  const { entries, rejected } = parseDirtyRootExempt(content);
  for (const r of rejected) {
    traceConfigRead(repoRoot, `entry ${JSON.stringify(r.line)} rejected (${r.reason})`);
  }
  if (entries.length > 0) {
    traceConfigRead(repoRoot, `${entries.length} exempt path(s) in effect: ${entries.join(", ")}`);
  }
  return entries;
}

/**
 * The per-cycle entry point: read the list for the cycle's own project.
 *
 * `DriverContext` rather than a bare path so the call site at
 * `runWorkDriver` stays one line and the file's location remains this
 * module's concern, not the driver's.
 */
export async function readDirtyRootExemptForCycle(ctx: {
  repoRoot: string;
}): Promise<readonly string[]> {
  return readDirtyRootExempt(ctx.repoRoot);
}

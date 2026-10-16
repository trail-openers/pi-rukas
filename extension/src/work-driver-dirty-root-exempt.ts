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
 * Two questions are answered here and they are NOT the same question:
 *
 *  - **Is this dirt?** (`isConfiguredExemptDirtLine`) — what every dirty-root
 *    GATE asks, answered from the porcelain line in front of it. Decided by
 *    prefix, and that is the feature: a tool's own settings file must not
 *    block a cycle, whatever wrote it.
 *  - **Is this the cycle's work?** (`readDirtyRootExemptBaseline` + the claim
 *    in work-driver-restore-entry.ts) — what the restore CLAIM asks, answered
 *    by PROVENANCE: was the path already untracked when the cycle started? A
 *    post-reset `??` code cannot answer it, because the mixed reset turns the
 *    cycle's staged-new files into `??` too.
 *
 * The parsed list travels on the cycle context (`dirtyRootExempt` on
 * `DriverContext`) and the baseline on its state file
 * (`pipelineState.dirtyRootExemptBaseline`); both are plain parameters
 * everywhere below them. Neither is held at module scope: up to
 * `PI_ENSEMBLE_PARALLEL_GROUPS` cycles run concurrently in one process and each
 * has its own project.
 *
 * Matching lives ONLY in `matchesConfiguredExempt` — one place owns the
 * prefix rule, so the six consumers cannot disagree about what is exempt.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { traceWarn } from "./trace.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import type { WorkEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/** The config file, read from repoRoot's working tree once per cycle. */
export const DIRTY_ROOT_EXEMPT_FILE = ".pi/dirty-root-exempt";

/**
 * #1362 — how many pre-existing exempt paths the baseline records. A repo whose
 * exempt prefix holds more than this many untracked files is not a tool writing
 * one settings file; it is a build output nobody gitignored, and listing every
 * path in it would bloat the state file for a claim that names at most
 * `UNTRACKED_SHOWN` of them. The cap is deliberately conservative — past it the
 * baseline is not written at all (nothing is claim-exempt), which is the
 * fail-closed direction rather than a truncated list that silently blesses part
 * of a tree.
 */
export const DIRTY_ROOT_EXEMPT_BASELINE_MAX = 500;

/** Why an entry contributes nothing to the list. */
export type ExemptRejectReason =
  | "absolute"
  | "parent-dir"
  | "glob"
  | "empty"
  | "not-repo-relative"
  | "protected";

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

/**
 * Is this `git status --porcelain` line an untracked (`??`) entry? `--porcelain
 * -z` and the plain form both put the two-character code first, so this holds
 * for every reader below. Shared so the dirt gates and the stager agree on what
 * "untracked" means.
 */
function isUntrackedPorcelainLine(line: string): boolean {
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
 *
 * **Gates only.** The restore claim does NOT ask this question — it decides by
 * the cycle-start baseline, not by the status code (see `readDirtyRootExempt-
 * Baseline` and work-driver-restore-entry.ts).
 */
export function isConfiguredExemptDirtLine(
  line: string,
  exempt: readonly string[] | undefined,
): boolean {
  if (exempt === undefined || exempt.length === 0) return false;
  if (!isUntrackedPorcelainLine(line)) return false;
  return matchesConfiguredExempt(normaliseRepoPath(line.slice(3)), exempt);
}

/** Does a normalised path begin with one of the configured prefixes? */
export function matchesConfiguredExempt(
  relPath: string,
  entries: readonly string[] | undefined,
): boolean {
  if (entries === undefined || entries.length === 0) return false;
  const norm = normaliseRepoPath(relPath);
  // A path that STILL carries a `..` segment after normalisation escapes the
  // tree: `normaliseRepoPath` drops `.` and empty segments but must keep `..`
  // (dropping it would turn `docs/../.github/x` into `docs/.github/x`, a path
  // that does not exist and silently matches nothing). Refusing here rather than
  // comparing a rewritten path is what stops `docs` from exempting a path that
  // traverses out of `docs` and back in — the same escape `..` is rejected for
  // in the parser, applied to the other side of the comparison.
  if (norm.split("/").includes("..")) return false;
  return entries.some((e) => norm === e || norm.startsWith(`${e}/`));
}

/**
 * Parse the config file's content. One repo-relative prefix per line; blank
 * lines and `#` comments are ignored; a leading `./` is stripped and a
 * trailing `/` normalised away.
 *
 * Rejections (each traced by the caller, each contributing nothing): an
 * absolute path, a line carrying a `..` segment, a line with any glob
 * character, anything that normalises to nothing (`.`, `./`, `/`), a
 * home-relative (`~`), drive-letter (`C:\`) or environment-substitution
 * (`$HOME`, `%TEMP%`) entry, and an entry naming a protected path.
 *
 * The last three groups are refused because they are a different path language
 * than the matcher speaks: `~`, a drive letter and `$`/`%` substitutions are
 * expanded by a shell or a Windows path layer, never by `matchesConfiguredExempt`,
 * so an operator who writes `~/.claude` gets an entry that matches nothing while
 * reading like it matches something. A rejected line is traced and contributes
 * nothing; the good lines beside it still apply.
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
    // Not repo-relative path syntax at all: a home-relative `~/…`, a Windows
    // drive letter, or a `$VAR` / `%VAR%` substitution. All three are expanded
    // by something that is not this parser, so they would sit in the list as a
    // prefix no path can ever literally begin with.
    if (
      line === "~" ||
      line.startsWith("~/") ||
      line.startsWith("~\\") ||
      /^[A-Za-z]:[\\/]/.test(line) ||
      line.includes("$") ||
      line.includes("%")
    ) {
      rejected.push({ line, reason: "not-repo-relative" });
      continue;
    }
    const norm = normaliseRepoPath(line);
    if (norm.length === 0 || norm === "..") {
      rejected.push({ line, reason: "empty" });
      continue;
    }
    // The post-normalisation sibling of the `..` check above: `./..`, `./../..`
    // and `..\..` all collapse to a bare `..`, which is not a repo-relative
    // prefix whatever shape it arrived in. Refusing it here, rather than
    // letting it into the list, is what keeps `matchesConfiguredExempt`'s own
    // `..` refusal (see there) from being the only thing between a malformed
    // entry and a prefix that traverses the tree.
    if (norm.split("/").includes("..")) {
      rejected.push({ line, reason: "parent-dir" });
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
 * The read failure ALSO comes back in `readFailed`, and that is not redundant
 * with the trace: a trace line reaches the cycle log and nowhere else, so an
 * operator who reads only the handoff of a cycle that then blocked on residue
 * would be told "your repo root is dirty" without being told that the very file
 * which would have exempted it could not be read. The caller records it on the
 * cycle's state (`withDirtyRootExemptReadFailure`), which is what puts it in the
 * handoff.
 *
 * Every rejection is traced with its reason, so a line the operator wrote and
 * the driver ignored is visible in the cycle log.
 */
export async function readDirtyRootExempt(
  repoRoot: string,
): Promise<{ entries: string[]; readFailed?: string }> {
  let content: string;
  try {
    content = await fs.readFile(path.join(repoRoot, DIRTY_ROOT_EXEMPT_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      const reason = `${code ?? String(err)}: ${DIRTY_ROOT_EXEMPT_FILE} at ${repoRoot}`;
      traceConfigRead(
        repoRoot,
        `could not be read (${code ?? String(err)}), so nothing is exempt — fix the file or remove it`,
      );
      return { entries: [], readFailed: reason };
    }
    return { entries: [] };
  }
  const { entries, rejected } = parseDirtyRootExempt(content);
  for (const r of rejected) {
    traceConfigRead(repoRoot, `entry ${JSON.stringify(r.line)} rejected (${r.reason})`);
  }
  if (entries.length > 0) {
    traceConfigRead(repoRoot, `${entries.length} exempt path(s) in effect: ${entries.join(", ")}`);
  }
  return { entries };
}

/**
 * #1362 — the paths already untracked under the project's exempt prefixes when
 * the cycle started. Called by the branch step, where repoRoot's dirt is first
 * read, and its result persisted once as
 * `pipelineState.dirtyRootExemptBaseline`.
 *
 * Why a snapshot and not a match: the restore claim is built AFTER the abort
 * path's mixed reset, at which point a staged-new file the cycle wrote and a
 * tool's stray that was merely sitting there are BOTH `??`. Git's status code
 * cannot separate them; the pre-cycle snapshot can. Only a post-reset `??` path
 * that appears here is claim-exempt — anything else under an exempt prefix is
 * the cycle's own output and the claim names it.
 *
 * Returns `undefined` — the "nothing is claim-exempt" answer — for a cycle with
 * no exemption list, for a read that failed, and for a tree carrying more than
 * `DIRTY_ROOT_EXEMPT_BASELINE_MAX` such paths. Each of those is the fail-closed
 * direction: the worst it does is name a tool file in a claim that could have
 * spared it. It never hides the cycle's work, which is the failure the whole
 * field exists to prevent.
 *
 * Never recompute this after the cycle has written anything: a snapshot taken
 * late blesses the cycle's own output as pre-existing, which is precisely the
 * claim the field was added to make true.
 */
export async function readDirtyRootExemptBaseline(
  execFn: ExecFn,
  repoRoot: string,
  exempt: readonly string[] | undefined,
): Promise<string[] | undefined> {
  if (exempt === undefined || exempt.length === 0) return undefined;
  let stdout: string;
  try {
    // `-uall` so a wholly-untracked directory lists its FILES: a baseline that
    // recorded `tmp/` while the claim asks about `tmp/x.json` would not match,
    // and the cycle's own file would be named as if it were a stray.
    const { stdout: out } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      argv: ["status", "--porcelain", "-z", "-uall"],
    });
    stdout = out;
  } catch (err) {
    traceWarn(
      `work-driver: ${DIRTY_ROOT_EXEMPT_FILE} — could not list the pre-existing untracked paths (${(err as Error).message?.slice(0, 160)}), so NOTHING is claim-exempt this cycle: a tool file under an exempt prefix will be named by the restore claim.`,
    );
    return undefined;
  }
  const paths: string[] = [];
  for (const rec of stdout.split("\0")) {
    if (!rec) continue;
    if (rec.slice(0, 2) !== "??") continue;
    const norm = normaliseRepoPath(rec.slice(3));
    if (norm.length === 0) continue;
    if (matchesConfiguredExempt(norm, exempt)) paths.push(norm);
    if (paths.length > DIRTY_ROOT_EXEMPT_BASELINE_MAX) {
      traceWarn(
        `work-driver: ${DIRTY_ROOT_EXEMPT_FILE} — more than ${DIRTY_ROOT_EXEMPT_BASELINE_MAX} untracked paths sit under the exempt prefixes, so the baseline was NOT recorded and nothing is claim-exempt this cycle. That is a build output or a cache, not a tool's settings file: gitignore it.`,
      );
      return undefined;
    }
  }
  // Deduplicated, sorted, stable: the value is persisted into the state file,
  // so the same tree must produce the same bytes on any two runs.
  return [...new Set(paths)].sort();
}

/**
 * #1362 — the sentence the handoff shows when the exemption file was unreadable
 * AND the cycle then blocked on residue. Kept out of the trace alone on
 * purpose: `traceWarn` reaches the cycle log, and the handoff is the artifact an
 * operator actually reads. Exported so the branch-step renderer and its test
 * quote one wording.
 */
export function dirtyRootExemptReadNotice(reason: string): string {
  return `the exemption file could not be read: ${reason} — so NOTHING is exempt this cycle. If a path named below is a tool-local file this project lists in ${DIRTY_ROOT_EXEMPT_FILE}, fix that file (permissions, ownership, or a directory left in its place) and re-run: until it reads, none of its entries apply.`;
}

/**
 * The `plumb-report` event carrying that sentence.
 *
 * The existing kind is deliberate: a NEW event kind would change the event-log
 * tail, and `nextStep()` routes on that tail. `plumb-report` is the kind the
 * handoff already renders (§ plumbing that failed), and appending it before the
 * branch step's own events cannot disturb any routing decision.
 */
export function dirtyRootExemptReadEvent(reason: string): WorkEvent {
  return {
    kind: "plumb-report",
    at: Date.now(),
    step: "branch",
    role: "driver",
    body: dirtyRootExemptReadNotice(reason),
  };
}

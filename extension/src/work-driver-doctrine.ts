/**
 * work-driver-doctrine — a cycle may not rewrite the rules it is judged by.
 *
 * `resolveMergeAuthority` reads `AGENTS.md` to decide whether this cycle may
 * merge. It runs at the `merged` step — *after* `commit-pr` has integrated the
 * developer's patches into `repoRoot`. So before #406 a developer subagent
 * could write "Agents may squash-merge PRs" into `AGENTS.md`, have it
 * integrated by the driver's own consolidation, and then have the driver read
 * that sentence back and honour it. The cycle granted itself authority. Amp
 * shipped a CVE for this exact shape; gh-aw treats the same file set as
 * protected on the same reasoning (the supply-chain case).
 *
 * There are two distinct threats here and they want different mechanisms.
 * Collapsing them into one blanket "halt on any doctrine edit" was the obvious
 * design and it is wrong, because this repo's own policy is that AGENTS.md
 * ships in the same PR as the behaviour it documents — a blanket halt would
 * stop nearly every legitimate cycle.
 *
 *   1. **Policy prose** (`AGENTS.md`, `CLAUDE.md`) — states what the operator
 *      permits. The fix is not to forbid the edit but to make it *inert for
 *      the cycle that wrote it*: doctrine is read at `baseSha`, never from the
 *      working tree. A self-granting patch is then simply invisible to the
 *      gate, and an honest documentation change still ships. See
 *      `readDoctrineAtBase`.
 *
 *   2. **Capability and gate files** (`.github/`, `.pi/`, `CODEOWNERS`,
 *      `agents.json`) — these define what "verified", "reviewed" and "green"
 *      *mean*, and they take effect within the same cycle: a workflow edited
 *      at develop is the workflow the `ci` step then reads. Reading them at
 *      base does not help, because the running system uses the working-tree
 *      copy. These halt. See `protectedPathsIn`.
 *
 * The asymmetry is the point: prose is neutralised, capability is refused.
 */

import { trace } from "./trace.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
type ExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Directories whose contents define what verification means.
 *
 * `.pi/work-state/` is this driver's own state and is gitignored, so it never
 * reaches a staged patch — no carve-out is needed for it. The rest of `.pi/`
 * (`verify-cmd`, `verify-cmd-full`, `smoke-cmd`, `decisions.json`) is exactly
 * the set that decides whether the develop gate has any teeth.
 */
const PROTECTED_DIRS = [".github", ".pi"];

/** Files that define who reviews, and with what tools. */
const PROTECTED_FILES = ["codeowners", "agents.json"];

/**
 * Policy-prose files. NOT halted — neutralised by `readDoctrineAtBase`.
 * Tracked separately so the develop gate can still surface the edit to a
 * reviewer, which is a signal worth seeing even when it is benign.
 */
const DOCTRINE_PROSE_FILES = ["agents.md", "claude.md"];

/** #406 escape hatch, matching the other gate kill-switches. */
export function protectedPathsEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PROTECTED_PATHS;
  return v !== "0" && v !== "false";
}

/** Normalise a repo-relative path to lowercase forward-slash segments. */
function segmentsOf(p: string): string[] {
  return protectedPathKey(p)
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/**
 * The comparison form of a path — what a #1090 grant must equal exactly.
 * Case is kept (unlike classification): on a case-sensitive filesystem
 * `CI.yml` and `ci.yml` are different files, and a grant names one of them.
 */
export function protectedPathKey(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

/** Does this path define a capability or gate the cycle is judged by? */
export function isProtectedPath(p: string): boolean {
  const segs = segmentsOf(p);
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1] ?? "";
  if (PROTECTED_FILES.includes(base)) return true;
  // Any ancestor directory, at any depth — a nested `.github/workflows/x.yml`
  // in a subpackage is as load-bearing as a top-level one.
  return segs.slice(0, -1).some((s) => PROTECTED_DIRS.includes(s));
}

/** Is this policy prose — allowed to change, but inert for this cycle? */
export function isDoctrineProsePath(p: string): boolean {
  const segs = segmentsOf(p);
  const base = segs[segs.length - 1] ?? "";
  return DOCTRINE_PROSE_FILES.includes(base);
}

/** Every protected path in a change set, deduplicated and stable-ordered. */
export function protectedPathsIn(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(isProtectedPath))].sort();
}

/** Every policy-prose path in a change set. */
export function doctrineProsePathsIn(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(isDoctrineProsePath))].sort();
}

/**
 * Parse `git status --porcelain` output into repo-relative paths.
 *
 * Rename entries (`R  old -> new`) yield both sides: a doctrine file moved out
 * of the way is as much an edit as one changed in place. Porcelain quotes
 * paths containing special characters; those quotes are stripped.
 */
export function porcelainPaths(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = line.slice(3);
    const arrow = entry.indexOf(" -> ");
    const parts = arrow >= 0 ? [entry.slice(0, arrow), entry.slice(arrow + 4)] : [entry];
    for (const p of parts) {
      const clean = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
      if (clean.length > 0) out.push(clean);
    }
  }
  return out;
}

/**
 * Is a porcelain entry a directory? `git status` (without `-uall`) collapses a
 * wholly untracked directory to one `?? dir/` entry, and that entry is not a
 * file. A grant of its key would admit every file under it unseen (#1090).
 */
export function isDirectoryEntry(raw: string): boolean {
  return raw.endsWith("/");
}

export interface DoctrineRead {
  /** The doctrine text as of the base commit, or undefined if unavailable. */
  text?: string;
  /** Why it is unavailable — operator-facing, recorded on the authority. */
  reason?: string;
}

/** A base SHA safe to interpolate into a git command. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Read a doctrine file as it stood at the cycle's base commit.
 *
 * Never reads the working tree. That is the whole point: the working tree at
 * the `merged` step contains whatever the developer subagents wrote, and a
 * grant found there proves nothing about what the operator permitted.
 *
 * Fails closed. An unreadable base, an unrecorded `baseSha`, or a repo with no
 * doctrine file all return no text, and no text is not a grant.
 */
export async function readDoctrineAtBase(
  execFn: ExecFn,
  repoRoot: string,
  baseSha: string | undefined,
  file = "AGENTS.md",
): Promise<DoctrineRead> {
  if (!baseSha || !SHA_RE.test(baseSha)) {
    trace("work-driver: doctrine — no usable baseSha, cannot read pre-cycle doctrine");
    return {
      reason:
        "no base commit recorded for this cycle, so what the project's doctrine said before the cycle ran could not be established",
    };
  }
  try {
    const { stdout } = await execFn(`git show ${baseSha}:${file}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    return { text: stdout };
  } catch {
    return { reason: `no ${file} at base commit ${baseSha.slice(0, 8)}` };
  }
}

/**
 * The develop gate's failure message for a self-modifying patch.
 *
 * Names the paths, because "a protected file changed" without saying which one
 * is the kind of message that sends an operator digging through a diff. A
 * developer re-dispatch can never satisfy this gate, so the remedy is the
 * operator's: the exact `/work` command that grants every protected path the
 * patch touched (#1090), or the process-wide escape hatch.
 */
export function explainProtectedPaths(
  ungranted: readonly string[],
  allTouched: readonly string[],
  issues: readonly number[],
): string {
  const head = `develop wrote to ${ungranted.length} protected path(s) without an operator grant — ${ungranted.join(", ")}. These define what verification, review and permission mean for this cycle, so a cycle that edits them is grading its own work. Make the change yourself`;
  const env = "PI_ENSEMBLE_PROTECTED_PATHS=0 disables the gate for every path instead";
  const paths = [...new Set(allTouched.map(protectedPathKey))].sort();
  // A directory is never a grant (it would admit every file under it), so a
  // change set that contains one gets no copy-paste command: the operator is
  // told to name the files, not handed a command that grants the directory.
  if (allTouched.some(isDirectoryEntry)) {
    const dirs = allTouched.filter(isDirectoryEntry).map(protectedPathKey);
    return `${head}; the change set includes a directory (${dirs.join(", ")}), which a grant cannot name — the files under it must be listed individually, and each granted by its exact path. No grant command is printed for a directory (${env}).`;
  }
  // The command is built from filenames a developer wrote, so it is printed
  // only when every one is a plain path token, and only for a single issue —
  // the one shape `--allow-protected` accepts. A name outside that token set
  // (non-ASCII, a space, a quote) is ungrantable by construction: the grant
  // parser rejects it, so no command is offered and the operator is told why (#1378).
  const plain = (p: string) => SAFE_PATH_RE.test(p) && !p.split("/").includes("..");
  const ungrantable = paths.filter((p) => !plain(p));
  if (ungrantable.length > 0) {
    return `${head}; ${ungrantable.join(", ")} cannot be granted with --allow-protected (a grant accepts only plain ASCII path tokens), so no grant command is printed (${env}).`;
  }
  if (issues.length !== 1) {
    return `${head}; or, if it is genuinely the work you asked for, grant the paths for one single-issue cycle with \`/work <issue> --restart --allow-protected <path>[,<path>]\` (${env}).`;
  }
  return `${head}; or, if it is genuinely the work you asked for, review each path's diff first — a granted path is trusted for the whole cycle, so grant none you did not mean to change — then grant the protected paths this patch touched, for one cycle only, with \`/work ${issues[0]} --restart --allow-protected ${paths.join(",")}\` (${env}).`;
}

/** A path safe to print inside a copy-paste `/work` command (and to grant). */
export const SAFE_PATH_RE = /^[A-Za-z0-9._/@+-]+$/;

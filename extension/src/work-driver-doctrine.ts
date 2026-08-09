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
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .map((s) => s.toLowerCase());
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
 * is the kind of message that sends an operator digging through a diff.
 */
export function explainProtectedPaths(paths: readonly string[]): string {
  return `develop wrote to ${paths.length} protected path(s) — ${paths.join(", ")}. These define what verification, review and permission mean for this cycle, so a cycle that edits them is grading its own work. Make the change yourself, or re-run with PI_ENSEMBLE_PROTECTED_PATHS=0 if it is genuinely the work you asked for.`;
}

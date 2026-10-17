/**
 * lens-evidence — what the reviewers are given beyond the diff.
 *
 * Two jobs, both of which exist because of the same discovery: **the lens
 * children's filesystem is not the branch.** The reviewed diff is built from
 * `origin/<base>..origin/<branch>`, but the children run with `cwd` set to a
 * worktree, and those stay detached at `baseSha`. So a reviewer that opens a
 * changed file reads the version from before the change.
 *
 * A real cycle shipped a documentation paragraph that contradicted another
 * paragraph seventy lines below it in the same file, and all six lenses passed
 * it. SIMPLICITY was already chartered for exactly that defect
 * (`skill/code-review-simplicity/SKILL.md:98-102` — "Confusing or contradictory
 * documentation"). It was not a missing lane; the contradicting line was simply
 * outside the diff, and therefore outside every reviewer's context. Adding a
 * seventh lens would have changed nothing, since it would have inherited the
 * same blind spot.
 *
 *   1. `buildEvidence` supplies the post-change content of prose files the diff
 *      touches, read at the branch, so the existing lens can see what it was
 *      always supposed to be judging.
 *   2. `runClaimScan` grounds the factual particulars the diff asserts against
 *      the branch, deterministically. See `claim-scan.ts` for why this is not a
 *      model and not a lens.
 */

import {
  type PathExistenceLookup,
  type UngroundedClaim,
  explainUngrounded,
  extractClaimCandidates,
  groundClaims,
  isProseFile,
} from "./claim-scan.ts";
import type { Finding } from "./lens-review.ts";
import { trace } from "./trace.ts";
import { pathsInDiff, readFileAtBranch } from "./work-driver-diff.ts";

type ExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

/** Files supplied in full, and the budget for doing so. */
const MAX_EVIDENCE_FILES = 6;
const MAX_EVIDENCE_BYTES = 120_000;

/** #408-style escape hatch, matching the other gate kill-switches. */
export function claimScanEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_CLAIM_SCAN;
  return v !== "0" && v !== "false";
}

export function evidenceSupplyEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_LENS_EVIDENCE;
  return v !== "0" && v !== "false";
}

/**
 * Render the post-change content of the prose files this diff touches.
 *
 * Prose only, and bounded. Supplying every changed source file would bury the
 * diff the reviewer is meant to be reading; prose is where a claim can
 * contradict something outside the hunk, because a code contradiction shows up
 * as a type error or a failing test long before review.
 */
export async function buildEvidence(
  repoRoot: string,
  branchName: string,
  diff: string,
): Promise<string | undefined> {
  if (!evidenceSupplyEnabled()) return undefined;
  const prose = pathsInDiff(diff).filter(isProseFile).slice(0, MAX_EVIDENCE_FILES);
  if (prose.length === 0) return undefined;

  const blocks: string[] = [];
  let budget = MAX_EVIDENCE_BYTES;
  for (const p of prose) {
    if (budget <= 0) break;
    const content = await readFileAtBranch(repoRoot, branchName, p);
    if (content === undefined) continue;
    const clipped =
      content.length > budget ? `${content.slice(0, budget)}\n… (truncated)` : content;
    budget -= clipped.length;
    blocks.push(`### ${p} — full content AFTER this PR\n\n\`\`\`\n${clipped}\n\`\`\``);
  }
  if (blocks.length === 0) return undefined;

  return `## Changed prose files, in full

The diff above shows only changed lines. These are the complete files as this PR leaves them, read from the branch. A statement added by this PR can contradict something further down a file it never touched — that is invisible in a diff, and it is why these are here.

${blocks.join("\n\n")}`;
}

/**
 * Ground every checkable particular the diff asserts in prose, and turn what
 * survives into findings.
 *
 * Severity is MEDIUM: this is a defect a human would ask to be fixed before
 * merge, not a stylistic note. Whether MEDIUM blocks is the project's call, not
 * this function's — see `DEFAULT_REVIEW_THRESHOLD`.
 */
export async function runClaimScan(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
  diff: string,
): Promise<Finding[]> {
  if (!claimScanEnabled()) return [];
  const candidates = extractClaimCandidates(diff);
  if (candidates.length === 0) return [];

  const lookup = async (token: string): Promise<string[]> => {
    // `git grep -F` on the branch ref: fixed-string, so no token is treated as
    // a pattern, and the ref rather than the filesystem because the worktree is
    // at the base commit.
    const { stdout } = await execFn(
      `git grep -l -F -- ${JSON.stringify(token)} origin/${branchName}`,
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    );
    // Output is `<ref>:<path>` per line.
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => (l.startsWith(`origin/${branchName}:`) ? l.slice(branchName.length + 8) : l));
  };

  // `git grep` exits 1 with no output when there are no matches, which the
  // exec seam surfaces as a throw. That is "no hits", not "could not tell", so
  // it must resolve to an empty list rather than drop the claim — otherwise the
  // gate could never flag anything.
  const safeLookup = async (token: string): Promise<string[]> => {
    try {
      return await lookup(token);
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      if (e.code === 1 && !e.stdout?.trim()) return [];
      throw err;
    }
  };

  let ungrounded: UngroundedClaim[];
  const pathExists = pathExistsAtBranch(execFn, repoRoot, branchName);
  try {
    ungrounded = await groundClaims(candidates, safeLookup, pathExists);
  } catch (err) {
    trace(`work-driver: claim-scan — grounding failed, skipping (${(err as Error).message})`);
    return [];
  }

  return ungrounded.map((c) => ({
    lens: "CLAIM_SCAN" as const,
    severity: "MEDIUM" as const,
    path: c.file,
    line: c.line,
    title: `Unsourced ${c.kind}: ${c.token}`,
    description: explainUngrounded(c),
    suggestion: `Replace \`${c.token}\` with a value the repository actually contains, cite where it comes from, or drop the claim.`,
  }));
}

/**
 * A path that is safe to interpolate into a git command.
 *
 * Same shape as `SAFE_PATH` in `work-driver-diff.ts`. A claim token is
 * untrusted text lifted out of prose, and `..` is what a token like
 * `../escape/foo.md` would otherwise smuggle into a tree-ish.
 */
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Does the file a path claim points at exist ON THE BRANCH?
 *
 * Two resolutions, and either one existing is enough (PM clarification, #1002):
 *
 *   - joined onto the asserting file's directory — `references/ci-cd.md` cited
 *     from `skill/devops-infrastructure/SKILL.md` is that skill's own reference
 *     file, which is how Pi documents bundled skill files ("use relative paths
 *     from the skill directory");
 *   - as-is from the repo root — for a token like `docs/foo.md` that was never
 *     relative to the file citing it.
 *
 * Both are checked at `origin/<branch>`, never the filesystem. The lens
 * children's worktree is detached at `baseSha`, so a reference file the PR
 * itself added does not exist on disk and would false-fire.
 *
 * Exit codes distinguish the two failure modes, and collapsing them was the
 * trap: `git cat-file -e` exits 128 for "not there", which is a fact the caller
 * acts on, and anything else (git missing, bad ref, unreadable repo) is "could
 * not tell", which throws and drops the claim. Grounding a claim on a
 * git-internal error, or flagging an absent file because git broke, are both
 * defects.
 */
function pathExistsAtBranch(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): PathExistenceLookup {
  return async (token, assertingFile) => {
    if (!SAFE_PATH.test(branchName) || !SAFE_PATH.test(token)) {
      // Not a repo path at all (it carries `..`, a backslash, or characters
      // outside the safe set). The existence question is unanswerable, which is
      // "absent" — the token stays eligible for the token-occurrence rule that
      // already ran above, so an unusual-but-real path can still ground by
      // appearing in code.
      return false;
    }
    const candidates = [joinAgainstAssertingDir(token, assertingFile), token];
    let couldNotTell = false;
    for (const resolved of candidates) {
      if (!SAFE_PATH.test(resolved)) continue;
      try {
        await execFn(`git cat-file -e ${JSON.stringify(`origin/${branchName}:${resolved}`)}`, {
          cwd: repoRoot,
          maxBuffer: 64 * 1024,
        });
        return true;
      } catch (err) {
        const e = err as { code?: number };
        // 128 is git's "does not exist". Any other non-zero is a broken git,
        // an unresolvable ref, or a timeout — none of which say the file is
        // missing.
        if (e.code !== 128) couldNotTell = true;
      }
    }
    if (couldNotTell) throw new Error(`could not read the branch for path \`${token}\``);
    return false;
  };
}

/**
 * Resolve a relative path token the way Markdown does: against the directory
 * of the file that cites it. A token already sitting at the repo root (no
 * directory in the asserting file) resolves to itself, and a leading `./` is
 * dropped so `./references/x.md` and `references/x.md` are the same claim.
 */
function joinAgainstAssertingDir(token: string, assertingFile: string): string {
  const clean = token.startsWith("./") ? token.slice(2) : token;
  const dir = assertingFile.slice(0, assertingFile.lastIndexOf("/") + 1);
  return `${dir}${clean}`;
}

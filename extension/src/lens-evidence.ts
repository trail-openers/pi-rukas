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
  try {
    ungrounded = await groundClaims(candidates, safeLookup);
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

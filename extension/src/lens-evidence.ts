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
 *   3. `pathExistsAtBranch` answers "does the file a path claim points at exist
 *      on the branch", which the existence escape in `groundClaims` needs and
 *      which nobody else in the codebase can answer — the worktree is at the
 *      wrong commit, so the filesystem is not an option.
 */

import { neutraliseEvidence } from "./comment-evidence.ts";
import { DEFAULT_GIT_TIMEOUT_MS, gitCatFileSaysAbsent } from "./git-range.ts";

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
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    shell?: string;
    /** #1005 argv form — matches `DriverContext.verifyExecFn` / `worktree.ts` ExecFn. */
    argv?: string[];
  },
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
    // The token is prose a human wrote, so the title goes through the same
    // neutraliser as every sibling finding line (`lens-review-render.ts`,
    // `lens-residuals.ts`): a token shaped like `VERDICT: APPROVED` or a fence
    // would otherwise read as this report's own verdict.
    title: neutraliseEvidence(`Unsourced ${c.kind}: ${c.token}`),
    description: explainUngrounded(c),
    suggestion: `Replace \`${c.token}\` with a value the repository actually contains, cite where it comes from, or drop the claim.`,
  }));
}

/**
 * A path that is safe to interpolate into a git command.
 *
 * Same character class as `SAFE_PATH` in `work-driver-diff.ts` — plus the
 * segment rule that one lacks. There, the path arrives from `git diff --name-
 * only`, which cannot produce `..`; here it arrives from prose a human wrote,
 * so `../outside/foo.md` is a real shape the scan will meet. A character class
 * that admits `.` admits `..`, so the guard is a segment check, not a charset
 * check: no segment may be `.` or `..`, and the token may not begin with `/`.
 */
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Whether a path may be interpolated into a `git cat-file` tree-ish. */
function isSafePath(value: string): value is string {
  if (!SAFE_PATH.test(value) || value.startsWith("/")) return false;
  return !value.split("/").some((seg) => seg === "." || seg === "..");
}

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
 *   - a throw — the branch could not be read at all, and that is not "absent".
 *     `gitCatFileSaysAbsent` from `git-range.ts` decides which side a rejection
 *     is on; do not hand-roll a second reading of git's exit codes here (the
 *     first fix round of #1002 found this site had one).
 */
function pathExistsAtBranch(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): PathExistenceLookup {
  // Memoised per (branch, resolved path) — i.e. per scan. `groundClaims` walks
  // its candidates serially and the same path token recurs across added lines
  // (the six #994 skills all cited `references/patterns.md`), so an unshared
  // probe paid a git spawn per mention for an answer git already gave.
  const cache = new Map<string, Promise<boolean>>();
  // argv, not a command string (#1005 shape): the path here comes from prose a
  // human wrote, so it must reach git as ONE argument rather than through a shell
  // re-parse, where `$(…)`, backticks or `;` inside a filename would execute.
  // The canary in test-git-range-1153.ts lists every importer of git-range.ts
  // and refuses a command-string git call in it.
  const probe = (resolved: string): Promise<boolean> => {
    const key = `${branchName}\u0000${resolved}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const fresh = execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      argv: ["cat-file", "-e", `origin/${branchName}:${resolved}`],
    }).then(
      () => true,
      (err: unknown) => {
        // 128/1 with git's OWN "that is not there" wording is a fact about the
        // path; anything else (a broken git, an unresolvable ref, a killed
        // probe) says nothing and must not be cached as "absent".
        if (gitCatFileSaysAbsent(err)) return false;
        throw err;
      },
    );
    cache.set(key, fresh);
    return fresh;
  };
  return async (token, assertingFile) => {
    // Not a repo path at all (it carries `..`, a backslash, or characters
    // outside the safe set). The existence question is unanswerable, which is
    // NOT the same answer as "absent": `git cat-file` was never asked, so
    // calling the file unsourced would report something the scan did not check.
    // It is "could not tell" — the same signal as a broken git — and the token
    // stays eligible for the token-occurrence rule, which ran before this.
    if (!SAFE_PATH.test(branchName) || !isSafePath(token)) {
      throw new Error(`could not judge path \`${token}\` — not a repo path`);
    }
    const candidates = [joinAgainstAssertingDir(token, assertingFile), token].filter(isSafePath);
    if (candidates.length === 0) {
      throw new Error(`could not judge path \`${token}\` — not a repo path`);
    }
    // The two resolutions are an OR, so they run together. `Promise.allSettled`
    // is the combinator: it awaits every probe and never rejects, so a sibling
    // that could not answer can neither strand an answer the branch already
    // gave nor leave an unawaited rejection behind. The precedence below is the
    // load-bearing part: `false` is a fact the scan reports and a rejection is a
    // fact it swallows, so once one resolution has said "absent", a sibling that
    // could not answer must not upgrade the answer to "could not tell".
    const outcomes = await Promise.allSettled(candidates.map(probe));
    if (outcomes.some((o) => o.status === "fulfilled" && o.value === true)) return true;
    if (outcomes.some((o) => o.status === "fulfilled" && o.value === false)) return false;
    // Not one probe answered: the branch could not be read, which is not "absent".
    throw new Error(`could not read the branch for path \`${token}\``);
  };
}

/**
 * Resolve a relative path token against the directory of the file that cites
 * it — `references/x.md` cited from `skill/foo/SKILL.md` becomes
 * `skill/foo/references/x.md`, dropping a leading `./` so that shape and the
 * bare one are the same claim. A token with no directory in the asserting file
 * resolves to itself. NOT general path resolution: it never collapses `..`, and
 * the caller refuses any token carrying one before calling this.
 */
function joinAgainstAssertingDir(token: string, assertingFile: string): string {
  const clean = token.startsWith("./") ? token.slice(2) : token;
  const dir = assertingFile.slice(0, assertingFile.lastIndexOf("/") + 1);
  return `${dir}${clean}`;
}

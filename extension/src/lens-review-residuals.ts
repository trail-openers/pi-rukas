/**
 * lens-review-residuals — the #973 residual-findings disclosure post.
 *
 * When `dispatch_lens_review`'s verdict is ISSUES_FOUND and an open PR/MR
 * exists for the branch, this module posts the residual findings (severity,
 * path:line, title) as ONE PR comment carrying the stable hidden marker
 * (`lensResidualsMarker`, merge-guard-round-cap.ts):
 *
 *   <!-- pi-rukas:lens-residuals branch=<b> patch=<patchId> -->
 *
 * The `patch=` is the SAME id the merge guard computes and compares —
 * `branchPatchId` against the PR's ACTUAL base branch (design decision 1).
 * The guard later reads the PR's comments (its own exec call) and refuses
 * the merge when no comment carries a marker matching the current branch
 * AND the current patch — so a failed post here leaves the guard refusing
 * (fail closed), and the failure is reported in the tool result (the
 * caller appends it to the summary text).
 *
 * Posting trigger (design decision 2): ISSUES_FOUND AND an open PR/MR,
 * exactly. APPROVED, REVIEW_INCOMPLETE and CRITICAL_ISSUES_FOUND post
 * nothing — an APPROVED run makes the marker moot because the guard's
 * strict rule already passes on that run's passed:true entry.
 *
 * Best-effort by design: every fault (no PR number, no remote, no base
 * ref, patch-id failure, forge post failure) is caught, traced, and
 * reported — never thrown, and never silently swallowed (the caller sees
 * the reason in the tool result).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectForge } from "./forge-detect.ts";
import { type LedgerEntry, branchPatchId, latestEntry, remoteName } from "./review-ledger.ts";
import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import type { LensReviewSummary } from "./lens-review.ts";
import { trace } from "./trace.ts";

const execp = promisify(exec);

/**
 * Post the residual-findings disclosure for a completed lens review.
 *
 * `findings` is the review's deduped finding list (from the summary). The
 * branch's ledger entries are read from the file the writer just appended
 * to (the write is fire-and-forget, so the caller passes the path; a
 * missing/unreadable file yields no auto-`since` but does not block the
 * post — the marker is about the PR, not the ledger).
 *
 * Returns the text the caller appends to the tool result (empty on
 * success — nothing extra to say; one line naming the failure otherwise).
 */
export async function postLensResidualDisclosure(opts: {
  summary: LensReviewSummary;
  branch?: string;
  cwd: string;
  ledgerFile?: string;
  execFn?: typeof execp;
}): Promise<string> {
  const { summary, branch, cwd } = opts;
  const execFn = opts.execFn ?? execp;
  // Posting trigger (design decision 2): only ISSUES_FOUND posts. The
  // other verdicts have no residual to disclose (APPROVED — the guard's
  // strict rule passes; REVIEW_INCOMPLETE / CRITICAL_ISSUES_FOUND — the
  // guard refuses on the ledger entry itself).
  if (summary.verdict !== "ISSUES_FOUND") return "";
  if (!branch) {
    trace("lens-residuals: no branch — cannot resolve the open PR; disclosure skipped");
    return "";
  }
  const run = doPost(opts, execFn, cwd, branch);
  try {
    return await run;
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200) ?? "unknown error";
    trace(`lens-residuals: post failed: ${msg}`);
    return `residual-findings disclosure FAILED: ${msg} — the merge guard will refuse the merge until the disclosure is posted (fail closed)`;
  }
}

async function doPost(
  opts: {
    summary: LensReviewSummary;
    branch?: string;
    cwd: string;
    ledgerFile?: string;
  },
  execFn: typeof execp,
  cwd: string,
  branch: string,
): Promise<string> {
  const { summary } = opts;
  // The PR for the branch (the guard resolves it the same way — the forge
  // CLI on the current branch; the caller runs from the branch's repo).
  const detection = await detectForge(cwd, { allowProbe: false });
  if (detection.source === "unknown") {
    throw new Error(`cannot determine the forge for ${cwd} (no PR number)`);
  }
  let prNumber: number | undefined;
  if (detection.forge === "gitlab") {
    const { stdout } = await execFn(`glab mr view --output json`, {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: 30_000,
    });
    prNumber = (JSON.parse(stdout) as { iid?: number }).iid;
  } else {
    const { stdout } = await execFn(`gh pr view --json number`, {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: 30_000,
    });
    prNumber = (JSON.parse(stdout) as { number?: number }).number;
  }
  if (typeof prNumber !== "number") {
    throw new Error(`no open PR/MR for branch ${branch} (no PR number resolved)`);
  }
  // The PR's identity (base branch) — the SAME read the guard uses for its
  // target, so the patch-id base is the PR's ACTUAL base (design decision 1).
  let baseBranch: string | undefined;
  let headBranch: string | undefined;
  if (detection.forge === "gitlab") {
    const { stdout } = await execFn(`glab mr view ${prNumber} --output json`, {
      cwd,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    const raw = JSON.parse(stdout) as { source_branch?: string; target_branch?: string };
    headBranch = raw.source_branch;
    baseBranch = raw.target_branch;
  } else {
    const { stdout } = await execFn(
      `gh pr view ${prNumber} --json headRefName,baseRefName`,
      { cwd, maxBuffer: 64 * 1024, timeout: 30_000 },
    );
    const raw = JSON.parse(stdout) as { headRefName?: string; baseRefName?: string };
    headBranch = raw.headRefName;
    baseBranch = raw.baseRefName;
  }
  if (!headBranch || !baseBranch) {
    throw new Error(`PR #${prNumber} returned no head/base branch names`);
  }
  // The remote + the patch-id — the SAME computation the guard applies
  // (review-ledger.ts branchPatchId, the PR's actual base).
  const remote = await remoteName(execFn, cwd);
  if (!remote) throw new Error("no git remote found (origin/upstream/first)");
  const patchId = await branchPatchId(execFn, cwd, `${remote}/${headBranch}`, `${remote}/${baseBranch}`);
  if (!patchId) {
    throw new Error(`could not compute the patch-id for ${headBranch} against ${baseBranch}`);
  }
  // The marker + the findings body (severity, path:line, title — the
  // operator-readable list; the marker line is hidden in the render).
  const marker = lensResidualsMarker(headBranch, patchId);
  const lines = summary.findings.map(
    (f) => `- [${f.severity}] ${f.path}:${f.line ?? "?"} — ${f.title} (${f.lens})`,
  );
  const body = [
    `## Six-pass review — residual findings (round disclosure)`,
    ``,
    `The lens review verdict is **${summary.verdict}**; nothing listed here has been fixed.`,
    `None is CRITICAL and the adversarial gate passed the diff, so a round-capped`,
    `review may carry these forward — but they are recorded here so a merge is never`,
    `silent about them. Decide them before merging.`,
    ``,
    ...lines,
    ``,
    marker,
    ``,
  ].join("\n");
  // Post via a body file (the driver's discloseResidualFindings pattern —
  // `--body-file` avoids shell-quoting issues with multi-line bodies).
  const dir = mkdtempSync(path.join("/tmp", "pi-lens-residuals-"));
  const file = path.join(dir, "residuals.md");
  writeFileSync(file, body, "utf8");
  const cmd =
    detection.forge === "gitlab"
      ? `glab mr note ${prNumber} --body-file ${JSON.stringify(file)}`
      : `gh pr comment ${prNumber} --body-file ${JSON.stringify(file)}`;
  await execFn(cmd, { cwd, maxBuffer: 256 * 1024, timeout: 30_000 });
  return "";
}

/**
 * #973 — the auto delta base (design decision 6): the latest lens entry's
 * `headSha` for the branch, when present AND an ancestor of the given ref
 * (the caller passes the head the review will run against). Returns
 * undefined when no entry has a `headSha`, when the sha is not an ancestor
 * of `headRef`, or when the ancestry check fails (fail to the full review).
 */
export async function autoDeltaSince(
  entries: LedgerEntry[],
  branch: string,
  headRef: string,
  cwd: string,
  execFn?: typeof execp,
): Promise<string | undefined> {
  const fn = execFn ?? execp;
  const latest = latestEntry(entries, branch, "lens");
  const sha = latest?.headSha;
  if (!sha) return undefined;
  try {
    // `git merge-base --is-ancestor <sha> <head>` exits 0 when sha is an
    // ancestor of head. A non-ancestor means the branch was rebased or the
    // sha is from a divergent history — the delta would be wrong, so the
    // caller falls back to a full review.
    await fn(`git merge-base --is-ancestor ${sha} ${headRef}`, {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: 30_000,
    });
    return sha;
  } catch {
    return undefined;
  }
}

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
 * The post itself routes through the project's canonical comment seam
 * (forge-comments.ts `postPrComment`, #775) — the same shape the #712
 * guard's REST/verb doors and the driver's handoff fallback use — rather
 * than re-deriving a forge-specific argv by hand. The guard reads the
 * marker back through its own comments read (merge-guard.ts
 * `readPrCommentBodies`), which is the same shape the adapter's
 * `prComments` seam lists.
 *
 * Best-effort by design: every fault (no PR number, no remote, no base
 * ref, patch-id failure, forge post failure) is caught, traced, and
 * reported — never thrown, and never silently swallowed (the caller sees
 * the reason in the tool result).
 */

import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { postPrComment } from "./forge-comments.ts";
import { detectForge } from "./forge-detect.ts";
import type { LensReviewSummary } from "./lens-review.ts";
import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import { branchPatchId, remoteName } from "./review-ledger.ts";
import { trace } from "./trace.ts";

const execp = promisify(exec);

/**
 * Post the residual-findings disclosure for a completed lens review.
 *
 * Returns the text the caller appends to the tool result (empty on
 * success — nothing extra to say; one line naming the failure otherwise).
 */
export async function postLensResidualDisclosure(opts: {
  summary: LensReviewSummary;
  branch?: string;
  cwd: string;
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
  opts: { summary: LensReviewSummary; branch?: string; cwd: string; execFn?: typeof execp },
  execFn: typeof execp,
  cwd: string,
  branch: string,
): Promise<string> {
  const { summary } = opts;
  // The PR for the branch (the guard resolves it the same way — the forge
  // CLI on the current branch; the caller runs from the branch's repo).
  const detection = await detectForge(cwd, { allowProbe: false });
  if (detection.forge === "unknown") {
    throw new Error(`cannot determine the forge for ${cwd} (no PR number)`);
  }
  let prNumber: number | undefined;
  if (detection.forge === "gitlab") {
    const { stdout } = await execFn("glab mr view --output json", {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: 30_000,
    });
    prNumber = (JSON.parse(stdout) as { iid?: number }).iid;
  } else {
    const { stdout } = await execFn("gh pr view --json number", {
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
    const { stdout } = await execFn(`gh pr view ${prNumber} --json headRefName,baseRefName`, {
      cwd,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
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
  const patchId = await branchPatchId(
    execFn,
    cwd,
    `${remote}/${headBranch}`,
    `${remote}/${baseBranch}`,
  );
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
    "## Six-pass review — residual findings (round disclosure)",
    "",
    `The lens review verdict is **${summary.verdict}**; nothing listed here has been fixed.`,
    "None is CRITICAL and the adversarial gate passed the diff, so a round-capped",
    "review may carry these forward — but they are recorded here so a merge is never",
    "silent about them. Decide them before merging.",
    "",
    ...lines,
    "",
    marker,
    "",
  ].join("\n");
  // Post via the project's canonical comment seam (forge-comments.ts
  // postPrComment, #775) — the SAME shape the driver's handoff fallback
  // uses, rather than a forge-specific argv re-derived here. The body file
  // is written to a temp dir for the lifetime of the post (`--body-file`
  // avoids shell-quoting issues with multi-line bodies) and removed
  // afterwards.
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-residuals-"));
  try {
    const file = path.join(dir, "residuals.md");
    writeFileSync(file, body, "utf8");
    await postPrComment(
      {
        forge: detection.forge,
        run: (cmd, map) =>
          execFn(cmd, { cwd, maxBuffer: 256 * 1024, timeout: 30_000 }).then(({ stdout }) =>
            map(stdout),
          ),
        withBodyFile: (_prefix, _b, withFile) => withFile(file),
      },
      prNumber,
      body,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return "";
}

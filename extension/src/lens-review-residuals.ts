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
import * as cmds from "./forge-commands.ts";
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
  pr?: number;
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
  // A branch is required to resolve the PR (or an explicit `pr` number is
  // used directly). Without either, the disclosure is skipped (fail
  // closed — the guard refuses).
  if (!branch && !opts.pr) {
    trace(
      "lens-residuals: no branch and no PR number — cannot resolve the open PR; disclosure skipped",
    );
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
    pr?: number;
    cwd: string;
    execFn?: typeof execp;
  },
  execFn: typeof execp,
  cwd: string,
  branch: string | undefined,
): Promise<string> {
  const { summary } = opts;
  // Resolve the PR number: explicit `pr` param → branch lookup via forge CLI.
  let prNumber: number | undefined = opts.pr;
  if (prNumber === undefined) {
    // The PR for the branch (the guard resolves it the same way — the forge
    // CLI on the current branch; the caller runs from the branch's repo).
    const detection = await detectForge(cwd, { allowProbe: false });
    if (detection.forge === "unknown") {
      throw new Error(`cannot determine the forge for ${cwd} (no PR number)`);
    }
    // The PR/MR for the BRANCH (the canonical by-source-branch lookup,
    // forge-commands.ts prListCmd — `glab mr view` with no argument reads the
    // MR for the CURRENT branch, not necessarily this one). A list that is
    // empty or does not name a number is "no open PR/MR" (fail closed).
    if (detection.forge === "gitlab") {
      const { stdout } = await execFn(
        cmds.prListCmd("gitlab", { sourceBranch: branch, state: "open" }),
        {
          cwd,
          maxBuffer: 8 * 1024,
          timeout: 30_000,
        },
      );
      const rows = JSON.parse(stdout) as Array<{ iid?: number }>;
      const first = rows[0];
      prNumber = Array.isArray(rows) && first ? first.iid : undefined;
    } else {
      const { stdout } = await execFn(
        cmds.prListCmd("github", { sourceBranch: branch, state: "open" }),
        {
          cwd,
          maxBuffer: 8 * 1024,
          timeout: 30_000,
        },
      );
      const rows = JSON.parse(stdout) as Array<{ number?: number }>;
      const first = rows[0];
      prNumber = Array.isArray(rows) && first ? first.number : undefined;
    }
    if (typeof prNumber !== "number") {
      throw new Error(`no open PR/MR for branch ${branch} (no PR number resolved)`);
    }
  }
  // The PR's identity (base branch) — the SAME read the guard uses for its
  // target, so the patch-id base is the PR's ACTUAL base (design decision 1).
  // The marker's `branch=` is the PR's headRefName (remote prefix stripped),
  // NOT the caller's resolved branch — the guard compares the marker's
  // branch against the PR's headRefName, so the marker must carry the same
  // value the guard will see.
  let baseBranch: string | undefined;
  let headBranch: string | undefined;
  {
    const detection = await detectForge(cwd, { allowProbe: false });
    if (detection.forge === "unknown") {
      throw new Error(`cannot determine the forge for ${cwd} (no PR number)`);
    }
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
  }
  if (!headBranch || !baseBranch) {
    throw new Error(`PR #${prNumber} returned no head/base branch names`);
  }
  // The remote + the patch-id — the SAME computation the guard applies
  // (review-ledger.ts branchPatchId, the PR's actual base).
  const remote = await remoteName(execFn, cwd);
  if (!remote) throw new Error("no git remote found (origin/upstream/first)");
  // #973 review — the patch-id is computed against FRESH refs: the guard
  // fetches the branch before its own patch-id, so the marker must use the
  // same refs (a local clone that has not seen the latest push would
  // compute a stale patch-id and the guard's marker check would fail even
  // though the post "succeeded" — the disclosure would never match). The
  // fetch runs first; on a fetch failure nothing is posted and the failure
  // is reported (fail closed — the caller's catch returns the note).
  try {
    await execFn(`git fetch ${remote} ${headBranch} ${baseBranch}`, {
      cwd,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
  } catch (err) {
    throw new Error(
      `git fetch ${remote} ${headBranch} ${baseBranch} failed: ${(err as Error).message?.slice(0, 200) ?? "unknown error"} — the disclosure was not posted (fail closed; the merge guard will refuse until the disclosure is posted)`,
    );
  }
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
  // The marker uses the PR's headRefName (stripped of remote prefix) — the
  // guard compares the marker's branch against the PR's headRefName, so the
  // marker must carry the SAME value the guard will see.
  const markerBranch = headBranch.replace(/^\/?[^/]+\//, "");
  const marker = lensResidualsMarker(markerBranch, patchId);
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
  // uses. postPrComment's withBodyFile OWNS the body→file lifecycle here:
  // it writes the body to a fresh temp file, hands the path to the
  // `--body-file` command (avoids shell-quoting issues with multi-line
  // bodies), and removes the file afterwards — no local temp-dir
  // bookkeeping in this module.
  const detection = await detectForge(cwd, { allowProbe: false });
  if (detection.forge === "unknown") {
    throw new Error(`cannot determine the forge for ${cwd} (no forge for comment post)`);
  }
  await postPrComment(
    {
      forge: detection.forge,
      run: (cmd, map) =>
        execFn(cmd, { cwd, maxBuffer: 256 * 1024, timeout: 30_000 }).then(({ stdout }) =>
          map(stdout),
        ),
      withBodyFile: async (_prefix, b, withFile) => {
        const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-residuals-"));
        try {
          const file = path.join(dir, "residuals.md");
          writeFileSync(file, b, "utf8");
          return await withFile(file);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    prNumber,
    body,
  );
  return "";
}

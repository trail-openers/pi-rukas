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
 * `mergeIdentity` (merge-guard-reads.ts, #1305) — the merge-base identity
 * the ledger writers record.
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { neutraliseEvidence, neutraliseMarkdownField } from "./comment-evidence.ts";
import { execp } from "./exec.ts";
import * as cmds from "./forge-commands.ts";
import { postPrComment } from "./forge-comments.ts";
import { detectForge } from "./forge-detect.ts";
import { resolvedSection, setAsideSection, suppressedSection } from "./lens-residuals.ts";
import { severityLabel } from "./lens-residuals.ts";
import { advisorySection } from "./lens-review-advisory.ts";
import { deltaFallbackText } from "./lens-review-delta-disclose.ts";
import { type Finding, carriedHeading, isCarried } from "./lens-review-types.ts";
import type { LensReviewSummary } from "./lens-review.ts";
import { mergeIdentity } from "./merge-guard-reads.ts";
import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import { PublicHygieneError } from "./public-hygiene-config.ts";
import { driverPublishRefusal } from "./public-hygiene-driver.ts";
import { remoteName } from "./review-ledger.ts";
import { trace } from "./trace.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";

/**
 * The git-ref-safe character allowlist the marker's `branch=` value must
 * satisfy before it is interpolated into the HTML-comment marker: letters,
 * digits, `/`, `.`, `_`, `-` — exactly what a branch name may carry in
 * practice, and nothing that could terminate the marker comment early
 * (`>` + `-` + `>`) or smuggle a second marker into the post. A failing
 * value is a refusal (fail closed — the guard then refuses the merge),
 * never a post.
 */
const GIT_REF_SAFE = /^[A-Za-z0-9/._-]+$/;

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
  // #1000 — an explicit `pr` is interpolated into the forge's identity and
  // comment commands (`gh pr view <pr> --json ...`, `gh pr comment <pr>`),
  // so a non-integer or non-positive value (a float like 7.5, NaN, 0 or a
  // negative) would either hit a bogus PR or fail the forge with an opaque
  // error: refuse up front (fail closed, same shape as the other refusals
  // — nothing is posted, the note names the refusal). Checked BEFORE the
  // no-branch-and-no-pr skip because a `pr: NaN` is falsy and would
  // otherwise be treated as "no PR number at all" (a silent skip) instead
  // of the explicit invalid-input refusal it is. The branch-lookup path's
  // resolved number is forge-supplied and integer by construction.
  if (opts.pr !== undefined && (!Number.isInteger(opts.pr) || opts.pr <= 0)) {
    trace(`lens-residuals: invalid PR number ${opts.pr} — disclosure skipped (fail closed)`);
    return "residual disclosure NOT posted — invalid PR number";
  }
  if (!branch && !opts.pr) {
    trace(
      "lens-residuals: no branch and no PR number — cannot resolve the open PR; disclosure skipped",
    );
    return "";
  }
  // The lookup-skip is derived from `pr !== undefined` (the branch-lookup
  // path inside doPost does the `prNumber === undefined` check); the real
  // `branch` — which may be undefined on the explicit-pr path — is passed
  // through so no sentinel string ever reaches the branch-lookup path.
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
  // The forge is resolved ONCE here and reused for the PR-number lookup, the
  // identity read and the comment post (three identical detectForge calls
  // was the old shape — three identical 30s-capable reads for one answer).
  const detection = await detectForge(cwd, { allowProbe: false });
  if (detection.forge === "unknown") {
    throw new Error(`cannot determine the forge for ${cwd} (no PR number)`);
  }
  // Resolve the PR number: explicit `pr` param → branch lookup via forge CLI
  // (the branch lookup only runs when no explicit `pr` was supplied — that
  // is the lookup-skip, derived from `opts.pr === undefined`, not from a
  // sentinel branch string).
  let prNumber: number | undefined = opts.pr;
  if (prNumber === undefined) {
    // The PR for the branch (the guard resolves it the same way — the forge
    // CLI on the current branch; the caller runs from the branch's repo).
    if (detection.forge === "gitlab") {
      // The PR/MR for the BRANCH (the canonical by-source-branch lookup,
      // forge-commands.ts prListCmd — `glab mr view` with no argument reads the
      // MR for the CURRENT branch, not necessarily this one). A list that is
      // empty or does not name a number is "no open PR/MR" (fail closed).
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
  // target, so the base the identity checks against the mainline is the PR's (#1305).
  // The marker's `branch=` is the PR's headRefName, NOT the caller's resolved
  // branch — the guard compares the marker's branch against the PR's
  // headRefName, so the marker must carry the same value the guard will see.
  // headRefName (gh) / source_branch (glab) is ALREADY the bare branch name
  // — there is no remote prefix to strip (and stripping one path segment
  // would leave the marker carrying `x` for a branch named `feature/x`).
  // (a branch named `feature/x` must stay `feature/x` in the marker or the
  // guard's `lensResidualsMarker(target.headBranch, patchId)` match can
  // never succeed).
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
  // SECURITY (fail closed) — BOTH refs from the identity read are validated
  // against GIT_REF_SAFE BEFORE any command (the `git fetch` below, the
  // patch-id read, the marker) uses either one: a baseRefName containing a
  // shell metacharacter (`;`, `$()`, a space, …) would otherwise be
  // interpolated into the shell `git fetch ${remote} ${headBranch}
  // ${baseBranch}` and execute arbitrary commands — nothing is fetched or
  // posted on a failure, and the caller's catch returns the refusal note
  // (the guard then refuses the merge, as with every other fault here).
  // The headRefName check moved here from the marker construction: it is
  // the SAME ref that feeds the fetch, so it is covered by this single
  // check (and both refs must hold before any exec touches either).
  if (!GIT_REF_SAFE.test(headBranch) || !GIT_REF_SAFE.test(baseBranch)) {
    trace(
      `lens-residuals: head/base branch names not git-ref-safe (head=${JSON.stringify(headBranch)}, base=${JSON.stringify(baseBranch)}) — disclosure refused (fail closed)`,
    );
    throw new Error(
      `the PR's head/base branch name is not git-ref-safe (head=${JSON.stringify(headBranch)}, base=${JSON.stringify(baseBranch)}) — disclosure not posted (fail closed; the merge guard refuses until the disclosure is posted)`,
    );
  }
  // The remote + the patch-id — the SAME computation the guard applies
  // (merge-guard-reads.ts mergeIdentity, #1305).
  const remote = await remoteName(execFn, cwd);
  if (!remote) throw new Error("no git remote found (origin/upstream/first)");
  // #973 review — the patch-id is computed against FRESH refs: the guard
  // fetches the branch before its own patch-id, so the marker must use the
  // same refs (a local clone that has not seen the latest push would
  // compute a stale patch-id and the guard's marker check would fail even
  // though the post "succeeded" — the disclosure would never match). The
  // fetch runs first; on a fetch failure nothing is posted and the failure
  // is reported (fail closed — the caller's catch returns the note).
  const fetchRefProblem = netRefProblem(remote, headBranch, baseBranch);
  if (fetchRefProblem !== undefined) {
    throw new Error(
      `git fetch refused: ${fetchRefProblem} — the disclosure was not posted (fail closed)`,
    );
  }
  try {
    await runNetGit(execFn, "git", {
      cwd,
      maxBuffer: 64 * 1024,
      timeoutMs: 30_000,
      argv: ["fetch", remote, headBranch, baseBranch],
    });
  } catch (err) {
    throw new Error(
      `git fetch ${remote} ${headBranch} ${baseBranch} failed: ${(err as Error).message?.slice(0, 200) ?? "unknown error"} — the disclosure was not posted (fail closed; the merge guard will refuse until the disclosure is posted)`,
    );
  }
  const identity = await mergeIdentity(execFn, cwd, headBranch, baseBranch);
  if (!identity.ok) {
    throw new Error(
      `could not compute the patch-id for ${headBranch}: ${identity.reason} — the disclosure was not posted (fail closed)`,
    );
  }
  const patchId = identity.patchId;
  // The marker + the findings body (severity, path:line, title — the
  // operator-readable list; the marker line is hidden in the render).
  // The marker uses the PR's headRefName AS-IS (already a bare branch name
  // — validated git-ref-safe above, before the fetch; stripping a path
  // segment from it would post a marker the guard's
  // `lensResidualsMarker(target.headBranch, patchId)` can never match).
  const marker = lensResidualsMarker(headBranch, patchId);
  // Severity, path and title are the LENS's words, stored in a file an agent
  // could have written, and this body is a forge comment: a title carrying
  // `<!-- pi-rukas:lens-residuals … -->` would post a second marker that
  // `mergeGuardRoundCap`'s substring check reads as its own disclosure, and a
  // `[text](url)` title becomes a clickable link. `neutraliseMarkdownField`
  // keeps the line's shape (this is a bullet list, not a prompt block) while
  // removing what a POST renders; the marker below is the renderer's own line
  // and is never passed through it.
  const residualLine = (f: Finding) => {
    const where = neutraliseMarkdownField(`${f.path}:${f.line ?? "?"}`);
    return `- [${severityLabel(f.severity)}] ${where} — ${neutraliseMarkdownField(f.title)} (${neutraliseMarkdownField(f.lens)})`;
  };
  // A carried row is still open from an earlier round: it sits under its own
  // heading, apart from this round's findings, so the comment never presents it
  // as this round's own finding.
  const carriedRows = summary.findings.filter(isCarried);
  const lines = [
    ...summary.findings.filter((f) => !isCarried(f)).map(residualLine),
    ...(carriedRows.length > 0
      ? [
          "",
          carriedHeading(carriedRows.length, "still open; this round did not resolve them:"),
          ...carriedRows.map(residualLine),
        ]
      : []),
  ];
  const body = [
    "## Six-pass review — residual findings (round disclosure)",
    "",
    `The lens review verdict is **${summary.verdict}**; nothing listed here has been fixed.`,
    "None is CRITICAL and the adversarial gate passed the diff, so a round-capped",
    "review may carry these forward — but they are recorded here so a merge is never",
    "silent about them. Decide them before merging.",
    "",
    ...lines,
    ...suppressedSection(
      summary.suppressed,
      `Suppressed as already known (${summary.suppressed?.length ?? 0}) — not re-reported; each names its row id and the reason it was dropped:`,
    ),
    ...resolvedSection(summary.resolved),
    ...setAsideSection(summary.setAside),
    ...advisorySection(summary.advisory),
    ...(summary.memoryNote ? ["", neutraliseEvidence(summary.memoryNote)] : []),
    ...(summary.deltaReview?.fallback
      ? [
          "",
          `Delta fallback: ${deltaFallbackText({ since: summary.deltaReview.since, fallback: summary.deltaReview.fallback })} — main's hunks may be included.`,
        ]
      : []),
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
  // bookkeeping in this module. The detection above is reused (resolved
  // once at the top of this function).
  // #1788 — the whole body, on the public-repositories-only rule, before
  // anything is written: this is a publish the tool_call guard cannot see (an
  // in-process exec), and its text is quoted off the branch by six reviewers.
  const refusal = await driverPublishRefusal("pull request comment", body, {
    command: "gh pr comment",
    cwd,
    exec: (cmd, opts) => execFn(cmd, opts ?? {}),
  });
  if (refusal !== undefined) throw new PublicHygieneError(refusal);
  await postPrComment(
    {
      forge: detection.forge,
      // #1788 — this disclosure is a PR comment, i.e. public text, and the seam
      // now requires the check rather than permitting its absence. The body is
      // composed from lens findings quoted off the branch, so it is exactly the
      // kind of text that has carried a private name before; a refusal is thrown
      // and this module's best-effort contract reports it rather than posting.
      // The seam's own awaited check is the one that judges this body: it now
      // resolves the target repository's visibility, so a second synchronous
      // copy of the pure matcher here would be a second owner of a decision the
      // seam already makes with more information than this call has.
      checkPublicText: async (label, text) => {
        const refusal = await driverPublishRefusal(label, text, {
          command: "gh pr comment",
          cwd,
          exec: (cmd, opts) => execFn(cmd, opts ?? {}),
        });
        if (refusal !== undefined) throw new PublicHygieneError(refusal);
      },
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

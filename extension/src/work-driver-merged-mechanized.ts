/**
 * work-driver-merged-mechanized — mechanized PR merge for the `merged` step.
 *
 * Extracted into a separate file to protect work-driver-merged.ts's
 * budget (266 lines, 500-line hard cap). Follows the mechanizedCommitPr
 * pattern: direct execution of enumerable git/gh operations; fallback
 * to LLM ops dispatch on any mechanized failure.
 *
 * Merge method is derived from repo settings via the forge adapter
 * (S4 of epic #608, #612) — forge-agnostic, the same adapter the rest
 * of the driver's PR operations go through.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ShellExecFn } from "./exec.ts";
import { prMergeHeadPinFlag, prMergeSubjectFlag } from "./forge-commands.ts";
import { PublicHygieneError } from "./public-hygiene-config.ts";
import { driverPublishCheck } from "./public-hygiene-driver.ts";
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import { trace } from "./trace.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { mergeSubjectForState } from "./work-driver-merge-subject.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The SHELL-ONLY seam of this module (#1279). `ShellExecFn` declares no `argv`,
 * so an argv-form call on the executor a function here holds is a compile
 * error, not a silently dropped argument. Everything this module runs is a
 * shell string: forge reads and the merge command. The bare `exec` import is
 * deliberate — the in-process merge exemption is pinned by test-merge-guard.ts.
 * An argv-form call added on this path needs the argv-aware `execp` first.
 */
const execp: ShellExecFn = promisify(exec);

/**
 * The hygiene refusal, recognised without importing a class across a forge
 * adapter that may be a test's own fake: the forge seam throws
 * `PublicHygieneError`, and `publicHygiene === true` is the stable marker the
 * class carries for exactly this question.
 */
function isPublicHygieneRefusal(err: unknown): boolean {
  return (
    err instanceof PublicHygieneError ||
    (err as { publicHygiene?: unknown } | null)?.publicHygiene === true
  );
}

/** The refusal text, never anything the guard would not have printed itself. */
function refusalMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.slice(0, 400);
}

/** Valid merge methods — maps to the forge adapter's `prMerge` method argument. */
export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * #1533 — how a refused head pin presents itself.
 *
 * Both CLIs say the same thing in different words, and neither wording may be
 * read as "already merged" or as a permanent forge error (see the classifier
 * below, which runs BEFORE those two checks). Spellings collected from the
 * upstream sources:
 *
 *  - GitHub CLI (`cli/cli`, `pkg/cmd/pr/merge/merge.go`) renders the API's
 *    `headRefOid` mismatch as a pull-request-state error whose text contains
 *    the flag name — that is the stable token, and gh's surrounding prose is
 *    not. So the token alone never classifies: it is required ALONGSIDE a
 *    mismatch word, so a gh error that merely mentions the flag (an unknown
 *    flag on an old gh, for instance) is not read as a moved head.
 *  - GitLab's `glab mr merge --sha` refuses with the SHA it was given and the
 *    one it found (its MR merge checks `sha` against `diff_refs.head_sha`),
 *    which is the second shape — a mismatch sentence naming SHAs, with or
 *    without the flag name.
 *
 * A pin refusal is never retried and never handed to the LLM-ops fallback:
 * both would be an attempt to merge a head nobody reviewed.
 */
export function isHeadPinRefusal(message: string): boolean {
  const m = message.toLowerCase();
  // The mismatch must be about the HEAD / the pinned commit, not about some
  // other SHA the error happens to name: `does not match` alone also renders a
  // base-branch or author mismatch, and those are ordinary merge failures.
  const mismatch =
    /\bhead\b[^\n]{0,60}(does not match|no longer match|mismatch|changed|moved)|\bmismatched head\b|\bhead commit\b|\b(?:sha|commit) mismatch\b|\bmismatch\b[^\n]{0,40}\bhead\b/.test(
      m,
    );
  if (!mismatch) return false;
  // …and the sentence must actually be about the pin: it names the flag, or it
  // names SHAs (the `--sha` form spells the two OIDs rather than the flag).
  return m.includes("match-head-commit") || m.includes("--sha") || /[0-9a-f]{7,40}/.test(m);
}

/** The refusal text of a pin rejection, bounded for the state file. */
function pinRefusalReason(message: string): string {
  return `head pin refused: the PR head no longer matches the reviewed commit — ${message
    .slice(0, 300)
    .replace(/[\r\n\t]+/g, " ")}`;
}

/**
 * Derive the merge method from repo settings via the forge adapter.
 *
 * Makes ONE adapter `repoSettings()` call and applies precedence:
 *   1. `squashMergeAllowed` → squash
 *   2. `mergeCommitAllowed` → merge
 *   3. `rebaseMergeAllowed` → rebase
 *   4. All false / forge undeterminable / call fails → fallback
 *
 * Squash is preferred when multiple are allowed — matches common default
 * and this project's convention.
 */
export async function deriveMergeMethod(
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<{ method: MergeMethod } | { fallback: true; note: string }> {
  const forge = await forgeForCycle({ repoRoot }, execFn);
  if (forge) {
    try {
      const repo = await forge.repoSettings();
      if (repo.squashMergeAllowed === true) return { method: "squash" };
      if (repo.mergeCommitAllowed === true) return { method: "merge" };
      if (repo.rebaseMergeAllowed === true) return { method: "rebase" };
      return {
        fallback: true,
        note: `no merge method permitted by repo settings (squashMergeAllowed=${repo.squashMergeAllowed}, mergeCommitAllowed=${repo.mergeCommitAllowed}, rebaseMergeAllowed=${repo.rebaseMergeAllowed}) — falling back to LLM dispatch`,
      };
    } catch (err) {
      return {
        fallback: true,
        note: `forge repo settings failed (${(err as Error).message?.slice(0, 120)}) — falling back to LLM dispatch`,
      };
    }
  }
  // Forge undetermined — fall back to the direct `gh` exec seam so the
  // test fakes (which mock `gh repo view` by substring) keep working.
  try {
    const { stdout } = await execFn(
      "gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    if (parsed.squashMergeAllowed === true) return { method: "squash" };
    if (parsed.mergeCommitAllowed === true) return { method: "merge" };
    if (parsed.rebaseMergeAllowed === true) return { method: "rebase" };
    return {
      fallback: true,
      note: "no merge method permitted by repo settings — falling back to LLM dispatch",
    };
  } catch (err) {
    return {
      fallback: true,
      note: `gh repo view failed (${(err as Error).message?.slice(0, 120)}) — falling back to LLM dispatch`,
    };
  }
}

/**
 * Execute the PR merge with the resolved method and verify the result,
 * via the forge adapter.
 *
 * Idempotent on resume: if the PR is already merged, treats that as
 * success and returns immediately. This is what makes a crash mid-
 * restoration recoverable.
 *
 * #356 — post-merge verification distinguishes two failure modes:
 *   - The `prView` call itself throws (transient forge/network error)
 *     AFTER the merge already succeeded → returns
 *     `{ merged: true, warningNote }`. Re-running the merge is impossible
 *     and a retry is out of scope; the merged event still fires with a
 *     warning note.
 *   - `prView` returns a state other than MERGED → genuine failure,
 *     returns `{ ok: false }`.
 *
 * Returns `{ merged: true, warningNote? }` on success, `{ ok: false }` on failure.
 */
/**
 * `executeAndVerifyMerge` — the `subject` is the #810 merge-subject seam:
 * when the driver merges a parked cycle's consolidated single-commit branch,
 * it must pass the PR title as `--subject` (the handoff-recovery commands
 * carry the same instruction), because GitHub's squash of a single-commit
 * branch would otherwise use that commit's housekeeping subject (the
 * `chore(handoff):` misclassification, PR #801). `undefined` keeps the
 * command byte-identical to the pre-#810 shape for the normal multi-commit
 * path and for forge adapters whose merge does not take a subject.
 */
export async function executeAndVerifyMerge(
  prNumber: number,
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
  subject: string | undefined,
  // #1533 — REQUIRED: the verified PR head OID the merge is pinned to. Every
  // caller has one by the time it reaches here; the step that cannot produce
  // one does not call this function at all.
  headOid: string,
  // The forge-resolution seam. Production leaves it undefined and the adapter
  // path is chosen by `forgeForCycle`, exactly as before; a test that exists to
  // cover the DIRECT-exec fallback passes `() => undefined` rather than hoping a
  // scratch directory has no forge above it — the probe asks `git remote`, so a
  // fixture nested inside any clone resolves a forge and the merge silently
  // takes the adapter path, which is the path that already had the check.
  resolveForge?: typeof forgeForCycle,
  // The visibility seam for the DIRECT-exec fallback's own public-only gate
  // (#1788 round 2). Production leaves it undefined and the fallback asks `gh`;
  // a test passes a stub so the case that a PRIVATE repository is not refused
  // can be stated without a forge. The adapter path gets its visibility from
  // the adapter itself.
  visibility?: VisibilityFn,
): Promise<{ merged: true; warningNote?: string } | { ok: false; reason: string }> {
  // Fail closed on the shape before anything is read or executed: an OID that
  // is not a full 40-char SHA is not a claim about one commit, and the command
  // builders refuse to render it anyway — naming the reason here is what the
  // merged step parks with.
  if (!isFullCommitSha(headOid)) {
    return {
      ok: false,
      reason: `refusing to merge PR #${prNumber}: the verified head OID is missing or not a full 40-char SHA`,
    };
  }
  const forge = resolveForge
    ? await resolveForge({ repoRoot }, execFn)
    : await forgeForCycle({ repoRoot }, execFn);
  if (!forge) {
    // Forge undetermined — fall back to the direct `gh` exec seam so the
    // test fakes (which mock `gh pr view` / `gh pr merge` by substring)
    // keep working unchanged. The subject travels as an argument to that
    // fallback and is checked there, on the single path that builds the
    // command — checking it here as well would state the same rule twice,
    // in two places that can then disagree.
    return executeAndVerifyMergeDirect(
      prNumber,
      method,
      execFn,
      repoRoot,
      subject,
      headOid,
      visibility,
    );
  }
  // First check: is the PR already merged? (idempotent on resume)
  try {
    const view = await forge.prView(prNumber);
    if (view.state === "MERGED") {
      trace(`work-driver: PR #${prNumber} already merged, skipping merge invocation`);
      return { merged: true };
    }
  } catch (err) {
    // prView failed — try the merge anyway; it may fail with "already merged" too.
    trace(`work-driver: pre-check prView failed: ${(err as Error).message?.slice(0, 120)}`);
  }

  // Execute the merge.
  //
  // #1788 round 1 — the subject check must not escape this function's contract.
  // `executeAndVerifyMerge` promises a discriminated result and `runMerged`
  // routes on it; a throw past here (the shape the forge adapter's `prMerge`
  // uses, where a `PublicHygieneError` is the caller's own error to catch) would
  // have left the merge step with an exception instead of a reason, and the
  // cycle would die instead of parking with the reason the guard gave. Same
  // shape as every other refusal in this function: `{ ok: false, reason }`.
  try {
    await forge.prMerge(prNumber, headOid, method, subject);
  } catch (err) {
    if (isPublicHygieneRefusal(err)) {
      const reason = refusalMessage(err);
      trace(`work-driver: merge subject refused for PR #${prNumber}: ${reason.slice(0, 200)}`);
      return { ok: false, reason };
    }
    const e = err as Error & { stderr?: string };
    const message = (e.stderr ?? e.message ?? "").toString();
    // #1533 — BEFORE the "already been merged" tolerance and the permanent-error
    // classifier: a refused pin is neither. Read as success it would report a
    // merge that never happened; read as an ordinary failure it would fall back
    // to an LLM ops dispatch against the same moved head.
    if (isHeadPinRefusal(message)) {
      trace(`work-driver: PR #${prNumber} head pin refused — no merge`);
      return { ok: false, reason: pinRefusalReason(message) };
    }
    // If the error indicates the PR is already merged, treat as success.
    if (/already been merged/i.test(message)) {
      trace(`work-driver: PR #${prNumber} was already merged during the merge invocation`);
      return { merged: true };
    }
    return {
      ok: false,
      reason: `forge pr merge failed: ${message.slice(0, 300)}`,
    };
  }

  // Post-merge verification: prView must return MERGED.
  try {
    const view = await forge.prView(prNumber);
    if (view.state !== "MERGED") {
      return {
        ok: false,
        reason: `forge pr merge succeeded but PR #${prNumber} state is ${view.state}, not MERGED`,
      };
    }
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const msg = e.message ?? "unknown";
    // Distinguish a deterministically PERMANENT forge failure from a transient
    // transport blip. The taxonomy is shared: the forge CLI's stderr carries
    // the same 4xx/"not found" wording `judgePrIdentity` (work-driver-git.ts)
    // and the mainline resolution paths match on — a permanent failure will
    // keep failing until the operator fixes auth or the PR, so #356's
    // merged-with-warning behaviour must NOT swallow it. Reporting it as
    // merged-success would leave an unverifiable merge looking green.
    const permanent = /\b(401|403|404)\b|not found|could not resolve/i.test(
      `${e.stderr ?? ""}\n${msg}`,
    );
    if (permanent) {
      trace(`work-driver: permanent post-merge verification failure: ${msg.slice(0, 200)}`);
      return {
        ok: false,
        reason: `post-merge verification failed with a permanent gh error: ${msg.slice(0, 300)}`,
      };
    }
    // #356 — TRANSIENT failure: the merge command succeeded (the merge call
    // exited 0); the verification call itself hit a forge/network error.
    // Returning ok:false here would cause the caller to emit a false
    // merge-failure plumb-report and fall back to an LLM ops dispatch
    // against an already-merged PR. The merged event still fires; a
    // warning note records that post-merge state verification was
    // inconclusive.
    const note = `post-merge verification inconclusive (prView error: ${msg.slice(0, 200) ?? "unknown"})`;
    trace(`work-driver: ${note}`);
    return { merged: true, warningNote: note };
  }

  return { merged: true };
}

/**
 * The direct-exec fallback for `executeAndVerifyMerge` when the forge is
 * undetermined (no remote, unknown host). This is the pre-S4 code path,
 * kept so the test fakes (which mock `gh pr view` / `gh pr merge` by
 * substring) keep working unchanged.
 */
async function executeAndVerifyMergeDirect(
  prNumber: number,
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
  subject: string | undefined,
  // #1533 — the verified head OID; REQUIRED and already shape-validated by the
  // caller, so this path cannot merge unpinned while the adapter path is pinned.
  headOid: string,
  visibility?: VisibilityFn,
): Promise<{ merged: true; warningNote?: string } | { ok: false; reason: string }> {
  // First check: is the PR already merged? (idempotent on resume)
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json state --jq '.state'`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() === "MERGED") {
      trace(`work-driver: PR #${prNumber} already merged, skipping merge invocation`);
      return { merged: true };
    }
  } catch (err) {
    trace(`work-driver: pre-check gh pr view failed: ${(err as Error).message?.slice(0, 120)}`);
  }

  // The subject a squash merge writes to main is public text, and this is the
  // one forge write a cycle cannot undo. The forge adapter's `prMerge` checks it
  // through `checkPublicText`; this direct-exec fallback builds the same command
  // itself and reaches no adapter, so it goes through the SAME driver seam —
  // one rule, one owner, one public-only gate, and a fallback that cannot become
  // the way past either. The pure `publicTextRefusal` it used to call asked
  // nothing about the repository, so a private project had its merge subject
  // refused here while the adapter path skipped the same text (#1788 round 2).
  // It returns the function's OWN failure shape rather than throwing, for the
  // reason spelled out on the adapter path above: `runMerged` routes on the
  // result, and a merge the guard refused is a merge that parks with a reason,
  // not an exception that escapes the step.
  // `mergeSubject` is the subject the merge actually writes: the checked text,
  // with this clone's paths rewritten out of it on a public target (#1788
  // follow-up). A local rather than a reassignment of the parameter.
  let mergeSubject = subject;
  if (subject !== undefined) {
    const checked = await driverPublishCheck("merge commit subject", subject, {
      command: "gh pr merge",
      cwd: repoRoot,
      // `VerifyExecFn` and the guard's `ExecFn` differ only in optionality of
      // the options bag; the seam accepts either shape and passes it through.
      exec: execFn as unknown as ExecFn,
      visibility,
      repoRoot,
    });
    if (checked.refusal !== undefined) {
      const refusal = checked.refusal;
      trace(`work-driver: merge subject refused for PR #${prNumber}: ${refusal.slice(0, 200)}`);
      return { ok: false, reason: refusal };
    }
    mergeSubject = checked.text;
  }

  // Execute the merge.
  try {
    await execFn(
      `gh pr merge ${prNumber} --${method} --delete-branch${prMergeSubjectFlag(mergeSubject)}${prMergeHeadPinFlag("github", headOid)}`,
      {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const message = (e.stderr ?? e.message ?? "").toString();
    // #1533 — before "already been merged" and before the permanent classifier.
    if (isHeadPinRefusal(message)) {
      trace(`work-driver: PR #${prNumber} head pin refused on the direct path — no merge`);
      return { ok: false, reason: pinRefusalReason(message) };
    }
    if (/already been merged/i.test(message)) {
      trace(`work-driver: PR #${prNumber} was already merged during gh pr merge invocation`);
      return { merged: true };
    }
    return {
      ok: false,
      reason: `gh pr merge failed: ${message.slice(0, 300)}`,
    };
  }

  // Post-merge verification: gh pr view must return MERGED.
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json state --jq '.state'`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() !== "MERGED") {
      return {
        ok: false,
        reason: `gh pr merge succeeded but PR #${prNumber} state is ${stdout.trim()}, not MERGED`,
      };
    }
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const msg = e.message ?? "unknown";
    const permanent = /\b(401|403|404)\b|not found|could not resolve/i.test(
      `${e.stderr ?? ""}\n${msg}`,
    );
    if (permanent) {
      trace(`work-driver: permanent post-merge verification failure: ${msg.slice(0, 200)}`);
      return {
        ok: false,
        reason: `post-merge verification failed with a permanent gh error: ${msg.slice(0, 300)}`,
      };
    }
    const note = `post-merge verification inconclusive (gh pr view error: ${msg.slice(0, 200) ?? "unknown"})`;
    trace(`work-driver: ${note}`);
    return { merged: true, warningNote: note };
  }

  return { merged: true };
}

/**
 * Mechanized merge: derive method → execute → verify.
 *
 * ANY failure returns `{ok: false, reason}` — the caller in runMerged
 * emits a plumb-report and falls back to the LLM ops dispatch.
 *
 * On success, returns the resolved merge method (for the merged event
 * and any fallback dispatch that follows) plus any notes from the
 * derive step.
 */
export async function mechanizedMerge(
  ctx: CycleContext,
  state: WorkState,
  // #1533 — the head the merged step verified, REQUIRED. A merge with no pin is
  // the defect this ticket removes, so the builder has no unpinned form.
  headOid: string,
): Promise<
  | { ok: true; method: MergeMethod; notes: string[] }
  | { ok: false; reason: string; method?: MergeMethod }
> {
  // #380 — this used to read `ctx.verifyExecFn` with no fallback, unlike
  // every other consumer of the seam. `verifyExecFn` is a TEST injection point
  // and is never assigned in production, so mechanized merge always returned
  // `ok: false` and every real merge went down the LLM-narrated path. That
  // also silently disabled `restoreCheckout`, since `mergeSucceeded` is only
  // set on this branch — which is why repoRoot was left sitting on the merged
  // feature branch after a cycle.
  const execFn: ShellExecFn = ctx.verifyExecFn ?? execp;

  const prNumber = state.pipelineState.prNumber;
  if (!prNumber) {
    return { ok: false, reason: "prNumber not set in pipeline state" };
  }
  // Checked before the method derivation so a cycle with nothing to pin does
  // not even read the repo settings; the merged step parks with this reason.
  if (!isFullCommitSha(headOid)) {
    return {
      ok: false,
      reason: `refusing to merge PR #${prNumber}: the verified head OID is missing or not a full 40-char SHA`,
    };
  }

  // Derive merge method from GitHub repo settings.
  const methodResult = await deriveMergeMethod(execFn, ctx.repoRoot);
  if ("fallback" in methodResult) {
    trace(`work-driver: merge method fallback: ${methodResult.note}`);
    return { ok: false, reason: methodResult.note };
  }

  // #810 — an explicit squash subject so a parked cycle's consolidated
  // single-commit branch lands with the PR title, not the driver's
  // `chore(handoff):` housekeeping commit subject. Returns undefined for
  // the normal shape (or when the PR title is unreadable) — the command
  // then stays byte-identical to the pre-#810 form.
  const subject = await mergeSubjectForState(ctx, state, execFn);
  if (subject) trace(`work-driver: merge subject override: ${subject}`);

  // Execute and verify the merge.
  const mergeResult = await executeAndVerifyMerge(
    prNumber,
    methodResult.method,
    execFn,
    ctx.repoRoot,
    subject,
    headOid,
  );
  if (!("merged" in mergeResult)) {
    return { ok: false, reason: mergeResult.reason, method: methodResult.method };
  }

  const notes: string[] = mergeResult.warningNote ? [mergeResult.warningNote] : [];
  trace(`work-driver: PR #${prNumber} merged via --${methodResult.method} ✓`);
  return { ok: true, method: methodResult.method, notes };
}

/**
 * merge-guard-reads — the forge reads and the ledger-branch refusal text the
 * merge guard (merge-guard.ts) needs on the lens-decision branch, extracted
 * into their own module to keep the guard under the 500-line file-size limit.
 *
 * Three concerns live here, all of them "read the forge or the ledger, then
 * say what the ledger shows":
 *
 * - `readPrCommentBodies` (#973): the PR/MR comment bodies the round-cap
 *   path's disclosure check reads (the guard's own exec call through the
 *   injectable `execFn`, no new forge seam). Refuses a malformed repo
 *   value or PR number up front (fail closed → []).
 * - `mergeIdentity` (#1305): the branch identity the guard compares and the
 *   residual-marker poster embeds — one function, so the two cannot disagree.
 * - `lensNotEvaluatedRefusal` (#1000): the refusal text the `applies: false`
 *   fall-through must use — "the round-cap path was not evaluated" —
 *   distinct from the `applies: true` path, where the rule WAS evaluated
 *   and a specific condition N failed (that refusal names the condition
 *   verbatim).
 * - `refuseUnlessCiGreen` (#2106): the guard's LAST gate — the executed CI
 *   verdict for the PR, read through the driver's own evidence gatherer, and
 *   the refusal that renders it. This is a forge READ like the others here,
 *   which is why it lives in this module and not in the guard.
 *
 * #1417 moved `renderHold` (and `HoldKind` / `HoldDetails`) out of here and
 * into merge-refusals.ts: a hold is refusal prose, not a forge read, and it
 * belongs beside the merge refusals it is deliberately worded differently
 * from.
 */

import { prCommentsCmd } from "./forge-commands.ts";
import { extractCommentRows } from "./forge-comments.ts";
import { isValidRepoValue } from "./merge-allowlist.ts";
import { analyseRefusal, clipCheckNames } from "./merge-refusal-render.ts";
import type { MergeExecFn, MergeTarget } from "./merge-target.ts";
import { identityBase } from "./review-ledger-path.ts";
import type { LedgerEntry } from "./review-ledger.ts";
import { committedPatchIdentity } from "./review-patch-identity.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { MergeEvidence } from "./work-driver-merge-evidence.ts";
import { gatherMergeEvidence } from "./work-driver-merge-evidence.ts";

/** Per-exec timeout for the guard's gh/git calls. */
const EXEC_TIMEOUT_MS = 30_000;

/**
 * #1305 — the identity of a PR's head as the review ledger records it:
 * `merge-base(<remote>/<head>, <remote>/<mainline>)..<remote>/<head>`
 * (`committedPatchIdentity`), against the SAME base the writers use
 * (`identityBase`, review-ledger-path.ts), so a
 * review stays current while main moves and goes stale only when the branch's
 * own content changes. The caller fetches both refs first.
 *
 * The writers only ever record against the MAINLINE, so a PR whose base is not
 * the mainline has no recorded identity to match: it fails closed here, named.
 * Every failure is `{ ok: false, reason }` — the guard refuses with it, the
 * marker poster posts nothing.
 */
export async function mergeIdentity(
  execFn: VerifyExecFn,
  cwd: string,
  headBranch: string,
  prBaseBranch: string,
): Promise<{ ok: true; patchId: string } | { ok: false; reason: string }> {
  const base = await identityBase(execFn, cwd);
  if (!base.ok) return base;
  if (prBaseBranch !== base.mainline) {
    return {
      ok: false,
      reason: `the PR's base \`${prBaseBranch}\` is not the mainline \`${base.mainline}\` — reviews are recorded against the mainline only`,
    };
  }
  const r = await committedPatchIdentity(
    execFn,
    cwd,
    `${base.remote}/${headBranch}`,
    `${base.remote}/${base.mainline}`,
  );
  return r.ok ? { ok: true, patchId: r.patchId } : r;
}

/**
 * #973 — the PR/MR comment bodies the round-cap path's disclosure check
 * reads (design decision 5: the guard's own exec call through the injectable
 * `execFn`, no new forge seam). The command is the CANONICAL seam
 * `prCommentsCmd` (forge-commands.ts — the same shape the `prComments`
 * adapter seam and the residual-disclosure post use: `gh pr view N
 * --json comments` on GitHub, the MR's `notes` endpoint on GitLab), so the
 * round-cap path works on GitLab too (a `glab mr view N --output json` read
 * has no `notes` field at all — the GitLab branch of the old hand-rolled
 * read could never find the marker). Every fault is fail-closed: an
 * unreadable comments list returns [] (the marker check fails, the merge is
 * refused) — the disclosure is a condition, and a missing condition is a
 * refusal, never a pass.
 */
export async function readPrCommentBodies(
  execFn: MergeExecFn,
  cwd: string,
  target: MergeTarget,
  prNumber: number,
  repoValue: string | undefined,
): Promise<string[]> {
  // Defensive second check mirroring readGhTarget (#955 lens fix 1): the
  // repo value is agent-derived (the `-R` flag or a PR URL) and is
  // interpolated into this exec string; an invalid value is a refusal
  // (fail closed — [] means the marker check fails and the merge is
  // refused), never a post or a pass.
  if (repoValue !== undefined && !isValidRepoValue(repoValue)) {
    trace(`merge-guard: invalid repo value ${repoValue} — comment read refused (fail closed)`);
    return [];
  }
  // Same shape for the PR number (fail closed): a non-integer or non-
  // positive value (NaN, 0, negative — a number the forge would interpolate
  // into `gh pr view <N>` / the MR notes endpoint as-is) is refused before
  // any exec — [] means the marker check fails and the merge is refused,
  // never a post or a pass. (A caller with a valid PR number already
  // resolved it through readGhTarget, which validates the same shape.)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    trace(`merge-guard: invalid PR number ${prNumber} — comment read refused (fail closed)`);
    return [];
  }
  const repoFlag = repoValue ? ` -R ${repoValue}` : "";
  try {
    const { stdout } = await execFn(prCommentsCmd(target.forge, prNumber) + repoFlag, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: EXEC_TIMEOUT_MS,
    });
    return extractCommentRows(target.forge, stdout).map((row) => {
      const o = row as Record<string, unknown>;
      const body = o.body;
      return typeof body === "string" ? body : "";
    });
  } catch (err) {
    trace(`merge-guard: comment read failed: ${(err as Error).message?.slice(0, 120)}`);
    return [];
  }
}

/**
 * #1360 — the adversarial half of the guard's refusal, with the latest row's
 * `detail` quoted verbatim when the row is non-passing and carries one.
 *
 * The ledger write records WHY a review did not count (`range-not-branch:
 * reviewed 1a2b3c4d..…`, `head-moved: …`, `tree-changed: …`, or the ordinary
 * verdict outcome). Without it the operator sees "no passing adversarial
 * review" and re-runs the very review that just ran — the row is on file,
 * it just refuses to pass. The comparison itself is untouched: this renders
 * the reason for a refusal the strict rule already made (#1360 settlement —
 * "no guard change" means the patch-id comparison and `mergeIdentity` are
 * unchanged; the refusal MESSAGE may carry the row's detail).
 *
 * A `detail` that is not a string (a legacy row) renders as no detail, and a
 * passing row never reaches here.
 *
 * The detail is quoted into a single-line refusal, so it is sanitised rather
 * than pasted: a detail written by an older build, or one whose git error
 * carried a newline, would otherwise break the line the operator reads (and
 * any log that parses it). Newlines and tabs collapse to spaces and the text
 * is clamped — the binding prefix and the SHAs it names are what the operator
 * needs, and both sit at the front.
 */

/** Bounds on the quoted detail: long enough for a prefix plus the two short
 * SHAs every binding refusal carries, short enough that one refusal stays one
 * readable line. */
const DETAIL_MAX_CHARS = 200;

/** One-line, bounded rendering of a row's `detail` — "" when it has none. */
function sanitizeDetail(detail: unknown): string {
  if (typeof detail !== "string") return "";
  const oneLine = detail.replace(/[\r\n\t]+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > DETAIL_MAX_CHARS ? `${oneLine.slice(0, DETAIL_MAX_CHARS - 1)}…` : oneLine;
}

export function adversarialRefusal(branch: string, adv: LedgerEntry | undefined): string {
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  if (!adv) {
    return `no passing adversarial review on file for branch \`${branch}\` (latest: none) — run adversarial_loop and let it complete before merging${override}`;
  }
  const identity = `passed=${adv.passed}, patchId=${adv.patchId.slice(0, 8)}`;
  const detailText = sanitizeDetail(adv.detail);
  const detail = detailText ? `, detail: ${detailText}` : "";
  return `no passing adversarial review on file for branch \`${branch}\` (latest: ${identity}${detail}) — run adversarial_loop and let it complete before merging${override}`;
}

/**
 * #1000 — the lens-branch refusal text. The round-cap path was consulted
 * and REFUSED TO APPLY (`applies: false`); the operator must be told that
 * the round-cap path was NOT evaluated — distinct from the `applies: true`
 * path, where the rule WAS evaluated and a specific condition N failed (the
 * guard renders that condition verbatim).
 *
 * Two shapes: no lens entry at all (nothing to evaluate), and a lens entry
 * whose verdict the round-cap rule cannot verify (a legacy row without a
 * `detail` field, or a non-ISSUES_FOUND verdict — the rule applies ONLY to
 * an ISSUES_FOUND latest entry).
 */
export function lensNotEvaluatedRefusal(
  branch: string,
  lens: LedgerEntry | undefined,
  opts: {
    /** #1449 — the path the last ledger write resolved to, when it was NOT
     * the per-clone ledger this guard is reading. Naming it is the whole point:
     * an operator who reads ONLY this refusal must be able to tell "nobody
     * reviewed this branch" from "a review ran and its row went elsewhere". */
    redirectedTo?: string;
  } = {},
): { block: true; reason: string } {
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  if (!lens) {
    // #1449 — the two situations an operator must be able to tell apart from
    // this text alone. Both refuse identically (the fail-closed rule is
    // unchanged); only the explanation differs.
    //
    // WHY the guard cannot detect this on its own: it reads through the same
    // `ledgerPathFor` the writer writes through, in the same process, so guard
    // and writer agree on the redirected file and the comparison a redirect
    // defeats is invisible from here. What it CAN say is what the write side
    // recorded at write time — the path provenance the writer persists on the
    // row it did manage to write (a row in a redirected file carries it; a
    // never-written row carries nothing), which is read out of the file the
    // override points at. Absent that provenance, this is the plain
    // never-reviewed refusal.
    if (opts.redirectedTo) {
      return {
        block: true,
        reason: `no lens review on file for branch \`${branch}\` (latest: none) — a lens review DID run and recorded its entry at the overridden path \`${opts.redirectedTo}\` rather than this clone's review ledger under the git common dir, so this guard cannot see it; unset PI_ENSEMBLE_REVIEW_LEDGER_FILE in the reviewing process and re-run dispatch_lens_review — the round-cap path was not evaluated (there is no entry to evaluate here)${override}`,
      };
    }
    return {
      block: true,
      reason: `no lens review on file for branch \`${branch}\` (latest: none) — the round-cap path was not evaluated (there is no entry to evaluate); run dispatch_lens_review and let it complete before merging${override}`,
    };
  }
  // A MALFORMED (non-string) detail is refused earlier by the round-cap
  // path itself (applies: true names the malformed entry), so the only
  // fall-through without a string detail is a row that simply lacks it.
  const detail =
    typeof lens.detail === "string"
      ? `verdict=${lens.detail}`
      : "verdict=unrecorded (legacy entry)";
  return {
    block: true,
    reason: `no passing lens review on file for branch \`${branch}\` (latest: passed=${lens.passed}, ${detail}) — the round-cap path was not evaluated (it applies only to an ISSUES_FOUND latest entry); run dispatch_lens_review and let it complete before merging${override}`,
  };
}

/**
 * #2106 — the guard's final fail-closed condition: the PR's executed CI
 * verdict. The incident: a plain `gh pr merge` shipped a PR whose only CI
 * check had concluded FAILURE a quarter of an hour earlier, because this
 * hook read only the local review ledger, and both rows had legitimately
 * passed. Ledger rows attest that the REVIEWS ran; nothing here said the
 * CHECKS passed. The driver's in-process merge has always consulted
 * `gatherMergeEvidence`; the `tool_call` path never did.
 *
 * No new CI reader: this calls the driver's gatherer as-is, so the guard and
 * the driver cannot drift on what "green" means — `skipped`, `neutral`,
 * `UNKNOWN`, `BLOCKED`, `DIRTY`, `DRAFT`, zero rows and a non-CLEAN
 * `mergeStateStatus` are all NOT passing there, and an unreadable read
 * refuses there too. `ok: true` is the only answer that lets the merge run.
 *
 * GitHub only, deliberately. `gatherMergeEvidence` spells its two reads with
 * the GitHub argv builders unconditionally (its check rows expect a `bucket`
 * or `state` per check), and `prChecksCmd("gitlab", n)` answers with a
 * pipelines payload whose rows carry neither, so running it for a glab merge
 * would refuse every MR on the absence of evidence. The GitLab path keeps
 * today's behaviour; its evidence gate is its own issue.
 *
 * #2107 — three things the gatherer's own contract leaves to the caller, and
 * which this guard does NOT leave unpoliced:
 *   - `expectedHeadOid`: the head the guard fetched and compared to the PR's
 *     `headOid`. The gatherer reports the OID its verdict was read at but
 *     accepts any value; only here is it required to BE that head. Absent or
 *     different is a refusal — a verdict about another commit is no verdict
 *     about this one.
 *   - `evidence.unrecognised`: rows whose `bucket`/`state` matched none of the
 *     gatherer's sets. The driver treats that as "no information"; the guard
 *     treats a list of checks nobody could grade as no evidence.
 *   - `timeoutMs`: `gatherMergeEvidence` bounds its reads by `maxBuffer` only,
 *     so a hung `gh` would hold the `tool_call` hook open forever. The guard
 *     races the read against its own per-exec budget and refuses as tooling.
 * `repoValue` threads the merge command's `-R` onto the two reads: gh resolves
 * the PR against the CURRENT checkout otherwise, which is a different PR than
 * the one the merge acts on.
 */
const CI_GUARD_BUDGET_MS = 2 * EXEC_TIMEOUT_MS;

export async function refuseUnlessCiGreen(
  execFn: MergeExecFn,
  cwd: string,
  prNumber: number,
  forge: MergeTarget["forge"],
  opts: {
    expectedHeadOid?: string;
    repoValue?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ block: true; reason: string } | undefined> {
  if (forge !== "github") return undefined;
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  // Every read in this pass is bounded by the guard's own per-exec budget: the
  // gatherer passes `maxBuffer` alone, and `MergeExecFn` forwards `timeout` to
  // the executor (merge-target.ts), so the bound is honoured rather than
  // decorative. The repo the merge names is threaded too (see the header).
  const repoFlag = opts.repoValue ? ` -R ${opts.repoValue}` : "";
  const bounded: MergeExecFn = async (cmd, o) =>
    execFn(cmd + repoFlag, { ...o, timeout: timeoutMs });
  // The wall-clock backstop: a stubbed or custom executor that ignores
  // `timeout` must not turn the guard's fail-closed gate into an open one.
  // Refusing as tooling is the same answer a slow `gh` gets.
  const budget = new Promise<never>((_resolve, reject) => {
    setTimeout(
      reject,
      CI_GUARD_BUDGET_MS,
      new Error(`the CI evidence read exceeded ${CI_GUARD_BUDGET_MS}ms`),
    );
  });
  let evidence: MergeEvidence;
  try {
    evidence = await Promise.race([gatherMergeEvidence(bounded, cwd, prNumber), budget]);
  } catch (err) {
    return ciToolingRefusal(prNumber, analyseRefusal(err));
  }
  if (evidence.ok) {
    // #2107 — `ok` alone is not enough for this guard. The verdict must belong
    // to the head the guard just verified, and every check row must have
    // actually been graded: an unrecognised `bucket` is no verdict, and a
    // green-looking list built only of rows nobody understood is not evidence.
    const pinned = ciHeadPin(prNumber, evidence, opts.expectedHeadOid);
    if (pinned) return pinned;
    const ungraded = ciUngradedRows(prNumber, evidence);
    if (ungraded) return ungraded;
    trace(`merge-guard: PR #${prNumber} — CI evidence ok (${evidence.mergeStateStatus})`);
    return undefined;
  }
  trace(
    `merge-guard: PR #${prNumber} — CI evidence refuses the merge (${evidence.failureKind ?? "ci"}): ${evidence.reason ?? "no reason given"}`,
  );
  return { block: true, reason: ciEvidenceRefusal(prNumber, evidence) };
}

/**
 * Is `a` the same commit as `b`? The guard's expected value is the OID `git
 * rev-parse` printed for the remote-tracking ref; the forge's is the OID the
 * PR carries. Both name the same commit and a forge is free to shorten what it
 * prints (the identity read's own fixture in these tests is a 6-char OID), so
 * the pin compares by OID prefix — never by length, and never by equality of
 * two values that could each be abbreviated. A value that is not hex is never
 * the same commit as anything, so a malformed expected value refuses.
 */
function sameOid(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!/^[0-9a-f]+$/.test(x) || !/^[0-9a-f]+$/.test(y)) return false;
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** The two ways an `ok: true` verdict still does not describe THIS head. */
function ciHeadPin(
  prNumber: number,
  evidence: MergeEvidence,
  expectedHeadOid: string | undefined,
): { block: true; reason: string } | undefined {
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  const read = evidence.headOid;
  if (read === undefined || expectedHeadOid === undefined || !sameOid(expectedHeadOid, read)) {
    const got = read ?? evidence.headOidError ?? "the evidence read reported no head";
    trace(
      `merge-guard: PR #${prNumber} — CI verdict head ${read?.slice(0, 8) ?? "<none>"} ≠ verified ${expectedHeadOid?.slice(0, 8) ?? "<none>"}`,
    );
    return {
      block: true,
      reason: `merge refused: the CI verdict for PR #${prNumber} was not read at the head this guard verified (${expectedHeadOid?.slice(0, 8) ?? "unreadable"}) — got ${String(got).slice(0, 120)}. A green board for another commit is not evidence about this one, and the guard refuses rather than merge unpinned${override}`,
    };
  }
  return undefined;
}

/**
 * The #2107 unknown-bucket refusal. `evidence.unrecognised` names the check
 * rows whose `bucket`/`state` matched none of the gatherer's sets — the
 * gatherer's own verdict for such a row is "nothing", and a `mergeStateStatus`
 * of CLEAN has to carry the whole list on its own. On the guard's path a
 * merge is irreversible, so rows nobody graded are rows that did not pass.
 */
function ciUngradedRows(
  prNumber: number,
  evidence: MergeEvidence,
): { block: true; reason: string } | undefined {
  const unrecognised = evidence.unrecognised ?? [];
  if (unrecognised.length === 0) return undefined;
  trace(
    `merge-guard: PR #${prNumber} — ${unrecognised.length} check row(s) reported a bucket this guard does not recognise`,
  );
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  return {
    block: true,
    reason: `merge refused: ${unrecognised.length} check row(s) on PR #${prNumber} reported a bucket that is not a known verdict (${clipCheckNames(unrecognised)}); only \`pass\` counts as passing here, and the guard does not merge on checks it could not grade${override}`,
  };
}

/** A tooling refusal in the gatherer's own words, for a read that never answered. */
function ciToolingRefusal(prNumber: number, detail: string): { block: true; reason: string } {
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  trace(`merge-guard: PR #${prNumber} — CI evidence read did not answer (${detail})`);
  return {
    block: true,
    reason: `merge refused: CI evidence is not available for PR #${prNumber} (failureKind: tooling) — ${detail}. This is a tooling failure, not a CI verdict, and the guard refuses rather than merge on an unreadable check state${override}`,
  };
}

/**
 * The refusal for a CI verdict the guard will not merge behind. It follows the
 * merge-refusal half of the #1417 split (see merge-refusals.ts): this command
 * IS a merge that every review gate has already cleared, so it names the
 * operator's override, exactly as the ledger refusals do. It is never rendered
 * through `renderHold` — a hold is what the guard says about a command it could
 * not read as a merge, and this one read it perfectly well.
 *
 * Three arms, and each says what it can prove (#2106 R3):
 *   - a CI VERDICT names the checks (`failing` / `inconclusive` carry the
 *     names) and the `mergeStateStatus` it read;
 *   - the PENDING arm quotes `MergeEvidence.reason` verbatim rather than
 *     re-deriving names from it: the type exposes no pending list, and
 *     inventing fields on a type the driver persists is a bigger change than
 *     quoting the sentence the gatherer already wrote for this case;
 *   - a TOOLING failure says so in its own words, so "gh is broken" is never
 *     mistaken for "CI is red" (#2106 R4).
 */
export function ciEvidenceRefusal(prNumber: number, evidence: MergeEvidence): string {
  const override = " (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)";
  const state = evidence.mergeStateStatus ?? "unreadable";
  if (evidence.failureKind === "tooling") {
    return `merge refused: CI evidence is not available for PR #${prNumber} (failureKind: tooling) — ${evidence.reason ?? "the check read failed"}. This is a tooling failure, not a CI verdict, and the guard refuses rather than merge on an unreadable check state${override}`;
  }
  const named: string[] = [];
  if (evidence.failing.length > 0) named.push(`failing: ${clipCheckNames(evidence.failing)}`);
  if (evidence.inconclusive.length > 0) {
    named.push(`skipped/neutral: ${clipCheckNames(evidence.inconclusive)}`);
  }
  const detail = named.length > 0 ? ` (${named.join("; ")})` : "";
  const what = evidence.reason
    ? `${evidence.reason}${detail}`
    : `mergeStateStatus is ${state}${detail}`;
  return `merge refused: PR #${prNumber} does not report green CI — ${what}; mergeStateStatus is ${state}. The reviews passed but the checks did not, and the guard does not merge behind a red, pending, skipped or unreadable check${override}`;
}

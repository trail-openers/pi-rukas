/**
 * work-driver-merged-authority — the permission half of the `/work` merged step,
 * split out of `work-driver-merged.ts` for the §12 file cap (AGENTS.md §12).
 *
 * `runMerged` asks four questions before it merges: does the repository permit it
 * (this module), is the head verifiable (also here, because the pin and the CI
 * verdict must describe one moment), has the protected/gate-file diff been checked,
 * and is the author allowlisted. This module holds the first two and the ordering of
 * all four for the gated branch; the headless `PI_ENSEMBLE_MERGE_AUTHORITY=0` branch
 * in the caller re-asks the last three with the same helpers.
 *
 * ## The ordering rules in here are the contract
 *
 * - **Doctrine at the base commit, never the working tree (#406).** This step runs
 *   after commit-pr integrated the developer's patches, so an `AGENTS.md` read from
 *   disk would include any grant a subagent just wrote for itself. Reading at base
 *   makes such a patch inert without forbidding it: honest `AGENTS.md` changes still
 *   ship in the PR.
 * - **The judge's answer is citation-verified, not regex-matched (#407).** The
 *   documents go to a judge and the answer is honoured only against a verified quote.
 *   The injected seam is honoured only under the offline suite's `FORBID_LIVE_SPAWN`
 *   gate — the headless runner forwards `policyJudgeFn` to the driver, so without that
 *   gate a caller of `runHeadless` could speak for the merge-authority judge.
 * - **One evidence read serves the pin, the CI verdict and the author gate.** The
 *   head, the green board and the login all come from the same `gatherMergeEvidence`
 *   call, so none of the three can describe a different moment on the forge.
 * - **The author gate runs ahead of the protected and gate-file reads.** A PR this
 *   cycle may not land at all should not spend a fetch and a diff to be told so.
 * - **The protected-path and gate-file gates sit OUTSIDE the authority switch.**
 *   `--merge` and `PI_ENSEMBLE_MERGE_AUTHORITY=0` are statements about permission and
 *   reviews, never about protected paths or declared gate files, so neither reaches them.
 *
 * Every refusal is a HOLD with the PR left open: merging is the one irreversible act
 * in the cycle, and a green PR is not permission.
 */

import { authorFromRead, evidenceAuthorRead } from "./merge-guard-author.ts";
import type { MergeExecFn } from "./merge-target.ts";
import { errText } from "./protected-paths-text.ts";
import { trace } from "./trace.ts";
import { cycleChildOpts } from "./work-cycle-trust.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { mergeAuthorityJudge } from "./work-driver-judge-seam.ts";
import {
  gatherMergeEvidence,
  heldByUnresolvedReview,
  resolveMergeAuthority,
} from "./work-driver-merge-authority.ts";
import { verifyMergeHead } from "./work-driver-merged-head.ts";
import {
  askAuthorGate,
  heldForMissingApproval,
  mergeAuthorHold,
} from "./work-driver-merged-hold.ts";
import { hasGitDir } from "./work-driver-merged-repo.ts";
import { judgePolicy } from "./work-driver-policy.ts";
import type { DoctrineDoc } from "./work-driver-policy.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

/** What the gated branch decided: merge on this head, or park with this state. */
export type AuthorityGateOutcome =
  | { ok: true; verifiedHead: string; note: string }
  | { ok: false; state: WorkState };

/** The arguments the gated branch needs; all are read from the caller's scope. */
export type AuthorityGateArgs = {
  ctx: CycleContext;
  state: WorkState;
  prNumber: number;
  mergeExec: MergeExecFn;
  /** The base-commit doctrine documents, read once and shared with the gate-file judge. */
  readMergeDocs: () => Promise<DoctrineDoc[]>;
  /** The protected-path gate, which takes the OID the merge is pinned to. */
  protectedGate: (verifiedHead: string | undefined) => Promise<WorkState | undefined>;
  /** The declared gate-file gate, judged on the same documents. */
  gateFileGate: (
    docs: readonly DoctrineDoc[],
    oid: string | undefined,
  ) => Promise<WorkState | undefined>;
  /** The author gate (#2181), on the login the evidence read carried. */
  authorGate: (
    evidence: { author?: string; authorError?: string } | undefined,
  ) => Promise<{ ok: true } | { ok: false; reason?: string }>;
};

/**
 * Run the permission gate and everything downstream of it for a gated cycle.
 *
 * `ok: false` carries the state to return — a cap-hit already appended, the PR open.
 * `ok: true` carries the verified head and its note, which the caller pins the merge
 * to and records on the merged event.
 */
export async function runAuthorityGate(args: AuthorityGateArgs): Promise<AuthorityGateOutcome> {
  const { ctx, state, prNumber, mergeExec } = args;
  const docs = await args.readMergeDocs();
  const authority = await resolveMergeAuthority(
    mergeAuthorityJudge(ctx, () =>
      judgePolicy(ctx.repoRoot, {
        processGroup: ctx.processGroup === true,
        signal: ctx.signal,
        ...cycleChildOpts(ctx),
      } satisfies NonNullable<Parameters<typeof judgePolicy>[1]>),
    ),
    docs,
    ctx.mergeGrant,
    { repoRoot: ctx.repoRoot, issues: ctx.issues ?? [ctx.issue] },
  );
  const evidence = authority.granted
    ? await gatherMergeEvidence(mergeExec, ctx.repoRoot, prNumber)
    : undefined;
  const routedRoundCap = heldByUnresolvedReview(state.eventLog);
  // The head the merge is pinned to, and why the step refuses to merge without one.
  // Computed beside the evidence read it comes from, so the CI verdict and the pin
  // describe the same moment on the forge.
  const headCheck =
    authority.granted && evidence?.ok && !routedRoundCap
      ? await verifyMergeHead(
          mergeExec,
          ctx.repoRoot,
          state.pipelineState.branchName,
          evidence,
          // The reviewed-head comparison needs a real clone to read the review ledger
          // from, so it is attempted only when the cycle has a repository on disk.
          // Everything else — a resumed or hand-built state file, a fixture with no
          // clone — gets the pin and an honest note; parking those on "no git remote
          // found" would be the driver inventing a fault the cycle never had. Grouped
          // cycles take the SAME rule: the lens review covers the one integrated
          // branch the merge merges.
          hasGitDir(ctx.repoRoot) ? undefined : { skipIdentity: true },
        )
      : undefined;
  if (!authority.granted || !evidence?.ok || routedRoundCap || headCheck?.ok !== true) {
    trace(
      `work-driver: merge held — authority=${authority.source}, evidence=${evidence?.reason ?? "not gathered"}${headCheck && !headCheck.ok ? `, head=${headCheck.refusal.reason}` : ""}`,
    );
    return {
      ok: false,
      state: appendEvent(
        heldForMissingApproval(state, authority, evidence, routedRoundCap, headCheck),
        {
          kind: "cap-hit",
          at: Date.now(),
          cap: "awaiting-human-merge",
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        },
      ),
    };
  }
  const verifiedHead = headCheck.headOid;

  // The author gate (#2181) runs on the SAME evidence read the head was taken from,
  // so the login judged and the commit pinned come from one read of the forge. Ahead
  // of the protected and gate-file reads: a PR this cycle may not land at all should
  // not spend a fetch and a diff to be told so.
  const authorDecision = await askAuthorGate(args.authorGate, evidence);
  if (!authorDecision.ok) {
    const reason = authorDecision.reason;
    trace(`work-driver: merge held — merge-author gate: ${reason.slice(0, 200)}`);
    return {
      ok: false,
      state: appendEvent(mergeAuthorHold(state, reason), {
        kind: "cap-hit",
        at: Date.now(),
        cap: "awaiting-human-merge",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      }),
    };
  }

  // The protected gate runs on the OID the merge is now pinned to, before any merge is
  // attempted and after every read that could have refused it.
  const protectedHold = await args.protectedGate(verifiedHead);
  if (protectedHold) return { ok: false, state: protectedHold };

  // The declared gate files are judged on the same documents, after the same reads —
  // and a doctrine grant (`--merge`) is not an answer to them.
  const gateFileHold = await args.gateFileGate(docs, verifiedHead);
  if (gateFileHold) return { ok: false, state: gateFileHold };

  return { ok: true, verifiedHead, note: headCheck.note };
}

/** The author gate for the branch where no evidence read ran (see the caller). */
export async function authorFromForgePr(
  ctx: CycleContext,
  exec: MergeExecFn,
  prNumber: number,
): Promise<{ author?: string; authorError?: string }> {
  try {
    const { stdout } = await exec(`gh pr view ${prNumber} --json author`, {
      cwd: ctx.repoRoot,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const login = (JSON.parse(stdout) as { author?: { login?: unknown } }).author?.login;
    if (typeof login !== "string" || login.trim().length === 0) {
      return {
        authorError: `the PR read reported no author login for PR #${prNumber}`,
      };
    }
    return { author: login.trim() };
  } catch (err) {
    return { authorError: `the PR read failed (${errText(err)})` };
  }
}

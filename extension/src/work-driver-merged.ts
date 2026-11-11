/**
 * work-driver-merged — Step 9 (merged) handler + the generic single-
 * dispatch helper + merge-reply parsing + dispatch-completion event builder.
 *
 * `buildCompletionEvent` maps DispatchResult → WorkEvent; `runSingleDispatch`
 * is the generic step body (branch, lens-fix, step-back, ci, merged);
 * `parseMergeCommit` + `runMerged` are the Step 9 pair.
 */

import { execp } from "./exec.ts";
import { authorFromRead, evidenceAuthorRead, heldForMergeAuthor } from "./merge-guard-author.ts";
import { errText } from "./protected-paths-text.ts";
import { trace, traceWarn } from "./trace.ts";
import { cycleChildOpts } from "./work-cycle-trust.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { markDraftPrReady } from "./work-driver-draft-pr.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { detectMainline, restoreCheckout } from "./work-driver-git.ts";
import { mergeAuthorityJudge } from "./work-driver-judge-seam.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { mergeAuthorityEnabled } from "./work-driver-merge-authority.ts";
import { authorFromForgePr, runAuthorityGate } from "./work-driver-merged-authority.ts";
import { heldForDeclaredGateFiles } from "./work-driver-merged-gate-files.ts";
import { verifyMergeHead } from "./work-driver-merged-head.ts";
import {
  askAuthorGate,
  heldForMissingApproval,
  mergeAuthorHold,
  mergeProtectedHold,
} from "./work-driver-merged-hold.ts";
import { type MergeMethod, mechanizedMerge } from "./work-driver-merged-mechanized.ts";
import { heldForProtectedPaths } from "./work-driver-merged-protected.ts";
import { hasGitDir } from "./work-driver-merged-repo.ts";
import { runMergedTeardown } from "./work-driver-merged-teardown.ts";
import { editIssueTldrs } from "./work-driver-merged-tldr.ts";
import { clearHostParkSignals } from "./work-driver-park-memory-host.ts";
import { clearParkRecords } from "./work-driver-park-record.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import {
  DOCTRINE_FILES,
  type DoctrineDoc,
  type PolicyJudgeFn,
  judgePolicy,
} from "./work-driver-policy.ts";
import { inlineMergePrompt } from "./work-driver-prompts-late.ts";
import { beginDispatch, clearDispatch, mintJobId } from "./work-driver-resume.ts";
import { activeIssuesOf, scratchDir, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import { type WorkState, type WorkStep, appendEvent } from "./workflow-state.ts";
import { worktreePrune, worktreeRemove } from "./worktree.ts";

export {
  buildCompletionEvent,
  overrideEnvForKillCause,
} from "./work-driver-completion-event.ts";
import { runSingleDispatch } from "./work-driver-dispatch-seam.ts";

export { runSingleDispatch };
import { parseMergeCommit } from "./work-driver-merged-parse.ts";
export { parsePrNumber, parseMergeCommit } from "./work-driver-merged-parse.ts";

/**
 * Step 9 — Merge the PR.
 *
 * Mechanized path (default): derive the merge method from the forge's repo
 * settings, execute `gh pr merge`, verify MERGED via `gh pr view`, restore the
 * local checkout to an up-to-date mainline. Any mechanized failure falls back to
 * an LLM ops dispatch (with a plumb-report emitted), which remains the fallback
 * path rather than a knob.
 *
 * Restoration runs INSIDE runMerged, before routeStepOutcome persists state.
 * Combined with idempotent merge (already-merged tolerance), a crash
 * mid-restoration is recoverable on resume.
 *
 * On dispatch failure: STEP_FAILURE_POLICY[merged] is HALT → cap-hit
 * 'step-failed:merged' → handoff. Operator merges manually.
 */
export async function runMerged(
  ctx: CycleContext,
  entryState: WorkState,
  now: number,
): Promise<WorkState> {
  // The final safeguard, not the usual mark point: the PR was marked ready on
  // entering ci. A draft cannot merge (`mergeStateStatus: DRAFT` holds it), so
  // this retries a ready that failed and no merge proceeds on a draft.
  const state = await markDraftPrReady(ctx, entryState);
  // The merge does not rely on the forge refusing a draft: a PR that is not
  // ready halts here, naming why, before any merge is attempted.
  const draft = state.pipelineState.prDraft;
  if (draft && draft.status !== "ready") {
    // The pr-ready clause is for a ready that failed, not for a re-arm that
    // did. `rearmError` is the re-arm's own field; on that path the driver never
    // attempted a ready, and the reason it is holding is that the PR is still
    // mergeable when it should be a draft. Printing `draft.error` there reported
    // an attempt that never happened.
    const rearmHold = draft.rearmError !== undefined;
    const failed = `marking PR ready failed: ${draft.error ?? "no reason recorded"}`;
    const reason = rearmHold
      ? `PR is still a draft: ${draft.holdReason ?? draft.rearmError}`
      : draft.holdReason
        ? `PR is still a draft: ${draft.holdReason}${draft.status === "ready-failed" ? `; ${failed}` : ""}`
        : draft.status === "ready-failed"
          ? failed
          : "PR is still a draft: not marked ready";
    return appendEvent(
      {
        ...state,
        pipelineState: { ...state.pipelineState, currentStep: "merged" },
      },
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "step-failed:merged",
        reviewRound: state.pipelineState.reviewRound,
        evidence: reason,
        nextStep: "handoff",
      },
    );
  }
  const prNumber = state.pipelineState.prNumber ?? 0;
  const issues = activeIssuesOf(state);
  let next: WorkState;
  let mergeMethod: MergeMethod = "squash";
  let preDispatch = state;
  let mergeSucceeded = false;
  // The head this step verified, which the merge is pinned to. Set only past the
  // head check; the LLM fallback prompt carries the same value so the fallback
  // path cannot merge what the mechanized path refused to. `undefined` rather
  // than `""`: an empty string is neither a value nor an absence, and the merge
  // paths below take `string | undefined` and refuse the absence.
  let verifiedHead: string | undefined;
  const headNotes: string[] = [];
  const mergeExec = ctx.verifyExecFn ?? execp;
  const judgeForGate = mergeAuthorityJudge(ctx, () =>
    judgePolicy(ctx.repoRoot, {
      processGroup: ctx.processGroup === true,
      signal: ctx.signal,
      ...cycleChildOpts(ctx),
    }),
  );
  // The base-commit doctrine, read once by whichever branch needs it: the authority
  // judge and the declared gate-file judge are handed the same documents.
  let mergeDocs: DoctrineDoc[] | undefined;
  const readMergeDocs = async (): Promise<DoctrineDoc[]> => {
    if (mergeDocs) return mergeDocs;
    const docs: DoctrineDoc[] = [];
    for (const file of DOCTRINE_FILES) {
      const read = await readDoctrineAtBase(
        mergeExec,
        ctx.repoRoot,
        state.pipelineState.baseSha,
        file,
      );
      if (read.text !== undefined) docs.push({ file, text: read.text });
      else if (read.reason) trace(`work-driver: merge authority — ${read.reason}`);
    }
    mergeDocs = docs;
    return docs;
  };

  // The merge-time protected-path gate runs once a verified head exists, so the
  // diff it inspects is the very commit the merge would land (it takes the OID
  // below rather than re-resolving a ref). The refusals, the fetch and why
  // neither --allow-protected nor PI_ENSEMBLE_PROTECTED_PATHS clears it are in
  // work-driver-merged-protected.ts; it sits outside the authority switch, so a
  // cycle with the permission gate off is still held off a protected diff.
  const protectedGate = (verifiedHead: string | undefined) =>
    heldForProtectedPaths(ctx, state, mergeExec, verifiedHead);

  // The repository's own gate-file list, judged on the same base-commit documents
  // The repository's own gate-file list, judged on the same base-commit documents
  // and honoured only against a verified quote (work-driver-merged-gate-files.ts).
  // Outside the authority switch, so `--merge` reaches neither gate.
  const gateFileGate = (docs: readonly DoctrineDoc[], oid: string | undefined) =>
    heldForDeclaredGateFiles(
      ctx.repoRoot,
      state,
      mergeExec,
      judgeForGate,
      docs,
      { repoRoot: ctx.repoRoot, issues: ctx.issues ?? [ctx.issue] },
      oid,
    );

  // The merge-author gate (#2181): the PR's author must be listed in the operator's
  // allowlist at the cycle's base commit. Like the two gates above it is NOT behind
  // `mergeAuthorityEnabled()` — `--merge` and `PI_ENSEMBLE_MERGE_AUTHORITY=0` are
  // statements about permission and reviews, never about who opened the PR, and a
  // non-allowlisted author parks with the PR left open. The author rides the evidence
  // read the gate already makes, so the allowlist decision and the CI verdict describe
  // one moment on the forge.
  //
  // `state.baseSha` is the commit, but it is OPTIONAL — a resumed or hand-written
  // state may not carry one — and every other base consumer in this driver falls back
  // to `origin/<default>` when it is absent. The gate takes the same fallback, and
  // still reads through git at a resolved OID: falling back to the mainline tip is the
  // documented meaning of an absent base, whereas reading the WORKING TREE would let a
  // PR widen its own allowlist by committing one. Nothing here silently allows: an
  // unresolvable fallback is the same refusal as a missing file.
  const authorBase = async (): Promise<string | undefined> => {
    const recorded = state.pipelineState.baseSha?.trim();
    if (recorded !== undefined && recorded.length > 0) return recorded;
    // The same origin/upstream chain the protected-path read walks; the default
    // branch is resolved rather than assumed, so a repo whose mainline is not named
    // `main` is judged at its own mainline.
    const { stdout } = await mergeExec("git", {
      argv: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd: ctx.repoRoot,
      timeout: 15_000,
      maxBuffer: 8 * 1024,
    });
    return stdout.trim() || undefined;
  };

  const authorGate = async (evidence: { author?: string; authorError?: string } | undefined) =>
    heldForMergeAuthor({
      exec: mergeExec,
      cwd: ctx.repoRoot,
      // A base the step cannot name is passed through as absent, and the gate refuses
      // it as "no base" rather than merging on an allowlist it never located.
      baseSha: await authorBase().catch(() => undefined),
      author: authorFromRead(evidenceAuthorRead(evidence)),
    });

  /**
   * Ask the author gate, and turn an executor rejection into the same park as a
   * refusal (see `askAuthorGate`).
   */
  const askGate = (evidence: { author?: string; authorError?: string } | undefined) =>
    askAuthorGate(authorGate, evidence);

  /** Park the cycle on an author-gate refusal: the hold, the cap, and a trace. */
  const authorHold = (reason: string) => {
    trace(`work-driver: merge held — merge-author gate: ${reason.slice(0, 200)}`);
    return appendEvent(mergeAuthorHold(state, reason), {
      kind: "cap-hit",
      at: Date.now(),
      cap: "awaiting-human-merge",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  };

  // #380 — two independent gates, both defaulting to "no". Merging is the
  // one irreversible act in the cycle and had neither; a green PR ≠ permission.
  if (mergeAuthorityEnabled()) {
    // The permission gate, the head pin, and the protected / gate-file / author
    // gates downstream of them, in the order that ordering is documented in
    // work-driver-merged-authority.ts: doctrine read at the base commit (#406),
    // the judge's answer citation-verified (#407), and one evidence read serving
    // the pin, the CI verdict and the author login alike.
    const gate = await runAuthorityGate({
      ctx,
      state,
      prNumber,
      mergeExec,
      readMergeDocs,
      protectedGate,
      gateFileGate,
      authorGate: askGate,
    });
    if (!gate.ok) return gate.state;
    verifiedHead = gate.verifiedHead;
    headNotes.push(gate.note);
  }
  // A cycle that reaches this point WITHOUT a verified head has not passed the
  // head check, whatever made it get here: the authority gate off
  // (`PI_ENSEMBLE_MERGE_AUTHORITY=0`) disables only the permission and evidence
  // gate, so the head is still read and the merge still pinned. An unreadable head
  // refuses exactly as the gated path does.
  if (verifiedHead === undefined) {
    // The author gate is asked here too. The evidence read did not run — this is the
    // branch the permission switch took (`PI_ENSEMBLE_MERGE_AUTHORITY=0`), which
    // turns off the permission and evidence gate, not this one — so the login comes
    // from the one read the step always makes, the PR target, whose `author` field
    // `merge-target` already fills from the forge. Refusing here on "no evidence" would
    // report an unreadable author for a PR whose author the step is holding, and would
    // make the switch a way to park every cycle.
    const authorDecision = await askGate(await authorFromForgePr(ctx, mergeExec, prNumber));
    if (!authorDecision.ok) return authorHold(authorDecision.reason);
    // No authority gate ran, so this is the only place the protected-path gate can
    // ask with a head in hand; a protected diff parks the same way as above.
    const protectedHold = await protectedGate(undefined);
    if (protectedHold) return protectedHold;
    const gateFileHold = await gateFileGate(await readMergeDocs(), undefined);
    if (gateFileHold) return gateFileHold;
    trace("work-driver: merge held — no verified head OID to pin the merge to");
    // The same hold shape as the protected-path park: this gate asked neither the
    // grant nor the forge, so it claims no authority verdict.
    const held = mergeProtectedHold(
      state,
      "no verified head OID was read for this cycle, so there is no commit to pin the merge to",
    );
    return appendEvent(held, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "awaiting-human-merge",
      reviewRound: held.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }

  // Try mechanized merge first.
  const mechResult = await mechanizedMerge(ctx, state, verifiedHead);
  if (mechResult.ok) {
    mergeMethod = mechResult.method;
    mergeSucceeded = true;
    // The head-check note rides the merged event so the record says what the
    // step actually verified (for a cycle whose comparison did not run: that it
    // did not run, not that it passed).
    for (const note of headNotes) {
      if (note) mechResult.notes.push(note);
    }
    // Mechanized merge succeeded — build the same event shapes the
    // dispatch path produces so downstream (merged event) is identical.
    // Record it; do not dispatch it. `runSingleDispatch` really spawns, and
    // `driver` is not a role, so dispatching it would fail every successful
    // mechanized merge into a handoff with teardown skipped.
    // `work-driver-commit.ts` builds its mechanized event directly for the same
    // reason.
    next = appendEvent(
      {
        ...state,
        pipelineState: { ...state.pipelineState, currentStep: "merged" },
      },
      { kind: "step-started", step: "merged", at: now },
    );
    next = appendEvent(
      next,
      synthesizeDriverCompletion({
        step: "merged",
        label: "driver:merge",
        summary: `Mechanized merge: PR #${prNumber} merged via --${mergeMethod}${mechResult.notes.length > 0 ? ` Notes: ${mechResult.notes.join("; ")}` : ""}`,
        startedAt: now,
        now: Date.now(),
      }),
    );
  } else {
    // Mechanized path failed — emit plumb-report and fall back to LLM.
    preDispatch = appendEvent(state, {
      kind: "plumb-report",
      at: Date.now(),
      step: "merged",
      role: "driver",
      body: `Mechanized merge fell back to ops dispatch: ${mechResult.reason}.`,
    });
    // Always resolve the merge method for the fallback prompt.
    mergeMethod = mechResult.method ?? "squash";
    next = await runSingleDispatch(ctx, preDispatch, "merged", "ops", "ops:merge", now, () =>
      inlineMergePrompt(
        issues,
        prNumber,
        mergeMethod,
        scratchDir(ctx.repoRoot, state.issue),
        verifiedHead,
      ),
    );
  }

  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;

  // For LLM fallback path: parse merge-commit marker from ops reply.
  // Mechanized path: mergeSucceeded is already true; mergeCommit stays
  // undefined (merge SHA extraction from mechanized path is a separate
  // enhancement — gh pr merge output doesn't include the commit SHA).
  let mergeCommit: string | undefined;
  if (!mechResult.ok) {
    mergeCommit = parseMergeCommit(last.summary);
  }

  // #1006 — prepend a TL;DR section to each active issue's body. The
  // merge succeeded; this is the "upon completion" moment. A failed
  // issueEdit does NOT flip the step outcome: the notes are recorded as
  // plumb-reports and the cycle continues to `merged` regardless.
  if (mergeSucceeded) {
    try {
      const execFnTldr = ctx.verifyExecFn ?? execp;
      // #1006 — per-call 45 s timeout (same deadline as the explore body
      // fetch); the TLDR edit is non-blocking, but an unbounded forge call
      // could stall the merged step past a stuck network connection.
      const forge = await forgeForCycle(ctx, execFnTldr, new Map(), {
        execOpts: { timeout: 45_000 },
      });
      if (forge) {
        const tldrNotes = await editIssueTldrs(forge, state);
        for (const note of tldrNotes) {
          next = appendEvent(next, {
            kind: "plumb-report",
            at: Date.now(),
            step: "merged",
            role: "driver",
            body: `TL;DR issue edit: ${note}`,
          });
        }
      }
    } catch (err) {
      // A TL;DR edit failure must never block the merged step.
      trace(`work-driver: TL;DR issue edit failed: ${(err as Error).message?.slice(0, 200)}`);
    }
  }

  // Restore checkout to mainline BEFORE persisting state (routeStepOutcome).
  // Combined with idempotent merge (already-merged tolerance), a crash
  // mid-restoration is recoverable: resume re-enters merged step, merge
  // short-circuits as already-done, restoration runs again.
  if (mergeSucceeded) {
    try {
      // #476 — same seam resolution as mechanizedMerge (#380): the test-only
      // injection is the preferred path when present, but production callers
      // omit it and would have skipped restoration entirely, leaving the
      // checkout on the merged feature branch with no prune and no local
      // branch -d attempt.
      const execFn = ctx.verifyExecFn ?? execp;
      const mainlineResult = await detectMainline(ctx.repoRoot, execFn);
      const mainline = mainlineResult.ok ? mainlineResult.branch : undefined;
      // #1093 — return the operator's checkout to the ref the cycle STARTED on,
      // not to mainline. Without a recorded startRef (pre-#1093 state) the
      // target stays mainline.
      const startRef = state.pipelineState.startRef;
      // `restoreCheckout` and its restore primitive are argv-form (#1093): they
      // call `execFn("git", { argv: ["checkout", ref, "--"] })`, so the command
      // they ask for is `git checkout main --`, not what the string form would
      // have joined. Handing them a shell-only executor would run `git` with no
      // arguments at all — every restore silently doing nothing while reading as
      // success, because a bare `git` exits 0 with usage on stderr.
      // A cycle that merged nothing has nothing to restore: the short-circuit and
      // fallback cases must not pay for git calls they should not make, and an
      // empty restoration is not the same as a completed one.
      if (mainline || startRef) {
        // #289 — restoreCheckout runs `git checkout <target>` + `branch -d`
        // (and `pull --ff-only` when the target is mainline) at repoRoot. A
        // sibling group mid-integrate would find itself moved onto it and
        // commit there, so this takes the same lock as integration.
        const restorationNotes = await withIntegrationLock(ctx.repoRoot, () =>
          restoreCheckout({
            repoRoot: ctx.repoRoot,
            mainline,
            mergedBranch: state.pipelineState.branchName,
            execFn,
            startRef,
            dirtyRootExempt: ctx.dirtyRootExempt,
            // #1362 — the claim this restore builds names only files the cycle
            // wrote; the cycle-start baseline is what makes that true.
            dirtyRootExemptBaseline: state.pipelineState.dirtyRootExemptBaseline,
          }),
        );
        for (const note of restorationNotes) {
          // Log restoration notes (informational — not errors).
          next = appendEvent(next, {
            kind: "plumb-report",
            at: Date.now(),
            step: "merged",
            role: "driver",
            body: `Checkout restoration: ${note}`,
          });
        }
      }
      // Clean up scratch dir on merged outcome.
      await teardownWorkspaceTmp(ctx.repoRoot, state.issue);
    } catch (err) {
      // Restoration failure — log but don't halt. The merge succeeded.
      next = appendEvent(next, {
        kind: "plumb-report",
        at: Date.now(),
        step: "merged",
        role: "driver",
        body: `Checkout restoration failed: ${(err as Error).message?.slice(0, 300)}`,
      });
    }
  }

  // Post-merge cleanup: worktrees, path claims, park records. All best-effort —
  // none of it may turn a landed merge into a handoff (see the module header).
  await runMergedTeardown(ctx, state, next);

  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      currentStep: "merged",
      status: "merged",
    },
    eventLog: [...next.eventLog, { kind: "merged", at: Date.now(), prNumber, mergeCommit }],
  };
}

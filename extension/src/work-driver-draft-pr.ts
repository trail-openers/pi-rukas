/**
 * work-driver-draft-pr — the cycle's PR is a draft until the driver's review
 * is done (#1292).
 *
 * commit-pr opens the PR before the six-pass review, and review + fixes take
 * hours. For that whole window GitHub showed an ordinary mergeable PR, and
 * people merged five of nine cycle PRs on one repo mid-review, stranding the
 * findings. A draft cannot be merged with the normal button or `gh pr merge`.
 *
 * ONE rule for recording `pipelineState.prDraft`, on every path, only once the
 * PR number is known:
 *   - the mechanized commit-pr records `draft` when `gh pr create --draft`
 *     succeeded (the flag is the fact);
 *   - the ops fallback records what `prView` says after the number is parsed
 *     (`recordFallbackDraftFact`): `draft`, or `ready` when the child opened it
 *     ready — no claim of a draft the forge does not report;
 *   - a cycle that resumes with no fact recorded (a crash between create and
 *     persist) reads `isDraft` live at the next mark point (`recordLiveDraftFact`).
 *
 * Every write above, and every `pr ready`, first proves the PR is this cycle's
 * own (`judgePrIdentity`: headRefName is the cycle branch, state OPEN). A PR
 * that cannot be proven — unreadable, or another branch's — records nothing and
 * is not marked: the number came from a child's reply, and a wrong number must
 * never flip someone else's PR.
 *
 * Marking ready (`markDraftPrReady`) is the only writer of `ready`. It is
 * refused — the PR stays a draft, with `holdReason` — while the latest lens
 * verdict is CRITICAL, or while ISSUES_FOUND findings were never disclosed on
 * the PR (`readyHoldReason`). Attempts are bounded per mark point and per cycle.
 *
 * #1398 — the disclosure check reads a FACT, not a cap name, and a `ready` is
 * no longer permanent. `readyHoldReason` used to ask which cap NAME had
 * appeared after the verdict (`round-cap` / `wall-clock` with
 * `nextStep: "handoff"`) and held only in that one shape, so any other
 * non-round-cap failure following an `ISSUES_FOUND` — `dispatch-failed`,
 * `verify-failed:*`, a kill cause, `ci-retry` — read as "nothing to hold for"
 * and the PR was marked ready over findings that had never been posted. The
 * `lens-residuals-posted` event (work-driver-draft-rearm.ts) is now the
 * positive fact, keyed on the patch identity the disclosure itself carries.
 * And a PR marked ready that then has to be reviewed again is a draft again
 * before that review runs — `rearmDraftForReview`, which closes the CI loop
 * (`ci → develop → … → lens-review → ci`) that used to leave the PR mergeable
 * for the whole re-review.
 *
 * A draft is still state OPEN (GitHub) / opened (GitLab), so the re-entry
 * guard and the identity gate accept it unchanged.
 */

import { execp } from "./exec.ts";
import type { ForgeType } from "./forge-detect.ts";
import type { NormalizedPullRequest } from "./forge-types.ts";
import type { Forge } from "./forge.ts";
import { mergeIdentity } from "./merge-guard-reads.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { prCarriesDisclosure, readyHoldReason } from "./work-driver-draft-hold.ts";
import { forgeFailureReason } from "./work-driver-draft-rearm.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { resolveMainline } from "./work-driver-git.ts";
import { netRefProblem } from "./work-driver-net-git.ts";
import { WORK_DRIVER_REVIEW_LOOP_STEPS } from "./work-driver-review-loop-steps.ts";
import { judgePrIdentity } from "./work-driver-verify-pr17.ts";
import type { PrDraftFindingsFact } from "./workflow-state-schema-pr-draft.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
/** `pr ready` calls per mark point (initial + 2 retries). */
export const MAX_READY_ATTEMPTS = 3;
/**
 * `pr ready` calls per cycle across EVERY mark point. The ci loop can visit
 * the mark point several times; this keeps the total waiting bounded.
 */
export const MAX_READY_ATTEMPTS_PER_CYCLE = 6;
/**
 * #1398 round 2 — draft-direction (`pr draft --undo`) calls per cycle, on its
 * OWN counter. The `ready` budget above belongs to the MERGE: charging a
 * re-arm against `attempts` meant a cycle that had to re-arm the draft could
 * no longer afford to mark its PR ready once its review concluded. The draft
 * direction is still bounded — it is just bounded by its own number.
 */
export const MAX_DRAFT_REARM_ATTEMPTS = 3;
/** Fixed pause between `pr ready` attempts (tests inject `sleep`). */
export const READY_RETRY_BACKOFF_MS = 2_000;

type VerifyExec = NonNullable<DriverContext["verifyExecFn"]>;

/**
 * `PI_ENSEMBLE_DRAFT_PR=1` / `=0` forces the setting; any other value is
 * ignored. Unset, it is on for a headless `/work` (nobody is watching the
 * review window) and off otherwise.
 */
export function draftPrEnabled(ctx: Pick<DriverContext, "headless">): boolean {
  const v = process.env.PI_ENSEMBLE_DRAFT_PR;
  if (v === "1") return true;
  if (v === "0") return false;
  return ctx.headless === true;
}

/** Steps that change or re-review the code: a review is not done while one follows the verdict. */
const REVIEW_LOOP_STEPS = new Set<string>(WORK_DRIVER_REVIEW_LOOP_STEPS);

/**
 * Did the latest review produce a verdict that nothing has superseded? True
 * when a lens verdict (approved, issues found — CRITICAL included — or an
 * empty diff) is on the log and no review-loop step started after it. Caps,
 * step-back, ci and merged may follow; a fix round or a re-review may not.
 */
export function reviewConcluded(eventLog: readonly WorkEvent[]): boolean {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (!e) continue;
    if (
      e.kind === "lens-approved" ||
      e.kind === "lens-issues-found" ||
      e.kind === "lens-skipped-empty-diff"
    ) {
      return true;
    }
    if (e.kind === "step-started" && REVIEW_LOOP_STEPS.has(e.step)) return false;
  }
  return false;
}

/** Mark the cycle's draft PR ready (`ci`, `merged`, handoff). Never throws. */
export async function markDraftPrReady(
  ctx: DriverContext,
  state: WorkState,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<WorkState> {
  const prNumber = state.pipelineState.prNumber;
  if (prNumber === undefined) return state;
  const current = await recordLiveDraftFact(ctx, state);
  const draft = current.pipelineState.prDraft;
  if (!draft || draft.status === "ready") return current;
  const forge = await resolveForge(ctx);
  // Identity first: a PR the cycle cannot prove is its own is never marked
  // ready; a known draft records why it stays unverified instead of staying silent.
  const own = await readOwnPr(forge, current, prNumber);
  if (!own.ok || !forge) {
    const reason = own.ok ? "the forge for this repo could not be determined" : own.reason;
    return withPrDraft(current, {
      ...draft,
      holdReason: `the PR could not be read to verify it is this cycle's: ${reason}`,
    });
  }
  // #1398 — the hold is keyed on the patch the disclosure carries. The PR's own
  // comment list is the PRIMARY record, and it is computed HERE (not threaded
  // from `markDraftPrReady`'s callers, who have no identity to key on) by asking
  // the forge whether the comment carrying this patch's disclosure actually
  // exists — the same read the merge guard makes (`readPrCommentBodies` +
  // `lensResidualsMarker`), so a disclosure that landed, was edited away, or was
  // posted for an older patch is judged the same way in both places.
  //
  // item 6 REVERSED (#1398 round 3) — the read is never skipped and the
  // persisted mirror is never trusted on its own. Round 2 short-circuited to the
  // mirror when it already carried the patch, and fell back to it when the read
  // THREW. Both let a state file speak for the PR: a hand-edited or corrupt
  // `findingsPosted` row — or one written by an older build against refs that
  // have since moved — licensed a ready the PR could not show, which is exactly
  // the class of bug #1292/#1398 exist to close. Now every mark point reads the
  // PR, and a read that fails HOLDS with a reason that says the read failed and
  // is retryable. The mirror still counts, but only as a corroboration of a
  // read that succeeded — never as its substitute.
  const patchId = await readyPatchId(ctx, current);
  const disclosureRead: { failed: boolean } = { failed: false };
  const findingsPosted =
    patchId === null
      ? persistedOrEmpty(draft)
      : await findingsPostedFor(
          forge,
          patchId,
          current.pipelineState.branchName,
          own.pr,
          disclosureRead,
        );
  const hold = readyHoldReason(current.eventLog, {
    ...(patchId ? { patchId } : {}),
    ...(findingsPosted ? { findingsPosted } : {}),
    branch: current.pipelineState.branchName,
    // item 5 — with no patch identity to key on, an `ISSUES_FOUND` HOLDS. The
    // pre-#1398 shape let every non-round-cap failure after a verdict read as
    // "nothing to hold for", which is exactly how a PR got marked ready over
    // findings nobody posted; a driver that cannot state which patch it is
    // marking ready cannot state that its findings were disclosed for it.
    ...(patchId === null ? { failClosedWithoutPatchId: true } : {}),
    // item 6 (round 3) — the read failed: hold, and name the read as the
    // reason. `disclosureReadFailed` outranks the mirror inside
    // `readyHoldReason`, so nothing cached can turn this into a pass.
    ...(disclosureRead.failed
      ? {
          disclosureReadFailed: `the disclosure read on PR #${prNumber} could not be completed — this is retryable, re-run the cycle once the forge answers`,
          mirrorAcceptable: false,
        }
      : {}),
  });
  if (hold) {
    trace(`work-driver: PR #${prNumber} stays a draft — ${hold}`);
    return withPrDraft(current, { ...draft, status: "draft", holdReason: hold });
  }
  const used = draft.attempts ?? 0;
  const attempts = Math.min(MAX_READY_ATTEMPTS, MAX_READY_ATTEMPTS_PER_CYCLE - used);
  if (attempts <= 0) {
    const error = `this cycle's ${MAX_READY_ATTEMPTS_PER_CYCLE} pr ready attempts are spent (last error: ${draft.error ?? "none recorded"})`;
    return withPrDraft(current, { status: "ready-failed", error, attempts: used });
  }
  let made = 0;
  let error = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    made++; // counted only once prReady is actually called
    try {
      await forge.prReady(prNumber);
      trace(`work-driver: PR #${prNumber} marked ready for review (draft → ready)`);
      // #1398 round 3 (PM/adversarial) — a ready that lands ENDS the review
      // round, and with it the re-arm budget that round was entitled to. The
      // counter is scoped to `rearmRound`, so the next round's re-arm finds a
      // fresh bound (work-driver-draft-rearm.ts reads the round and ignores a
      // counter from another); zeroing it here keeps the record honest about the
      // round it belongs to rather than leaving a stale number that merely
      // happens to be ignored. Without this, a cycle that CI-looped several
      // times — each re-arm succeeding — reached the bound and then reviewed a
      // mergeable PR: the bound had become the bug.
      return withPrDraft(current, {
        status: "ready",
        attempts: used + made,
        draftAttempts: 0,
        rearmRound: current.pipelineState.reviewRound ?? 0,
      });
    } catch (err) {
      const raw = rawErrorText(err);
      error = forgeFailureReason(raw);
      trace(`work-driver: pr ready #${prNumber} failed (attempt ${attempt}/${attempts}): ${raw}`);
    }
    if (attempt < attempts) await sleep(READY_RETRY_BACKOFF_MS);
  }
  return withPrDraft(current, { status: "ready-failed", error, attempts: used + made });
}

/**
 * The handoff's decision. A review that concluded is marked ready (unless held);
 * a cycle that stopped before its review concluded keeps the draft and records
 * why — whatever its status, so the handoff never claims the review is done;
 * a ready that failed earlier is retried only once the review concluded.
 */
export async function settleDraftPrAtHandoff(
  ctx: DriverContext,
  state: WorkState,
  sleep?: (ms: number) => Promise<void>,
): Promise<WorkState> {
  const live = await recordLiveDraftFact(ctx, state);
  const draft = live.pipelineState.prDraft;
  if (!draft || draft.status === "ready") return live;
  if (!reviewConcluded(live.eventLog)) {
    trace("work-driver: handoff before the review concluded — PR stays a draft");
    return withPrDraft(live, {
      ...draft,
      holdReason: "the review did not conclude before the cycle stopped",
    });
  }
  return markDraftPrReady(ctx, live, sleep);
}

/**
 * Crash safety: when no draft fact is recorded but the PR exists and this is a
 * draft-enabled cycle, ask the forge whether the PR is a draft. A failed read
 * records nothing (the mark points read again). Only ever adds a `draft` fact.
 */
export async function recordLiveDraftFact(
  ctx: DriverContext,
  state: WorkState,
): Promise<WorkState> {
  const ps = state.pipelineState;
  if (ps.prDraft || ps.prNumber === undefined || !draftPrEnabled(ctx)) return state;
  const pr = await readOwnPr(await resolveForge(ctx), state, ps.prNumber);
  return pr.ok && pr.pr.isDraft === true ? withPrDraft(state, { status: "draft" }) : state;
}

/**
 * The ops fallback opened the PR (its number was just parsed): record what the
 * forge reports for THIS cycle's PR. Only a PR that is a draft is recorded as
 * `draft`; one the child opened ready is recorded `ready`, so nothing claims a
 * draft the forge does not show. An unreadable or foreign view records nothing —
 * the mark points read it live.
 */
export async function recordFallbackDraftFact(
  ctx: DriverContext,
  state: WorkState,
  prNumber: number,
  execFn: VerifyExec,
): Promise<WorkState> {
  if (!draftPrEnabled(ctx)) return state;
  const own = await readOwnPr(await resolveForge(ctx, execFn), state, prNumber);
  if (!own.ok) return state;
  if (own.pr.isDraft === true) return withPrDraft(state, { status: "draft" });
  if (own.pr.isDraft === false) {
    trace(
      `work-driver: ops fallback opened PR #${prNumber} ready, not as a draft — the review window is open`,
    );
    return withPrDraft(state, {
      status: "ready",
      holdReason:
        "the ops fallback opened the PR ready rather than as a draft, so it was open for review",
    });
  }
  return state;
}

/** The forge for this cycle, or `undefined` (traced) when it cannot be determined. */
async function resolveForge(
  ctx: DriverContext,
  execFn: VerifyExec = ctx.verifyExecFn ?? execp,
): Promise<Forge | undefined> {
  try {
    return ctx.forge ?? (await forgeForCycle(ctx, execFn));
  } catch (err) {
    trace(`work-driver: the forge for this repo could not be determined: ${rawErrorText(err)}`);
    return undefined;
  }
}

type OwnPrRead = { ok: true; pr: NormalizedPullRequest } | { ok: false; reason: string };

/**
 * The PR's view, only when the forge reports it as THIS cycle's open PR.
 * Anything else — unreadable, no head, another branch, not OPEN — is traced and
 * yields `ok: false` with a short public reason, so the caller records and marks nothing.
 */
async function readOwnPr(
  forge: Forge | undefined,
  state: WorkState,
  prNumber: number,
): Promise<OwnPrRead> {
  if (!forge) return { ok: false, reason: "the forge for this repo could not be determined" };
  try {
    const pr = await forge.prView(prNumber);
    const identity = judgePrIdentity(state.pipelineState.branchName, {
      state: pr.state,
      headRefName: pr.headRefName,
    });
    if (identity.ok) return { ok: true, pr };
    trace(`work-driver: PR #${prNumber} ${identity.failure} — its draft state is left unchanged`);
    return { ok: false, reason: identity.failure };
  } catch (err) {
    trace(
      `work-driver: could not read PR #${prNumber}: ${rawErrorText(err)} — its draft state is left unchanged`,
    );
    return { ok: false, reason: forgeFailureReason(rawErrorText(err)) };
  }
}

/**
 * The one writer of `pipelineState.prDraft` for this family of modules. Shared
 * with work-driver-draft-rearm.ts (the #1398 re-arm) so the two cannot build
 * the snapshot differently — a re-arm that dropped a field the ready path had
 * written would silently lose the disclosure fact.
 */
export function withPrDraft(
  state: WorkState,
  prDraft: NonNullable<WorkState["pipelineState"]["prDraft"]>,
): WorkState {
  return { ...state, pipelineState: { ...state.pipelineState, prDraft } };
}

/**
 * The raw text of a failure — for the trace only, never the public handoff.
 * Lives with the re-arm module (the one that halts with a forge reason); this
 * file used to carry a duplicate `forgeFailureReason` and a pass-through
 * re-export of it, both deleted — two tables that must stay in sync drift, and
 * only one of them is tested. The re-export in particular let a caller import
 * the reason from whichever module it happened to be reading.
 */
function rawErrorText(err: unknown): string {
  const stderr =
    err instanceof Error && "stderr" in err && typeof err.stderr === "string" ? err.stderr : "";
  const message = err instanceof Error ? err.message : String(err);
  return (stderr || message).trim().slice(0, 300) || "(no error text)";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * The disclosure facts the hold check may rely on, read from the PR itself.
 *
 * Returns the `prDraft` mirror when the PR carries this patch's disclosure
 * marker, and an EMPTY list when it does not — an empty list is what turns the
 * hold on, so a state that claims a disclosure the PR cannot show does not
 * license a ready. A failed comment read is likewise an empty list: the
 * disclosure is a condition and an unreadable condition is a refusal, never a
 * pass (the same rule the merge guard applies to its own comment read).
 *
 * #1398 round 3 — the mirror is never consulted WITHOUT a read: not when the
 * read threw, and not because it "already covers" the patch. The only shape in
 * which it reaches the gate is the one where the PR itself confirmed the
 * disclosure and the mirror corroborates it.
 */
async function findingsPostedFor(
  forge: Forge,
  patchId: string,
  branch: string | undefined,
  pr: NormalizedPullRequest,
  // item 6 — the caller distinguishes "the PR carries no marker" from "the PR
  // could not be read": the first is a disclosure that never happened (a hold,
  // full stop), the second is a tooling fault whose hold reason must say so.
  readStatus: { failed: boolean } = { failed: false },
): Promise<PrDraftFindingsFact[]> {
  let bodies: string[];
  try {
    bodies = (await forge.prComments(pr.number)).map((c) => c.body);
  } catch (err) {
    readStatus.failed = true;
    trace(`work-driver: the disclosure read for PR #${pr.number} failed: ${rawErrorText(err)}`);
    return [];
  }
  return prCarriesDisclosure(bodies, branch ?? pr.headRefName, patchId)
    ? [{ patchId, at: Date.now(), round: 0, prNumber: pr.number }]
    : [];
}

/**
 * The mirror as it stands, when there is no patch identity to check it against
 * — the fail-closed branch keys on nothing, so what it passes is irrelevant to
 * the verdict (`readyHoldReason` holds on the missing identity either way).
 */
function persistedOrEmpty(
  draft: NonNullable<WorkState["pipelineState"]["prDraft"]>,
): PrDraftFindingsFact[] {
  return draft.findingsPosted ?? [];
}

/**
 * The patch identity a disclosure or a ready is keyed on — the merge guard's own
 * computation (`mergeIdentity`, #1305): `merge-base(remote/head, remote/mainline)
 * ..remote/head`, against the branch's remote refs and the mainline. Lives here
 * rather than in work-driver-draft-rearm.ts because BOTH modules need it and
 * the re-arm module imports this one (a shared helper in the dependency
 * direction that already exists keeps the pair acyclic).
 *
 * The refs must already be fetched by the caller (the disclosure path fetches
 * them). A local clone that has not seen the latest push computes a stale id —
 * the fail-closed direction: a stale id never matches a current one.
 */
export async function currentPatchIdentity(
  execFn: VerifyExec,
  cwd: string,
  branch: string,
): Promise<{ ok: true; patchId: string } | { ok: false; reason: string }> {
  // #1398 round 2 — the branch reaches `git merge-base`/`git patch-id` through
  // an exec string, so the same allowlist every networked git call applies
  // (`netRefProblem`, #1095) is applied here before any command runs: a ref
  // carrying refspec or option syntax is refused by name, never handed to git.
  const refProblem = netRefProblem(branch);
  if (refProblem !== undefined) return { ok: false, reason: refProblem };
  const mainline = await resolveMainline(cwd, execFn);
  if (!mainline.ok) return mainline;
  return mergeIdentity(execFn, cwd, branch, mainline.branch);
}

/**
 * The patch identity the ready comparison is keyed on, or `null` when it cannot
 * be computed (no branch, no remote, no mainline, an unreadable merge-base).
 * `null` is deliberate and never a silent pass: `readyHoldReason` without a
 * `patchId` falls back to the pre-#1398 cap-name shape, so a driver that cannot
 * establish an identity cannot be fooled into marking an undisclosed review ready
 * — and cannot be blocked by a git read that has nothing to do with the review.
 */
async function readyPatchId(ctx: DriverContext, state: WorkState): Promise<string | null> {
  const branch = state.pipelineState.branchName;
  if (!branch) return null;
  const execFn: VerifyExec = ctx.verifyExecFn ?? execp;
  const identity = await currentPatchIdentity(execFn, ctx.repoRoot, branch);
  if (!identity.ok) {
    trace(`work-driver: the ready check has no patch identity to key on — ${identity.reason}`);
    return null;
  }
  return identity.patchId;
}

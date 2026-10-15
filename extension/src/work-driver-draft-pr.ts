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
 * Marking ready (`markDraftPrReady`) is the only writer of `ready`. It is
 * refused — the PR stays a draft, with `holdReason` — while the latest lens
 * verdict is CRITICAL, or while ISSUES_FOUND findings were never disclosed on
 * the PR (`readyHoldReason`). Attempts are bounded per mark point and per cycle.
 *
 * A draft is still state OPEN (GitHub) / opened (GitLab), so the re-entry
 * guard and the identity gate accept it unchanged.
 */

import { execp } from "./exec.ts";
import { prReadyCmd } from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** `pr ready` calls per mark point (initial + 2 retries). */
export const MAX_READY_ATTEMPTS = 3;
/**
 * `pr ready` calls per cycle across EVERY mark point. The ci loop can visit
 * the mark point several times; this keeps the total waiting bounded.
 */
export const MAX_READY_ATTEMPTS_PER_CYCLE = 6;
/** Fixed pause between `pr ready` attempts (tests inject `sleep`). */
export const READY_RETRY_BACKOFF_MS = 2_000;

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
const REVIEW_LOOP_STEPS = new Set([
  "develop",
  "adversarial",
  "commit-pr",
  "lens-fix",
  "lens-review",
]);

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

/**
 * Why the driver must NOT mark the PR ready, or `undefined` when it may.
 *  - a CRITICAL verdict is never marked ready over (the cap only routes it);
 *  - an ISSUES_FOUND verdict that a round/wall-clock cap sent to handoff was
 *    never disclosed on the PR (only the `ci` route discloses), so the
 *    findings would travel unseen — the PR stays a draft.
 */
export function readyHoldReason(eventLog: readonly WorkEvent[]): string | undefined {
  let verdictIdx = -1;
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const k = eventLog[i]?.kind;
    if (k === "lens-issues-found" || k === "lens-approved" || k === "lens-skipped-empty-diff") {
      verdictIdx = i;
      break;
    }
  }
  const verdict = eventLog[verdictIdx];
  if (verdict?.kind === "lens-issues-found" && verdict.verdict === "CRITICAL_ISSUES_FOUND") {
    return "a CRITICAL finding is open, and the driver does not mark a PR ready over one";
  }
  if (verdict?.kind === "lens-issues-found") {
    const capped = eventLog
      .slice(verdictIdx + 1)
      .some(
        (e) =>
          e.kind === "cap-hit" &&
          (e.cap === "round-cap" || e.cap === "wall-clock") &&
          e.nextStep === "handoff",
      );
    if (capped) {
      return "the review's remaining findings were never posted to the PR, so it was not marked ready";
    }
  }
  return undefined;
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
  const hold = readyHoldReason(current.eventLog);
  if (hold) {
    trace(`work-driver: PR #${prNumber} stays a draft — ${hold}`);
    return withPrDraft(current, { status: "draft", holdReason: hold });
  }
  const used = draft.attempts ?? 0;
  const attempts = Math.min(MAX_READY_ATTEMPTS, MAX_READY_ATTEMPTS_PER_CYCLE - used);
  if (attempts <= 0) {
    const error = `this cycle's ${MAX_READY_ATTEMPTS_PER_CYCLE} pr ready attempts are spent (last error: ${draft.error ?? "none recorded"})`;
    return withPrDraft(current, { status: "ready-failed", error, attempts: used });
  }
  let made = 0;
  let error = "";
  try {
    // Forge resolution is inside the try: a failure is recorded, not thrown.
    const forge: Forge | undefined =
      ctx.forge ?? (await forgeForCycle(ctx, ctx.verifyExecFn ?? execp));
    if (!forge) throw new Error("the forge for this repo could not be determined");
    for (let attempt = 1; attempt <= attempts; attempt++) {
      made++;
      try {
        await forge.prReady(prNumber);
        trace(`work-driver: PR #${prNumber} marked ready for review (draft → ready)`);
        return withPrDraft(current, { status: "ready", attempts: used + made });
      } catch (err) {
        error = errorText(err);
        trace(
          `work-driver: pr ready #${prNumber} failed (attempt ${attempt}/${attempts}): ${error}`,
        );
      }
      if (attempt < attempts) await sleep(READY_RETRY_BACKOFF_MS);
    }
  } catch (err) {
    error = errorText(err);
    made = Math.max(made, 1);
  }
  return withPrDraft(current, { status: "ready-failed", error, attempts: used + made });
}

/**
 * The handoff's decision. A review that concluded is marked ready (unless held);
 * a cycle that stopped before its review concluded keeps the draft and records
 * why; a ready that failed earlier is retried only once the review concluded —
 * a fix round in progress means the head is not yet reviewed.
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
    return draft.status === "draft"
      ? withPrDraft(live, {
          status: "draft",
          holdReason: "the review did not conclude before the cycle stopped",
        })
      : live;
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
  try {
    const forge = ctx.forge ?? (await forgeForCycle(ctx, ctx.verifyExecFn ?? execp));
    const pr = await forge?.prView(ps.prNumber);
    if (pr?.isDraft === true) return withPrDraft(state, { status: "draft" });
  } catch (err) {
    trace(`work-driver: could not read PR #${ps.prNumber} draft state: ${errorText(err)}`);
  }
  return state;
}

/**
 * The ops fallback opened the PR (its number was just parsed): record what the
 * forge reports. Only a PR that is a draft is recorded as `draft`; one the child
 * opened ready is recorded `ready`, so nothing claims a draft the forge does not
 * show. An unreadable view records nothing — the mark points read it live.
 */
export async function recordFallbackDraftFact(
  ctx: DriverContext,
  state: WorkState,
  prNumber: number,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
): Promise<WorkState> {
  if (!draftPrEnabled(ctx)) return state;
  try {
    const forge = ctx.forge ?? (await forgeForCycle(ctx, execFn));
    const pr = await forge?.prView(prNumber);
    if (pr?.isDraft === true) return withPrDraft(state, { status: "draft" });
    if (pr?.isDraft === false) {
      trace(
        `work-driver: ops fallback opened PR #${prNumber} ready, not as a draft — the review window is open`,
      );
      return withPrDraft(state, { status: "ready" });
    }
  } catch (err) {
    trace(`work-driver: could not verify PR #${prNumber} draft state: ${errorText(err)}`);
  }
  return state;
}

/**
 * The handoff comment's lines about the draft (empty when there is nothing to
 * say). `forge` picks the real ready command; unknown, both are named.
 */
export function draftPrHandoffLines(ps: WorkState["pipelineState"], forge?: ForgeType): string[] {
  const draft = ps.prDraft;
  const pr = ps.prNumber;
  if (!draft || pr === undefined || draft.status === "ready") return [];
  const readyCmd =
    forge === "github" || forge === "gitlab"
      ? `\`${prReadyCmd(forge, pr)}\``
      : `\`gh pr ready ${pr}\` (GitHub) or \`glab mr update ${pr} --ready\` (GitLab)`;
  if (draft.status === "draft") {
    return [
      "### Pull request is still a draft",
      "",
      `PR #${pr} was opened as a draft and stays one: ${draft.holdReason ?? "the driver did not mark it ready"}. Mark it ready with ${readyCmd} once the work is finished.`,
      "",
    ];
  }
  return [
    "### Marking the pull request ready FAILED",
    "",
    `The review is done, but marking PR #${pr} ready failed (${draft.attempts ?? 0} attempt(s) this cycle), so it is still a draft. Last error: ${draft.error ?? "(none recorded)"}`,
    "",
    `Run ${readyCmd} to mark it ready.`,
    "",
  ];
}

function withPrDraft(
  state: WorkState,
  prDraft: NonNullable<WorkState["pipelineState"]["prDraft"]>,
): WorkState {
  return { ...state, pipelineState: { ...state.pipelineState, prDraft } };
}

function errorText(err: unknown): string {
  const e = err as Error & { stderr?: string };
  const text = (e.stderr || e.message || String(err)).toString().trim().slice(0, 300);
  return text || "(no error text)";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * work-driver-issue-closed — the cycle's own ISSUE changed under it.
 *
 * `endIfPrGone` watches the PR, and it is the only forge-state gate the driver
 * has. Nothing ever read the issue. `runWorkDriverInner`'s terminal refusal keys
 * on the LOCAL state file (`status !== "running"`), and the one cycle-entry
 * forge read — `checkAttentionLabel` — reads only `.labels`, so a cycle driven
 * by a person who closed the issue mid-run kept dispatching children: explore,
 * plan, branch, develop, adversarial and commit-pr are all ungated, and each
 * pays for a fresh agent turn on work a human just said they no longer want.
 *
 * `endIfIssueClosed` mirrors `endIfPrGone`'s discipline for the issue:
 *  - ANY CLOSED member of the group ends the cycle at its next step boundary.
 *    `NormalizedIssue` exposes `state` and `labels` only — there is no
 *    `stateReason` through the forge seam, so COMPLETED and NOT_PLANNED are
 *    indistinguishable and every CLOSED is terminal. We do not branch on a
 *    reason we cannot read.
 *  - anything unreadable runs the step and records a plumb note. A cycle is
 *    never ended on a guess: a `gh` outage must not mass-abort healthy cycles,
 *    which would be a worse bug than the one being fixed.
 *  - `--restart` is NOT an override here, unlike the attention label. The label
 *    asks "has a human seen this?", which `--restart` answers; a CLOSED issue
 *    asks "does a human still want this?", which only reopening answers. The
 *    operator path is `gh issue reopen <N>` first.
 *
 * Decisions the ticket's gap gate left open, committed here:
 *
 *  - GROUP POLICY — any CLOSED member ends the WHOLE cycle, it does not drop
 *    the member and continue. The group shares one branch, one PR and one
 *    review; continuing on #10 after #11 was closed pushes #11's already-paid-
 *    for work onto a PR nobody asked for and renders a handoff for a subset the
 *    operator never requested. `droppedIssues` stays reserved for explore's
 *    per-issue body verdicts; the handoff names which issue closed.
 *  - PLACEMENT — `runStep`, before the dispatch switch, mirroring the
 *    `gate.ended ?? runX(...)` shape. `handoff` is deliberately NOT gated: the
 *    park IS a handoff, so gating it would refuse to run the very renderer the
 *    park needs. `merged` is deliberately NOT gated: it merges a PR whose
 *    review already passed, and refusing it would destroy finished, approved
 *    work because an issue was closed afterwards — `endIfPrGone` remains the
 *    authority on that step, since the PR is what a merge acts on.
 *  - READ SHAPE — one `issueView` per issue per gate, via `ctx.forge` so the
 *    existing `mkFakeForge` seam can inject it. The entry block makes one call
 *    that answers BOTH questions (label + state) rather than stacking a second
 *    read next to `checkAttentionLabel`'s.
 *  - RETRY OWNERSHIP — its own WeakSet. Sharing `endIfPrGone`'s would let a
 *    cycle whose PR was unreadable skip this gate's backoff, and the two gates
 *    answer different questions on different objects.
 *  - TERMINAL SHAPE — status `handoff` with the existing cap-hit + plumb-report
 *    pair and cap literal `issue-closed:<step>`. It writes NO verifyEvidence:
 *    `VerifyEvidenceOrigin` is a closed union whose `pr-not-open` text is about
 *    pushes to a branch, and routing an issue closure through it would produce
 *    an explanation that talks about the wrong object. The label is recorded as
 *    deliberately SKIPPED, not failed — see `issueClosedPark`.
 */

import { notifyAgent } from "./agent-message.ts";
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import { trace } from "./trace.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { reportFinalState } from "./work-driver-final-state.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Same shape as `PrGate`, so runStep reads the same way at every gate site. */
export type IssueGate = { ended?: WorkState; state: WorkState };

/**
 * Backoff before re-reading an unreadable issue state. A named sibling of
 * `PR_STATE_RETRY_DELAYS_MS`, not an alias: the two gates have independent
 * budgets, and a test asserting on one must not be perturbed by the other.
 */
const ISSUE_STATE_RETRY_DELAYS_MS = [500, 1500];

/** Cycles whose issue state has already been found unreadable (note once). */
const unreadableIssueCycles = new WeakSet<DriverContext>();

/**
 * Per-cycle, per-issue verdict cache. Keyed on the DriverContext so it dies
 * with the cycle — a fresh `/work` (or `--restart`) re-reads, which is the
 * point: reopening the issue must be seen by the next run, not by this one.
 */
const cycleVerdicts = new WeakMap<DriverContext, Map<number, "OPEN" | "CLOSED">>();

function cacheVerdict(ctx: DriverContext, issue: number, state: "OPEN" | "CLOSED"): void {
  let map = cycleVerdicts.get(ctx);
  if (!map) {
    map = new Map();
    cycleVerdicts.set(ctx, map);
  }
  map.set(issue, state);
}

/**
 * Resolve the forge the same way every other cycle-seam read does
 * (`work-driver-draft-pr.ts`): an injected `ctx.forge` wins so the existing
 * `mkFakeForge` fixture drives this gate, else resolve one for the repo.
 * `PI_ENSEMBLE_FORGE=none` means there is no forge to ask — no verdict, no note.
 */
/**
 * Resolve the forge the way every other cycle-seam read does: an injected
 * `ctx.forge` wins (the `mkFakeForge` fixture drives this gate), else the same
 * guarded detection `handoffForge` uses — `PI_ENSEMBLE_FORGE=none` or an
 * undetectable forge yields `undefined`, which means NO VERDICT and therefore
 * NO read.
 *
 * `forgeForCycle` is deliberately not used here: it forces a forge with
 * `PI_ENSEMBLE_FORGE=github` and does not treat `unknown` as absent, so a repo
 * with no forge gets a real `gh` subprocess per step. The gate runs before every
 * step, so that is ~360ms x ~12 steps of pure overhead — it pushed
 * test-work-driver-adv-retry-357's timed region from ~2s past its 5.5s bound.
 * A cycle must not be slowed by a check that cannot answer anyway; the gate
 * already fails open.
 */
const forgeCache = new Map<string, Forge | undefined>();

async function cycleForge(ctx: DriverContext): Promise<Forge | undefined> {
  if (ctx.forge) return ctx.forge;
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  const key = ctx.repoRoot;
  if (forgeCache.has(key)) return forgeCache.get(key);
  let forge: Forge | undefined;
  try {
    const det = await detectForge(ctx.repoRoot, {});
    forge = det.forge === "unknown" ? undefined : createForge(det, { cwd: ctx.repoRoot });
  } catch {
    forge = undefined;
  }
  forgeCache.set(key, forge);
  return forge;
}

/**
 * Read one issue's state, retrying an unreadable read at most once per cycle.
 * `undefined` state means "could not tell", which is never a verdict.
 */
type IssueRead = {
  state?: "OPEN" | "CLOSED";
  attempts: number;
  error?: string;
};

async function readIssueState(forge: Forge, issue: number, retry: boolean): Promise<IssueRead> {
  let error: string | undefined;
  const readOnce = async () => {
    try {
      const view = await forge.issueView(issue);
      // forge-mapping upper-cases gh's `state` verbatim; an unmapped value is
      // not proof the issue is open, so it is treated as unreadable.
      const s = view.state;
      return s === "OPEN" || s === "CLOSED" ? s : undefined;
    } catch (err) {
      error = (err as Error).message?.slice(0, 160);
      return undefined;
    }
  };
  let state = await readOnce();
  let attempts = 1;
  for (const delay of retry ? ISSUE_STATE_RETRY_DELAYS_MS : []) {
    if (state !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    state = await readOnce();
    attempts++;
  }
  return { state, attempts, error };
}

/**
 * End the cycle because its issue was closed. Returns `ended` only on a
 * confident CLOSED; an unreadable read falls through to `state` with a note.
 *
 * `opts.entryRead` carries a read already made at cycle entry so the entry
 * block does not read every issue twice.
 */
export async function endIfIssueClosed(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
  opts: {
    /** Skip the read: the caller already read this issue (cycle entry). */
    preRead?: Map<number, "OPEN" | "CLOSED" | undefined>;
    /** Test seam; defaults to the cycle's own forge. */
    forge?: Forge;
  } = {},
): Promise<IssueGate> {
  const group = [...new Set([ctx.issue, ...(ctx.issues ?? [])])];
  const forge = opts.forge ?? (await cycleForge(ctx));
  // No forge to ask: no verdict is possible, so the cycle proceeds silently
  // (there is nothing to note — the driver has no forge at all).
  if (!forge) return { state };

  const seen = unreadableIssueCycles.has(ctx);
  const preRead = opts.preRead ?? cycleVerdicts.get(ctx);
  let anyUnchecked = false;
  for (const n of group) {
    // Cached once per cycle per issue. The gate runs before EVERY step, so an
    // uncached read is one `gh` round-trip per issue per step — on a 12-step
    // grouped cycle that is dozens of forks inside the driver's own step budget
    // (it pushed #357 T8's timed region from ~2s to ~10s). A cycle that reads
    // OPEN and is then closed still stops at the NEXT cycle start; the gate's
    // job is to stop paying for children, and one read per cycle per issue is
    // enough to do that without taxing every step. An unreadable read is NOT
    // cached — the next gate retries, so a transient gh outage is not locked in.
    const read: IssueRead = preRead?.has(n)
      ? { state: preRead.get(n) ?? undefined, attempts: 0 }
      : await readIssueState(forge, n, !seen);
    if (read.state === "CLOSED") {
      return { state, ended: issueClosedPark(state, n, step, group.length) };
    }
    if (read.state === undefined) anyUnchecked = true;
    else cacheVerdict(ctx, n, read.state);
  }

  if (anyUnchecked && !seen) {
    unreadableIssueCycles.add(ctx);
    return { state: unreadableIssueNote(state, group, step) };
  }
  return { state };
}

/**
 * The park. `status: "handoff"` + `nextStep: "handoff"` so the cycle routes to
 * the renderer instead of dispatching another child.
 *
 * `handoffLabelSkipped` is what keeps the label off an issue a human just
 * closed. `needs-human-attention` is written by four independent sites
 * (`postHandoffToForge`, `postHandoffWithRetry`, `applyIssueLabelDualTarget`,
 * and the prose contract in `inlineHandoffOpsPrompt`), and the last of those is
 * a *prompt* to an @ops child — no runtime guard can suppress it. The flag
 * therefore lives in the state, which every one of those sites reads, and the
 * ops prompt tells the child about it.
 *
 * It is `skipped`, not `failed`: recording it as unapplied would make
 * `verifyHandoffLabel`'s honest "not verifiable" fire the "HANDOFF DISPATCH
 * INCOMPLETE" banner on a handoff that deliberately declined the label.
 */
export function issueClosedPark(
  state: WorkState,
  closedIssue: number,
  step: WorkStep,
  groupSize: number,
): WorkState {
  const who =
    groupSize > 1
      ? `issue #${closedIssue} (of ${groupSize} in this group)`
      : `issue #${closedIssue}`;
  const reason = `${who} is CLOSED — the ${step} step was not run and no further child was dispatched. A person closed it while the cycle was running; reopen it (\`gh issue reopen ${closedIssue}\`) before starting another cycle. The branch and any worktree are left as they are, and nothing was merged.`;
  return appendEvent(
    {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        currentStep: "handoff",
        handoffLabelSkipped: true,
      },
    },
    {
      kind: "cap-hit",
      at: Date.now(),
      cap: `issue-closed:${step}`,
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    },
    { kind: "plumb-report", at: Date.now(), step, role: "issue-gate", body: reason },
  );
}

/** The issue state stayed unreadable: the step runs, and the note says why. */
function unreadableIssueNote(state: WorkState, group: number[], step: WorkStep): WorkState {
  return appendEvent(state, {
    kind: "plumb-report",
    at: Date.now(),
    step,
    role: "issue-gate",
    body: `Could not read the state of ${group.map((n) => `#${n}`).join(", ")} before the ${step} step — the step ran anyway (a cycle is never ended on a guess). If \`gh\` is unhealthy, that is why the closed-issue check did not run.`,
  });
}

/**
 * Cycle-entry read answering BOTH questions in one `issueView` per issue: the
 * attention label and the issue state.
 *
 * Returns the per-issue state so the first `endIfIssueClosed` does not re-read,
 * and the attention verdict shaped like `checkAttentionLabel`'s so the caller's
 * refusal path is unchanged. `checked: false` is disclosed, never silently
 * approved — the same contract the label check has always honoured.
 */
export async function checkIssueStatesAtEntry(
  ctx: DriverContext,
  opts: { restart?: boolean; forge?: Forge } = {},
): Promise<{
  read: Map<number, "OPEN" | "CLOSED" | undefined>;
  closed?: { issue: number; groupSize: number };
  /** False when no read succeeded — the caller discloses, never approves. */
  checked: boolean;
  /** Attention-label refusal, if a group member carries the label. */
  attention?: { message: string };
}> {
  const group = [...new Set([ctx.issue, ...(ctx.issues ?? [])])];
  const forge = opts.forge ?? (await cycleForge(ctx));
  if (!forge) return { read: new Map(), checked: false };
  const read = new Map<number, "OPEN" | "CLOSED" | undefined>();
  let checked = true;
  for (const n of group) {
    const r = await readIssueState(forge, n, true);
    read.set(n, r.state);
    if (r.state === undefined) checked = false;
    if (r.state === "CLOSED")
      return { read, closed: { issue: n, groupSize: group.length }, checked };
  }
  return { read, checked };
}

/** Trace helper shared with the entry block's disclosure. */
export function traceUnreadableIssueStates(issues: number[]): void {
  trace(`work-driver: issue-state gate could not read ${issues.map((n) => `#${n}`).join(", ")}`);
}

/**
 * work-driver-state-guards — the pre-loop refusals: reads of the state and of
 * the issue that can end a cycle before any step is dispatched.
 *
 * Split from `work-driver.ts` (file-size gate). The entry module owns the
 * step loop; these are pre-flight verdicts, each with the same shape — a
 * notify, a `reportFinalState`, and a `{started:false}` reason the caller
 * surfaces. Keeping them together makes the one that does NOT refuse but must
 * not silently pass (an unreadable label check) visible next to the ones that
 * do.
 *
 * Evaluation order (the order `work-driver.ts` calls them, before the sweeps
 * so a refused start mutates nothing): state-file validity → the
 * `needs-human-attention` label → the #1743 repeat-park guard.
 */
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import { checkAttentionLabel } from "./work-driver-attention.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { reportFinalState } from "./work-driver-final-state.ts";
import type { StartRefusal } from "./work-driver-outcome.ts";
import { repeatParkVerdict, repeatParkVerdictReason } from "./work-driver-park-memory.ts";
import { validateDiscriminants } from "./workflow-state-validate.ts";
import { type WorkState, detectInconsistencies, workStateDir } from "./workflow-state.ts";

/**
 * #408 — the driver has always WRITTEN `needs-human-attention` and never read
 * it back, so /work on a handed-off issue quietly reran the whole pipeline
 * and produced the same handoff again. Checked before any dispatch is paid
 * for. `--restart` is the override: it already means "I revised the issue".
 *
 * Returns the refusal reason, or `undefined` to continue. An unreadable `gh`
 * does NOT refuse (every later step needs `gh` anyway and would fail with a
 * clearer error) but IS traced, so the cycle records that the gate did not
 * run rather than pretending it passed.
 */
export async function refuseAttentionLabelled(ctx: CycleContext): Promise<string | undefined> {
  const attention = await checkAttentionLabel(ctx.repoRoot, ctx.issue, {
    restart: ctx.restart === true,
    issues: ctx.issues,
  });
  if (attention.refuse && attention.message) {
    notifyAgent(ctx.host, attention.message);
    return "issue carries the needs-human-attention label";
  }
  if (!attention.checked) {
    trace(`work-driver: needs-human-attention check did not run for #${ctx.issue}`);
  }
  return undefined;
}

/**
 * #533 — refuse on unrecognised discriminant in `running` state only, plus the
 * half-written-state check (#382's resume hazard). Both read the same file the
 * loop is about to act on; both notify with the state path and the
 * "rm to start fresh, your git work is unaffected" reassurance.
 *
 * Returns the refusal reason, or `undefined` when the state is usable.
 */
export function refuseInvalidState(ctx: CycleContext, state: WorkState): string | undefined {
  if (state.pipelineState.status === "running") {
    const unknowns = validateDiscriminants(state);
    if (unknowns.length > 0) {
      const detail = unknowns.map((u) => `  - ${u}`).join("\n");
      trace(`work-driver: state discriminant validation failed for issue ${ctx.issue}:\n${detail}`);
      notifyAgent(
        ctx.host,
        `pi-rukas /work driver halted on issue #${ctx.issue}: state file carries an unrecognised value.\n${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
      );
      return "state-file discriminant validation failed";
    }
  }
  const inconsistencies = detectInconsistencies(state);
  if (inconsistencies.length > 0) {
    const detail = inconsistencies.join("\n  - ");
    trace(`work-driver: state inconsistencies detected for issue ${ctx.issue}:\n  - ${detail}`);
    notifyAgent(
      ctx.host,
      `pi-rukas /work driver halted on issue #${ctx.issue}: state-file inconsistencies detected.\n  - ${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
    );
    return "state-file inconsistencies detected";
  }
  return undefined;
}

/** Marks the #1743 refusal reason so the headless runner can project it. */
export const REPEAT_PARK_REFUSAL_PREFIX = "repeat-park: ";

/**
 * The pre-loop refusals, in the order they are asked. Kept as one call so the
 * driver's start sequence stays one screen: the label gate is the human's own
 * signal and is read first, the park gate last, and both run BEFORE either
 * sweep so a refused start mutates nothing on disk.
 *
 * `state` is the snapshot the attention gate reports as the cycle's final
 * state; the park gate writes no state at all, so it reports none.
 */
export async function refuseUnproductiveStart(
  ctx: CycleContext,
  state: WorkState,
): Promise<StartRefusal | undefined> {
  const labelled = await refuseAttentionLabelled(ctx);
  if (labelled) {
    reportFinalState(ctx, state);
    return { reason: labelled };
  }
  return refuseRepeatPark(ctx);
}

/** Did this driver refuse because the issue has already parked twice? */
export function isRepeatParkRefusal(reason: string): boolean {
  return reason.startsWith(REPEAT_PARK_REFUSAL_PREFIX);
}

/**
 * #1743 — a park a human has already been told about twice is not news a third
 * time. Two cycles have parked this issue for this reason against this exact
 * issue text AND reported it; a third start would re-run explore or plan,
 * report the same verdict again, and cost the operator another handoff to read.
 *
 * Scope, deliberately narrow (each exclusion is a reproduced false stop):
 *  - EVERY issue in the group is checked, like the attention gate — a grouped
 *    cycle for #10+#11 must not start because only the primary was clean.
 *  - Only `intent-park` and `existing-pr-detected` can refuse (see
 *    REFUSABLE_PARK_CAPS). The plan gate's verdict is a model's judgement.
 *  - `existing-pr-detected` is re-checked against the forge first: the record
 *    remembers a GitHub state, and a PR a person has since closed is not a
 *    reason to stop.
 *  - `--continue-pr` never refuses AN OPEN-PR PARK: continuing that very PR is
 *    the documented remedy for `existing-pr-detected`, so arming the guard
 *    against it would block the fix. It does NOT waive an `intent-park`
 *    refusal — continuing a PR has nothing to do with what the issue says, and
 *    a third "this issue does not say enough to build from" is exactly the
 *    report this guard stops.
 *
 * `--restart` deliberately does NOT bypass this. Its whole contract is "re-run
 * this unchanged issue and see what happens", and a factory that passes it on
 * every cycle is the exact shape that produced the duplicate reports; the
 * attention gate above may be overridden because `--restart` means "I revised
 * the issue", but this guard fires precisely when nothing was revised.
 *
 * Fails open: an unreadable issue body cannot be compared with the record, so
 * the run proceeds (traced) rather than being refused on a judgement the driver
 * could not make. Returns the refusal (reason + verdict), or `undefined` to
 * continue.
 */
export async function refuseRepeatPark(ctx: CycleContext): Promise<StartRefusal | undefined> {
  const verdict = await repeatParkVerdict(ctx, ctx.issues);
  if (!verdict) return undefined;
  // The documented way out of an open-PR park is to continue that PR. Refusing
  // it would make the guard block the remedy it tells the operator to run — and
  // ONLY that remedy: an intent park is not a PR problem.
  if (ctx.continuePr && verdict.cap === "existing-pr-detected") {
    trace(
      `work-driver: repeat-park guard stood down for #${verdict.issue} — --continue-pr IS the remedy for the open-PR park (PR #${verdict.reason})`,
    );
    return undefined;
  }
  const first = new Date(verdict.firstAt).toISOString();
  const grouped = verdict.issue !== ctx.issue;
  const message = `pi-rukas /work refused to start on issue #${ctx.issue}${grouped ? ` (group member #${verdict.issue})` : ""}: it has already been parked ${verdict.count} times and reported ${verdict.deliveredCount} times as \`${verdict.cap}\` (${verdict.reason}), first reported ${first}, against the same issue text.
A third identical park reports nothing new, so no step was dispatched, no worktree was touched and no state file was written.
Two ways forward: revise the body of #${verdict.issue} (any substantive edit clears the guard and the next park reports in full), or run once with PI_ENSEMBLE_REPEAT_PARK=0 to report it regardless.`;
  trace(
    `work-driver: repeat-park refusal for #${verdict.issue} (cycle #${ctx.issue}): ${verdict.cap} (${verdict.reason}) x${verdict.count}, reported ${verdict.deliveredCount}`,
  );
  notifyAgent(ctx.host, message);
  return {
    reason: `${REPEAT_PARK_REFUSAL_PREFIX}${repeatParkVerdictReason(verdict)}`,
    repeatPark: verdict,
  };
}

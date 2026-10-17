/**
 * work-driver-state-guards — the pre-loop refusals: three reads of the state
 * file that can end a cycle before any step is dispatched.
 *
 * Split from `work-driver.ts` (file-size gate). The entry module owns the
 * step loop; these are pre-flight verdicts, each with the same shape — a
 * notify, a `reportFinalState`, and a `{started:false}` reason the caller
 * surfaces. Keeping them together makes the third one (an unreadable label
 * check that does NOT refuse but must not silently pass) visible next to the
 * two that do.
 */
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import { checkAttentionLabel } from "./work-driver-attention.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { reportFinalState } from "./work-driver-final-state.ts";
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

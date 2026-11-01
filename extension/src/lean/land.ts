/**
 * lean/land — the one irreversible act in a run, performed or refused.
 *
 * `machine.ts` lets exactly one edge into this state (`ci` + `green`) and
 * `engine.ts`'s arrival gate refuses an arrival whose newest decided `verify`
 * or `ci` is not green. Neither is restated here — a second copy of that
 * judgement is the bloat this step exists to avoid. What is left is the two
 * things only this step can observe:
 *
 *   1. **May it merge at all?** `autoMerge`, read from `.pi/work.json` AT the
 *      run's `baseSha` through `loadWorkConfig` — the #406 rule `config.ts`
 *      already enforces, so a run that edited its own config is judged by the
 *      bytes that existed before it started. Absent or false → `refused`.
 *   2. **Is it merging the head that was verified?** The forge's own merge
 *      evidence (`gatherMergeEvidence`) reports the head the CI verdict was read
 *      at, from the same read as `mergeStateStatus`; it must equal the newest
 *      decided `verify`'s `verifiedHead`. Anything else → `refused`, naming both.
 *
 * The merge goes through the adapter's `prMerge`, which pins to the verified
 * head and refuses an unpinned call, and the result is READ BACK: `merged` is a
 * claim about the forge, not about the call's return value. If the merge cannot
 * be performed exactly and confirmed, this step returns `refused` — never an
 * approximation (no unpinned merge, no method guess, no fallback).
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { HandlerCtx } from "./engine.ts";
import type { LandDeps } from "./land-deps.ts";
import { specifyBranch } from "./specify-tree.ts";
import type { Outcome } from "./state.ts";

/** The newest decided `verify`'s head, which is what the merge must be about. */
function verifiedHead(ctx: HandlerCtx): string | undefined {
  for (let i = ctx.steps.length - 1; i >= 0; i--) {
    const step = ctx.steps[i];
    if (step?.state !== "verify" || step.outcome === undefined) continue;
    const head = step.outcome.verifiedHead;
    return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
  }
  return undefined;
}

/** The `land` step. Returns `merged` | `refused`; never throws. */
export async function landOutcome(ctx: HandlerCtx, deps: LandDeps): Promise<Outcome> {
  const refuse = (why: string): Outcome => ({ kind: "refused", reason: `land refused: ${why}` });
  const head = verifiedHead(ctx);
  if (head === undefined) return refuse("no verified head on the step log");

  const config = await deps
    .loadConfig(ctx.repoRoot, ctx.run.baseSha)
    .then((c) => ({ autoMerge: c.autoMerge === true }))
    .catch((err: unknown) => ({ why: (err as Error)?.message ?? String(err) }));
  if ("why" in config)
    return refuse(`the project config could not be read at the base — ${config.why}`);
  if (config.autoMerge !== true)
    return refuse("autoMerge is not true in .pi/work.json at the run's base");

  const branch = specifyBranch(ctx.run.branch, ctx.issue);
  try {
    const number = await deps.openPr(ctx.repoRoot, branch);
    if (number === undefined) return refuse(`no open PR on ${branch}`);
    const ev = await deps.evidence(ctx.repoRoot, number);
    if (ev === undefined) return refuse(`the merge evidence for PR #${number} could not be read`);
    if (ev.ok !== true)
      return refuse(
        `the forge says PR #${number} is not mergeable — ${ev.reason ?? "no reason given"}`,
      );
    if (ev.inconclusive.length > 0)
      return refuse(`required checks reporting skipped/neutral: ${ev.inconclusive.join(", ")}`);
    if (ev.failing.length > 0) return refuse(`checks failing: ${ev.failing.join(", ")}`);
    const prHead = ev.headOid;
    if (prHead === undefined || !isFullCommitSha(prHead))
      return refuse(
        `the forge gave no full head OID to pin the merge to — ${ev.headOidError ?? "no reason given"}`,
      );
    if (prHead !== head)
      return refuse(
        `the PR head ${prHead.slice(0, 12)} is not the verified head ${head.slice(0, 12)}`,
      );
    await deps.merge(ctx.repoRoot, {
      number,
      headOid: head,
      method: "squash",
      subject: deps.mergeSubject?.(ctx.issue),
    });
    const after = await deps.stateAfter(ctx.repoRoot, number);
    if (after !== "MERGED")
      return refuse(`the PR reports ${String(after)} after the merge, not MERGED`);
    return { kind: "merged", reason: `merged PR #${String(number)} at ${head.slice(0, 12)}` };
  } catch (err) {
    return refuse(`the forge refused the pinned merge — ${(err as Error)?.message ?? String(err)}`);
  }
}

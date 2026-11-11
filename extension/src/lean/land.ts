/**
 * lean/land — the one irreversible act in a run, performed or refused.
 *
 * `machine.ts` lets exactly one edge into this state (`ci` + `green`) and
 * `engine.ts`'s arrival gate (`landEarned`) refuses an arrival whose newest
 * decided `verify` or `ci` is not green. Neither is restated here — a second
 * copy of that judgement is the bloat this step exists to avoid. What is left is
 * the two things only this step can observe:
 *
 *   1. **May it merge at all?** `autoMerge`, read from `.pi/work.json` AT the
 *      run's `baseSha` through `loadWorkConfig` — the rule `config.ts`
 *      already enforces, so a run that edited its own config is judged by the
 *      bytes that existed before it started. Two refusals, because the two
 *      causes need different operator actions: `autoMerge` absent or false →
 *      `refused` naming the missing grant; a config that could not be READ →
 *      also `refused`, but naming the unreadable config. An unreadable config
 *      never silently resolves to `autoMerge: false`, because "the project
 *      declined to grant it" and "nobody could tell what it said" send the
 *      operator to different files.
 *   2. **Is it merging the head that was verified?** The forge's own merge
 *      evidence (`gatherMergeEvidence`) reports the head the CI verdict was read
 *      at, from the same read as `mergeStateStatus`; it must equal the newest
 *      decided `verify`'s `verifiedHead`. Anything else → `refused`, naming both.
 *   3. **May this author's PR be landed at all?** (#2181) The PR's author must be
 *      listed in `.pi/merge-authors` at the run's `baseSha` — the same gate file,
 *      the same base commit, and the same shared function the `/work` driver's
 *      `merged` step and the merge guard call. An allowlist that is absent,
 *      unreadable or empty, and an author the forge did not report, all →
 *      `refused`. No override reaches it: `autoMerge` grants that the project
 *      permits landing, not that this person's PR may be landed.
 *
 * The merge goes through the adapter's `prMerge`, which pins to the verified
 * head and refuses an unpinned call, and carries an explicit squash subject
 * (`landDeps()` builds it the way the driver builds its own commit title —
 * `deriveConsolidationSubject` over the issue title), because the squash
 * subject BECOMES the commit record on main and release-please derives the
 * version bump and changelog entry from it. Leaving it to the forge's default
 * is leaving the changelog to luck.
 *
 * The result is READ BACK: `merged` is a claim about the forge, not about the
 * call's return value. If the merge cannot be performed exactly and confirmed,
 * this step returns `refused` — never an approximation (no unpinned merge, no
 * method guess, no fallback).
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { authorFromRead, evidenceAuthorRead, heldForMergeAuthor } from "./../merge-guard-author.ts";
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

  // Two states, deliberately not collapsed into one `false`: the `.then` arm is
  // "the config answered" and the `.catch` arm is "the config could not be read".
  // Folding the second into the first made an unreadable `.pi/work.json` report
  // itself as a grant the project never made, which is the wrong diagnosis for the
  // one operator who has to act on it. Both refuse — this step fails closed on
  // either — but they refuse for different reasons, in different words.
  const grant = await deps
    .loadConfig(ctx.repoRoot, ctx.run.baseSha)
    .then((c) => ({ autoMerge: c.autoMerge === true }))
    .catch((err: unknown) => ({ why: (err as Error)?.message ?? String(err) }));
  if ("why" in grant)
    return refuse(
      `the project config at the run's base could not be read (${grant.why}) — the merge stays refused because the grant could not be established, which is NOT the same as the project declining to grant it`,
    );
  if (grant.autoMerge !== true)
    return refuse(
      "autoMerge is not true in .pi/work.json at the run's base (the config was read, and it did not grant the merge)",
    );

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
    // #2181 — the merge-author gate, after every check that could refuse and
    // before the one call that cannot be undone. The author comes from the
    // evidence read above (`mergeEvidenceViewCmd` carries `author`), so the login
    // judged belongs to the same PR state the head pin was taken from; the
    // allowlist is read at the run's base sha by the shared gate, never here and
    // never from the working tree.
    const authorGate = await deps.checkAuthor(
      ctx.repoRoot,
      ctx.run.baseSha,
      authorFromRead(evidenceAuthorRead(ev)),
    );
    if (authorGate.ok !== true)
      return refuse(`the merge-author gate refused it — ${authorGate.reason ?? "no reason given"}`);
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

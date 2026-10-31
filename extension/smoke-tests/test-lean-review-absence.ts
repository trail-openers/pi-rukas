#!/usr/bin/env bun
/**
 * lean/review — what ABSENCE of signal must never read as.
 *
 * Sibling of `test-lean-review-wiring.ts` (which pins the loop, the fix round,
 * and the frozen contract); this one pins the two shapes where a gate produced
 * no evidence at all, because both are the failure mode this step exists to
 * make impossible: a review that did not happen reporting as a review that
 * passed. Both were found by adversarial review of the step and both are
 * regressions this suite now catches — verified by reverting the fix and
 * watching the assertions go red.
 *
 *   (h) the evidence helpers must be handed the BRANCH. `buildEvidence` and
 *       `runClaimScan` each build an `origin/<arg>` ref internally, so an
 *       argument that is a resolved 40-hex sha names a ref git can never
 *       resolve. Neither helper throws on that — every failure inside them is
 *       swallowed — so the step used to get "no claims to check, no prose to
 *       supply" back, which is indistinguishable from a clean scan. #422's
 *       claim scan and #390's prose evidence were inert for every lean run.
 *       The only way to catch it is to make one of them really read the branch
 *       and assert it found something.
 *
 *   (i) a lens round that ran no lens must not clear the step. The review
 *       layer's empty-delta outcome is `verdict: "APPROVED"` with no lens
 *       behind it, and says so on exactly one field (`noReview`) the step used
 *       to drop on the way to its own `LensRound`. The frozen driver branches
 *       on it and routes to handoff; here it fell through to `done` and printed
 *       "review clean". Both shapes are driven: the flagged one, and an
 *       unflagged round that reported no usage at all.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import path from "node:path";
import { ReviewInfraError } from "../src/lean/review.ts";
import {
  BRANCH,
  USAGE,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  makeRepo,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { put } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (h) the evidence helpers read the BRANCH, not the resolved sha ───────────
{
  const { repoRoot, baseSha } = makeRepo();
  const wt = path.join(repoRoot, ".worktrees", "lean-7");
  git(repoRoot, "worktree", "add", "-B", BRANCH, wt, baseSha);
  // Prose that asserts two checkable particulars nothing in the repository
  // grounds, in the two forms `claim-scan.ts` extracts: a quantity with a unit,
  // and a SCREAMING_SNAKE env var.
  put(wt, "docs/claims.md", "# claims\nRuns on 64 TB of cache with DEPLOY_TOKEN set.\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "docs: invented claims");
  git(wt, "push", "-q", "origin", `refs/heads/${BRANCH}`);
  // Rewind the checkout to the base — the state a lean worktree is in while the
  // step runs, and the reason these two helpers must read a ref at all.
  git(repoRoot, "checkout", "-q", baseSha);

  const seen: { evidence: string | undefined; findings: number }[] = [];
  const { outcome, threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      lens: async (a) => {
        seen.push({ evidence: a.evidence, findings: a.extraFindings?.length ?? 0 });
        return { verdict: "APPROVED", findings: "", usage: USAGE };
      },
    }),
  );
  assert(threw === undefined, `(h) the run does not throw (${threw?.message})`);
  assert(outcome?.kind === "done", `(h) clean gates reach done (got ${outcome?.kind})`);
  assert(seen.length === 1, "(h) one lens round ran");
  assert(
    (seen[0]?.findings ?? 0) > 0,
    `(h) the claim scan reported the unsourced claims — so it resolved a real ref, not origin/<sha> (got ${String(seen[0]?.findings)})`,
  );
  assert(
    (seen[0]?.evidence ?? "").includes("64 TB"),
    `(h) the prose evidence carries the post-change file, read from the branch (${(seen[0]?.evidence ?? "undefined").slice(0, 60)})`,
  );
}

// ── (i) a lens round that ran no lens is not an approval ─────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });

  const { threw: t1, outcome: o1 } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      lens: async () => ({
        verdict: "APPROVED",
        findings: "",
        usage: undefined,
        noReview: true,
        note: "No changes since the last lens review (aabbccdd) — nothing to review.",
      }),
    }),
  );
  assert(
    t1 instanceof ReviewInfraError && /ran no lens/.test(t1.message),
    `(i1) the no-review outcome throws rather than reaching done (${t1?.message ?? `got ${String(o1?.kind)}`})`,
  );
  assert(
    o1 === undefined,
    `(i1) the step reports no outcome at all for a review that ran nobody (got ${String(o1?.kind)})`,
  );

  const { threw: t2, outcome: o2 } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      lens: async () => ({ verdict: "APPROVED", findings: "", usage: undefined }),
    }),
  );
  assert(
    t2 instanceof ReviewInfraError && /no usage from any lens child/.test(t2.message),
    `(i2) an APPROVED round with no usage behind it throws too (${t2?.message ?? `got ${String(o2?.kind)}`})`,
  );

  // And the positive control: a round that ran its lenses still reaches `done`,
  // so the two guards above are not a blanket refusal.
  const { threw: t3, outcome: o3 } = await runStep(ctxFor(repoRoot, baseSha, BRANCH), depsWith({}));
  assert(
    t3 === undefined && o3?.kind === "done",
    `(i3) a lens round with usage still clears (${t3?.message ?? String(o3?.kind)})`,
  );
}

cleanupRoots();
process.exit(exit);

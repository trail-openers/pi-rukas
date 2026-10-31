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
 *   (j) the fixer's tree is named per round AND per run, so a directory nobody
 *       created can never be at its path. The old fixed name meant `worktree
 *       add` was the only thing refusing a non-empty directory, with two awaits
 *       (`provisionWorktree`, then `status`) between it and the clean read — and
 *       nothing tested that read at all. Now: a pre-populated path is a refusal
 *       that never dispatches and never reaches origin, and two rounds of one run
 *       get two different trees.
 *
 *   (k) a refused integration says what happened to the tree. The restore is
 *       awaited before the throw and its outcome is in the cause, because "the
 *       tree is back at the reviewed commit" and "the tree is still at the
 *       fixer's head, and verify will read that" are different facts.
 *
 *   (l) the run's PR number reaches the lens round. Without it every
 *       ISSUES_FOUND round spends a `gh pr list` asking the forge for a number
 *       this run recorded at `publish`.
 *
 *   (m) a disclosure note is never carried and dropped: it reaches a surface.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fixTreeName } from "../src/lean/review-tree.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  frozenBlob,
  git,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";

/** The frozen record `specify` would have written for this repo's committed test. */
function frozenSha(repoRoot: string): string {
  return sha256(frozenBlob(repoRoot, "HEAD"));
}

const { assert, failures } = makeAssert();

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
        return cleanLensRound();
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
        ...cleanLensRound(),
        verdict: "APPROVED",
        findings: "",
        usage: undefined,
        lenses: [],
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
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "APPROVED",
        findings: "",
        usage: undefined,
        lenses: [],
      }),
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

// ── (j) the fixer's tree is named per round AND per run ─────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const reviewed = git(repoRoot, "rev-parse", `origin/${BRANCH}`);

  // (j1) A pre-populated tree is a refusal that NEVER dispatches, and the dirty
  // read that used to be the step's only guard is no longer the thing standing
  // between an adopted directory and `git add -A`.
  //
  // The path is derived from the run's own clock, so the test states the clock
  // and names the path the step is about to reach for: driving the collision
  // requires naming it, which is also the property that makes a resumed attempt
  // re-enter its own tree rather than a stranger's.
  const runId = "1700000000000";
  const ctxJ = ctxFor(repoRoot, baseSha, BRANCH);
  ctxJ.now = () => Number(runId);
  const planted = fixTreeName(repoRoot, 7, "a", 1, 0, runId);
  mkdirSync(planted, { recursive: true });
  put(planted, "planted-by-somebody-else.ts", "export const stolen = 1;\n");
  let fixerDispatched = 0;
  const { threw: tj, outcome: oj } = await runStep(
    ctxJ,
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: async (spec: DispatchSpec) => {
        fixerDispatched++;
        put(spec.cwd as string, "fix.ts", "export const x = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: adopted the planted file");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    tj instanceof ReviewInfraError && /could not create the fix worktree/.test(tj.message),
    `(j1) a directory already at the round's tree path is refused, not adopted (${tj?.message ?? `got ${String(oj?.kind)}`})`,
  );
  assert(
    fixerDispatched === 0,
    "(j1) and the fixer was never paid for a round that cannot be made clean",
  );
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`) === reviewed,
    "(j1) and origin still holds the reviewed head — the planted file never reached it",
  );
  rmSync(planted, { recursive: true, force: true });

  // (j2) Every (arm, round, attempt, run) quadruple gets its own tree, and the
  // name carries all four: that is what makes "anything here is ours" true without
  // a check, and what makes a RESUME re-derive the path its killed self used.
  const a = fixTreeName(repoRoot, 7, "a", 1, 0, runId);
  const b = fixTreeName(repoRoot, 7, "a", 1, 0, runId);
  const c = fixTreeName(repoRoot, 7, "a", 2, 0, runId);
  const d = fixTreeName(repoRoot, 7, "a", 1, 0, "1700000009999");
  const lensArm = fixTreeName(repoRoot, 7, "l", 1, 0, runId);
  const otherAttempt = fixTreeName(repoRoot, 7, "a", 1, 1, runId);
  assert(
    a === b,
    "(j2) the same (arm, round, attempt, run) derives the SAME path — this is the resume property, and an in-memory counter would break it",
  );
  assert(a !== c, "(j2) a different ROUND is a different tree");
  assert(a !== d, "(j2) a different RUN is a different tree");
  assert(
    a !== lensArm,
    "(j2) the lens arm's fix of the same round is a DIFFERENT tree from the adversarial arm's — one round dispatches two fixers, and sharing the path is what made `add --force` adopt a live tree",
  );
  assert(
    a !== otherAttempt,
    "(j2) a second concurrent attempt on the same issue, round and run gets its own path, so neither adopts the other's leftovers",
  );
  assert(
    a.includes("lean-7-fix-a-1-0-") && c.includes("lean-7-fix-a-2-0-"),
    `(j2) and the name itself carries the arm and round it belongs to (${path.basename(a)}, ${path.basename(c)})`,
  );

  // (j3) The name the step reaches for IS this path: the refusal above quoted it.
  // That is the whole of what this seam can be driven to prove offline — the
  // collision is refused at `add`, before the provisioner runs and before the
  // clean read, which is the ordering the race lived in. A round that got a clean
  // tree is already covered by (c) of `test-lean-review-wiring.ts`, which drives
  // a full fix round through this same `fixTree`.
  assert(
    tj instanceof ReviewInfraError && tj.message.includes(planted),
    `(j3) the refusal names the exact tree it refused to adopt, so the operator can see whose directory it was (${tj?.message})`,
  );
}

// ── (k) a refused integration names what happened to the tree ───────────────
{
  const note = "the fix round changed the frozen acceptance contract: tests/AC1.test.ts";

  // (k1) The tree is there and the restore runs: the cause says so, and says it
  // BEFORE the throw, because `fail` awaits the restore rather than firing it.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const frozenRun = (root: string, issue: number) => {
    const ctx = ctxFor(root, baseSha, BRANCH);
    const frozen = { "tests/AC1.test.ts": frozenSha(root) };
    ctx.run.steps.push({
      key: "7:specify:0",
      state: "specify",
      startedAt: 1,
      endedAt: 2,
      outcome: { kind: "ok", frozen, tests: { AC1: ["tests/AC1.test.ts"] } },
    });
    return ctx;
  };
  const cheating = async (spec: DispatchSpec) => {
    const wt = spec.cwd as string;
    put(wt, "tests/AC1.test.ts", "// rewritten\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: cheated");
    return result({ role: FIXER_ROLE });
  };
  const { threw: tk } = await runStep(
    frozenRun(repoRoot, 7),
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: cheating,
    }),
  );
  assert(
    tk instanceof ReviewInfraError && tk.message.includes(note),
    `(k1) the frozen refusal is still the cause the operator reads (${tk?.message})`,
  );
  assert(
    tk instanceof ReviewInfraError && /the run's tree was put back at/.test(tk.message),
    `(k1) and the cause says the tree went back where the gates read it (${tk?.message})`,
  );
  assert(
    tk instanceof ReviewInfraError && !/WORKTREE LEFT AT/.test(tk.message),
    "(k1) and does not claim the tree was left behind when it was not",
  );

  // (k2) A restore that cannot run — the run's own tree is gone — is named in
  // the cause. This is the fact a fire-and-forget `void` kept to itself: a
  // branch left at the fixer's head, with `verify` and `publish` about to read it.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 2;\n" });
  const ctx2 = frozenRun(rr2, 7);
  const runTree = path.join(rr2, ".worktrees", "lean-7");
  // Take the run's tree away while the fixer runs, so the restore finds nothing.
  const removeTree = async (spec: DispatchSpec) => {
    await cheating(spec);
    git(rr2, "worktree", "remove", "--force", runTree);
    return result({ role: FIXER_ROLE });
  };
  const { threw: tk2 } = await runStep(
    ctx2,
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: removeTree,
    }),
  );
  assert(
    tk2 instanceof ReviewInfraError && /WORKTREE LEFT AT THE FIXER'S HEAD/.test(tk2.message),
    `(k2) when the tree cannot be put back, the cause says so rather than tracing it (${tk2?.message})`,
  );
  assert(
    tk2 instanceof ReviewInfraError && /verify and publish will read that tree/.test(tk2.message),
    "(k2) and names what will read the wrong tree next",
  );
}

// ── (l) the run's PR number reaches the lens round ─────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.run.steps.push({
    key: "7:publish:0",
    state: "publish",
    startedAt: 1,
    endedAt: 2,
    outcome: {
      kind: "ok",
      prUrl: "https://github.com/acme/widget/pull/321",
      publishedHead: git(repoRoot, "rev-parse", `origin/${BRANCH}`),
      draft: false,
    },
  });
  const seenPr: (number | undefined)[] = [];
  const { threw: tl } = await runStep(
    ctx,
    depsWith({
      lens: async (a) => {
        seenPr.push(a.pr);
        return cleanLensRound();
      },
    }),
  );
  assert(tl === undefined, `(l) the run does not throw (${tl?.message})`);
  assert(
    seenPr.length === 1 && seenPr[0] === 321,
    `(l) the lens round was handed the PR this run opened, so the review layer never asks the forge for it (got ${JSON.stringify(seenPr)})`,
  );

  // And the absence: a run whose `publish` has not decided gets no number, which
  // is the review layer's own "look it up" signal rather than a bogus one.
  const seenPr2: (number | undefined)[] = [];
  await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      lens: async (a) => {
        seenPr2.push(a.pr);
        return cleanLensRound();
      },
    }),
  );
  assert(
    seenPr2.length === 1 && seenPr2[0] === undefined,
    `(l) with no recorded PR the step passes none rather than inventing one (got ${JSON.stringify(seenPr2)})`,
  );
}

// ── (m) a disclosure note is never carried and dropped ─────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const withNote = (note: string | undefined) =>
    depsWith({
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "APPROVED",
        findings: "",
        ...(note === undefined ? {} : { note }),
      }),
    });

  // A round that cleared with a disclosure still outstanding puts the note on a
  // surface the operator reads. `finishLensReview` only sets `note` on an
  // ISSUES_FOUND round, so this shape is not one today's review layer produces —
  // which is exactly why it is asserted: a note carried into the step and read
  // by nothing is the silent version of the failure it reports, and the merge
  // guard's round-cap path refuses the run until that marker is on the PR.
  const { outcome: om, threw: tm } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    withNote("residual-findings disclosure FAILED: forge unreachable"),
  );
  assert(tm === undefined && om?.kind === "done", `(m) the round still clears (${tm?.message})`);
  assert(
    (om?.reason ?? "").includes("DISCLOSURE NOT POSTED") &&
      (om?.reason ?? "").includes("forge unreachable"),
    `(m) and the note reaches the reason, not the bit-bucket (${om?.reason})`,
  );

  // The positive control: no note, no clause — the reason of a clean round is
  // not cluttered with a warning about something that did not happen.
  const { outcome: om2 } = await runStep(ctxFor(repoRoot, baseSha, BRANCH), withNote(undefined));
  assert(
    om2?.kind === "done" && !(om2.reason ?? "").includes("DISCLOSURE"),
    `(m) a round with nothing to disclose says only that it was clean (${om2?.reason})`,
  );
}

cleanupRoots();
process.exit(failures());

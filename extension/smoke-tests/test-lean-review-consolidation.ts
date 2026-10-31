#!/usr/bin/env bun
/**
 * lean/review — the findings the six-lens review raised, each pinned by the
 * case that would have caught it the first time.
 *
 * These are not extra coverage; each is a lens finding that no existing case
 * exercised, grouped by the finding it closes:
 *
 *   (n) the PR-number extractor against BOTH forges and a malformed value. The
 *       suite drove one hardcoded GitHub URL, so a GitLab `/-/merge_requests/77`
 *       form returning `undefined` — and a bad value throwing a `TypeError` out
 *       of the step — were both invisible.
 *
 *   (o) `openFromPass`'s `adversarialRounds` branch. Every adversarial stub set
 *       `loopOutcome` only, so the arm that reads the loop's own per-round
 *       records never ran: the records, not the prose, decide what a pass left
 *       open, and that was untested in both directions.
 *
 *   (p) the no-progress break. A fixer that commits nothing used to leave the
 *       step paying to re-review a commit identical to the one it just reviewed.
 *
 *   (q) H5 — the adversarial gate's cost row is attributed to the role the loop
 *       SYNTHESISES, which is the only role the frozen driver's own events carry
 *       and so the only one lean's `byRole` column can be compared against.
 *
 *   (w) a row count BEYOND the loader cap, driven through `errorOutcome`: what
 *       the recording path keeps, drops, and survives a second pass with.
 *
 * The cases that create a worktree on disk — the fixer's write fence, the tree's
 * name, the reset and the re-provision — live in `test-lean-review-tree.ts`.
 * This file folds values and drives gates; it never asks git to make a tree. The
 * split is the size ratchet's, but the seam is real: a tree case fails for a
 * reason a fold case cannot produce.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/lean/config.ts";
import { errorOutcome } from "../src/lean/error-outcome.ts";
import { FIX_RUN_ID_SHAPE, prNumberFromLog, reviewAttemptFromLog } from "../src/lean/review-log.ts";
import { fixTreeName } from "../src/lean/review-tree.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  DISPATCHES_MAX_ROWS,
  FIXER_ROLE,
  LENS_ROLE,
  MAX_REVIEW_ROUNDS,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixRunId,
  git,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (n) the PR-number extractor, driven against both forges and a bad value ──
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const withUrl = (prUrl: string | undefined): number | undefined => {
    const ctx = ctxFor(repoRoot, baseSha, BRANCH);
    ctx.run.steps.push({
      key: "7:publish:0",
      state: "publish",
      startedAt: 1,
      endedAt: 2,
      outcome: { kind: "ok", ...(prUrl === undefined ? {} : { prUrl }) },
    });
    return prNumberFromLog(ctx.steps);
  };
  // The fixture previously drove ONE hardcoded GitHub URL, which is how a
  // GitLab-shaped URL — the other forge this harness publishes to — could read as
  // `undefined` while every lean run paid a `gh pr list` per ISSUES_FOUND round.
  assert(
    withUrl("https://github.com/acme/widget/pull/321") === 321,
    "(n) GitHub's /pull/<n> reads as its number",
  );
  assert(
    withUrl("https://gitlab.example.com/grp/sub/-/merge_requests/77") === 77,
    "(n) GitLab's /-/merge_requests/<n> reads as its number too — the shape the old fixture never drove",
  );
  assert(
    withUrl("https://github.com/acme/widget/pull/321/") === 321,
    "(n) a trailing slash is still the same PR",
  );
  // Anchored at the end, so a tail that is not the number is not a number.
  assert(
    withUrl("https://gitlab.example.com/grp/-/merge_requests/77/diffs") === undefined,
    "(n) a URL whose tail is not the number answers ABSENT rather than reporting some other digit",
  );
  // The throw the unguarded `new URL()` produced out of the step.
  let threw = false;
  let value: number | undefined = 1;
  try {
    value = withUrl("not a url at all");
  } catch {
    threw = true;
  }
  assert(!threw, "(n) a malformed PR URL does not throw out of the step");
  assert(
    value === undefined,
    "(n) and it answers absent, the review layer's own look-it-up signal",
  );
  assert(withUrl("https://") === undefined, "(n) a URL with no path answers absent");
  assert(withUrl(undefined) === undefined, "(n) no recorded PR answers absent");
  // Absence is decided by the shared `validPrUrl` gate, so a non-https URL cannot
  // produce a number by any path.
  assert(
    withUrl("http://github.com/acme/widget/pull/321") === undefined,
    "(n) an http (non-https) URL is refused by the shared `validPrUrl` gate, so it yields no number",
  );
}

// ── (o) openFromPass: both shapes the branch distinguishes ──────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const seen: string[] = [];
  let fixerCommits = 0;
  /**
   * The one way a findings-carrying pass reaches the lens round: the step fixes
   * first and comes back around, so the fixture's fixer MUST commit. A fixer that
   * commits nothing is refused by the no-progress break (case (p)), which is the
   * right product behaviour and the wrong way to reach a second round — an earlier
   * version of these cases did exactly that and "proved" the carry never happens,
   * which was a property of the stub rather than of the step.
   */
  const committing = async (spec: DispatchSpec) => {
    const wt = spec.cwd as string;
    put(wt, `fix-${String(fixerCommits++)}.ts`, "export const x = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: the finding");
    return result({ role: FIXER_ROLE });
  };
  let advCalls = 0;
  const runWithAdv = async (over: Partial<DispatchResult>) => {
    seen.length = 0;
    advCalls = 0;
    // The findings text is FIXED for a given case, not varied per call. The step
    // now refuses to re-buy findings it already asked a fixer to fix
    // (`stagnantAgainstFix`), so a stub that varied its text each call would
    // never converge and the run would loop to the round cap. What has to vary
    // for THIS case is whether the carry reached the lens round, and that is read
    // from `seen`, not from the gate's prose.
    return run(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        // Varied per call for the same reason the lens findings vary in
        // `test-lean-review-wiring.ts`: a gate that re-reports identical text
        // against a head the fixer moved is a deterministic gate the step now
        // refuses to buy again (`stagnantAgainstFix`), which would end the run
        // before the carry this case is about ever reached a lens round.
        adversarial: async () =>
          advCalls++ === 0 ? result(over) : result({ loopOutcome: "approved" }),
        lens: async (a) => {
          seen.push(a.context);
          return cleanLensRound();
        },
        dispatch: committing,
      }),
    );
  };

  // (o1) A trailing record that is NOT approved: findings, whatever the prose
  // says. The text deliberately does not contain the marker, so the old prose
  // fallback would have called this a clean pass.
  const o1 = await runWithAdv({
    loopOutcome: "approved",
    text: "Reviewed and it is fine.",
    adversarialRounds: [
      { round: 1, status: "ISSUES_FOUND", verdictParsed: true },
      { round: 2, status: "MINOR_OBSERVATIONS", verdictParsed: true },
    ],
  });
  assert(
    o1.threw === undefined && o1.outcome?.kind === "done",
    `(o1) the round still clears once the gate is happy (${o1.threw?.message})`,
  );
  assert(
    seen.length >= 1 && seen[0]!.includes("OUTSTANDING FROM THE ADVERSARIAL GATE"),
    "(o1) and the non-APPROVED trailing record reached the lens context — decided by the RECORD, not the prose, which never said PASSED WITH FINDINGS",
  );

  // (o2) Records beat prose in the other direction too.
  const o2 = await runWithAdv({
    loopOutcome: "approved",
    text: "Adversarial PASSED WITH FINDINGS after round 1 but the last round was clean.",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  });
  assert(
    o2.threw === undefined && o2.outcome?.kind === "done",
    `(o2) an APPROVED trailing record clears (${o2.threw?.message})`,
  );
  assert(
    seen.length >= 1 && !seen[0]!.includes("OUTSTANDING FROM THE ADVERSARIAL GATE"),
    "(o2) and nothing is carried forward on an APPROVED record, even though the prose holds the findings marker",
  );

  // (o3) A trailing record the loop never acted on: `verdictParsed: false` means
  // the status was DEFAULTED, which is not a status an adversarial gate approved
  // with — so it must count as outstanding rather than as silence.
  const o3 = await runWithAdv({
    loopOutcome: "approved",
    text: "1. a real finding the reviewer failed to parse",
    adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: false }],
  });
  assert(
    o3.threw === undefined && o3.outcome?.kind === "done",
    `(o3) the step does not throw on an unparsed trailing record (${o3.threw?.message})`,
  );
  assert(
    seen.length >= 1 && seen[0]!.includes("a real finding"),
    "(o3) and the unparsed trailing record still counts as outstanding — a defaulted status is not an approval",
  );

  // (o4) No records at all: the prose marker is the only thing left to read.
  const o4 = await runWithAdv({
    loopOutcome: "approved",
    text: "Adversarial PASSED WITH FINDINGS: 2. the carried one",
  });
  assert(
    o4.threw === undefined && seen.length >= 1 && seen[0]!.includes("the carried one"),
    "(o4) with no records at all, the prose marker is what carries the findings",
  );

  // (o5) T6 — the carried block reaches the round that CONSUMES it. The findings
  // arm fixes first and comes back around, so `carried` has to survive the
  // `continue`: assigned on one branch and read only on the other made the
  // parameter dead on the path that used it.
  const carriedSeen: (string | undefined)[] = [];
  // o5's OWN counter, not the `advCalls` the cases above share: `runWithAdv`
  // resets that one to 0 on every call, so a case reusing it would start its
  // first gate call at a count the previous case left behind and take the wrong
  // arm — the lens would run at round 1 and the carry would never be exercised.
  let advO5 = 0;
  const o5 = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => {
        advO5++;
        // Round 1 refuses; round 2 clears the gate. The findings the FIRST round
        // asked for are what the fixer answers, and the second round's refusal
        // text must DIFFER from the first or `stagnantAgainstFix` fires on the
        // re-review — which is the step refusing to re-buy identical findings, not
        // a bug in the carry this case is about.
        return advO5 === 1
          ? result({ loopOutcome: "rejected", text: "1. the finding the fixer will answer" })
          : // Round 2 PASSES the gate. Its trailing record must be APPROVED: a
            // non-blocking record would make `openFromPass` hand its own text back
            // as findings, the step would fix them, and the fixer would run a
            // second time — which is correct behaviour, but it moves the round the
            // lens first runs to round 3 and overwrites `carried` with the gate's
            // second text. This case is about ONE carry surviving ONE fix into the
            // next lens round, so the gate asks once and then clears.
            result({
              loopOutcome: "approved",
              text: "",
              adversarialRounds: [{ round: 2, status: "APPROVED", verdictParsed: true }],
            });
      },
      lens: async (a) => {
        carriedSeen.push(a.context);
        return cleanLensRound();
      },
      dispatch: committing,
    }),
  );
  assert(
    o5.threw === undefined && o5.outcome?.kind === "done",
    `(o5) the fix round and the re-review both ran (${o5.threw?.message})`,
  );
  // The findings arm FIXES first and comes back around, so the arm that CONSUMES
  // `carried` is the NEXT round's, and it is the FIRST round whose lens actually
  // ran — the round that refuses never reaches a lens at all. Finding the carry on
  // any lens round after a fix round is the property; the original defect was that
  // the assignment did not survive the `continue`, which is what this proves it now
  // does. Asserting a specific round number would pin the fixture's shape rather
  // than the step's behaviour.
  const carriedAny = carriedSeen.filter((c): c is string => c !== undefined);
  assert(
    carriedAny.length >= 1 &&
      carriedAny.some((c) => c.includes("the finding the fixer will answer")),
    `(o5) a lens round after the fix carries the adversarial gate's findings, surviving the fix and the continue (lens rounds ran ${String(carriedSeen.length)}x, ${String(carriedAny.length)} carried: ${JSON.stringify(carriedAny[0]?.slice(0, 90))})`,
  );
}

// ── (p) the no-progress break ───────────────────────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const head = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      // CONSTANT findings, deliberately: this case IS the no-progress break. The
      // fixer is dispatched, paid for, and commits nothing, so `assertFixAdvanced`
      // refuses the round before stagnation is ever consulted. A converging stub
      // here would test the fixture instead of the break.
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      // Dispatched, paid for, commits NOTHING. The step would otherwise pay to
      // re-review the identical commit, once per round of the bound.
      dispatch: async () => result({ role: FIXER_ROLE }),
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /fixed nothing/.test(threw.message),
    `(p) a fix round that left the head unchanged is a throw, not a re-review (${threw?.message})`,
  );
  assert(
    threw instanceof ReviewInfraError && threw.message.includes(head.slice(0, 12)),
    `(p) and it names the sha it refused to re-review (${threw?.message})`,
  );
  assert(
    threw instanceof ReviewInfraError && threw.dispatches.length > 0,
    "(p) and the children it did pay for are still on the error",
  );
}

// ── (q) H5: the row's role, asserted rather than agreed with ────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The loop's synthesised role — NOT the inner reviewer's — is what the frozen
  // driver's own dispatch events carry, so it is the only value that makes the
  // two engines' `byRole` columns comparable.
  assert(
    ADVERSARIAL_GATE_ROLE === "adversarial-loop",
    `(q) the constant names the loop's SYNTHESISED role, not the reviewer's (got ${ADVERSARIAL_GATE_ROLE})`,
  );
  const { outcome } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ role: "adversarial-developer", loopOutcome: "approved" }),
    }),
  );
  const roles = (outcome?.dispatches ?? []).map((r) => r.role);
  assert(
    roles.includes("adversarial-developer") && !roles.includes(ADVERSARIAL_GATE_ROLE),
    `(q) the row records what the child actually reported — a mis-attributed role stays visible in the record instead of being silently rewritten (${JSON.stringify(roles)})`,
  );
}


cleanupRoots();
process.exit(failures());

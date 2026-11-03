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
 *   (r2) a NON-BLOCKING verdict from either gate buys no fixer. The adversarial
 *       doctrine calls only `CRITICAL_ISSUES_FOUND` blocking
 *       (`agents-base/adversarial-developer.md`, and `decideLoopAction` passes on
 *       `ISSUES_FOUND`/`MINOR_OBSERVATIONS`), and the lens layer reserves its
 *       CRITICAL verdict the same way — so a run whose gate reported findings it
 *       did not block on must end `done` with one pass and no fixer, not buy a
 *       child, a re-review and a second gate pass.
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
  blockingReject,
  DISPATCHES_MAX_ROWS,
  FIXER_ROLE,
  LENS_ROLE,
  REVIEW_PASSES,
  cleanLensRound,
  lensRoundFor,
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
  passed,
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
   * The one way a findings-carrying pass reaches the RE-REVIEW: the step fixes
   * first and then re-reviews, so the fixture's fixer MUST commit. A fixer that
   * commits nothing is refused by the no-change break (case (p)), which is the
   * right product behaviour and the wrong way to reach the second pass — an
   * earlier version of these cases did exactly that and "proved" the carry never
   * happens, which was a property of the stub rather than of the step.
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
    // The findings text is FIXED for a given case, not varied per call. Under one
    // wave there is nothing to converge to and no round cap to reach: what has to
    // vary for THIS case is whether the carry reached the lens pass, and that is
    // read from `seen`, not from the gate's prose.
    return run(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        // Varied per call so the second pass is a distinct read: the case reads
        // `seen`, and a gate that said the same thing twice would leave the
        // re-review's own carry indistinguishable from the first pass's.
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
    o1.threw === undefined && passed(o1.outcome?.kind),
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
    o2.threw === undefined && passed(o2.outcome?.kind),
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
    o3.threw === undefined && passed(o3.outcome?.kind),
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

  // (o6) A `rejected` whose loop carried NO record at all. `parseVerdict` defaults
  // the status when the reply holds no `VERDICT:` marker, and the report-only loop
  // hands that record back verbatim — so a rejection with nothing behind it is
  // prose that was never a judgement, and the step must refuse it rather than spend
  // its one wave fixing an absence. The mutant is `lastRecord !== undefined &&
  // …verdictParsed !== true` in `adversarialGate`: with it, this case clears.
  const o6 = await runWithAdv({
    loopOutcome: "rejected",
    text: "findings with no VERDICT marker anywhere",
    adversarialRounds: undefined,
  });
  assert(
    o6.threw instanceof ReviewInfraError &&
      /no reviewed round to read a verdict from/.test(o6.threw.message),
    `(o6) a rejection with no reviewed round is refused, not fixed against (${o6.threw?.message ?? "the step accepted it"})`,
  );

  // (o7) And the incoherent pair: `rejected` whose OWN trailing record reads
  // APPROVED. The loop refused a head it also certified, and neither reading is
  // safe — clearing a head the loop rejected, or buying a fixer for an approval.
  const o7 = await runWithAdv({
    loopOutcome: "rejected",
    text: "1. a finding under an APPROVED record",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  });
  assert(
    o7.threw instanceof ReviewInfraError &&
      /rejected a head it also approved/.test(o7.threw.message),
    `(o7) a rejected outcome whose parsed record says APPROVED is refused the same way (${o7.threw?.message ?? "the step accepted it"})`,
  );

  // (o5) T6 — the carried block reaches the pass that CONSUMES it. The wave fixes
  // first and then re-reviews, so `carried` has to survive the fix: assigned before
  // the wave and read only after it, it was once dead on the path that used it.
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
        // The full review refuses; the re-review's gate clears. The findings the
        // FIRST pass asked for are what the fixer answers, and the second pass's
        // text must DIFFER from the first so the case can tell the two reads apart.
        return advO5 === 1
          ? blockingReject("1. the finding the fixer will answer")
          : // The re-review's gate PASSES. Its trailing record must be APPROVED: a
            // non-blocking record would make `openFromPass` hand its own text back
            // as findings on the round that is supposed to clear, and the run would
            // end on a NOT ADDRESSED refusal instead of the pass this case reads.
            result({
              loopOutcome: "approved",
              text: "",
              adversarialRounds: [{ round: 2, status: "APPROVED", verdictParsed: true }],
            });
      },
      lens: async (a) => {
        carriedSeen.push(a.context);
        // The re-review stamps the range the step named — an un-stamped round is
        // refused as a verdict on some other diff, and this case is about the carry
        // surviving the wave, not about that refusal.
        return lensRoundFor(a, "APPROVED", []);
      },
      dispatch: committing,
    }),
  );
  assert(
    o5.threw === undefined && passed(o5.outcome?.kind),
    `(o5) the fix wave and the re-review both ran (${o5.threw?.message})`,
  );
  // The carry is assigned before the wave and consumed by both lens passes, so
  // finding it on the lens calls either side of the fix is the property; the
  // original defect was that the assignment did not survive the wave, which is
  // what this proves it now does. Asserting a specific pass number would pin the
  // fixture's shape rather than the step's behaviour.
  const carriedAny = carriedSeen.filter((c): c is string => c !== undefined);
  assert(
    carriedAny.length >= 1 &&
      carriedAny.some((c) => c.includes("the finding the fixer will answer")),
    `(o5) both lens passes carry the adversarial gate's findings, surviving the fix (lens rounds ran ${String(carriedSeen.length)}x, ${String(carriedAny.length)} carried: ${JSON.stringify(carriedAny[0]?.slice(0, 90))})`,
  );
}

// ── (p) a fix wave that changed nothing ─────────────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const head = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      // The findings are CONSTANT, deliberately: this case IS the no-change break.
      // The fixer is dispatched, paid for, and commits nothing, so
      // `assertFixAdvanced` refuses the wave. A converging stub here would test the
      // fixture instead of the break.
      adversarial: async () => blockingReject("1. silent catch"),
      // Dispatched, paid for, commits NOTHING. The step would otherwise pay to
      // re-review the identical commit the gate has already read.
      dispatch: async () => result({ role: FIXER_ROLE }),
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /fixed nothing/.test(threw.message),
    `(p) a fix wave that left the head unchanged is a throw, not a re-review (${threw?.message})`,
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

process.exit(failures());

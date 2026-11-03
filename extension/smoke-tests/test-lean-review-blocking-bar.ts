#!/usr/bin/env bun
/**
 * lean/review — the step's BLOCKING BAR: only a blocking verdict buys a wave.
 *
 * Split from `test-lean-review-consolidation.ts` by the 500-line cap (AGENTS.md
 * §12), along the seam that file's own case groups describe: everything there
 * folds values and drives gates the step already agreed with, and everything here
 * drives the one question the step's cost turns on — whether a given verdict is a
 * demand for a fixer. The seam is real, not convenient: a bar case fails for a
 * reason a fold case cannot produce.
 *
 * Both reviewing layers' doctrine says the same thing in different words: only the
 * CRITICAL verdict blocks. `agents-base/adversarial-developer.md` calls
 * `ISSUES_FOUND` "Should address, not blocking" and `MINOR_OBSERVATIONS`
 * "Non-blocking, author's discretion", and `decideLoopAction` passes on both at the
 * terminal round; the lens layer's `computeVerdict` reserves
 * `CRITICAL_ISSUES_FOUND` and reaches `ISSUES_FOUND` for anything merely at or
 * above the project's bar. A step that paid a fixer for those findings was paying
 * for a child, a re-review and a second gate pass against findings the reviewing
 * layer itself declined to block on, and the disclosure path that already exists
 * for them — the layer's residual post — said nothing about the extra wave.
 *
 * Both gates are driven, because the two arms read their bar from different places
 * and each broke separately: the adversarial arm's bar is the trailing record's
 * status, the lens arm's is the round's verdict. And the blocking direction is
 * driven too — without it every non-blocking assertion here is also satisfied by a
 * step that never fixes anything.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  FIXER_ROLE,
  PASS_ROWS,
  blockingFinding,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  lensRoundWith,
  makeRepo,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();
// ── (r2) a NON-BLOCKING verdict buys no fixer, from EITHER gate ─────────────
//
// Both roles' doctrine says the same thing in different words: only the CRITICAL
// verdict blocks. `agents-base/adversarial-developer.md` calls `ISSUES_FOUND`
// "Should address, not blocking" and `MINOR_OBSERVATIONS` "Non-blocking, author's
// discretion", and `decideLoopAction` passes on both at the terminal round; the
// lens layer's `computeVerdict` reserves `CRITICAL_ISSUES_FOUND` and reaches
// `ISSUES_FOUND` for anything merely at or above the project's bar. A step that
// paid a fixer for those findings was paying for a child, a re-review and a second
// gate pass against findings the reviewing layer itself declined to block on, and
// the disclosure path that already exists for them — the layer's residual post —
// said nothing about the extra wave.
//
// Both gates are driven, because the two arms read their bar from different places
// and each broke separately: the adversarial arm's bar is the trailing record's
// status, the lens arm's is the round's verdict.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 7;\n" });

  // A gate that reports findings WITHOUT blocking. The shape is the loop's own:
  // `decideLoopAction` returns `pass` for every status but `CRITICAL_ISSUES_FOUND`
  // at the terminal round, `synthesizeResult` buckets a pass as
  // `loopOutcome: "approved"`, and `passedRoundText` writes
  // `Adversarial PASSED WITH FINDINGS … (verdict: ${status} — non-blocking per
  // agents-base/adversarial-developer.md)`. The trailing record is what
  // `openFromPass` reads, so both are stated — and the record, not the prose, is
  // what makes the disclosure assertion below a fact about the step rather than an
  // artefact of the stub's wording.
  const nonBlockingGate = async () =>
    result({
      loopOutcome: "approved",
      text: "Adversarial PASSED WITH FINDINGS after round 1 (verdict: MINOR_OBSERVATIONS — non-blocking per agents-base/adversarial-developer.md)\n\n1. a finding the reviewer reported without blocking",
      adversarialRounds: [{ round: 1, status: "MINOR_OBSERVATIONS", verdictParsed: true }],
    });

  // The same pass, blocking: the loop's `rejected` arm off a CRITICAL record. The
  // pair is the point — one word of the reviewer's verdict is all that separates a
  // step that pays for a wave from one that ends clean, and both are driven here
  // so the rule cannot be satisfied by a stub that only ever says the easy thing.

  // (r2a) adversarial non-blocking + clean lenses → `done`, one pass, zero fixers.
  let r2AdvCalls = 0;
  let r2LensRounds = 0;
  let r2Fixers = 0;
  const r2LensSeen: string[] = [];
  const r2a = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => {
        r2AdvCalls++;
        return nonBlockingGate();
      },
      lens: async (a) => {
        r2LensRounds++;
        r2LensSeen.push(a.context ?? "");
        return cleanLensRound();
      },
      // Counts the dispatch and commits: a fixer that DID its job is the stub that
      // proves the step chose not to buy one, rather than one that bought a fixer
      // which then failed to advance the head.
      dispatch: async (spec: DispatchSpec) => {
        r2Fixers++;
        const wt = spec.cwd as string;
        put(wt, `r2-fix-${String(r2Fixers)}.ts`, "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: r2");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    r2a.threw === undefined && r2a.outcome?.kind === "done",
    `(r2a) an adversarial ISSUES_FOUND with clean lenses ENDS done — non-blocking is not a wave (${r2a.threw?.message ?? `kind ${String(r2a.outcome?.kind)}`})`,
  );
  // THE MEASURED COUNTS. Exact equalities, not `<=`: the regression this case
  // exists to catch is the step buying one more child than the gate's own verdict
  // asked for, and a `<=` would let a second pass through. `advCalls` and `fixers`
  // are read off the STUBS rather than off `dispatches` because a child this step
  // has no business buying is a child whose row should not exist either: counting
  // the dispatch catches "it ran", and the rows catch "it paid for it and billed
  // the run" — a step that dispatched a fixer and dropped its row passes the first
  // and fails the second.
  assert(
    r2Fixers === 0 && (r2a.outcome?.dispatches ?? []).some((r) => r.role === FIXER_ROLE) === false,
    `(r2a) and it dispatched ZERO fixers — no child, so no commit, so no re-review (dispatch called ${String(r2Fixers)}x, fixer rows ${String((r2a.outcome?.dispatches ?? []).filter((r) => r.role === FIXER_ROLE).length)})`,
  );
  assert(
    r2LensRounds === 1 &&
      r2AdvCalls === 1 &&
      (r2a.outcome?.dispatches ?? []).filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length === 1,
    `(r2a) and ONE pass of each gate, not the wave's two — the re-review exists to judge a fix, and no fix ran (${String(r2LensRounds)} lens, ${String(r2AdvCalls)} adv)`,
  );
  assert(
    (r2a.outcome?.dispatches ?? []).length === PASS_ROWS,
    `(r2a) and the cost record is one pass's worth — ${String(PASS_ROWS)} rows, one gate and six lenses (got ${String((r2a.outcome?.dispatches ?? []).length)})`,
  );
  // The findings are not dropped on the floor: they travel to the lenses, which is
  // the disclosure the frozen driver's own loop makes for a pass-with-findings
  // (`work-driver-adversarial.ts`, `adversarial-findings.ts`), and the pass reason
  // says what the round actually reported instead of claiming nothing was.
  assert(
    r2LensSeen.some((c) => c.includes("a finding the reviewer reported without blocking")),
    `(r2a) and the non-blocking findings still reach the lenses — non-blocking is not the same as discarded (${JSON.stringify(r2LensSeen[0]?.slice(0, 80))})`,
  );
  assert(
    r2a.outcome?.reason?.includes("APPROVED") === true,
    `(r2a) and the reason names the round's own verdict, so the operator can see what was reported and left unfixed (${r2a.outcome?.reason})`,
  );

  // (r2b) the lens arm: an ISSUES_FOUND round whose rows sit BELOW the project's
  // bar. That is exactly what the layer's own `ISSUES_FOUND` verdict means, and
  // `reported` holds only the BLOCKING half post-advisory-split — so an empty
  // `reported` beside the verdict is the production shape, not a fixture invention
  // (`work-driver-lens-verdicts.ts` #456: `computeVerdict` partitions, it does not
  // filter, and the advisory half goes to the residual disclosure).
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 8;\n" });
  let r2bLensRounds = 0;
  let r2bFixers = 0;
  const r2b = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => {
        r2bLensRounds++;
        return {
          ...cleanLensRound(),
          verdict: "ISSUES_FOUND" as const,
          findings: "- [LOW] SIMPLICITY a.ts:1: naming",
          reported: [],
        };
      },
      dispatch: async (spec: DispatchSpec) => {
        r2bFixers++;
        const wt = spec.cwd as string;
        put(wt, `r2b-fix-${String(r2bFixers)}.ts`, "export const x = 2;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: r2b");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    r2b.threw === undefined && r2b.outcome?.kind === "done",
    `(r2b) a lens ISSUES_FOUND at the project's bar ENDS done, and a CRITICAL round still does not (${r2b.threw?.message ?? `kind ${String(r2b.outcome?.kind)}`})`,
  );
  assert(
    r2bFixers === 0,
    `(r2b) and the lens arm buys no fixer for non-blocking rows either (${String(r2bFixers)} fixer dispatches)`,
  );

  // (r2c) the bar still blocks: a CRITICAL lens round on the SAME fixture must
  // still buy its fixer. Without this half the two cases above are satisfied by a
  // step that never fixes anything, which is the opposite defect and invisible.
  const { repoRoot: rr3, baseSha: bs3 } = makeRepo();
  await setup({ repoRoot: rr3, baseSha: bs3, branch: BRANCH, feature: "export const f = 9;\n" });
  let r2cFixers = 0;
  let r2cLensRounds = 0;
  const r2c = await run(
    ctxFor(rr3, bs3, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => {
        r2cLensRounds++;
        // The full round raises a blocking row; the re-review of the fix reports
        // none of them, which is the layer's resolve and the step's ADDRESSED.
        return r2cLensRounds === 1
          ? lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()])
          : cleanLensRound();
      },
      dispatch: async (spec: DispatchSpec) => {
        r2cFixers++;
        const wt = spec.cwd as string;
        put(wt, `r2c-fix-${String(r2cFixers)}.ts`, "export const x = 3;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: r2c");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    r2c.threw === undefined && r2c.outcome?.kind === "fixed",
    `(r2c) a CRITICAL round still buys its fixer and re-reviews — the relaxation is scoped to non-blocking, not to the step's whole ability to fix (${r2c.threw?.message ?? `kind ${String(r2c.outcome?.kind)}`})`,
  );
  // (r2a′) THE PAIR: the same step, the same lens round, the blocking verdict —
  // and the wave IS bought. Without this half, every assertion above is also
  // satisfied by a step that never fixes anything, which is a different defect and
  // invisible to them.
  let r2aPrimeFixers = 0;
  let r2aPrimeAdvCalls = 0;
  const r2aPrime = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => {
        r2aPrimeAdvCalls++;
        // The full pass blocks; the re-review's pass clears, as the wave requires.
        return r2aPrimeAdvCalls === 1
          ? result({
              loopOutcome: "rejected",
              text: "1. a finding the reviewer blocked on",
              adversarialRounds: [
                { round: 1, status: "CRITICAL_ISSUES_FOUND", verdictParsed: true },
              ],
            })
          : result({
              loopOutcome: "approved",
              text: "",
              adversarialRounds: [{ round: 2, status: "APPROVED", verdictParsed: true }],
            });
      },
      lens: async () => cleanLensRound(),
      dispatch: async (spec: DispatchSpec) => {
        r2aPrimeFixers++;
        const wt = spec.cwd as string;
        put(wt, `r2a-prime-${String(r2aPrimeFixers)}.ts`, "export const x = 4;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: r2a prime");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    r2aPrime.threw === undefined && r2aPrime.outcome?.kind === "fixed" && r2aPrimeFixers === 1,
    `(r2a′) and the blocking verdict does buy its one fixer and its re-review — the relaxation is scoped to non-blocking, not to the step's ability to fix (${r2aPrime.threw?.message ?? `kind ${String(r2aPrime.outcome?.kind)}, ${String(r2aPrimeFixers)} fixers`})`,
  );
}

cleanupRoots();
process.exit(failures());

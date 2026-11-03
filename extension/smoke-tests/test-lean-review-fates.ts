#!/usr/bin/env bun
/**
 * lean/review — what the review layer's own judgements are allowed to decide.
 *
 * Split from `test-lean-review-wiring.ts` along the seam that file already drew:
 * wiring is about *plumbing* (which commit each gate read, which rows get billed,
 * what a fixer is dispatched with). This file is about the step's **decision
 * procedure** — the rules that turn a round's report into "clears" or "hands back",
 * and the four ways a wrong reading of a report becomes a wrong outcome:
 *
 *   (b3/b4/b5) every way a round does not run is refused on BOTH passes. The step
 *       has only clean passes as exits, so an incomplete re-review that is not
 *       thrown is certified, and its silence read back as the fixer having answered
 *       everything. Both `assertRan` arms and the did-not-run bar, second round.
 *
 *   (h) a blocking row is ADDRESSED only on the layer's own resolve notice. The old
 *       rule read "the delta round did not re-report it" as addressed, so a row
 *       vanished by every route that was not a resolve, and the wave passed on no
 *       evidence. Silence is not an answer, in either direction.
 *
 *   (i) a fresh row is attributed to the fix only at CRITICAL severity. Below that
 *       it is disclosed on the reason, because a report-only finding is not a demand
 *       and the step must not hand a run back for a HIGH the layer would disclose.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  CAUSE_NEW_CRITICAL,
  CAUSE_NOT_ADDRESSED,
  type ReviewDeps,
  ReviewInfraError,
  blockingFinding,
  blockingReject,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  passed,
  resolvedLensRound,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// (b3) The SAME bar on the SECOND pass. Both arrows out of the step are clean
// passes, so a re-review that did not complete has no route except a throw: if
// only the first round is checked, an incomplete re-review falls through the
// "nothing outstanding" branch and its missing verdict is read as the fixer having
// answered everything. The mutant is `assertRan(reReview, rows)` deleted from the
// re-review — a change that leaves every other assertion in this file green.
const { repoRoot: rr3, baseSha: bs3 } = makeRepo();
await setup({ repoRoot: rr3, baseSha: bs3, branch: BRANCH, feature: "export const f = 16;\n" });
const { threw: t3b } = await run(
  ctxFor(rr3, bs3, BRANCH),
  depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async (a) =>
      a.wave === "fix"
        ? { ...resolvedLensRound(a, [blockingFinding()]), verdict: "REVIEW_INCOMPLETE" }
        : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
    dispatch: fixerThatCommits("b3"),
  }),
);
assert(
  t3b instanceof ReviewInfraError && /re-review of the fix did not complete/.test(t3b.message),
  `(b3) an incomplete RE-review throws rather than certifying the fix (${t3b?.message ?? "the step passed on a round that never finished"})`,
);

// (b4) The other way a round does not run: `noReview`. A re-review that ran no
// lens — because nothing appeared to change in its range — reports an ordinary
// verdict with nothing behind it, and the step must refuse it exactly as it
// refuses the first round's. Both passes get the same check because both
// conclusions are the same shape: "nothing outstanding", arrived at by nobody.
const { repoRoot: rr4, baseSha: bs4 } = makeRepo();
await setup({ repoRoot: rr4, baseSha: bs4, branch: BRANCH, feature: "export const f = 17;\n" });
const { threw: t4b } = await run(
  ctxFor(rr4, bs4, BRANCH),
  depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async (a) =>
      a.wave === "fix"
        ? { ...resolvedLensRound(a, [blockingFinding()]), noReview: true }
        : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
    dispatch: fixerThatCommits("b4"),
  }),
);
assert(
  t4b instanceof ReviewInfraError && /ran no lens/.test(t4b.message),
  `(b4) a re-review that ran no lens is refused, not read as the fixer having answered everything (${t4b?.message ?? "the step passed on an empty round"})`,
);

// (b5) And the arm that cannot be reached any other way: `usage` absent. Same
// reasoning, different field — the layer can report a verdict while its lens
// children reported nothing, and an absent usage is not a zero-cost pass.
const { repoRoot: rr5, baseSha: bs5 } = makeRepo();
await setup({ repoRoot: rr5, baseSha: bs5, branch: BRANCH, feature: "export const f = 18;\n" });
const { threw: t5b } = await run(
  ctxFor(rr5, bs5, BRANCH),
  depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async (a) => {
      const round =
        a.wave === "fix"
          ? resolvedLensRound(a, [blockingFinding()])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]);
      // The `usage` field is what `assertRan` reads, so the stub has to produce a
      // round without it — built as an object literal that never sets it rather
      // than by deleting one from a complete round.
      if (a.wave !== "fix") return round;
      const { usage: _usage, ...withoutUsage } = round;
      return { ...withoutUsage, usage: undefined } as unknown as typeof round;
    },
    dispatch: fixerThatCommits("b5"),
  }),
);
assert(
  t5b instanceof ReviewInfraError && /no usage from any lens child/.test(t5b.message),
  `(b5) a re-review reporting a verdict with no usage behind it is refused (${t5b?.message ?? "the step passed on free work"})`,
);

// ── (h) SILENCE IS NOT AN ANSWER: a blocking row the re-review never mentions ─
//
// The old rule read "the delta round did not re-report it" as ADDRESSED, so a row
// vanished by every route that was not a resolve — a round that dropped it, an
// advisory discount, a lens that failed to see it — and the wave passed on no
// evidence at all. The rule now: ADDRESSED requires the layer's OWN resolved notice
// for that row. A row absent from `reported` AND from `resolved` is NOT ADDRESSED,
// and the step fails closed. The mutant that proves this is `fate: "addressed"` in
// `classifyFates`' not-re-reported arm: with it, every assertion below goes red.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 8;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => blockingReject("1. the row the wave must answer"),
      // The full round reports a HIGH row; the re-review reports NOTHING and
      // resolves NOTHING — the shape the old code cleared on.
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "APPROVED", [])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h"),
    }),
  );
  // The row itself must appear in the cause: `CAUSE_NOT_ADDRESSED` alone is also
  // produced by the gate's own carried prose, so an assertion on the cause prefix
  // is satisfied by a step that resolved the row in silence. The row's citation is
  // the assertion that separates "refused" from "refused BECAUSE THIS ROW".
  assert(
    threw instanceof ReviewInfraError &&
      threw.message.includes(CAUSE_NOT_ADDRESSED) &&
      /leak/.test(threw.message),
    `(h) a blocking row the re-review neither reported nor resolved is NOT ADDRESSED, not addressed by omission (${threw?.message ?? "the wave passed"})`,
  );
  assert(
    threw instanceof ReviewInfraError && /a\.ts:1/.test(threw.message),
    `(h) and the refusal names the row it refused to clear, so the operator can triage it without the transcript (${threw?.message?.slice(0, 160)})`,
  );

  // The positive control: the SAME wave, with the layer's resolve notice present,
  // passes. Without this half, (h) is satisfied by a step that always refuses.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 9;\n" });
  const { threw: t2, outcome: o2 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      // The lens round carries the blocking verdict, so the wave is bought without
      // the gate also contributing prose that `classifyFates` would render as its
      // own carried row — this case is about ONE row's fate and nothing else.
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? resolvedLensRound(a, [blockingFinding()])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h2"),
    }),
  );
  assert(
    t2 === undefined && o2?.kind === "fixed",
    `(h) and the same wave clears when the layer DOES resolve the row — the rule demands proof, not a refusal to pass (${t2?.message ?? `kind ${String(o2?.kind)}`})`,
  );
}

// ── (i) a fresh row below CRITICAL is disclosure, never a handback ───────────
//
// `new-critical` is the fate that ends the wave on something the fix introduced, so
// it belongs to `severity === "CRITICAL"` alone. The old rule reached it for any
// fresh row, which handed a run back for a HIGH the lenses raised on the fix range —
// a second wave's worth of refusal for a finding the layer itself would disclose.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 10;\n" });
  const { threw, outcome } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? // The row the wave was asked about is resolved; a NEW HIGH row appears
            // in the fix range. Only a CRITICAL may be attributed to the fix.
            {
              ...resolvedLensRound(a, [blockingFinding()]),
              reported: [blockingFinding({ title: "unguarded write", line: 2 })],
            }
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("i"),
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(i) a fresh HIGH in the fix range is disclosed and the wave still clears — only a CRITICAL is a handback (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    outcome?.reason !== undefined && /DISCLOSED/.test(outcome.reason),
    `(i) and the disclosed row is stated on the reason rather than dropped (${outcome?.reason?.slice(0, 180)})`,
  );

  // And the CRITICAL half: the same fixture with the new row at CRITICAL severity
  // must hand back, or (i) is satisfied by a step that discloses everything.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 11;\n" });
  const { threw: t2 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? {
              ...resolvedLensRound(a, [blockingFinding()]),
              reported: [
                blockingFinding({ title: "injected path", line: 2, severity: "CRITICAL" }),
              ],
            }
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("i2"),
    }),
  );
  assert(
    t2 instanceof ReviewInfraError && t2.message.includes(CAUSE_NEW_CRITICAL),
    `(i) and the SAME shape at CRITICAL severity does hand back — the bar is severity, not novelty (${t2?.message ?? "the wave passed"})`,
  );
}

cleanupRoots();
process.exit(failures());

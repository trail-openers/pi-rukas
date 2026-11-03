#!/usr/bin/env bun
/**
 * lean/review — what the review layer's own judgements are allowed to decide.
 *
 * Split from `test-lean-review-wiring.ts` along the seam that file already drew:
 * wiring is about *plumbing* (which commit each gate read, which rows get billed,
 * what a fixer is dispatched with). This file is about the step's **decision
 * procedure** — the rules that turn a round's report into "clears" or "hands back",
 * and the ways a wrong reading of a report becomes a wrong outcome.
 *
 * The step reads ONE thing: the layer's verdict, and the layer's rows. It states
 * no fate of its own about any finding. So the cases below are the three readings
 * that survive, plus the ways each can be gotten wrong:
 *
 *   (b3/b4/b5) every way a round does not run is refused on BOTH passes. The step
 *       has only clean passes as exits, so an incomplete re-review that is not
 *       thrown is certified, and its silence read back as the fixer having answered
 *       everything. Both `assertRan` arms and the did-not-run bar, second round.
 *
 *   (h) a carried row at HIGH or above is NOT ADDRESSED. `carried: true` is the
 *       layer's own refusal to resolve (`rowFate`), so a row that comes back
 *       carrying it is the layer saying the fix did not answer it — and the refusal
 *       names the row. A row the layer DID resolve simply is not in `reported`, and
 *       the same wave then clears.
 *
 *   (h2) an unknown severity on a carried row is blocking, not below the bar: a
 *       row whose severity is missing or outside the four schema values is parsed
 *       model output, and reading it as disclosable is how a malformed row clears a
 *       wave.
 *
 *   (h3) a carried row the advisory split moved OUT of `reported` still hands the
 *       wave back. `splitAdvisory` discounts any finding whose cited line is outside
 *       the PR's changed lines into a tier excluded from the verdict, the counts and
 *       `hasCritical` — so a check that read only `reported` would call the wave
 *       cleared on a row the layer still holds open. The step reads both tiers.
 *
 *   (i) the layer's own CRITICAL verdict on the fix range hands back, and the
 *       handback names the fixer's head and the range — origin is at the fix, so an
 *       operator chasing "where is my work" is pointed at the pushed commits.
 *
 *   (i2) a fresh row BELOW the bar is disclosure, never a handback: the step must
 *       not hand a run back for a LOW the layer itself would disclose.
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
  carriedFinding,
  carriedLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
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
        ? { ...lensRoundFor(a, "APPROVED", []), verdict: "REVIEW_INCOMPLETE" }
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
// verdict with nothing behind it, and the step must refuse it exactly as it refuses
// the first round's. Both passes get the same check because both conclusions are the
// same shape: "nothing outstanding", arrived at by nobody.
const { repoRoot: rr4, baseSha: bs4 } = makeRepo();
await setup({ repoRoot: rr4, baseSha: bs4, branch: BRANCH, feature: "export const f = 17;\n" });
const { threw: t4b } = await run(
  ctxFor(rr4, bs4, BRANCH),
  depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async (a) =>
      a.wave === "fix"
        ? { ...lensRoundFor(a, "APPROVED", []), noReview: true }
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
          ? lensRoundFor(a, "APPROVED", [])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]);
      if (a.wave !== "fix") return round;
      // The `usage` field is what `assertRan` reads, so the stub has to produce a
      // round without it — built as an object literal that never sets it rather
      // than by deleting one from a complete round.
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

// ── (h) a carried row is the layer's NOT ADDRESSED, and the refusal names it ─
//
// `carried: true` on a `reported` row is what the findings store puts on an open row
// `rowFate` refused to resolve — the cited code is unchanged, so the layer is saying
// the fix did not answer it. That marker is the ONLY thing the step reads per row.
// The mutant is the carried test inverted (`!isCarried(f)`): with it, every carried
// row below discloses and the wave passes on the layer's own red.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 8;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      // The full round reports a HIGH row; the re-review re-reports it CARRIED.
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "ISSUES_FOUND", [{ ...blockingFinding(), carried: true } as never])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h"),
    }),
  );
  // The row itself must appear in the cause: `CAUSE_NOT_ADDRESSED` alone is also
  // produced by the re-gate's own CRITICAL record, so an assertion on the cause
  // prefix is satisfied by a step that never looked at the rows. The row's citation
  // is the assertion that separates "refused" from "refused BECAUSE THIS ROW".
  assert(
    threw instanceof ReviewInfraError &&
      threw.message.includes(CAUSE_NOT_ADDRESSED) &&
      /leak/.test(threw.message),
    `(h) a blocking row the re-review carried is NOT ADDRESSED, and the refusal quotes it (${threw?.message ?? "the wave passed"})`,
  );
  assert(
    threw instanceof ReviewInfraError && /a\.ts:1/.test(threw.message),
    `(h) and the refusal names the row's citation, so the operator can triage it without the transcript (${threw?.message?.slice(0, 160)})`,
  );

  // The positive control: the SAME wave, with the layer having resolved the row —
  // which is the row simply absent from `reported` — passes. Without this half, (h)
  // is satisfied by a step that always refuses.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 9;\n" });
  const { threw: t2, outcome: o2 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      // The lens round carries the blocking verdict, so the wave is bought without
      // the gate also contributing prose that would have to be separated from the
      // row's own reading — this case is about ONE row's fate and nothing else.
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "APPROVED", [])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h2"),
    }),
  );
  assert(
    t2 === undefined && o2?.kind === "fixed",
    `(h) and the same wave clears when the layer resolved the row — the step reads the layer's rows, not its own guess (${t2?.message ?? `kind ${String(o2?.kind)}`})`,
  );
}

// ── (h2) an unknown severity on a carried row blocks — it is not "below the bar" ─
//
// A `reported` row is parsed model output. A row whose `severity` is missing or is
// not one of the four schema values has no rank, and a comparison against a missing
// rank is how a malformed row slips under a HIGH bar. Fail closed, the direction
// every other absence in this step goes. The mutant is `rank === undefined ||` in
// `atOrAboveBar`: with it deleted this case goes red.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 19;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "ISSUES_FOUND", [
              {
                ...blockingFinding({ title: "unranked row" }),
                severity: "BLOCKER",
                carried: true,
              } as never,
            ])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h3"),
    }),
  );
  assert(
    threw instanceof ReviewInfraError &&
      threw.message.includes(CAUSE_NOT_ADDRESSED) &&
      /unranked row/.test(threw.message),
    `(h2) a carried row whose severity is not one of the four values is blocking, not disclosable (${threw?.message ?? "the wave passed on a row it could not rank"})`,
  );
}

// The bar itself — a row at one bar and a step that reads another, at the wave and
// at the handback — is `test-lean-review-bar-threshold.ts`, split out along the
// same seam the 500-line cap asked for. The cases here hold the fate rules that do
// not depend on which bar the project named.

// ── (h3) a carried row the ADVISORY split moved out of `reported` still hands back ─
//
// `splitAdvisory` (#1140/#1125) discounts every finding whose cited line sits
// outside the PR's changed lines into a tier the verdict, the severity counts and
// the ledger's `hasCritical` all ignore. It discounts CARRIED rows too — so a
// carried HIGH can be absent from `reported` while the findings store still holds it
// open, and a NOT ADDRESSED check that read only `reported` would certify that wave
// clean. That is the discount deciding a question the layer never put to the step:
// the layer said "not addressed", and said it in the tier, not in the tier's
// exclusion. The step reads `isCarried && atOrAboveBar` over both row sets.
//
// Two mutants, both red here and green nowhere else: drop `advisory` from the
// concatenation (the discounted row then clears the wave), or drop the
// `isCarried` test (a fresh advisory row would hand back — see (i2)'s control).
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 20;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      // The re-review reports NOTHING in `reported` and carries the HIGH in the
      // advisory tier — the shape a real `splitAdvisory` produces for a carried row
      // whose cited line fell outside the PR's changed lines.
      lens: async (a) =>
        a.wave === "fix"
          ? carriedLensRound(a, [blockingFinding({ title: "discounted leak" })], {
              intoAdvisory: true,
            })
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h4"),
    }),
  );
  assert(
    threw instanceof ReviewInfraError &&
      threw.message.includes(CAUSE_NOT_ADDRESSED) &&
      /discounted leak/.test(threw.message),
    `(h3) a carried HIGH that sits ONLY in the advisory tier hands the run back, and the refusal quotes it (${threw?.message ?? "the wave cleared on a row the layer still holds open"})`,
  );

  // The control that keeps (h3) from being satisfied by a step that refuses every
  // advisory row: the SAME fixture shape with the row FRESH (not carried) below the
  // bar discloses and clears. Without it, "read both tiers" could be implemented as
  // "block on anything advisory".
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 21;\n" });
  const { threw: t2, outcome: o2 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "APPROVED", [], [
              blockingFinding({ title: "out-of-range note", severity: "MEDIUM" }),
            ])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("h5"),
    }),
  );
  assert(
    t2 === undefined && o2?.kind === "fixed",
    `(h3) and a FRESH advisory row is the layer's to disclose — the step does not block on the tier itself (${t2?.message ?? `kind ${String(o2?.kind)}`})`,
  );
}

// ── (i) the layer's CRITICAL verdict on the fix range hands back, and says where ─
//
// The verdict is the layer's own `computeVerdict` answer over its `reported` rows —
// the step does not recompute it and does not need a row of any particular severity
// to honour it. The mutant is the verdict arm deleted: a CRITICAL re-review then
// falls through to the clean return.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 11;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "CRITICAL_ISSUES_FOUND", [
              blockingFinding({ title: "injected path", line: 2, severity: "CRITICAL" }),
            ])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("i"),
    }),
  );
  assert(
    threw instanceof ReviewInfraError && threw.message.includes(CAUSE_NEW_CRITICAL),
    `(i) the re-review's own CRITICAL verdict hands the run back (${threw?.message ?? "the wave passed"})`,
  );
  // The origin question a handback must answer without a transcript: the fix IS
  // pushed, so origin is at the fixer's head, and the range it sits in is named.
  assert(
    threw instanceof ReviewInfraError &&
      /fixer's head/.test(threw.message) &&
      /\.\./.test(threw.message),
    `(i) and the cause states the fix is pushed and names both SHAs of the fix range, so nobody hunts for unpushed work (${threw?.message?.slice(0, 220)})`,
  );
}

// ── (i2) a fresh row below the bar is disclosure, never a handback ───────────
//
// Only a row the layer itself carried, or the layer's own CRITICAL verdict, ends the
// wave. A fresh LOW on the fix range is a finding the layer discloses through its
// residual post, and a step that handed the run back for it would be holding its own
// bar above the layer's. (LOW is the row's severity and MEDIUM the harness default
// bar: a row at the bar is a demand for the wave, which is (b1) of
// `test-lean-review-bar-threshold.ts`.)
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 10;\n" });
  const { threw, outcome } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "APPROVED", [
              blockingFinding({ title: "unguarded write", line: 2, severity: "LOW" }),
            ])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("i2"),
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(i2) a fresh LOW in the fix range is disclosed and the wave still clears (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    outcome?.reason !== undefined && /DISCLOSED/.test(outcome.reason),
    `(i2) and the disclosed row is stated on the reason rather than dropped (${outcome?.reason?.slice(0, 180)})`,
  );
}

// ── (i3) the DISCLOSED count is the rows disclosed, not the rows reported ───
//
// `reported` is every row the round reported at the bar, and a row can reach the
// clean return while carried, as long as its severity sits below the blocking one —
// the NOT ADDRESSED arm refuses only `carried && atOrAboveBar`. So a count that
// took `reported.length` told the operator that a row the layer still holds OPEN was
// disclosed, and inflated the number by every such row. The mutant is that count
// restored (`reported.length`): this case goes red on it and nothing else does.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 24;\n" });
  const { threw, outcome } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "APPROVED", [
              // One fresh LOW: disclosed, and the only row the count may state.
              blockingFinding({ title: "unguarded write", severity: "LOW" }),
              // One CARRIED LOW: below the blocking bar, so it does not hand the
              // run back, but it is a row the layer holds open — not a disclosure.
              carriedFinding({ title: "still open below the bar", severity: "LOW" }),
            ])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: fixerThatCommits("i3"),
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(i3) a carried row BELOW the bar does not hand the wave back (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    /DISCLOSED: 1 below-bar row$/.test(outcome?.reason ?? ""),
    `(i3) and the disclosed count states the ONE disclosed row, not the two the round reported — a carried row is not a disclosure (${outcome?.reason?.slice(-90)})`,
  );
}

cleanupRoots();
process.exit(failures());

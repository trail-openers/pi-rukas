#!/usr/bin/env bun
/**
 * lean/review — the BLOCKING BAR IS THE PROJECT'S, at both places it is read.
 *
 * The step reads one predicate, `atOrAboveBar`, twice: once to decide whether a
 * six-lens round buys the one fix wave (`lensBlocks`), and once to decide whether a
 * row the re-review carried back is a refusal or a disclosure (`blockingSeverity`).
 * Both readings take the `Severity` the step resolved ONCE at the run's base commit
 * from `ReviewDeps.reviewThreshold`, never a constant in the step. A hard-coded bar
 * is the defect this suite refuses, and it is the follow-up to the one-wave policy:
 * the wave used to fire only on a `CRITICAL_ISSUES_FOUND` verdict, so a HIGH finding
 * in round 1 bought nobody and shipped disclosed while `AGENTS.md §1` calls HIGH and
 * above blocking.
 *
 * The cases are chosen so the BAR and the ROW SEVERITY are never the same value
 * where that can be avoided: a HIGH row at a HIGH bar is answered the same way by a
 * step that reads the threshold and by one that hard-coded HIGH, so only a case that
 * pulls the two apart can tell them apart. (b1) drives the wave bar, (b2) the
 * handback bar, and each carries the control that stops its negative assertion being
 * satisfied by a step that never reads rows at all.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  CAUSE_NOT_ADDRESSED,
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

// ── (b1) a row AT the bar buys the wave; a row BELOW it is disclosed ────────
//
// The pair the follow-up defect turns on. `computeVerdict` reaches `ISSUES_FOUND`
// for any finding at or above the project's threshold, so an `ISSUES_FOUND` round
// whose `reported` rows sit at the bar IS a demand for the wave — reading only the
// verdict's name is what let a HIGH ship. The bar here is CRITICAL for the below-row
// half so the row severity (MEDIUM) cannot coincide with it.
{
  // (b1a) HIGH row, HIGH bar → exactly one fixer and the `fixed` kind.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 30;\n" });
  let b1aFixers = 0;
  let b1aRounds = 0;
  const b1a = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      reviewThreshold: async () => "HIGH" as const,
      lens: async (a) => {
        b1aRounds++;
        return b1aRounds === 1
          ? lensRoundWith("ISSUES_FOUND", [blockingFinding()])
          : lensRoundFor(a, "APPROVED", []);
      },
      dispatch: async (spec) => {
        b1aFixers++;
        return fixerThatCommits("b1a")(spec);
      },
    }),
  );
  assert(
    b1a.threw === undefined && b1a.outcome?.kind === "fixed" && b1aFixers === 1,
    `(b1a) bar HIGH, an ISSUES_FOUND round with a HIGH row buys EXACTLY ONE fixer (${b1a.threw?.message ?? `kind ${String(b1a.outcome?.kind)}, ${String(b1aFixers)} fixers`})`,
  );
  assert(
    b1aRounds === 2,
    `(b1a) and the wave re-reviews the fix, as a CRITICAL round's does (${String(b1aRounds)} lens rounds)`,
  );

  // (b1b) MEDIUM row, CRITICAL bar → no fixer, disclosed, one pass only. The bar
  // and the row are deliberately different values: a step that hard-coded HIGH into
  // the wave bar would buy a fixer here, and one that read the rows not at all would
  // buy none in (b1a).
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 31;\n" });
  let b1bFixers = 0;
  let b1bRounds = 0;
  const b1b = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      reviewThreshold: async () => "CRITICAL" as const,
      lens: async () => {
        b1bRounds++;
        return lensRoundWith("ISSUES_FOUND", [
          blockingFinding({ severity: "MEDIUM", lens: "SIMPLICITY", title: "naming" }),
        ]);
      },
      dispatch: async (spec) => {
        b1bFixers++;
        return fixerThatCommits("b1b")(spec);
      },
    }),
  );
  assert(
    b1b.threw === undefined &&
      b1b.outcome?.kind === "done" &&
      b1bFixers === 0 &&
      b1bRounds === 1,
    `(b1b) bar CRITICAL with a MEDIUM row buys NO fixer and no re-review — the bar is the project's, not a constant (${b1b.threw?.message ?? `kind ${String(b1b.outcome?.kind)}, ${String(b1bFixers)} fixers, ${String(b1bRounds)} rounds`})`,
  );
}

// ── (b2) the re-review's carried-row bar is the resolved threshold too ──────
//
// The same predicate read at the second time. A row the layer carries back is its
// statement that the fix did not answer it — but whether that hands the run back is
// still the project's bar, and the step used to keep a private HIGH for this arm
// while the wave arm read the resolved one. Two runs, one row: the looser bar lets
// the wave clear and disclose, the project's own bar refuses it.
{
  // (b2a) bar CRITICAL, the fix range reports a fresh LOW and carries a LOW back →
  // the wave clears and the fresh row is DISCLOSED on the reason. The row the wave was
  // bought for resolves on the first re-review (the fixer changed its cited code) and
  // the second round is where both rows arrive, which is the only shape that gets a
  // carried row to the clean return: a row carried on the FIRST re-review is the very
  // row the wave was bought for, and refusing it then is the (h) arm, not this case.
  // The fresh row is what `disclosureNote` counts and the carried row is what it
  // refuses to count — the count rule is (i3)'s subject, and this case pins that
  // neither row blocks at a bar the project set above them.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 32;\n" });
  let b2aFixers = 0;
  let b2aRounds = 0;
  const b2a = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      reviewThreshold: async () => "CRITICAL" as const,
      lens: async (a) => {
        b2aRounds++;
        if (a.wave !== "fix") return lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]);
        return b2aFixers === 1 && b2aRounds === 2
          // The wave's own row resolves (the fixer changed its cited code) and the
          // round reports a fresh LOW: under a CRITICAL bar that is the row the layer
          // discloses and the step must not block on, and `disclosureNote` is the only
          // surface that can say so.
          ? lensRoundFor(a, "APPROVED", [
              // Fresh and below the bar: the disclosed row.
              blockingFinding({ title: "below the bar", severity: "LOW", lens: "SIMPLICITY" }),
              // Carried and below the bar: the layer holds it open, so it is no
              // disclosure — and it is no handback either, at this bar.
              carriedFinding({ title: "carried under a looser bar", severity: "LOW" }),
            ])
          : lensRoundFor(a, "APPROVED", []);
      },
      dispatch: async (spec) => {
        b2aFixers++;
        return fixerThatCommits("b2a")(spec);
      },
    }),
  );
  assert(
    b2a.threw === undefined && b2aFixers === 1 && b2aRounds === 2,
    `(b2a) a carried LOW under a CRITICAL bar does not hand the run back — the handback bar is the project's too (${b2a.threw?.message ?? `${String(b2aFixers)} fixers, ${String(b2aRounds)} rounds`})`,
  );
  assert(
    b2a.outcome?.kind === "fixed" && /DISCLOSED: 1 below-bar row/.test(b2a.outcome.reason ?? ""),
    `(b2a) and the row it declined to block on is DISCLOSED on the reason, not dropped (${b2a.outcome?.kind} / ${b2a.outcome?.reason?.slice(-90)})`,
  );

  // (b2b) THE CONTROL: the same carried row, the project's own HIGH bar → the wave
  // hands back and quotes it. Without this the case above is also satisfied by a step
  // that reads no carried row at all. The row is HIGH and the bar is the project's
  // HIGH because that is the pair a step that hard-coded the bar answers the same way
  // as one that reads it: what tells them apart is the LOOSER bar above, where only
  // the resolved reading lets the row through.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 33;\n" });
  let b2bFixers = 0;
  const b2b = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      reviewThreshold: async () => "HIGH" as const,
      lens: async (a) =>
        a.wave === "fix"
          ? carriedLensRound(a, [blockingFinding({ title: "carried at the project's bar" })])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: async (spec) => {
        b2bFixers++;
        return fixerThatCommits("b2b")(spec);
      },
    }),
  );
  assert(
    b2b.threw instanceof ReviewInfraError &&
      b2b.threw.message.includes(CAUSE_NOT_ADDRESSED) &&
      /carried at the project's bar/.test(b2b.threw.message) &&
      b2bFixers === 1,
    `(b2b) at the project's own HIGH bar the SAME carried row does hand the run back (${b2b.threw?.message ?? `no refusal, ${String(b2bFixers)} fixers`})`,
  );
}

// ── (b3) an unranked severity blocks at BOTH bars ──────────────────────────
//
// A row is parsed model output, so a severity outside the four schema values has no
// rank. Fail closed: an unranked row is never "below the bar", and that must hold at
// the wave bar as well as the handback bar — a malformed row that slipped the wave bar
// would ship, and one that slipped the handback bar would clear a wave the layer says
// is unanswered. The mutant is `rank === undefined ||` in `atOrAboveBar`.
for (const bar of ["CRITICAL", "HIGH"] as const) {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: `export const f = ${bar === "CRITICAL" ? 34 : 35};\n` });
  let unrankedFixers = 0;
  const unranked = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      reviewThreshold: async () => bar,
      lens: async (a) =>
        a.wave === "fix"
          ? lensRoundFor(a, "APPROVED", [])
          : lensRoundWith("ISSUES_FOUND", [
              { ...blockingFinding({ title: `unranked at ${bar}` }), severity: "BLOCKER" } as never,
            ]),
      dispatch: async (spec) => {
        unrankedFixers++;
        return fixerThatCommits(`b3-${bar}`)(spec);
      },
    }),
  );
  assert(
    unranked.threw === undefined && unranked.outcome?.kind === "fixed" && unrankedFixers === 1,
    `(b3/${bar}) an unranked severity on the FULL round still buys the wave at a ${bar} bar — fail closed, it is not "below the bar" (${unranked.threw?.message ?? `kind ${String(unranked.outcome?.kind)}, ${String(unrankedFixers)} fixers`})`,
  );
}

cleanupRoots();
process.exit(failures());

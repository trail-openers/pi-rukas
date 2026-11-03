#!/usr/bin/env bun
import type { DispatchSpec } from "../src/types.ts";
/**
 * lean/review — which gate's verdict is a DEMAND, and which is a disclosure.
 *
 * Split from `test-lean-review-tree.ts` along that file's own seam: the tree file
 * is about the disposable fixer worktree (its fence, its name, its provisioning).
 * This file is about the two things a gate decides about a fixer — whether it is
 * dispatched at all, and what it is told — because both come off ONE value
 * (`fromGate`) and each half is satisfiable without the other:
 *
 *   (j) only a BLOCKING gate verdict is a demand on the fixer. The adversarial gate
 *       runs report-only, so its `rejected` arm can carry findings that do not mean
 *       "must not proceed". A step that treats any rejection as blocking buys
 *       remediation for a disclosure; one that treats none as blocking ignores the
 *       gate. The finding text, the brief's gate name and the tree's arm all derive
 *       from the same `gate.blocking`, so they cannot disagree about who rejected.
 *
 *   (k) a re-review is honoured only for the range the step named. The layer stamps
 *       the delta it read; a stamp that contradicts the step's base is a verdict on
 *       some other diff, and its silence would be read back as the fixer having
 *       fixed nothing.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  type DispatchUsageRow,
  FIXER_ROLE,
  ReviewInfraError,
  blockingFinding,
  blockingOnGateThenClears,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  issuesFoundThenClears,
  lensRoundWith,
  makeRepo,
  passed,
  rejectsThenClears,
  resolvedLensRound,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/** A fixer that commits, so the wave is not refused for fixing nothing. */
function committingFixerTree(tag: string) {
  return async (spec: DispatchSpec): Promise<ReturnType<typeof result>> => {
    const wt = spec.cwd as string;
    put(wt, `fix-${tag}.ts`, `export const fix_${tag} = 1;\n`);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", `fix(${tag}): the wave's fix`);
    return result({ role: FIXER_ROLE });
  };
}

// ── (j) only a BLOCKING gate verdict is a demand on the fixer ───────────────
//
// The adversarial gate runs in report-only mode, so its `rejected` arm carries
// findings that do NOT mean "must not proceed". Both halves are needed: a step that
// treats any rejection as blocking buys remediation for disclosure, and one that
// treats none as blocking ignores the gate. The mutant for the first is
// `BLOCKING_ADVERSARIAL_STATUSES` widened to include `ISSUES_FOUND`; the mutant for
// the second is the same set emptied.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 12;\n" });
  const prompts: string[] = [];
  const { threw, outcome } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: issuesFoundThenClears("1. a finding the gate reported, never blocked on"),
      lens: async (a) =>
        a.wave === "fix"
          ? // The row IS resolved here, so the only thing left that could refuse the
            // wave is the non-blocking gate's prose — which is exactly what this case
            // is about. `lensRoundFor(a, "APPROVED", [])` would instead fail on the
            // row's own fate and read as though the gate prose had blocked.
            resolvedLensRound(a, [blockingFinding()])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: async (spec) => {
        if (spec.role === FIXER_ROLE) prompts.push(spec.prompt);
        return committingFixerTree("j1")(spec);
      },
    }),
  );
  assert(
    threw === undefined && passed(outcome?.kind),
    `(j1) a re-gate that reports findings without the CRITICAL status clears the wave (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    prompts.length === 1 && !/ADVERSARIAL/.test(prompts[0] ?? ""),
    `(j1) and the non-blocking gate's prose is nowhere in the fixer's brief — only a blocking verdict is a demand on it (${(prompts[0] ?? "").slice(0, 140)})`,
  );

  // The blocking half of the same shape, or (j1) is satisfied by a step that
  // ignores the gate entirely.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 13;\n" });
  const prompts2: string[] = [];
  const { threw: t2 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      adversarial: rejectsThenClears("1. a finding the gate blocked on"),
      lens: async (a) =>
        a.wave === "fix"
          ? resolvedLensRound(a, [blockingFinding()])
          : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
      dispatch: async (spec) => {
        if (spec.role === FIXER_ROLE) prompts2.push(spec.prompt);
        return committingFixerTree("j2")(spec);
      },
    }),
  );
  assert(
    t2 === undefined,
    `(j2) precondition: the blocking wave ran and cleared (${t2?.message ?? "no throw"})`,
  );
  // The discriminator: `findings`, `gate` and the tree's arm all derive from the
  // ONE `fromGate` value, so a blocking gate puts its prose in the brief AND names
  // itself as the gate — while (j1) shows the same fixture shape contributing
  // nothing. A step that derived the two independently could satisfy one and not
  // the other.
  assert(
    prompts2.length === 1 && /gate: adversarial pass/.test(prompts2[0] ?? ""),
    `(j2) a BLOCKING gate names itself in the brief's gate field, so a fixer told "six-lens review" while handed gate prose cannot exist (${(prompts2[0] ?? "").slice(0, 200)})`,
  );
  assert(
    prompts.length === 1 && !/gate: adversarial pass/.test(prompts[0] ?? ""),
    `(j1) and the non-blocking gate's pass contributes NEITHER its prose nor its name to the brief (${(prompts[0] ?? "").slice(0, 200)})`,
  );
  // (h) a blocking row the re-review neither reported nor resolved is NOT ADDRESSED
  {
    const { repoRoot, baseSha } = makeRepo();
    await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 14;\n" });
    // The re-review stamps a range whose LOWER bound is something other than the
    // head the step named — the shape of a layer that reviewed some other diff and
    // still returned a verdict. A verdict on a range nobody asked for cannot answer
    // for the fix, and the step must say which range it named against which it got.
    const { threw } = await run(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        adversarial: async () => result({ loopOutcome: "approved" }),
        lens: async (a) =>
          a.wave === "fix"
            ? {
                ...resolvedLensRound(a, [blockingFinding()]),
                deltaReview: { since: "0".repeat(40), head: a.head },
              }
            : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
        dispatch: committingFixerTree("k"),
      }),
    );
    assert(
      threw instanceof ReviewInfraError &&
        /did not range over the fix/.test(threw.message) &&
        /0{12}/.test(threw.message),
      `(k) a re-review whose stamp names a range the step did not name is refused, and the refusal quotes both ranges (${threw?.message ?? "the step accepted a verdict on some other diff"})`,
    );
  }

  // (h2) The positive control for (k): the same fixture with the stamp the step
  // actually asked for must clear, or (k) is satisfied by a step that always refuses.
  {
    const { repoRoot, baseSha } = makeRepo();
    await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 15;\n" });
    const { threw, outcome } = await run(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        adversarial: async () => result({ loopOutcome: "approved" }),
        lens: async (a) =>
          a.wave === "fix"
            ? resolvedLensRound(a, [blockingFinding()])
            : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
        dispatch: committingFixerTree("k2"),
      }),
    );
    assert(
      threw === undefined && passed(outcome?.kind),
      `(k2) and the correctly-stamped re-review clears — (k) is a range check, not a refusal to pass (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
    );
  }
}

cleanupRoots();
process.exit(failures());

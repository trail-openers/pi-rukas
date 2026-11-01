#!/usr/bin/env bun
/**
 * The ROUTING half of the lens-coverage gate: what an unaccounted selected file
 * DOES to a round's verdict, over a real clone driven through the injected
 * `lensChildFn` seam (never a live spawn).
 *
 * The pure accounting — what the denominator is, and what counts as evidence
 * for a file — is pinned in `test-lens-coverage-denominator.ts`; the fixture
 * both files share is `lib/lens-coverage-fixture.ts`.
 *
 * Both directions are pinned here, because a denominator that always fails is
 * as useless as one that never fires:
 *   (a) a round with an unaccounted selected file does NOT read as a pass;
 *   (b) a round where every selected file is accounted for still APPROVEDs,
 *       with no coverage section in its report at all.
 * The denominator comes from a diff the review computed itself (`base...head`
 * from refs it resolved), which is the only shape that earns a denominator at
 * all; (d) pins the pasted-diff arm earns none.
 */

import { rmSync } from "node:fs";
import { renderSummary } from "../src/lens-review-render.ts";
import { runLensReview } from "../src/lens-review.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import {
  CHANGED_A,
  CHANGED_B,
  PASTED_DIFF,
  gitChanged,
  lens,
  mkClone,
  reportFrom,
  round,
  teardown,
} from "./lib/lens-coverage-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// (a) The uncovered round is not a pass. Every lens answers COMPLETELY — the
// closing summary the prompt requires, no findings — and none names a file.
// Pre-gate this is a byte-identical APPROVED.
{
  const c = mkClone();
  try {
    const out = await round(c, (name) => lens(name, [], "The diff is clean from my perspective."));
    assert(
      out.lenses.length > 0 && out.lenses.every((l) => !l.blocked),
      "(a) every lens ran — the incompleteness below is coverage, not a blocked roster",
    );
    assert(
      out.verdict === "REVIEW_INCOMPLETE",
      `canary (a): selected files no evidence accounts for do NOT read APPROVED (got ${out.verdict})`,
    );
    assert(
      out.unaccountedFiles?.join(",") === [CHANGED_A, CHANGED_B].join(","),
      `(a) the unaccounted files are NAMED, not merely reflected in the verdict (got ${JSON.stringify(out.unaccountedFiles)})`,
    );
    const text = renderSummary(out, 4);
    assert(
      text.includes("COVERAGE INCOMPLETE") && text.includes(CHANGED_A) && text.includes(CHANGED_B),
      "(a) the operator's report names both uncovered lanes",
    );
  } finally {
    teardown(c);
  }
}

// (b) A fully covered round still passes — the direction that keeps the gate
// from becoming a wall. One lens cites one file in a finding, another names the
// other in its summary: both evidence kinds count, and nothing is left over.
{
  const c = mkClone();
  try {
    const out = await round(c, (name) =>
      name === LENS_ROSTER[0]?.name
        ? lens(
            name,
            // Every changed file is named, and the LOW is below the MEDIUM bar:
            // a round that covers its denominator still reaches APPROVED.
            reportFrom(name, [{ severity: "LOW", path: CHANGED_A, title: "naming" }]),
            `No issues in ${CHANGED_B} from my lens.`,
          )
        : lens(name, [], `No issues in ${CHANGED_B} from my lens.`),
    );
    assert(
      out.verdict === "APPROVED",
      `canary (b): a round whose every selected file is accounted for still APPROVEDs (got ${out.verdict})`,
    );
    assert(out.unaccountedFiles === undefined, "(b) a covered round carries no coverage field");
    assert(
      !renderSummary(out, 4).includes("COVERAGE INCOMPLETE"),
      "(b) and no coverage section in its report",
    );
  } finally {
    teardown(c);
  }
}

// (c) Half coverage is a real subtraction: the round accounts for one of the
// two changed files and is incomplete for the other.
{
  const c = mkClone();
  try {
    const out = await round(c, (name) =>
      name === LENS_ROSTER[0]?.name
        ? lens(
            name,
            // The findings cite the file git says the PR touched — read from git
            // itself, so this case proves the citation matches the DENOMINATOR's
            // spelling rather than whatever this file happened to write.
            reportFrom(name, [
              {
                severity: "HIGH",
                path: gitChanged(c)[0] ?? CHANGED_A,
                line: 4,
                title: "missing validation",
              },
            ]),
            "…",
          )
        : lens(name, [], "The diff is clean from my perspective."),
    );
    // The expected set comes from the review's OWN git read, so the denominator
    // it is measured against is the set the child sees: the second changed file
    // is the one no evidence can reach.
    const covered = gitChanged(c)[0] ?? CHANGED_A;
    const uncovered = gitChanged(c)
      .filter((f) => f !== covered)
      .sort();
    assert(
      // The HIGH is at the MEDIUM bar, so it blocks on its own merit: the
      // coverage gate must not be able to make a real finding disappear, and
      // must not be credited with a verdict the finding already earned.
      out.verdict === "REVIEW_INCOMPLETE" || out.verdict === "ISSUES_FOUND",
      `canary (c): ${covered} covered of 2 leaves the round NOT a pass (got ${out.verdict})`,
    );
    assert(
      out.unaccountedFiles?.join(",") === uncovered.join(","),
      `(c) only the uncovered file is named (got ${JSON.stringify(out.unaccountedFiles)}, want ${JSON.stringify(uncovered)})`,
    );
  } finally {
    teardown(c);
  }
}

// (d) A caller-pasted diff earns no denominator: the round is judged exactly as
// before. Pasted text is not evidence of what the PR changed, so it cannot
// license a penalty either.
{
  const c = mkClone();
  try {
    let write: Promise<unknown> = Promise.resolve();
    const out = await runLensReview({
      cwd: c.repo,
      branch: "feat/x",
      head: c.head,
      // The PR's own diff, pasted: the SAME bytes a computed round would get
      // (every file section carries its `--- ` line — `changedLineRanges` only
      // recognises a `+++ ` preceded by one, so a headerless pasted diff is not
      // even the same change set).
      diff: PASTED_DIFF,
      lensChildFn: (async (args: { lens: { name: string } }) =>
        lens(args.lens.name, [], "The diff is clean from my perspective.")) as never,
      onLedgerWrite: (w: Promise<unknown>) => {
        write = w;
      },
    });
    await write;
    assert(
      out.verdict === "APPROVED" && out.unaccountedFiles === undefined,
      `canary (d): a pasted diff earns NO denominator — unchanged behaviour (got ${out.verdict})`,
    );
  } finally {
    teardown(c);
  }
}

// (e) ORIGINAL PREMISE, KEPT AS AN OPEN QUESTION RATHER THAN REDEFINED. The
// intent was: a round carrying a CRITICAL must not have that verdict replaced
// by a coverage complaint. Stated literally — a CRITICAL on `src/untouched.ts`,
// a file the PR never changes — this CANNOT pass, and that is a finding about
// how two gates interact, not a test to fix: the #1125 advisory split discounts
// a CRITICAL outside the changed lines to ADVISORY, so it never reaches
// `computeVerdict` and there is no blocking verdict for the coverage gate to
// preserve. The assertion below therefore tests the case the mechanism DOES
// cover (CRITICAL inside the diff, one file unaccounted: the blocking verdict
// stands and the gap is still disclosed), and the final assertion PINS the
// discounted case as a known gap so it cannot be mistaken for covered.
{
  const c = mkClone();
  try {
    const out = await round(c, (name) =>
      name === LENS_ROSTER[0]?.name
        ? lens(
            name,
            reportFrom(name, [
              { severity: "CRITICAL", path: CHANGED_A, line: 4, title: "secret in source" },
            ]),
            "The diff is clean from my perspective.",
          )
        : lens(name, [], "The diff is clean from my perspective."),
    );
    // A file the PR does not change, so it cannot stand as evidence for either
    // file it does: the round has an unaccounted file AND a CRITICAL.
    assert(
      out.verdict === "CRITICAL_ISSUES_FOUND",
      `(e) an uncovered file does not DOWNGRADE a blocking verdict (got ${out.verdict})`,
    );
    // The finding accounts for CHANGED_A; CHANGED_B is the one nobody judged.
    assert(
      out.unaccountedFiles?.join(",") === CHANGED_B,
      `(e) and the gap is still DISCLOSED on a round that already blocks (got ${JSON.stringify(out.unaccountedFiles)})`,
    );
    // The discounted case, PINNED as a known gap rather than asserted away: a
    // CRITICAL on a file the PR never touches is advisory, so a round whose only
    // CRITICAL sat there has no blocking verdict to preserve and the coverage
    // gate is the only thing between it and a pass. Reported as an open question.
    // Its OWN clone: the store keys on branch + headSha, so reusing `c` here
    // would carry the round's own CRITICAL row into the next round and make this
    // round's findings someone else's.
    const g = mkClone();
    const discounted = await round(g, (name) =>
      name === LENS_ROSTER[0]?.name
        ? lens(
            name,
            reportFrom(name, [
              {
                severity: "CRITICAL",
                path: "src/untouched.ts",
                line: 1,
                title: "secret in source",
              },
            ]),
            "The diff is clean from my perspective.",
          )
        : lens(name, [], "The diff is clean from my perspective."),
    );
    rmSync(g.root, { recursive: true, force: true });
    assert(
      discounted.findings.every((f) => f.path !== "src/untouched.ts") &&
        discounted.verdict === "REVIEW_INCOMPLETE",
      `(e-gap) an OUT-OF-DIFF CRITICAL is discounted to advisory, leaving the coverage gate as the only thing that refuses the round (got ${discounted.verdict}, blocking ${JSON.stringify(discounted.findings.map((f) => f.path))}, advisory ${JSON.stringify((discounted.advisory ?? []).map((f) => f.path))}) — open question, not a covered case`,
    );
  } finally {
    teardown(c);
  }
}

process.exit(exit);

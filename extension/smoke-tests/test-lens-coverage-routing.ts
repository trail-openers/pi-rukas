#!/usr/bin/env bun
/**
 * The ROUTING half of the coverage gate, over a real clone driven through the
 * injected `lensChildFn` seam (never a live spawn). It pins the two levels
 * separately, because they have opposite verdicts and one file that conflates
 * them defeats the design:
 *
 *   LENS LEVEL — verdict-bearing. A lane that left neither a finding nor the
 *   closing summary the prompt requires makes the round `REVIEW_INCOMPLETE`.
 *   Case (f) is the guarantee worth having: it is asserted end-to-end through
 *   `runLensReview`, and it is mutation-proven in
 *   `test-lens-silence.ts` (dropping the `lensProducedEvidence` arm reddens it).
 *
 *   FILE LEVEL — disclosure only. A changed file no finding cited and no
 *   summary named is NAMED to the operator and decides nothing. Cases (a)/(b)/
 *   (c) pin both directions of that: a clean round over uncovered files still
 *   APPROVEDs with the gap disclosed, and the list is a real subtraction.
 *   A blocking gate here would fail precisely the case it exists to pass —
 *   coverage is derivable only from findings, so genuinely good code has none.
 *
 * The pure accounting — what the denominator is, and what counts as evidence
 * for a file — is pinned in `test-lens-coverage-denominator.ts`; the fixture
 * both files share is `lib/lens-coverage-fixture.ts`.
 *
 * The denominator comes from a diff the review computed itself (`base...head`
 * from refs it resolved), which is the only shape that earns a denominator at
 * all; (d) pins that the pasted-diff arm earns none.
 */

import { rmSync } from "node:fs";
import {
  TEST_SUMMARY_CITES_BOTH_FILES,
  TEST_SUMMARY_QUOTES_BOTH_FILES,
} from "./lib/lens-recital-probe.ts";
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
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// (a) The uncovered round is DISCLOSED, not refused. Every lens answers
// COMPLETELY — the closing summary the prompt requires, no findings — and none
// names a file. Under the ruling that is a note naming both files and an
// APPROVED verdict: gating here would refuse a clean round over good code.
{
  const c = mkClone();
  try {
    const out = await round(c, (name) => lens(name, [], "The diff is clean from my perspective."));
    assert(
      out.lenses.length > 0 && out.lenses.every((l) => !l.blocked),
      "(a) every lens ran and left evidence — so this round is complete at the lens level",
    );
    assert(
      out.verdict === "APPROVED",
      `canary (a): files no evidence accounts for do NOT block a round whose lenses all reviewed — it is disclosure, not a verdict (got ${out.verdict})`,
    );
    assert(
      out.unaccountedFiles?.join(",") === [CHANGED_A, CHANGED_B].join(","),
      `(a) the unaccounted files are NAMED, so a suspiciously quiet review is visible (got ${JSON.stringify(out.unaccountedFiles)})`,
    );
    const text = renderSummary(out, 4);
    assert(
      text.includes("COVERAGE") && text.includes(CHANGED_A) && text.includes(CHANGED_B),
      "(a) the operator's report names both uncovered files",
    );
    assert(
      !text.includes("REVIEW INCOMPLETE"),
      "(a) canary: the file-level disclosure never renders the blocking banner",
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
      out.coverageComplete === true,
      "(b) and says so positively: this round had a denominator and covered it",
    );
    const text = renderSummary(out, 4);
    assert(!text.includes("no lens accounted for"), "(b) and no coverage warning in its report");
    assert(
      text.includes("no files in scope") === false,
      "(b) and does not misreport itself as having had no files in scope",
    );
    // The ✓ line must be EARNED, not merely consistent with the fields: at
    // least one denominator file cited by a structured finding, and no lane
    // that came back silent. (b)'s round has a real `report_finding` citation
    // on CHANGED_A, so it earns it.
    assert(
      text.includes("COVERAGE — every file"),
      "(b) the positive coverage line renders for the round that earned it — a real finding citation, no silent lane",
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
      // A HIGH finding at the MEDIUM bar blocks on its own merit; the coverage
      // disclosure neither adds to that nor takes anything away from it.
      out.verdict === "ISSUES_FOUND",
      `canary (c): the HIGH decides the verdict and the uncovered file does not change it (got ${out.verdict})`,
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
      out.verdict === "APPROVED" &&
        out.unaccountedFiles === undefined &&
        out.coverageComplete === undefined,
      `canary (d): a pasted diff earns NO denominator — unchanged verdict, no disclosure, and NOT the 'covered' claim (got ${out.verdict}, coverageComplete ${JSON.stringify(out.coverageComplete)})`,
    );
    // The report must say "no files in scope", never fall silent into looking
    // fully covered: an absent warning is not evidence of coverage.
    assert(
      renderSummary(out, 4).includes("no files in scope"),
      "(d) canary: a round with no denominator reports NO FILES IN SCOPE rather than claiming coverage",
    );
  } finally {
    teardown(c);
  }
}

// (e) A blocking verdict is never REPLACED by a coverage complaint, and the gap
// is still disclosed on a round that already blocks on its own merits.
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
    // The out-of-diff CRITICAL, now stated as what it is under the two-level
    // ruling: the #1125 advisory split discounts a CRITICAL outside the changed
    // lines, so nothing blocks on the merits — and the FILE-level gate is no
    // longer there to refuse the round either. What refuses it is the LENS-level
    // rule (a lane that left no evidence), which is the guarantee this file
    // exists to keep.
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
        discounted.verdict === "APPROVED" &&
        discounted.unaccountedFiles?.join(",") === [CHANGED_A, CHANGED_B].join(","),
      `(e-gap) an OUT-OF-DIFF CRITICAL is discounted to advisory and the file-level gate no longer refuses the round: the verdict is the findings' and the gap is DISCLOSED (got ${discounted.verdict}, blocking ${JSON.stringify(discounted.findings.map((f) => f.path))}, advisory ${JSON.stringify((discounted.advisory ?? []).map((f) => f.path))}, unaccounted ${JSON.stringify(discounted.unaccountedFiles)}) — open question, disclosed not blocked`,
    );
  } finally {
    teardown(c);
  }
}

// (f) THE GUARANTEE WORTH HAVING, end-to-end: a lens that emitted nothing makes
// the round REVIEW_INCOMPLETE. This is the lens-level level, deliberately kept
// separate from (a) — where every lens answered and the file list alone could
// not refuse anything. Mutation-proven: making `lensProducedEvidence` return
// true unconditionally turns this red (see the report).
{
  const c = mkClone();
  try {
    const silent = LENS_ROSTER[0]?.name;
    const out = await round(c, (name) =>
      // One lane comes back with NEITHER a finding NOR the closing summary the
      // prompt requires: byte-identical to a careful review that found nothing,
      // until the lens-level rule is asked.
      name === silent
        ? lens(name, [], "")
        : lens(name, [], "The diff is clean from my perspective."),
    );
    assert(
      out.verdict === "REVIEW_INCOMPLETE",
      `canary (f): a lens that emitted neither a finding nor a summary yields REVIEW_INCOMPLETE (got ${out.verdict}) — the lens-level guarantee`,
    );
    assert(
      (out.unreviewedLanes ?? []).length === 1 &&
        (out.unreviewedLanes ?? []).some((l) => l.startsWith(String(silent))),
      `(f) the silent lane is NAMED so the operator knows which to re-run (got ${JSON.stringify(out.unreviewedLanes)})`,
    );
    const text = renderSummary(out, 4);
    assert(
      text.includes("REVIEW INCOMPLETE") && text.includes("came back having reviewed nothing"),
      "(f) the report carries the lens-level banner, not the file-level warning",
    );
  } finally {
    teardown(c);
  }
}

// (g) THE LYING ✓. The whole point of the coverage field is that an absent
// warning is not evidence of coverage — so the PRESENCE of the positive claim
// must be backed by evidence stronger than prose. Two reproduced shapes where
// the field used to be stamped on a round that never showed it read the files:
//
//   (g1) five lenses whose ONLY findings cite a file OUTSIDE the denominator
//        (`src/elsewhere.ts` — discounted to advisory by #1125, so it decides
//        nothing and accounts for nothing inside the set), each closing with a
//        free-text recital of the two denominator paths. The finding is
//        structured evidence about a file NOT in the set; the summary is prose
//        about files in it. Quoting is the only thing standing between the ✓
//        and a review that showed no work on either changed file. (The
//        unquoted case — a real citation inside the denominator — is case (b).)
//   (g2) a SILENT SECURITY lane plus five quoting lanes: `REVIEW_INCOMPLETE`
//        and `coverageComplete: true` at once — the round admits nobody
//        reviewed it while claiming it covered everything.
//
// Mutation-proof: the rule is `coverageClaimEarned` (lens-review-fanout.ts) and
// the unit assertions in `test-lens-coverage-denominator.ts` redden directly on
// it; these two cases reddens too when the stamp at `lens-review.ts` is
// neutralised, which is what proves the round actually consults the rule.
{
  const c = mkClone();
  try {
    // A summary whose ONLY mention of each changed path is a quoted recital —
    // no path token, so neither the `summary` nor the `finding` claim fires.
    const quoting = TEST_SUMMARY_QUOTES_BOTH_FILES;
    const out = await round(c, (name) =>
      lens(
        name,
        reportFrom(name, [
          // The lenses' ONLY findings cite a file the PR does not change: real
          // structured evidence, in the wrong place — exactly the reproduced
          // shape (the advisory split discounts it, so it decides nothing).
          { severity: "HIGH", path: "src/elsewhere.ts", line: 1, title: "elsewhere" },
        ]),
        quoting,
      ),
    );
    assert(
      // The recital names neither file as a path token, so BOTH stay
      // unaccounted: the disclosure still fires, and the ✓ must not.
      out.unaccountedFiles?.join(",") === [CHANGED_A, CHANGED_B].join(",") &&
        out.hasDenominator === true,
      `(g1) the quoted recital accounts for nothing — both files stay DISCLOSED (got ${JSON.stringify(out.unaccountedFiles)})`,
    );
    assert(
      out.coverageComplete === undefined,
      `canary (g1): a round whose only evidence for the denominator is prose that QUOTES the paths earns NO positive coverage claim (got coverageComplete ${JSON.stringify(out.coverageComplete)})`,
    );
    const text = renderSummary(out, 4);
    assert(
      !text.includes("COVERAGE \u2014 every file"),
      `canary (g1): NO coverage line renders beside a review that showed nothing but quoted paths — neither the ✓ claim nor a gap warning (got ${JSON.stringify(text.split("\n").filter((l) => l.includes("COVERAGE")))})`,
    );
    assert(
      !text.includes("no files in scope"),
      "(g1) it still is not misreported as having had no denominator — three states, not two",
    );
  } finally {
    teardown(c);
  }
}

{
  const c = mkClone();
  try {
    const silent = LENS_ROSTER[0]?.name;
    const quoting = TEST_SUMMARY_QUOTES_BOTH_FILES;
    const out = await round(c, (name) =>
      name === silent ? lens(name, [], "") : lens(name, [], quoting),
    );
    assert(
      out.verdict === "REVIEW_INCOMPLETE",
      `(g2) the silent lane still refuses the round (got ${out.verdict})`,
    );
    assert(
      out.coverageComplete === undefined,
      `canary (g2): a round that admits a lane reviewed nothing cannot simultaneously claim every file was covered (got coverageComplete ${JSON.stringify(out.coverageComplete)})`,
    );
    const g2text = renderSummary(out, 4);
    assert(
      !g2text.includes("COVERAGE \u2014 every file"),
      `canary (g2): and no coverage line at all in that report — no ✓ claim (got ${JSON.stringify(g2text.split("\n").filter((l) => l.includes("COVERAGE")))})`,
    );
  } finally {
    teardown(c);
  }
}

// (h) A deterministic extra finding (the `CLAIM_SCAN` witness the caller merges
// separately) accounts for the file it cites, exactly as a lens's own finding
// does. Wrong polarity before: model prose that quotes a path could account and
// a grep-backed witness that looked could not.
{
  const c = mkClone();
  try {
    let write: Promise<unknown> = Promise.resolve();
    const summary = await runLensReview({
      cwd: c.repo,
      branch: "feat/x",
      head: c.head,
      base: c.base,
      full: true,
      // Every lens says the same three words — no lens accounts for anything.
      lensChildFn: (async (args: { lens: { name: string } }) =>
        lens(args.lens.name, [], "All clear")) as never,
      extraFindings: [
        { lens: "CLAIM_SCAN", severity: "LOW", path: CHANGED_A, title: "grounded claim" },
      ],
      onLedgerWrite: (w: Promise<unknown>) => {
        write = w;
      },
    });
    await write;
    assert(
      summary.unaccountedFiles?.join(",") === CHANGED_B,
      `(h) a CLAIM_SCAN finding accounts for the file it cites: only the OTHER changed file is left over (got ${JSON.stringify(summary.unaccountedFiles)})`,
    );
    assert(
      summary.coverageComplete === undefined,
      "(h) and with a file still unaccounted, no positive claim either",
    );
  } finally {
    teardown(c);
  }
}

// (i) A summary that CITES both changed paths as path tokens, with its only
// structured finding OUTSIDE the denominator: the DISCLOSURE is satisfied (no
// gap to name) but nothing inside the set carries a `finding`-class claim, so
// the ✓ line must stay unprinted. This is the case that pins the renderer's
// tri-state input: neutralise `hasDenominator: s.hasDenominator === true` in
// lens-review-render.ts back to the old inference and the "no files in scope"
// assertion below reddens (the round re-infers itself into the ✓ arm).
{
  const c = mkClone();
  try {
    const out = await round(c, (name) =>
      lens(
        name,
        reportFrom(name, [
          { severity: "HIGH", path: "src/elsewhere.ts", line: 1, title: "elsewhere" },
        ]),
        // CITED as path tokens, so the disclosure is satisfied; the ✓ still
        // requires a structured finding inside the set.
        TEST_SUMMARY_CITES_BOTH_FILES,
      ),
    );
    assert(
      out.unaccountedFiles === undefined && out.hasDenominator === true,
      `(i) both files are named as path tokens, so the disclosure is satisfied (got ${JSON.stringify(out.unaccountedFiles)})`,
    );
    assert(
      out.coverageComplete === undefined,
      `canary (i): no ✓ without a finding-class claim INSIDE the denominator (got coverageComplete ${JSON.stringify(out.coverageComplete)})`,
    );
    const text = renderSummary(out, 4);
    assert(
      !text.includes("COVERAGE \u2014 every file"),
      `canary (i): the ✓ line stays unprinted for a round with no finding-class claim inside the denominator (got ${JSON.stringify(text.split("\n").filter((l) => l.includes("COVERAGE")))})`,
    );
    assert(
      !text.includes("no files in scope"),
      "(i) and the round does not misreport itself as having had no denominator",
    );
  } finally {
    teardown(c);
  }
}

process.exit(exit);

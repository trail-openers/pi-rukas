#!/usr/bin/env bun
/**
 * #1529 — the merge guard refuses a PR whose own commits touch a protected path,
 * and refuses when that read cannot be had.
 *
 * Driven through the REAL `registerMergeGuard` hook (the shared harness in
 * merge-guard-helpers.ts), so this is the guard's behaviour, not a unit test of a
 * helper: a ledger that says APPROVED everywhere, CI green, the head pinned — and
 * the merge is still refused, because the PR changes `.github/`, `.pi/`,
 * `CODEOWNERS` or `agents.json`.
 *
 * The five arms, in the order a reviewer will read them:
 *
 *   1. A protected diff refuses, naming the path — the whole point.
 *   2. A rename out of a protected path refuses too (the source side).
 *   3. An unreadable read refuses. "Could not read the diff" and "nothing
 *      protected changed" must not be the same answer to a gate that merges on
 *      the difference; a fixture that answers an unscripted command with an empty
 *      string would make arm 3 vacuous, so the harness throws on anything it has
 *      not been told to answer.
 *   4. An ordinary diff still merges — the gate is not a blanket refusal.
 *   5. The read is taken from the MERGE BASE, so a protected file that changed on
 *      main after the branch was cut does not hold the cycle. Pinned on the range
 *      the guard actually asked git for, not on an assertion about the answer.
 */

import { nulNameStatus } from "./lib/nul-porcelain.ts";
import {
  assert,
  GOOD_ENTRIES,
  TARGET,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

await setupLedgerPath();

const CI = ".github/workflows/ci.yml";
const OWNERS = "CODEOWNERS";

/**
 * A clean PR for the arms that are not about the protected set: one ordinary
 * file, so the read is genuinely issued and genuinely parses — an empty stream
 * would let the arm pass without the parser having seen anything.
 */
const CLEAN = nulNameStatus("M\tsrc/app.ts");
/** A PR whose own commit edits the CI workflow. */
const PROTECTED = nulNameStatus(`M\t${CI}`);
/** A PR that moves the CI workflow out of `.github/` — `git mv` in the other direction. */
const RENAMED_OUT = nulNameStatus(`R100\t${CI}\tsrc/ci.yml`);

{
  // 1. The refusal itself, on an otherwise fully-approved PR.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: PROTECTED,
  });
  assert(r.block === true, "refused: a PR whose own commits edit .github/ is not agent-merged");
  assert(
    (r.reason ?? "").includes(CI),
    `…and the refusal names the protected path (got ${JSON.stringify((r.reason ?? "").slice(0, 120))})`,
  );
  assert(
    /operator merges/.test(r.reason ?? ""),
    "…and tells the operator to merge it themselves rather than offering to relax the gate",
  );
}

{
  // 2. The rename source is the protected side; a destination-only check would pass.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: RENAMED_OUT,
  });
  assert(
    r.block === true && (r.reason ?? "").includes(CI),
    "refused: `git mv .github/workflows/ci.yml src/ci.yml` is a protected change (the rename SOURCE counts)",
  );
}

{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: nulNameStatus("M\tdocs/guide.md", `A\t${OWNERS}`),
  });
  assert(
    r.block === true && (r.reason ?? "").includes(OWNERS),
    "refused: CODEOWNERS is protected even beside an ordinary file",
  );
}

{
  // 3. Unreadable is not clean. The harness throws for this arm rather than
  //    answering "", because an empty stdout would be indistinguishable from a
  //    PR that changed nothing protected — the exact confusion this arm exists
  //    to make impossible.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiffThrows: true,
  });
  assert(
    r.block === true,
    "refused: an unreadable protected-path read is a refusal, not a clean diff",
  );
  assert(
    /could not inspect|protected-path read/.test(r.reason ?? ""),
    `…and the refusal says the read failed rather than blaming the ledger (got ${JSON.stringify((r.reason ?? "").slice(0, 120))})`,
  );
}

{
  // 4. The gate is not a blanket refusal: everything else about this PR passes
  //    and nothing protected changed, so the hook allows the merge.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: CLEAN,
  });
  assert(
    r.block !== true,
    `an ordinary diff still merges (got ${JSON.stringify((r.reason ?? "").slice(0, 140))})`,
  );
}

{
  // A fetch that cannot reach the remote is a refusal of the merge, not a
  // ledger question: nothing was fetched, so nothing was verified.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: CLEAN,
    failFetch: true,
  });
  assert(
    r.block === true && /fetch/i.test(r.reason ?? ""),
    `refused: a failed fetch blocks the merge through the real hook (got ${JSON.stringify((r.reason ?? "").slice(0, 120))})`,
  );
}

{
  // A resolve of the base that THROWS is a refusal…
  const t = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: CLEAN,
    failBaseOid: "throws",
  });
  assert(
    t.block === true && /origin\/main/.test(t.reason ?? ""),
    `refused: a base resolve that throws blocks the merge through the real hook (got ${JSON.stringify((t.reason ?? "").slice(0, 120))})`,
  );
  // …and one that ANSWERS a non-OID is a refusal too: the gate diffs the OIDs it
  // was handed, so garbage is neither a base nor a clean diff.
  const g = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: CLEAN,
    failBaseOid: "garbage",
  });
  assert(
    g.block === true && !/protected path\(s\)/.test(g.reason ?? ""),
    `refused: a non-OID rev-parse blocks the merge through the real hook (got ${JSON.stringify((g.reason ?? "").slice(0, 120))})`,
  );
}

{
  // 5. The range. `git diff` is asked for `<merge-base>..<head>`, so a regression
  //    to the two-dot `<remote>/<base>..<remote>/<head>` form is the thing this
  //    arm rules out: main's own protected commit would then hold every branch
  //    cut before it. Asserted on the command the guard actually issued.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    target: TARGET,
    protectedDiff: CLEAN,
  });
  assert(r.block !== true, "a clean diff merges while the range is inspected");
  const diffCall = (r.calls as string[]).find((c) => c.includes("diff -z --name-status"));
  assert(
    diffCall !== undefined,
    `the guard issued the \`-z --name-status\` protected read (last calls: ${JSON.stringify((r.calls as string[]).slice(-4))})`,
  );
  const range = (diffCall ?? "").split("--end-of-options")[1]?.trim() ?? "";
  assert(
    range.includes("..") && !range.includes("origin/") && !range.startsWith(".."),
    `the range is <merge-base>..<head>, never <remote>/<base>..<remote>/<head> — a moved main does not make a clean branch look protected (got ${JSON.stringify(range)})`,
  );
}

teardownLedger();
process.exit(exit);

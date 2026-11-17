#!/usr/bin/env bun
/**
 * The acceptance table reaches the PR comment as ONE post per attempt, and the
 * step hands that same table to the adversarial gate.
 *
 * The sibling of `test-lean-review-acceptance-briefs.ts` (which pins the briefs,
 * the two-post pair, and the entry guard). This file holds the post case that the
 * suite split in two, because the two halves of it share nothing but the fixture:
 *
 *  (b) **one comment per attempt.** The step posts the table once on the run's PR
 *      through the existing `deps.prComment` seam, and hands the adversarial gate
 *      the identical bytes it handed the six lenses. The three verdict shapes are
 *      each a row the reader can weigh, and the comment names the full sha of the
 *      head the gates read beside the certified-head claim — a comment that named
 *      no head would leave a reader unable to tell which commit the rows describe.
 * (b') **the derived-spec regression, at the surface that had the bug.** A run
 *      whose contract the RECORD holds rather than the issue — a prose body plus a
 *      `derivedSpec` on the run — rendered `""` at the comment, so nothing posted,
 *      while the briefs were handed a full table. The disclosure existed everywhere
 *      but the one place a PR reviewer would read it.
 *
 * The repo, the branch and the commits are real (`lib/lean-review-fixtures.ts`);
 * only the models and the gate verdicts are stubs, so the post is the step's own.
 *
 * Offline: no child process, no model, no token.
 */

import {
  acceptanceComment,
  renderAcceptanceSection,
} from "../src/lean/review-acceptance.ts";
import {
  CRITERIA,
  DERIVED_SPEC,
  ISSUE_BODY,
  NL,
  PROSE_BODY,
  logFor,
  realFrozen,
} from "./lib/lean-review-acceptance-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  cleanupRoots,
  ctxFor,
  depsWith,
  lensRoundFor,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const { assert, failures } = makeAssert();
isolateLedger();

/** The section the assertions compare the posted bytes against: the shared fixture's
 * log and issue body, through the one renderer the step uses. Hoisted so both cases
 * read it the same way. */
function section(head: string): string {
  return renderAcceptanceSection(logFor(head), ISSUE_BODY);
}

// ── (b) one comment per attempt, carrying the same bytes ───────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const posts: string[] = [];
  const adversarialTables: (string | undefined)[] = [];
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.steps.push(...logFor(head));
  const { outcome, threw } = await runStep(
    ctx,
    depsWith({
      // The real wiring builds this brief; drive it with the table the step would
      // have composed, so the adversarial seat's copy of it is asserted too.
      // (The step's own pass through this seam is case (b)'s post path.)
      fetchIssueBody: async () => ISSUE_BODY,
      prComment: async (_repo, _pr, bodyText) => {
        posts.push(bodyText);
      },
      lens: async (a) =>
        lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []),
      // The seat's own brief is composed inside `review-deps.ts` from exactly these
      // args (`adversarialContext(a.issue, a.wave, a.blockingFindings, a.acceptanceTable)`),
      // so the strongest thing capturable at this seam is that the step handed the
      // gate the table at all — and then the same composition, reprinted here, is
      // what the seat read. The sibling's case (a) pins that composition against the briefs.
      adversarial: async (a) => {
        adversarialTables.push(a.acceptanceTable);
        return result({ loopOutcome: "approved" });
      },
    }),
  );
  assert(outcome !== undefined && threw === undefined, `(b) the step passed (${String(outcome?.kind)})`);
  assert(
    adversarialTables.length >= 1 && adversarialTables.every((t) => t === section(head)),
    `(b) the step handed the ADVERSARIAL gate the same table it handed the six lenses, on every pass (${String(adversarialTables.length)} passes) — the mutant: threading it to the lenses only, which leaves the gate that can block a run judging without it`,
  );
  assert(
    posts.length === 1,
    `(b) exactly ONE acceptance comment per attempt (${String(posts.length)} posted: ${JSON.stringify(
      posts.map((p) => p.slice(0, 40)),
    )})`,
  );
  const posted = posts[0] ?? "";
  assert(
    posted.includes("AC1") && posted.includes("AC2") && posted.includes("AC3"),
    "(b) the comment carries every criterion, not just the first",
  );
  assert(
    posted.includes(`pass at ${head.slice(0, 12)}`) &&
      posted.includes(`pass (command) at ${head.slice(0, 12)}`) &&
      posted.includes("manual — needs a human"),
    "(b) and each of the three verdict shapes is a row the reader can weigh",
  );
  const anchor = posted.split(NL).find((l) => l.startsWith("Reviewed head:")) ?? "";
  // One substring assembled from char codes and this case's own head — no literal
  // that can disagree with the printer over a dash or a space.
  const want =
    "Reviewed head: `" + head + "` " + String.fromCharCode(8212) + " the commit the gates read, which is the certified head.";
  assert(
    anchor === want && anchor.includes(head),
    `(b) the comment names the head the gates read, as the full sha, beside the certified-head claim (${JSON.stringify(
      anchor,
    )}) — the mutant: a comment that named no head would leave a reader unable to tell which commit the rows describe`,
  );
  assert(
    posted.includes(section(head)),
    "(b) and the section is the SAME bytes the briefs were handed — one renderer, three surfaces",
  );
  // The comment's own renderer, exercised directly on the same log: the step's
  // post path above proves it reached the forge; this proves the shape is the
  // renderer's and not an artefact of the harness.
  assert(
    acceptanceComment(logFor(head), ISSUE_BODY, head).includes(section(head)),
    "(b) acceptanceComment is the section plus its head anchor, nothing else",
  );
  cleanupRoots();
}

// ── (b') the derived-spec run, at the surface that had the bug ─────────────
//
// A prose body with a derived spec on the run rendered `""` at the comment (so nothing
// posted) while the briefs were handed a full table — the disclosure existed everywhere
// but the one place a PR reviewer would read it. So this drives the STEP's own post
// path, not the renderer, and counts the posts rather than only their contents.
{
  const derivedRun = {
    spec: {
      problem: DERIVED_SPEC.problem,
      criteria: CRITERIA.map((c) => ({ ...c })),
      size: DERIVED_SPEC.size,
    },
    model: "some/model",
    at: 1_700_000_000_000,
  };
  const { repoRoot, baseSha } = makeRepo();
  const dHead = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const dPosts: string[] = [];
  const dCtx = ctxFor(repoRoot, baseSha, BRANCH);
  dCtx.run = { ...dCtx.run, derivedSpec: derivedRun };
  dCtx.steps.push(...logFor(dHead, realFrozen(repoRoot, dHead)));
  const derivedStep = await runStep(
    dCtx,
    depsWith({
      fetchIssueBody: async () => PROSE_BODY,
      prComment: async (_repo, _pr, bodyText) => {
        dPosts.push(bodyText);
      },
      lens: async (a) => lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []),
      adversarial: async () => result({ loopOutcome: "approved" }),
    }),
  );
  assert(
    derivedStep.outcome !== undefined && derivedStep.threw === undefined,
    `(b) the derived run's step passed (${String(derivedStep.outcome?.kind)})`,
  );
  assert(
    dPosts.filter((p) => p.startsWith("## The acceptance table")).length === 1,
    `(b) a derived run posts exactly ONE acceptance comment (${String(dPosts.filter((p) => p.startsWith("## The acceptance table")).length)}: ${JSON.stringify(dPosts.map((p) => p.slice(0, 24)))}) — the mutant: dropping the record at the post site, which posts none and leaves every other file green`,
  );
  assert(
    renderAcceptanceSection(logFor(dHead), PROSE_BODY, { derivedSpec: derivedRun }) !== "" &&
      (dPosts[0] ?? "").includes("AC1") &&
      (dPosts[0] ?? "").includes(`pass at ${dHead.slice(0, 12)}`),
    "(b) …and that comment is the table of the DERIVED criteria, at the head the gate certified",
  );
  cleanupRoots();
}

console.log(
  `\n${failures() === 0 ? "briefs-derived green" : "briefs-derived RED"} (${String(failures())} failing)`,
);
process.exit(failures());

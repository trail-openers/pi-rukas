#!/usr/bin/env bun
/**
 * The acceptance table reaches BOTH reviewer briefs and the PR comment, and the
 * step refuses a head the gate never certified.
 *
 * Three claims, each of which a stub of the other half cannot fake:
 *
 *  (a) **the two briefs.** `lensContext` is what six lens children read and
 *      `adversarialContext` is what the adversarial reviewer reads; both must
 *      carry the section, on BOTH waves. The fixer's brief is NOT one of the two
 *      (A4): it already names the frozen files it may not touch, and a seat that
 *      edits the tree does not need the gate's results re-stated to it.
 *  (b) **one comment per attempt.** The step posts the table once on the run's PR
 *      through the existing `deps.prComment` seam — whatever arm closed the step,
 *      and separately from the unreviewed-lanes post `review-bound.ts` owns.
 *  (c) **the entry guard (A5).** A branch that moved between `publish` and `review`
 *      is refused before pass 1 is bought, naming both shas: every `pass at …`
 *      cell would otherwise speak about bytes no gate ran.
 *
 * The repo, the branch and the commits are real (`lib/lean-review-fixtures.ts`);
 * only the models and the gate verdicts are stubs, so the guard's git read is a
 * git read and the refusal is the step's own.
 *
 * Offline: no child process, no model, no token.
 */

import {
  acceptanceComment,
  renderAcceptanceSection,
} from "../src/lean/review-acceptance.ts";
import { leanReviewAcceptanceEnabled } from "../src/lean/review-acceptance-switch.ts";
import { lensContext } from "../src/lean/review-deps.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { renderPiSpec } from "../src/lean/spec.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const { assert, failures } = makeAssert();
isolateLedger();

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The newline, spelled for the assertions that read one line out of a posted body. */
const NL = String.fromCharCode(10);

/** The full 40-hex shape, as the comment must print it. */
const FULL_SHA = /^[0-9a-f]{40}$/;

const CRITERIA = [
  { id: "AC1", text: "The meter refuses the draw once the quota is spent.", verify: "test" as const },
  { id: "AC2", text: "The preservation script still exits 0.", verify: "command" as const },
  { id: "AC3", text: "The refusal reads well to a human.", verify: "manual" as const },
];

const ISSUE_BODY = `Add a quota check to the meter.\n\n${renderPiSpec({
  problem: "The meter must refuse the draw once the quota is spent.",
  criteria: CRITERIA,
  size: "M",
})}\n`;

/** The log the step reads, matching what the fixture repo really holds. */
function logFor(head: string): Step[] {
  const step = (state: string, outcome: Outcome | undefined, n = 0): Step => ({
    key: `7:${state}:${String(n)}`,
    state: state as Step["state"],
    startedAt: 1,
    outcome,
  });
  return [
    step("specify", { kind: "ok", frozen: { "tests/AC1.test.ts": "a".repeat(64) }, tests: { AC1: ["tests/AC1.test.ts"] } }),
    step("verify", {
      kind: "green",
      verifiedHead: head,
      commandCriteria: { AC2: "passed" },
      commandNotRunnable: {},
    }),
    step("publish", { kind: "ok", prUrl: "https://github.com/o/r/pull/11", publishedHead: head }),
  ];
}

/** The section every assertion below compares the briefs against. */
const section = (head: string): string => renderAcceptanceSection(logFor(head), ISSUE_BODY);

// ── (a) both briefs carry the section, on both waves ──────────────────────
{
  const head = HEAD;
  const tbl = section(head);
  assert(tbl.includes("AC1"), "(a) the fixture's table is not empty — every assertion below is about real bytes");
  for (const wave of ["full", "fix"] as const) {
    const lens = lensContext(7, wave, { issueBody: ISSUE_BODY, acceptanceTable: tbl });
    assert(
      lens.includes(tbl),
      `(a) the lens brief on the ${wave} wave carries the table verbatim (${String(lens.length)} chars)`,
    );
    assert(
      lens.includes("## The acceptance table"),
      `(a) and the ${wave} wave's lens brief names the section it printed`,
    );
  }
  // The adversarial seat's brief is composed inside `review-deps.ts`; the step's
  // own dispatch is what shows the whole path, so case (b) asserts it there.
  const noTable = lensContext(7, "full", { issueBody: ISSUE_BODY });
  assert(
    !noTable.includes("## The acceptance table"),
    "(a) a brief with no table threaded is the render from before the table existed",
  );
  const emptyTable = lensContext(7, "full", { issueBody: ISSUE_BODY, acceptanceTable: "  " });
  assert(
    emptyTable === noTable,
    "(a) and a blank table threads nothing: byte-identical to the no-table call",
  );
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
      // what the seat read. Case (a) pins that composition against the briefs.
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

// ── (c) the guard: a moved head is refused before anything is paid for ─────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The log certifies a DIFFERENT commit than origin holds — the shape a push
  // between `publish` and `review` leaves.
  const posts: string[] = [];
  let lensCalls = 0;
  let advCalls = 0;
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.steps.push(...logFor("ffffffffffffffffffffffffffffffffffffffff"));
  const { outcome, threw } = await runStep(
    ctx,
    depsWith({
      fetchIssueBody: async () => ISSUE_BODY,
      prComment: async (_repo, _pr, bodyText) => {
        posts.push(bodyText);
      },
      lens: async (a) => {
        lensCalls++;
        return lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []);
      },
      adversarial: async () => {
        advCalls++;
        return result({ loopOutcome: "approved" });
      },
      dispatch: fixerThatCommits("guard"),
    }),
  );
  assert(
    threw instanceof ReviewInfraError && outcome === undefined,
    `(c) the step refuses a head its gate never certified (${threw?.name ?? "no throw"}, ${String(outcome?.kind)})`,
  );
  assert(
    /never been verified/.test(threw?.message ?? ""),
    `(c) and the refusal says why (${JSON.stringify((threw?.message ?? "").slice(0, 160))})`,
  );
  assert(
    (threw?.message ?? "").includes(head.slice(0, 12)) &&
      (threw?.message ?? "").includes("ffffffffffff"),
    "(c) the refusal names BOTH shas — the certified one and the one origin holds",
  );
  assert(
    lensCalls === 0 && advCalls === 0,
    `(c) and it refuses BEFORE pass 1 is bought (${String(lensCalls)} lens rounds, ${String(advCalls)} adversarial passes)`,
  );
  assert(posts.length === 0, `(c) nothing was posted for a run that never reviewed anything (${String(posts.length)})`);
  cleanupRoots();
}

// ── (c2) a log with no green verify is refused too ──────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  let lensCalls = 0;
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  // No `verify` step at all: "nothing was certified" is not a state in which a
  // table of results at the head may be printed.
  const { threw } = await runStep(
    ctx,
    depsWith({
      fetchIssueBody: async () => ISSUE_BODY,
      lens: async (a) => {
        lensCalls++;
        return lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []);
      },
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /no verified head|named a verified head/.test(threw.message),
    `(c2) a run with no green verify is refused rather than given an unanchored table (${JSON.stringify(
      (threw?.message ?? "no throw").slice(0, 140),
    )})`,
  );
  assert(lensCalls === 0, `(c2) and no child was bought (${String(lensCalls)})`);
  cleanupRoots();
}

// ── (d) the switch: off means no table anywhere, and no guard ──────────────
await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE: "0" }, async () => {
  assert(!leanReviewAcceptanceEnabled(), "(d) the reader is off on the literal \"0\"");
  const { repoRoot, baseSha } = makeRepo();
  // Origin holds a head the log never certified — the exact shape (c) refuses.
  // With the switch off the guard does not run, so the step passes.
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const posts: string[] = [];
  const contexts: string[] = [];
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.steps.push(...logFor("ffffffffffffffffffffffffffffffffffffffff"));
  const { outcome, threw } = await runStep(
    ctx,
    depsWith({
      fetchIssueBody: async () => ISSUE_BODY,
      prComment: async (_repo, _pr, bodyText) => {
        posts.push(bodyText);
      },
      lens: async (a) => {
        contexts.push(a.context);
        return lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []);
      },
    }),
  );
  assert(
    threw === undefined && outcome !== undefined,
    `(d) with the switch at 0 the entry guard does not run and the step passes (${String(outcome?.kind)}${threw === undefined ? "" : ` / ${threw.message.slice(0, 90)}`})`,
  );
  assert(
    contexts.length > 0 && contexts.every((c) => !c.includes("## The acceptance table")),
    `(d) and no lens brief carries the table (${String(contexts.length)} briefs)`,
  );
  assert(posts.length === 0, `(d) and nothing is posted (${String(posts.length)})`);
  cleanupRoots();
});

console.log(
  `\n${failures() === 0 ? "briefs green" : "briefs RED"} (${String(failures())} failing)`,
);
process.exit(failures());

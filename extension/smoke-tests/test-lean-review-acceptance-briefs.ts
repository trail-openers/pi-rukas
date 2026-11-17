#!/usr/bin/env bun
/**
 * The acceptance table reaches BOTH reviewer briefs and the PR comment, and the
 * step refuses a head the gate never certified.
 *
 * Four claims, each of which a stub of the other half cannot fake:
 *
 *  (a) **the two briefs.** `lensContext` is what six lens children read and
 *      `adversarialContext` is what the adversarial reviewer reads; both must
 *      carry the section, on BOTH waves. The fixer's brief is NOT one of the two
 *      (A4): it already names the frozen files it may not touch, and a seat that
 *      edits the tree does not need the gate's results re-stated to it.
 *  (b) **one comment per attempt.** The step posts the table once on the run's PR
 *      through the existing `deps.prComment` seam — whatever arm closed the step,
 *      and separately from the unreviewed-lanes post `review-bound.ts` owns.
 * (b2) **both comments, when both are owed.** The table and the unreviewed-lanes
 *      disclosure are two claims, and every other post case here composes only one
 *      of them, so this case pins the pair: two posts, in order, and what a forge
 *      that refuses one leaves on the outcome the operator and the host read.
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
import { execp } from "../src/exec.ts";
import { leanReviewAcceptanceEnabled } from "../src/lean/review-acceptance-switch.ts";
import { lensContext } from "../src/lean/review-deps.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { renderPiSpec } from "../src/lean/spec.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  frozenBlob,
  lensRoundFor,
  makeRepo,
  result,
  runStep,
  setup,
  stepGitEnv,
} from "./lib/lean-review-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const { assert, failures } = makeAssert();
isolateLedger();

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The newline, spelled for the assertions that read one line out of a posted body. */
const NL = String.fromCharCode(10);

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

/**
 * The log the step reads, matching what the fixture repo really holds.
 *
 * `frozen` overrides the recorded digest of the frozen test. A case that buys a fix
 * wave MUST pass the repo's own hash (`sha256(frozenBlob(repoRoot, head))`): the
 * review step's integration re-hashes the committed bytes, so a made-up digest makes
 * every fix round "change the frozen acceptance contract" and the case measures that
 * refusal instead of what it names. A case that buys no fixer never reaches that
 * proof and the placeholder is enough.
 */
function logFor(head: string, frozen?: Record<string, string>): Step[] {
  const step = (state: string, outcome: Outcome | undefined, n = 0): Step => ({
    key: `7:${state}:${String(n)}`,
    state: state as Step["state"],
    startedAt: 1,
    outcome,
  });
  return [
    step("specify", { kind: "ok", frozen: frozen ?? { "tests/AC1.test.ts": "a".repeat(64) }, tests: { AC1: ["tests/AC1.test.ts"] } }),
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

/** The frozen record a fix-wave case must hand `logFor`: the digest of the repo's own
 * committed bytes, which is the one the step's own frozen proof accepts. */
const realFrozen = (repoRoot: string, head: string): Record<string, string> => ({
  "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, head)),
});

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
  // The regression, at the surface that had the bug: the step's own post path for a
  // run whose contract the record holds rather than the issue. A prose body with a
  // derived spec on the run rendered `""` at the comment (so nothing posted) while
  // the briefs were handed a full table — the disclosure existed everywhere but the
  // one place a PR reviewer would read it.
  {
    const derivedBody = "Add a quota check to the meter, in prose only.\n";
    const derivedRun = {
      spec: {
        problem: "The meter must refuse the draw once the quota is spent.",
        criteria: CRITERIA.map((c) => ({ ...c })),
        size: "M" as const,
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
        fetchIssueBody: async () => derivedBody,
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
      renderAcceptanceSection(logFor(dHead), derivedBody, { derivedSpec: derivedRun }) !== "" &&
        (dPosts[0] ?? "").includes("AC1") &&
        (dPosts[0] ?? "").includes(`pass at ${dHead.slice(0, 12)}`),
      "(b) …and that comment is the table of the DERIVED criteria, at the head the gate certified",
    );
  }
  cleanupRoots();
}

// ── (b2) both disclosures post, and a forge that refuses one says so on the record ──
//
// The pair, not either half: the acceptance table and the unreviewed-lanes comment
// are two separate claims, and every other post case here drives a step that composes
// only one of them (a stub issue body has no parsable spec, so the table arm is `""`).
// Deleting either post, or swapping them, left every other file green — which is why
// this case pins the count, the order, AND what a refused post leaves on the outcome.
{
  // One fixture repo PER ATTEMPT. The arm buys a fix wave and `integrate` pushes the
  // fixer's commit, so a second attempt on the same clone would find origin holding a
  // head no green `verify` of its own log named — the entry guard would then refuse the
  // run for the previous attempt's fix rather than for anything this arm did.
  const makeCase = async () => {
    const { repoRoot, baseSha } = makeRepo();    const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
    const ctx = ctxFor(repoRoot, baseSha, BRANCH);
    // The step's clock measures from the newest `review` entry's `startedAt`, which the
    // engine writes ahead of the handler; seeding it once at 0 is what makes "the bound
    // has been spent" a fact the step reads. The clock then advances ONLY once `past` is
    // set, so every read up to and including the fixer stays inside the 30-minute bound
    // and the single read taken AFTER the fix and BEFORE pass 2 fires. That is R2, the
    // arm that records a bound on a RETURNED pass, and so the only one that owes TWO
    // comments; the pre-fix arm hands back with a THROWN stop instead, which is why the
    // early reads must stay inert.
    ctx.steps.push({ key: ctx.stepKey, state: "review", startedAt: 0 } as Step);
    let past = false;
    ctx.now = () => (past ? 31 * 60_000 : 1);
    // `realFrozen` records the digest of the repo's OWN committed bytes, so the fix round
    // this arm buys is legal rather than a tampering refusal.
    ctx.steps.push(...logFor(head, realFrozen(repoRoot, head)));
    const fixer = fixerThatCommits(`b2-${String(tag++)}`);
    // `dispatch` is the step's last read before R2, so it is the seam that arms the
    // bound: everything up to and including the fixer ran inside the budget. The commit
    // stays LOCAL, which is what `lib/lean-review-problem-capture.ts` does for the same
    // wave: `integrate` then pushes it from the run's tree, and the entry guard's origin
    // read on a later attempt is satisfied by the `verify:1`/`publish:1` rows this case
    // appends, which name that head too.
    const dispatch = async (spec: DispatchSpec): Promise<DispatchResult> => {
      const out = await fixer(spec);
      past = true;
      return out;
    };
    return { ctx, head, dispatch };
  };
  let tag = 0;

  const drive = async (fail: "none" | "first" | "both") => {
    const { ctx, head, dispatch } = await makeCase();
    const posts: string[] = [];
    let failed = 0;
    const deps = depsWith({
      fetchIssueBody: async () => ISSUE_BODY,
      prComment: async (_repo, _pr, bodyText) => {
        posts.push(bodyText);
        const wantFail = fail === "both" || (fail === "first" && failed === 0);
        if (wantFail) {
          failed++;
          throw new Error("forge refused the comment");
        }
      },
      lens: async (a) =>
        // Pass 1 blocks (which buys the wave) and the re-review ANSWERS the fix: an empty
        // round stamped with the range the step named, the production layer's own shape.
        // A re-review that re-reported the row would hand the run back instead of reaching
        // R2, and one that left the stamp out is refused as a whole-branch round.
        a.wave === "fix"
          ? lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", [])
          : lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "CRITICAL_ISSUES_FOUND", [
              blockingFinding(),
            ]),
      adversarial: async () => result({ loopOutcome: "approved" }),
      dispatch,
    });
    // The head the entry guard must accept: origin holds it once `integrate` has pushed
    // the fixer's commit, so the log's newest green `verify` names the same one.
    ctx.steps.push(
      {
        key: "7:verify:1",
        state: "verify",
        startedAt: 1,
        endedAt: 2,
        outcome: { kind: "green", verifiedHead: head },
      },
      {
        key: "7:publish:1",
        state: "publish",
        startedAt: 1,
        endedAt: 2,
        outcome: { kind: "ok", prUrl: "https://github.com/o/r/pull/11", publishedHead: head },
      },
    );
    const { outcome, threw } = await runStep(ctx, deps);
    return { posts, outcome, threw };
  };

  const both = await drive("none");
  assert(
    both.threw === undefined && both.outcome !== undefined,
    `(b2) the step records its bound and RETURNS while owing two disclosures (${String(both.outcome?.kind)}${both.threw === undefined ? "" : ` / ${both.threw.message.slice(0, 90)}`}) — the mutant: driving an arm that throws, whose finally-armed posts never run`,
  );
  assert(
    both.posts.length === 2,
    `(b2) exactly TWO comments — the acceptance table and the unreviewed-lanes disclosure (${String(both.posts.length)} posted: ${JSON.stringify(both.posts.map((p) => p.slice(0, 30)))}) — the mutant: deleting either post, which every other file here cannot see`,
  );
  assert(
    both.posts[0]?.includes("## The acceptance table") === true &&
      both.posts[0]?.includes("AC1") === true,
    `(b2) the FIRST comment is the acceptance table, in the order the step asks for them (${JSON.stringify(both.posts[0]?.slice(0, 40))})`,
  );
  assert(
    both.posts[1]?.includes("never judged") === true &&
      !both.posts[1]!.includes("## The acceptance table"),
    `(b2) and the SECOND is the unreviewed-lanes disclosure, with no table smuggled into it (${JSON.stringify(both.posts[1]?.slice(0, 40))})`,
  );
  assert(
    (both.outcome?.reason ?? "").includes("DISCLOSURE NOT POSTED") === false,
    `(b2) a run whose posts landed says nothing about a lost post (${JSON.stringify((both.outcome?.reason ?? "").slice(-90))})`,
  );

  // The forge refuses the TABLE only. The disclosure must still be attempted, and the
  // outcome must name what went missing — a warn line nobody reads is the silent version
  // of the failure the comment existed to disclose.
  const lostTable = await drive("first");
  assert(
    lostTable.threw === undefined && lostTable.outcome !== undefined,
    `(b2) a refused comment never fails the step (${String(lostTable.outcome?.kind)}${lostTable.threw === undefined ? "" : ` / ${lostTable.threw.message.slice(0, 90)}`})`,
  );
  assert(
    lostTable.posts.length === 2,
    `(b2) and the second post is still ATTEMPTED after the first was refused (${String(lostTable.posts.length)} attempted) — the mutant: an awaited first post whose rejection skips the second, leaving the run with neither disclosure`,
  );
  assert(
    (lostTable.outcome?.reason ?? "").includes("DISCLOSURE NOT POSTED") &&
      (lostTable.outcome?.reason ?? "").includes("acceptance table"),
    `(b2) the outcome names the table the forge refused, so a reader can tell the disclosure is missing from the PR (${JSON.stringify((lostTable.outcome?.reason ?? "").slice(-120))})`,
  );
  assert(
    !(lostTable.outcome?.reason ?? "").includes("unreviewed-lanes"),
    `(b2) and it names ONLY what went missing — the disclosure that landed is not reported as lost (${JSON.stringify((lostTable.outcome?.reason ?? "").slice(-120))})`,
  );

  // Both refused: both named, so neither absence is invisible.
  const lostBoth = await drive("both");
  const r2 = lostBoth.outcome?.reason ?? "";
  assert(
    r2.includes("acceptance table") && r2.includes("unreviewed-lanes"),
    `(b2) with the forge refusing both, the reason names both (${JSON.stringify(r2.slice(-160))})`,
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
    /never been verified|never verified|have never been verified|cannot print results/.test(threw?.message ?? ""),
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

#!/usr/bin/env bun
/**
 * The acceptance table reaches BOTH reviewer briefs, and the step refuses a head
 * the gate never certified.
 *
 * Three claims here, each of which a stub of the other half cannot fake:
 *
 *  (a) **the two briefs.** `lensContext` is what six lens children read and
 *      `adversarialContext` is what the adversarial reviewer reads; both must
 *      carry the section, on BOTH waves. The fixer's brief is NOT one of the two
 *      (A4): it already names the frozen files it may not touch, and a seat that
 *      edits the tree does not need the gate's results re-stated to it.
 * (b2) **both comments, when both are owed.** The table and the unreviewed-lanes
 *      disclosure are two claims, and every other post case here composes only one
 *      of them, so this case pins the pair: two posts, in order, and what a forge
 *      that refuses one leaves on the outcome the operator and the host read.
 *  (c) **the entry guard (A5).** A branch that moved between `publish` and `review`
 *      is refused before pass 1 is bought, naming both shas: every `pass at …`
 *      cell would otherwise speak about bytes no gate ran.
 *
 * The single-comment case (b) and its derived-spec regression live in the sibling
 * `test-lean-review-acceptance-briefs-derived.ts`; both files drive the same step
 * over the fixture in `lib/lean-review-acceptance-fixtures.ts`.
 *
 * The repo, the branch and the commits are real (`lib/lean-review-fixtures.ts`);
 * only the models and the gate verdicts are stubs, so the guard's git read is a
 * git read and the refusal is the step's own.
 *
 * Offline: no child process, no model, no token.
 */

import { renderAcceptanceSection } from "../src/lean/review-acceptance.ts";
import { lensContext } from "../src/lean/review-deps.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import type { Step } from "../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import {
  HEAD,
  ISSUE_BODY,
  logFor,
  realFrozen,
} from "./lib/lean-review-acceptance-fixtures.ts";
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
  // own dispatch is what shows the whole path, so the sibling's case (b) asserts it there.
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
  let tag = 0;
  const makeCase = async () => {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
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

console.log(
  `\n${failures() === 0 ? "briefs green" : "briefs RED"} (${String(failures())} failing)`,
);
process.exit(failures());

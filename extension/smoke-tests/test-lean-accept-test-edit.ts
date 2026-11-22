#!/usr/bin/env bun
/**
 * An edited pre-existing test whose BASE version fails against the head code reaches review,
 * and lands only when the NEWEST review accepts that exact file on the verified head.
 *
 *  (v) verify records the file in `projectRoster.baseVersionRed` and goes green, rather than a
 *      builder-fixable red no build round can clear;
 *  (r) the review step tells its seats which files need a grant, and records the adversarial
 *      reviewer's structured `lean-test-accept v1` block as `review.accepted`, bound to the head;
 *  (l) land refuses without the acceptance — naming the file — and lands with it; an acceptance
 *      on another head, on another path, or in an older review does not carry;
 *  (p) the block is read strictly, and the record is validated and rebuilt by the loader.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import { rmSync } from "node:fs";
import { reviewCompleteOf } from "../src/headless/work-lean-pr.ts";
import { engineFacts } from "../src/lean/engine-facts.ts";
import { readTestAcceptances } from "../src/lean/review-test-accept.ts";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { buildOutcome, outcomeProblem } from "../src/lean/state-outcome.ts";
import { type LeanRun, type Outcome, type Step, createRun } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { ISSUE_BODY, logFor, realFrozen } from "./lib/lean-review-acceptance-fixtures.ts";
import {
  BRANCH,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const { assert, failures } = makeAssert();
isolateLedger();
const FILE = "tests/test-a.sh";
const NAME = "tests/test-a.sh::one";
const OTHER_HEAD = "f".repeat(40);
const block = (body: string): string => `Reviewed.\n\n\`\`\`lean-test-accept v1\n${body}\n\`\`\`\n`;
const grant = (head: string, p = FILE) => ({
  path: p,
  reason: "the issue changes this output",
  head,
});

// ── (v) the step records the failing base version and goes green ───────────
const verified = await runVerify({
  issue: 2501,
  implement: true,
  config: { fast: PASS_TIER },
  roster: { files: [FILE], basePassed: [NAME], headPassed: [NAME] },
  editProjectTests: { [FILE]: "#!/bin/sh\nexit 0\n" },
  baseProjectTestFails: true,
});
const roster = verified.outcome?.projectRoster as ProjectRosterRecord | undefined;
assert(
  verified.outcome?.kind === "green",
  `(v) a failing base version is recorded, not a builder-fixable red (got ${verified.outcome?.kind ?? `threw: ${verified.threw?.message}`})`,
);
assert(
  JSON.stringify(roster?.baseVersionRed) === JSON.stringify([FILE]) &&
    roster?.editedFiles === undefined,
  `(v) the roster names the file under baseVersionRed, not editedFiles (${JSON.stringify(roster)})`,
);
const verifiedHead = verified.outcome?.verifiedHead ?? "";

/** A log the land gate reads: the real verify outcome, then each review, then a green ci. */
function runWith(reviews: Outcome[]): LeanRun {
  const at = (state: string, outcome: Outcome, n: number): Step => ({
    key: `2501:${state}:${String(n)}`,
    state: state as Step["state"],
    startedAt: n,
    outcome,
  });
  return {
    ...createRun({
      issue: 2501,
      version: "test",
      models: {},
      baseSha: roster?.baseSha ?? "0".repeat(40),
      branch: "lean/issue-2501",
    }),
    state: "landed",
    steps: [
      at("verify", verified.outcome as Outcome, 0),
      ...reviews.map((r, i) => at("review", r, i + 1)),
      at("ci", { kind: "green" }, 9),
    ],
  } as LeanRun;
}
const review = (accepted?: ReturnType<typeof grant>[]): Outcome => ({
  kind: "done",
  review: { rounds: [], waves: [], ...(accepted === undefined ? {} : { accepted }) },
});

// ── (l) land without and with the acceptance ──────────────────────────────
{
  const bare = runWith([review()]);
  assert(!engineFacts.landEarned(bare), "(l) an unaccepted failing base version refuses land");
  assert(
    engineFacts.landRefusal(bare).includes(FILE),
    `(l) the refusal names the file (${engineFacts.landRefusal(bare).slice(0, 160)})`,
  );
  assert(
    engineFacts.landEarned(runWith([review([grant(verifiedHead)])])),
    "(l) the newest review accepting the file on the verified head lands",
  );
  assert(
    !engineFacts.landEarned(runWith([review([grant(OTHER_HEAD)])])),
    "(l) an acceptance bound to another head does not carry",
  );
  assert(
    !engineFacts.landEarned(runWith([review([grant(verifiedHead, "tests/test-b.sh")])])),
    "(l) an acceptance naming another path does not carry",
  );
  assert(
    !engineFacts.landEarned(runWith([review([grant(verifiedHead)]), review()])),
    "(l) a stale acceptance from an older review does not carry past the newest one",
  );
}

// ── (h) the headless cap never offers a merge on a head land refuses ───────
{
  const judged = (accepted?: ReturnType<typeof grant>[]): boolean => {
    const r = review(accepted);
    r.review?.rounds.push({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
    const steps = runWith([r]).steps;
    steps.splice(1, 0, {
      key: "2501:publish:0",
      state: "publish",
      startedAt: 0,
      outcome: { kind: "ok" },
    });
    return reviewCompleteOf(steps);
  };
  assert(!judged(), "(h) an unaccepted failing base version is not a complete review");
  assert(judged([grant(verifiedHead)]), "(h) the same review with the grant is complete");
}

// ── (r) the review step's wiring, end to end ──────────────────────────────
{
  // With `fixReply`, pass 1's lens round blocks, a fixer pushes, and the second adversarial pass
  // (the fix wave's) answers `fixReply`: its grant is the one the record keeps.
  const drive = async (reply: string, fixReply?: string) => {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({
      repoRoot,
      baseSha,
      branch: BRANCH,
      feature: "export const f = 2;\n",
    });
    const ctx = ctxFor(repoRoot, baseSha, BRANCH);
    const log = logFor(head, realFrozen(repoRoot, head));
    const verify = log.find((s) => s.state === "verify");
    if (verify?.outcome !== undefined)
      verify.outcome.projectRoster = { ...(roster as ProjectRosterRecord), baseVersionRed: [FILE] };
    ctx.steps.push(...log);
    const tables: (string | undefined)[] = [];
    const { outcome, threw } = await runStep(
      ctx,
      depsWith({
        fetchIssueBody: async () => ISSUE_BODY,
        prComment: async () => undefined,
        lens: async (a) =>
          fixReply !== undefined && a.wave !== "fix"
            ? lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding({ severity: "CRITICAL" })])
            : lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []),
        adversarial: async (a) => {
          tables.push(a.acceptanceTable);
          const text = a.wave === "fix" ? (fixReply ?? reply) : reply;
          return result({ loopOutcome: "approved", text });
        },
        ...(fixReply === undefined ? {} : { dispatch: fixerThatCommits("accept") }),
      }),
    );
    return { head, outcome, threw, tables };
  };
  const granted = await drive(
    block(JSON.stringify([{ path: FILE, reason: "the issue changes it" }])),
  );
  assert(granted.threw === undefined, `(r) the step passed (${granted.threw?.message ?? ""})`);
  assert(
    granted.tables.length > 0 &&
      granted.tables.every((t) => t?.includes(`\`${FILE}\``) && t.includes("lean-test-accept v1")),
    "(r) the adversarial seat is told which edited test needs a grant, and how to give it",
  );
  assert(
    JSON.stringify(granted.outcome?.review?.accepted) ===
      JSON.stringify([{ path: FILE, reason: "the issue changes it", head: granted.head }]),
    `(r) the grant is recorded with the head the pass read (${JSON.stringify(granted.outcome?.review)})`,
  );
  assert(
    outcomeProblem(granted.outcome as unknown as Record<string, unknown>, "review") === undefined &&
      JSON.stringify(
        buildOutcome(granted.outcome as unknown as Record<string, unknown>).review?.accepted,
      ) === JSON.stringify(granted.outcome?.review?.accepted),
    "(p) the record the step writes is one the loader accepts and rebuilds unchanged",
  );
  const grantBlock = block(JSON.stringify([{ path: FILE, reason: "the issue changes it" }]));
  const reGranted = await drive("No grant yet.", grantBlock);
  const fixHead = reGranted.outcome?.review?.waves.at(-1)?.head;
  assert(
    reGranted.outcome?.kind === "fixed" &&
      fixHead !== undefined &&
      fixHead !== reGranted.head &&
      reGranted.outcome.review?.accepted?.[0]?.head === fixHead,
    `(r) the fix wave's second pass grants on the head the fixer pushed (${JSON.stringify(reGranted.outcome?.review)})`,
  );
  const dropped = await drive(grantBlock, "No grant on the fixed head.");
  assert(
    dropped.outcome?.kind === "fixed" && dropped.outcome.review?.accepted === undefined,
    "(r) a pass-1 grant is not kept when the fix wave's pass grants nothing",
  );
  const withheld = await drive("VERDICT: APPROVED, but no grant.");
  assert(
    withheld.threw === undefined && withheld.outcome?.review?.accepted === undefined,
    "(r) a reply with no block grants nothing",
  );
  cleanupRoots();
}

// ── (p) the block is read strictly, and the loader refuses a malformed record ──
{
  const pending = [FILE];
  const one = JSON.stringify([
    { path: FILE, reason: "ok" },
    { path: "x.sh", reason: "not pending" },
  ]);
  assert(
    readTestAcceptances(block(one), pending, verifiedHead).length === 1,
    "(p) a path nobody asked about is dropped",
  );
  assert(
    readTestAcceptances(block(one) + block(one), pending, verifiedHead).length === 0,
    "(p) two blocks grant nothing",
  );
  assert(
    readTestAcceptances(block("[{"), pending, verifiedHead).length === 0,
    "(p) invalid JSON grants nothing",
  );
  assert(
    readTestAcceptances(block(JSON.stringify([{ path: FILE }])), pending, verifiedHead).length ===
      0,
    "(p) an entry with no reason grants nothing",
  );
  assert(
    readTestAcceptances(`\`lean-test-accept v1\` ${one}`, pending, verifiedHead).length === 0,
    "(p) prose that names the block's info string is not a block",
  );
  assert(
    outcomeProblem(
      {
        kind: "done",
        review: { rounds: [], waves: [], accepted: [{ ...grant(verifiedHead), head: "abc" }] },
      },
      "review",
    ) !== undefined,
    "(p) the loader refuses an acceptance not bound to a full head",
  );
  assert(
    outcomeProblem(
      {
        kind: "green",
        projectRoster: {
          ...(roster as ProjectRosterRecord),
          baseVersionRed: Array.from({ length: 21 }, (_, i) => `t${String(i)}.sh`),
        },
      },
      "verify",
    ) !== undefined,
    "(p) the loader refuses a baseVersionRed list past its cap",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(
  `\n${failures() === 0 ? "accept-test-edit green" : "accept-test-edit RED"} (${String(failures())} failing)`,
);
process.exit(failures());

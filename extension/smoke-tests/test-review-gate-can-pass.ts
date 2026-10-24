#!/usr/bin/env bun
/**
 * A review that passes must be allowed to pass, and one whose fix never landed
 * must stop rather than read the same branch again.
 *
 * Two defects, both at the lens-review boundary, and between them they are the
 * best explanation on record for why no cycle has ever reached `ci`.
 *
 * 1. **The gate could not PASS.** `appendReviewCapHit` was called
 *    unconditionally, outside the verdict if/else, and guards only on the
 *    round number and the wall clock — never on the verdict. So a review
 *    returning APPROVED on round 3 got a `round-cap` cap-hit appended right
 *    after its `lens-approved` event, and `nextStep` — which reads the log
 *    tail — routed it to `handoff` instead of `ci`. Rounds 1-2 finding issues
 *    and round 3 approving is the ordinary success shape. This is #328's
 *    "gate that cannot fail" in mirror image, and it arrived in #457's fix for
 *    handoffs blaming the wrong gate.
 *
 *    It also double-capped `REVIEW_INCOMPLETE`: that branch appends its own
 *    `review-incomplete` cap, then got a `round-cap` on top which became the
 *    tail, so the operator was told the loop ran out of rounds when in fact a
 *    lens had failed every retry.
 *
 * 2. **A failed lens-fix integration kept the loop running.** When
 *    `integrateLensFix` returned an error the driver recorded a plumb-report
 *    and nothing else — deliberately, so that "the tail remains
 *    adversarial-approved and nextStep() routes correctly". The failure was
 *    hidden from the one consumer that could act on it. The next round then
 *    re-read `origin/<base>..origin/<branch>`, which had not moved, and
 *    re-reported the identical findings until the round cap fired. Measured on
 *    One measured cycle: two full rounds after the driver had already logged that it
 *    refused to integrate. Same shape on #673 and #677.
 *
 *    The silent sibling was worse: `res.empty` mapped to `{committed:false}`
 *    with no error, so a fixer that wrote nothing produced not even a report.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { nextStep } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// #533 — nextStep returns a discriminated result; unwrap for comparisons.
function stepOf(s: WorkState): string {
  const d = nextStep(s);
  return d.kind === "step" ? d.step : d.kind;
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const code = (f: string) =>
  readFileSync(path.join(SRC, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

/** A cycle sitting at lens-review on round 3, with the given tail events. */
const stateWith = (events: WorkEvent[]): WorkState =>
  ({
    issue: 900,
    eventLog: events,
    pipelineState: {
      currentStep: "lens-review",
      lastCompletedStep: "lens-review",
      status: "running",
      reviewRound: 3,
      branchName: "feature/issue-900",
      prNumber: 1,
      plumbReports: [],
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any;

const approved: WorkEvent = {
  kind: "lens-approved",
  at: 1,
  jobId: "j",
  round: 3,
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
} as any;
const roundCap: WorkEvent = {
  kind: "cap-hit",
  at: 2,
  cap: "round-cap",
  reviewRound: 3,
  nextStep: "handoff",
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
} as any;

// ------------- runLens itself, against real git, must not cap an approval
//
// The routing assertion below is a consequence, not a canary: `nextStep` is a
// pure function of state, so feeding it a hand-built log proves nothing about
// what `runLens` EMITS. The defect was entirely in the emission. So drive the
// real function over a real repository and read the log it produces.

{
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { promisify } = await import("node:util");
  const { runLens } = await import("../src/work-driver-lens.ts");
  const { mkLensSummary } = await import("./test-helpers.ts");
  const execFileP = promisify(execFile);

  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-lensgate-"));
  try {
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
    await execFileP("git", ["init", "--initial-branch=main", repo]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "a.txt"), "base\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    // A branch with a real commit, so the diff is non-empty — an empty diff
    // short-circuits before the verdict block and would prove nothing.
    await git(repo, ["checkout", "-q", "-b", "feature/issue-900"]);
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    await git(repo, ["commit", "-qam", "work"]);
    await git(repo, ["push", "-q", "-u", "origin", "feature/issue-900"]);
    await git(repo, ["checkout", "-q", "main"]);

    const ctx = {
      repoRoot: repo,
      issue: 900,
      // Round 3 of 3 with an APPROVED verdict: the exact shape that parked.
      lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    } as any;
    const before = {
      issue: 900,
      eventLog: [],
      pipelineState: {
        currentStep: "lens-review",
        lastCompletedStep: "adversarial",
        status: "running",
        reviewRound: 2,
        branchName: "feature/issue-900",
        prNumber: 1,
        worktrees: {},
        plumbReports: [],
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    } as any;

    const after = await runLens(ctx, before, Date.now());
    const kinds = (after.eventLog ?? []).map((e: WorkEvent) => e.kind);
    assert(
      kinds.includes("lens-approved"),
      `runLens recorded the approval (log: ${JSON.stringify(kinds)})`,
    );
    assert(
      !kinds.includes("cap-hit"),
      `canary: an APPROVED round 3 emits NO cap-hit (log: ${JSON.stringify(kinds)}) — it emitted round-cap, and that parked every successful cycle`,
    );
    assert(
      stepOf(after) === "ci",
      `canary: and the state runLens actually produced routes to ci (got ${stepOf(after)})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // The consequence, pinned separately: a cap-hit on top of an approval WOULD
  // redirect it. This is what makes the emission above load-bearing.
  assert(
    stepOf(stateWith([approved])) === "ci" && stepOf(stateWith([approved, roundCap])) === "handoff",
    "routing consequence: an approval routes to ci, an approval plus a cap-hit routes to handoff",
  );
}

{
  // The verdict → events tail moved to work-driver-lens-verdicts.ts (split
  // for module size hygiene) — the landmarks live there now.
  const lens = code("work-driver-lens-verdicts.ts");
  const approvedIdx = lens.indexOf('summary.verdict === "APPROVED"');
  const issuesIdx = lens.indexOf('kind: "lens-issues-found"');
  const capIdx = lens.indexOf("appendReviewCapHit(");
  const constIdx = lens.indexOf('REVIEW_INCOMPLETE_CAP = "review-incomplete"');
  const fallbackIdx = lens.indexOf("capKilled ?? REVIEW_INCOMPLETE_CAP");
  assert(
    approvedIdx >= 0 && issuesIdx >= 0 && capIdx >= 0 && constIdx >= 0 && fallbackIdx >= 0,
    "all five landmarks are present in work-driver-lens-verdicts.ts (incl. the named REVIEW_INCOMPLETE_CAP const + its bare `??` fallback)",
  );
  assert(
    capIdx > issuesIdx && capIdx < fallbackIdx,
    "canary: appendReviewCapHit is called inside the ISSUES_FOUND branch only — it ran unconditionally",
  );
  assert(
    (lens.match(/appendReviewCapHit\(/g) ?? []).length === 1,
    "...exactly once, so no branch can pick up a second cap",
  );
}

// ---------------- a failed lens-fix integration halts, and says why

{
  const adv = code("work-driver-adversarial.ts");
  assert(
    /if \(!result\.committed\)/.test(adv),
    "canary: the halt triggers on !committed, not just on an error — the empty case was silent",
  );
  assert(
    /cap: "lens-fix-not-integrated"/.test(adv),
    "canary: it emits a real cap-hit — the failure used to go only to plumbReports, invisible to nextStep",
  );
  // The old comment justified hiding it: "so the tail remains
  // adversarial-approved and nextStep() routes correctly". Routing was
  // preserved by concealing the fault from routing.
  assert(
    !/tail remains "adversarial-approved" and nextStep\(\) routes correctly[\s\S]{0,200}plumbReports\.push[\s\S]{0,400}\}\s*\n\s*\/\/ `integrate\(\)` already pushed/.test(
      readFileSync(path.join(SRC, "work-driver-adversarial.ts"), "utf8"),
    ),
    "...and no longer falls through to another review round",
  );
}

{
  const capped = stateWith([
    approved,
    {
      kind: "cap-hit",
      at: 3,
      cap: "lens-fix-not-integrated",
      reviewRound: 3,
      nextStep: "handoff",
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    } as any,
  ]);
  assert(stepOf(capped) === "handoff", "a lens-fix-not-integrated cap routes to handoff");
  const why = explainCap("lens-fix-not-integrated", capped);
  assert(
    why.length > 0 && !/^the cycle halted without recording/.test(why),
    "canary: the cap has its own explanation — an unregistered cap reads to the operator as a crash",
  );
  assert(
    /worktree/.test(why),
    "...and points at the worktree, where the fix may still be sitting uncommitted",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

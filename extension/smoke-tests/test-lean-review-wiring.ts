#!/usr/bin/env bun
/**
 * lean/review — the step's own contract, driven with both gates and the fixer
 * stubbed and a real temp git repo behind them.
 *
 * The step makes four claims worth testing rather than reading, and each is a
 * claim a stub of the gates CANNOT fake on its own — so the repo, the branch and
 * the commits are real, and only the models are stubs:
 *
 *   (a) `done` only when BOTH gates clear, and the reason names the commit;
 *   (b) a gate that produced no verdict is never a pass (the loop's `infra`
 *       arm, the lens round's `REVIEW_INCOMPLETE`);
 *   (c) a fix round's commit lands on the run's branch and on origin, and the
 *       next round reviews THAT and not the previous head;
 *   (d) the frozen contract survives: a fixer that committed a change to a
 *       frozen test is refused, and the run's worktree is put back where the
 *       gates read it.
 *
 * Plus the deterministic preconditions, which all run before a single child is
 * paid: an unreadable origin, a run with no base, and a budget too small to pay
 * for a round are all refusals, never a `done`.
 *
 * The gates and the fixer are the three injected seams of `ReviewDeps`, so no
 * child process is spawned and no token is spent.
 *
 * The two cases that pin ABSENCE OF SIGNAL — a lens round that ran no lens, and
 * the evidence helpers reading a ref that cannot exist — live in
 * `test-lean-review-absence.ts`, which shares this file's repo harness through
 * `lib/lean-review-fixtures.ts`.
 */

import path from "node:path";
import { ReviewInfraError } from "../src/lean/review.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { DispatchSpec } from "../src/types.ts";
import {
  BRANCH,
  USAGE,
  type ReviewDeps,
  cleanupRoots,
  ctxFor,
  depsWith,
  frozenBlob,
  git,
  makeRepo,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { put } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (a) both gates clean → `done`, and the reason names the reviewed commit ──
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const seen: string[] = [];
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async (a) => {
        seen.push(`adv:${a.head}`);
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        seen.push(`lens:${a.head}`);
        // The production shape of a clean round: six lenses ran, so the round
        // reports their usage. A round with `usage: undefined` is a round that
        // ran nobody, and the step refuses it (`test-lean-review-absence.ts`).
        return { verdict: "APPROVED", findings: "", usage: USAGE };
      },
    }),
  );
  assert(threw === undefined, `(a) a clean run does not throw (${threw?.message})`);
  assert(outcome?.kind === "done", `(a) both gates clean is "done" (got ${outcome?.kind})`);
  assert(
    (outcome?.reason ?? "").includes(head.slice(0, 12)),
    `(a) the reason names the commit the gates read`,
  );
  assert(
    seen.length === 2 && seen[0] === `adv:${head}` && seen[1] === `lens:${head}`,
    `(a) both gates reviewed the SAME commit (${seen.join(", ")})`,
  );
  assert(
    (outcome?.dispatches ?? []).length === 2 && (outcome?.dispatches ?? []).every((r) => r.ok),
    `(a) both gate rounds are recorded as cost rows`,
  );
}

// ── (b) a gate with no verdict is not a pass ────────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ adversarial: async () => result({ loopOutcome: "infra-failure" }) }),
  );
  assert(
    threw instanceof ReviewInfraError && /no verdict/.test(threw.message),
    `(b1) an adversarial pass with no verdict throws rather than passing (${threw?.message})`,
  );
  const { threw: t2 } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      lens: async () => ({ verdict: "REVIEW_INCOMPLETE", findings: "x", usage: USAGE }),
    }),
  );
  assert(
    t2 instanceof ReviewInfraError && /did not complete/.test(t2.message),
    `(b2) an incomplete lens round throws rather than being fixed against (${t2?.message})`,
  );
}

// ── (c) a fix round lands on the branch, and the next round reviews THAT ─────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const reviewed: string[] = [];
  const seen2: string[] = [];
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  const { outcome, threw } = await run(
    ctx,
    depsWith({
      adversarial: async (a) => {
        reviewed.push(`adv:${a.head}`);
        // Findings on round 1, clean on round 2: the step must re-review what
        // its own fixer produced and not certify the round-1 head twice.
        if (reviewed.length === 1)
          return result({ loopOutcome: "rejected", text: "1. silent catch" });
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        reviewed.push(`lens:${a.head}`);
        return { verdict: "APPROVED", findings: "", usage: USAGE };
      },
      dispatch: async (spec: DispatchSpec) => {
        // The fixer's own work, made where the step sent it.
        put(spec.cwd ?? "", "fix.ts", "export const fixed = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the finding");
        return result({ role: "developer" });
      },
    }),
  );
  assert(threw === undefined, `(c) a fix round does not throw (${threw?.message})`);
  assert(
    outcome?.kind === "done",
    `(c) the run finishes once the re-review is clean (got ${outcome?.kind})`,
  );
  const branchHead = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  assert(branchHead !== head, "(c) origin's branch moved: the fixer's commit is on it");
  assert(
    git(repoRoot, "log", "--format=%s", `origin/${BRANCH}`).includes("fix: the finding"),
    "(c) the fixer's commit is on origin's branch, not just in its disposable tree",
  );
  assert(
    reviewed[1] !== `adv:${head}`,
    `(c) round 2's reviewer read the FIXED head, not round 1's (${reviewed.join(", ")})`,
  );
  assert(
    git(repoRoot, "merge-base", "--is-ancestor", head, branchHead) === "",
    "(c) the pushed head descends from the reviewed head (git's own ancestry claim held)",
  );

  // (c2) THE SAME RUN, WITH THE FROZEN RECORD PRESENT. `integrate` proves every
  // frozen blob at the fixer's head still hashes to its record before it pushes.
  // That proof is a `git show` re-hashed against a sha256; a probe reading an
  // OBJECT ID instead (`rev-parse <ref>:<path>`) matches nothing at all, so it
  // would refuse every fix round that ever committed — in the one place the step
  // claims to enforce the contract. A run that froze nothing cannot catch that:
  // `frozen` is empty and the comparison never runs. So this is (c) again with
  // the map the fixture's own base commit hashes to, and asserts the half (d)
  // cannot: a legitimate fix still lands.
  const frozenNow = { "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, "HEAD")) };
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: "ok", frozen: frozenNow, tests: { AC1: ["tests/AC1.test.ts"] } },
  });
  const second = await run(
    ctx,
    depsWith({
      adversarial: async () => {
        seen2.push("x");
        if (seen2.length === 1) return result({ loopOutcome: "rejected", text: "1. leak" });
        return result({ loopOutcome: "approved" });
      },
      lens: async () => ({ verdict: "APPROVED", findings: "", usage: USAGE }),
      dispatch: async (spec: DispatchSpec) => {
        put(spec.cwd as string, "second-fix.ts", "export const s = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the second finding");
        return result({ role: "developer" });
      },
    }),
  );
  assert(
    second.threw === undefined && second.outcome?.kind === "done",
    `(c2) a fix round touching ONLY unfrozen files passes the frozen proof — the probe hashes bytes, not an object id (${second.threw?.message ?? String(second.outcome?.kind)})`,
  );
  assert(
    git(repoRoot, "log", "--format=%s", `origin/${BRANCH}`).includes("fix: the second finding"),
    "(c2) and its commit is on origin — the proof did not refuse a legitimate fix",
  );
}

// ── (d) a fixer that rewrote the frozen contract is refused ──────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  const frozenFile = frozenBlob(repoRoot, "HEAD");
  const frozen = { "tests/AC1.test.ts": sha256(frozenFile) };
  // The frozen record must reach the step the way the machine puts it there: a
  // decided `specify:ok` step carrying the map.
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: "ok", frozen, tests: { AC1: ["tests/AC1.test.ts"] } },
  });
  const { threw } = await run(
    ctx,
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: async (_spec: DispatchSpec) => {
        const wt = path.join(repoRoot, ".worktrees", "lean-7-fix");
        put(wt, "tests/AC1.test.ts", "// rewritten\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: cheated");
        return result({ role: "developer" });
      },
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /frozen acceptance contract/.test(threw.message),
    `(d) a fixer that committed a change to a frozen test is refused (${threw?.message})`,
  );
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`) === head,
    "(d) the refused fix was never pushed: origin still holds the reviewed head",
  );
}

// ── the preconditions, all paid for before any child is ─────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  let dispatched = 0;
  const counting = depsWith({
    adversarial: async () => {
      dispatched++;
      return result({ loopOutcome: "approved" });
    },
    lens: async () => {
      dispatched++;
      return { verdict: "APPROVED", findings: "", usage: USAGE };
    },
  });
  const { threw } = await run(ctxFor(repoRoot, baseSha, "lean/issue-7-never-pushed"), counting);
  assert(
    threw instanceof ReviewInfraError && /no lean\/issue-7-never-pushed/.test(threw.message),
    `(e1) a branch origin does not have is a refusal, never an empty-diff approval (${threw?.message})`,
  );
  assert(dispatched === 0, "(e1) no child was paid for a review that could not run");

  const noBase = ctxFor(repoRoot, "", BRANCH);
  const { threw: t2 } = await run(noBase, counting);
  assert(
    t2 instanceof ReviewInfraError && /no base commit/.test(t2.message),
    `(e2) a run with no base is refused before a gate runs (${t2?.message})`,
  );

  // A budget that cannot pay for a SECOND round is not a licence to certify the
  // branch after one: a lens round that found something at the bound is a
  // handback, because the step has no way to say the findings do not matter.
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const poor = depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async () => ({
      verdict: "ISSUES_FOUND",
      findings: "- [HIGH] SECURITY a.ts:1: leak",
      usage: USAGE,
    }),
    loadConfig: async () => ({
      ...defaultConfig(),
      budgets: { ...defaultConfig().budgets, review: { turns: 150, tokens: 1000, minutes: 5 } },
    }),
  });
  const { threw: t3, outcome: o3 } = await run(ctxFor(repoRoot, baseSha, BRANCH), poor);
  assert(
    t3 instanceof ReviewInfraError && /still open after 1 review round/.test(t3.message),
    `(e3) findings at a budget that pays for one round hand back rather than passing (${t3?.message ?? `got ${String(o3?.kind)}`})`,
  );
  assert(
    (t3 as ReviewInfraError | undefined)?.dispatches.length === 2,
    "(e3) the round the run did pay for is still recorded on the refusal",
  );

  // (f) What a handback owes the operator is the cost of EVERY round, not the
  // one that failed. A total re-derived per round would report a two-round run
  // as a one-round one, and the next run would be bought on that lie. The budget
  // is set to two rounds' worth so the loop is forced to fix AND re-review.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 4;\n" });
  const twoRounds = {
    ...defaultConfig(),
    budgets: { ...defaultConfig().budgets, review: { turns: 600, tokens: 1000, minutes: 5 } },
  };
  const neverClears = depsWith({
    loadConfig: async () => twoRounds,
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async () => ({
      verdict: "ISSUES_FOUND",
      findings: "- [HIGH] SECURITY a.ts:1: leak",
      usage: USAGE,
    }),
  });
  const { threw: t4 } = await run(ctxFor(rr2, bs2, BRANCH), neverClears);
  assert(
    t4 instanceof ReviewInfraError && /still open after 2 review round/.test(t4.message),
    `(f) the loop runs to the round the budget pays for, then throws (${t4?.message})`,
  );
  assert(
    (t4 as ReviewInfraError | undefined)?.dispatches.length === 5,
    `(f) the handback carries every child it paid for — 2 reviewers, 2 lens rounds and the fixer between them (got ${String((t4 as ReviewInfraError | undefined)?.dispatches.length)})`,
  );
  assert(
    (t4 as ReviewInfraError | undefined)?.dispatches.some((r) => r.role === "developer") === true,
    "(f) the FIXER is billed too: a step whose cost report omits the round that did the work cannot be used to price the next run",
  );
  assert(
    (t4 as ReviewInfraError | undefined)?.dispatches.filter(
      (r) => r.role === "adversarial-developer",
    ).length === 2,
    "(f) both adversarial passes appear in the record the operator is handed",
  );

  // (g) A budget that pays for no round at all still gets exactly one look, and
  // a head that was not reviewed is never reported as reviewed.
  const { threw: t5 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      loadConfig: async () => ({
        ...defaultConfig(),
        budgets: { ...defaultConfig().budgets, review: { turns: 0, tokens: 0, minutes: 0 } },
      }),
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => ({
        verdict: "ISSUES_FOUND",
        findings: "- [HIGH] SECURITY a.ts:1: leak",
        usage: USAGE,
      }),
    }),
  );
  assert(
    t5 instanceof ReviewInfraError && /budget of 0 turns/.test(t5.message),
    `(g) a zero review budget still gets one look, then refuses (${t5?.message})`,
  );
}

cleanupRoots();
process.exit(exit);

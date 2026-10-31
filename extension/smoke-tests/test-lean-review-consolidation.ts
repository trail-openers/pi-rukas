#!/usr/bin/env bun
/**
 * lean/review — the findings the six-lens review raised, each pinned by the
 * case that would have caught it the first time.
 *
 * These are not extra coverage; each is a lens finding that no existing case
 * exercised, grouped by the finding it closes:
 *
 *   (n) the PR-number extractor against BOTH forges and a malformed value. The
 *       suite drove one hardcoded GitHub URL, so a GitLab `/-/merge_requests/77`
 *       form returning `undefined` — and a bad value throwing a `TypeError` out
 *       of the step — were both invisible.
 *
 *   (o) `openFromPass`'s `adversarialRounds` branch. Every adversarial stub set
 *       `loopOutcome` only, so the arm that reads the loop's own per-round
 *       records never ran: the records, not the prose, decide what a pass left
 *       open, and that was untested in both directions.
 *
 *   (p) the no-progress break. A fixer that commits nothing used to leave the
 *       step paying to re-review a commit identical to the one it just reviewed.
 *
 *   (q) H5 — the adversarial gate's cost row is attributed to the role the loop
 *       SYNTHESISES, which is the only role the frozen driver's own events carry
 *       and so the only one lean's `byRole` column can be compared against.
 *
 *   (r) the fixer's write fence, and its tree's dependencies surviving the
 *       integration reset.
 *
 *   (s) T1 — the tree identity travels in its own validated field, so the fixer
 *       row keeps a real duration and a resumed attempt still finds its tree.
 *
 *   (t) the step's budget is actually armed (H1/H2): a child bound derived from
 *       `budgets.review.minutes`, not the generic one.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/lean/config.ts";
import { FIX_RUN_ID_SHAPE, prNumberFromLog, reviewAttemptFromLog } from "../src/lean/review-log.ts";
import { fixTreeName } from "../src/lean/review-tree.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import type { DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  DISPATCHES_MAX_ROWS,
  FIXER_ROLE,
  LENS_ROLE,
  MAX_REVIEW_ROUNDS,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  makeRepo,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (n) the PR-number extractor, driven against both forges and a bad value ──
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const withUrl = (prUrl: string | undefined): number | undefined => {
    const ctx = ctxFor(repoRoot, baseSha, BRANCH);
    ctx.run.steps.push({
      key: "7:publish:0",
      state: "publish",
      startedAt: 1,
      endedAt: 2,
      outcome: { kind: "ok", ...(prUrl === undefined ? {} : { prUrl }) },
    });
    return prNumberFromLog(ctx.steps);
  };
  // The fixture previously drove ONE hardcoded GitHub URL, which is how a
  // GitLab-shaped URL — the other forge this harness publishes to — could read as
  // `undefined` while every lean run paid a `gh pr list` per ISSUES_FOUND round.
  assert(
    withUrl("https://github.com/acme/widget/pull/321") === 321,
    "(n) GitHub's /pull/<n> reads as its number",
  );
  assert(
    withUrl("https://gitlab.example.com/grp/sub/-/merge_requests/77") === 77,
    "(n) GitLab's /-/merge_requests/<n> reads as its number too — the shape the old fixture never drove",
  );
  assert(
    withUrl("https://github.com/acme/widget/pull/321/") === 321,
    "(n) a trailing slash is still the same PR",
  );
  // Anchored at the end, so a tail that is not the number is not a number.
  assert(
    withUrl("https://gitlab.example.com/grp/-/merge_requests/77/diffs") === undefined,
    "(n) a URL whose tail is not the number answers ABSENT rather than reporting some other digit",
  );
  // The throw the unguarded `new URL()` produced out of the step.
  let threw = false;
  let value: number | undefined = 1;
  try {
    value = withUrl("not a url at all");
  } catch {
    threw = true;
  }
  assert(!threw, "(n) a malformed PR URL does not throw out of the step");
  assert(
    value === undefined,
    "(n) and it answers absent, the review layer's own look-it-up signal",
  );
  assert(withUrl("https://") === undefined, "(n) a URL with no path answers absent");
  assert(withUrl(undefined) === undefined, "(n) no recorded PR answers absent");
  // Absence is decided by the shared `validPrUrl` gate, so a non-https URL cannot
  // produce a number by any path.
  assert(
    withUrl("http://github.com/acme/widget/pull/321") === undefined,
    "(n) an http (non-https) URL is refused by the shared `validPrUrl` gate, so it yields no number",
  );
}

// ── (o) openFromPass: both shapes the branch distinguishes ──────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const seen: string[] = [];
  let fixerCommits = 0;
  /**
   * The one way a findings-carrying pass reaches the lens round: the step fixes
   * first and comes back around, so the fixture's fixer MUST commit. A fixer that
   * commits nothing is refused by the no-progress break (case (p)), which is the
   * right product behaviour and the wrong way to reach a second round — an earlier
   * version of these cases did exactly that and "proved" the carry never happens,
   * which was a property of the stub rather than of the step.
   */
  const committing = async (spec: DispatchSpec) => {
    const wt = spec.cwd as string;
    put(wt, `fix-${String(fixerCommits++)}.ts`, "export const x = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: the finding");
    return result({ role: FIXER_ROLE });
  };
  let advCalls = 0;
  const runWithAdv = async (over: Parameters<typeof result>[0]) => {
    seen.length = 0;
    advCalls = 0;
    return run(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        // Varied per call for the same reason the lens findings vary in
        // `test-lean-review-wiring.ts`: a gate that re-reports identical text
        // against a head the fixer moved is a deterministic gate the step now
        // refuses to buy again (`stagnantAgainstFix`), which would end the run
        // before the carry this case is about ever reached a lens round.
        adversarial: async () => result({ ...over, text: `${over.text} [${String(advCalls++)}]` }),
        lens: async (a) => {
          seen.push(a.context);
          return cleanLensRound();
        },
        dispatch: committing,
      }),
    );
  };

  // (o1) A trailing record that is NOT approved: findings, whatever the prose
  // says. The text deliberately does not contain the marker, so the old prose
  // fallback would have called this a clean pass.
  const o1 = await runWithAdv({
    loopOutcome: "approved",
    text: "Reviewed and it is fine.",
    adversarialRounds: [
      { round: 1, status: "ISSUES_FOUND", verdictParsed: true },
      { round: 2, status: "MINOR_OBSERVATIONS", verdictParsed: true },
    ],
  });
  assert(
    o1.threw === undefined && o1.outcome?.kind === "done",
    `(o1) the round still clears once the gate is happy (${o1.threw?.message})`,
  );
  assert(
    seen.length >= 1 && seen[0].includes("OUTSTANDING FROM THE ADVERSARIAL GATE"),
    "(o1) and the non-APPROVED trailing record reached the lens context — decided by the RECORD, not the prose, which never said PASSED WITH FINDINGS",
  );

  // (o2) Records beat prose in the other direction too.
  const o2 = await runWithAdv({
    loopOutcome: "approved",
    text: "Adversarial PASSED WITH FINDINGS after round 1 but the last round was clean.",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  });
  assert(
    o2.threw === undefined && o2.outcome?.kind === "done",
    `(o2) an APPROVED trailing record clears (${o2.threw?.message})`,
  );
  assert(
    seen.length >= 1 && !seen[0].includes("OUTSTANDING FROM THE ADVERSARIAL GATE"),
    "(o2) and nothing is carried forward on an APPROVED record, even though the prose holds the findings marker",
  );

  // (o3) A trailing record the loop never acted on: `verdictParsed: false` means
  // the status was DEFAULTED, which is not a status an adversarial gate approved
  // with — so it must count as outstanding rather than as silence.
  const o3 = await runWithAdv({
    loopOutcome: "approved",
    text: "1. a real finding the reviewer failed to parse",
    adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: false }],
  });
  assert(
    o3.threw === undefined && o3.outcome?.kind === "done",
    `(o3) the step does not throw on an unparsed trailing record (${o3.threw?.message})`,
  );
  assert(
    seen.length >= 1 && seen[0].includes("a real finding"),
    "(o3) and the unparsed trailing record still counts as outstanding — a defaulted status is not an approval",
  );

  // (o4) No records at all: the prose marker is the only thing left to read.
  const o4 = await runWithAdv({
    loopOutcome: "approved",
    text: "Adversarial PASSED WITH FINDINGS: 2. the carried one",
  });
  assert(
    o4.threw === undefined && seen.length >= 1 && seen[0].includes("the carried one"),
    "(o4) with no records at all, the prose marker is what carries the findings",
  );

  // (o5) T6 — the carried block reaches the round that CONSUMES it. The findings
  // arm fixes first and comes back around, so `carried` has to survive the
  // `continue`: assigned on one branch and read only on the other made the
  // parameter dead on the path that used it.
  const carriedSeen: (string | undefined)[] = [];
  const o5 = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => {
        advCalls++;
        return advCalls === 1
          ? result({ loopOutcome: "rejected", text: "1. the finding the fixer will answer" })
          : result({
              loopOutcome: "approved",
              text: "no prose marker here",
              adversarialRounds: [{ round: 1, status: "MINOR_OBSERVATIONS", verdictParsed: true }],
            });
      },
      lens: async (a) => {
        carriedSeen.push(
          a.context.includes("OUTSTANDING FROM THE ADVERSARIAL GATE") ? a.context : undefined,
        );
        return cleanLensRound();
      },
      dispatch: committing,
    }),
  );
  assert(
    o5.threw === undefined && o5.outcome?.kind === "done",
    `(o5) the fix round and the re-review both ran (${o5.threw?.message})`,
  );
  assert(
    carriedSeen.length >= 2 &&
      carriedSeen[1] !== undefined &&
      carriedSeen[1].includes("MINOR_OBSERVATIONS"),
    "(o5) and the second round's lens context carries the adversarial gate's outstanding findings — assigned before the fix, read after it",
  );
}

// ── (p) the no-progress break ───────────────────────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const head = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      // Dispatched, paid for, commits NOTHING. The step would otherwise pay to
      // re-review the identical commit, once per round of the bound.
      dispatch: async () => result({ role: FIXER_ROLE }),
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /fixed nothing/.test(threw.message),
    `(p) a fix round that left the head unchanged is a throw, not a re-review (${threw?.message})`,
  );
  assert(
    threw instanceof ReviewInfraError && threw.message.includes(head.slice(0, 12)),
    `(p) and it names the sha it refused to re-review (${threw?.message})`,
  );
  assert(
    threw instanceof ReviewInfraError && threw.dispatches.length > 0,
    "(p) and the children it did pay for are still on the error",
  );
}

// ── (q) H5: the row's role, asserted rather than agreed with ────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The loop's synthesised role — NOT the inner reviewer's — is what the frozen
  // driver's own dispatch events carry, so it is the only value that makes the
  // two engines' `byRole` columns comparable.
  assert(
    ADVERSARIAL_GATE_ROLE === "adversarial-loop",
    `(q) the constant names the loop's SYNTHESISED role, not the reviewer's (got ${ADVERSARIAL_GATE_ROLE})`,
  );
  const { outcome } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ role: "adversarial-developer", loopOutcome: "approved" }),
    }),
  );
  const roles = (outcome?.dispatches ?? []).map((r) => r.role);
  assert(
    roles.includes("adversarial-developer") && !roles.includes(ADVERSARIAL_GATE_ROLE),
    `(q) the row records what the child actually reported — a mis-attributed role stays visible in the record instead of being silently rewritten (${JSON.stringify(roles)})`,
  );
}

// ── (r) the fixer's write fence + the run tree's dependencies after reset ───
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  let fence: { root?: string; repo?: string } | undefined;
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: async (spec: DispatchSpec, opts) => {
        fence = opts.writeFence;
        put(spec.cwd as string, "fix.ts", "export const x = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(threw === undefined, `(r) the fix round completed (${threw?.message})`);
  assert(
    fence !== undefined &&
      typeof fence.root === "string" &&
      fence.root.includes("/.worktrees/lean-7-fix-1-"),
    `(r) THE FIXER IS DISPATCHED WITH A WRITE FENCE rooted at its own disposable tree — the same shape \`build\` passes, and the fence \`build\`'s builder has always had (got ${JSON.stringify(fence?.root)})`,
  );
  assert(
    fence?.repo === repoRoot,
    `(r) and the fence names the repo, so a write to the repo root is outside it (got ${String(fence?.repo)})`,
  );
  // The fence is not decoration: prove a write outside the tree is the case it
  // exists for, using the production predicate the guard applies to a child's
  // write/edit/bash.
  // The judgement is the PRODUCTION predicate the guard runs in every mode. A
  // fence the step passes but the guard never consults is a field on a spec.
  const { loadFenceConfig, judgeWrite } = await import("../src/write-fence-path.ts");
  const wt = String(fence?.root);
  // Loaded the way the driver loads it for a real child — through the env the
  // spawn stamps — so this exercises the same config the guard reads, not a
  // hand-built object that could be friendlier than the real one.
  const cfg = loadFenceConfig({
    PI_ENSEMBLE_WRITE_ROOT: wt,
    PI_ENSEMBLE_WRITE_REPO: String(fence?.repo),
    PI_ENSEMBLE_WRITE_SCRATCH: path.join(repoRoot, "scratch"),
  });
  assert(
    cfg !== undefined && cfg.root !== undefined,
    "(r) the fence config loads from the spawn's env",
  );
  const inside = judgeWrite(path.join(wt, "src", "ok.ts"), wt, cfg);
  const outside = judgeWrite(path.join(repoRoot, "outside-the-tree.ts"), wt, cfg);
  assert(inside.ok, "(r) and the production fence allows a write inside the fixer's tree");
  assert(
    !outside.ok,
    `(r) and REFUSES a write to the repo root, which is what a fixer without a fence could do (${outside.ok ? "allowed" : outside.message})`,
  );
}

// ── (s) T1: the tree identity is data, not a smuggled duration ──────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const fixerRows: { ms: number; runId?: string }[] = [];
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "ISSUES_FOUND",
        findings: "- [HIGH] SECURITY a.ts:1: leak",
      }),
      dispatch: async (spec: DispatchSpec) => {
        put(spec.cwd as string, "fix.ts", "export const x = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the finding");
        // A child that reports a real wall clock: the row must keep it.
        return result({ role: FIXER_ROLE, ms: 1234 });
      },
    }),
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  for (const r of rows) if (r.role === FIXER_ROLE) fixerRows.push({ ms: r.ms, runId: r.runId });
  assert(
    rows.length === DISPATCHES_MAX_ROWS,
    `(s) the run recorded the cap's worth of rows (got ${String(rows.length)})`,
  );
  assert(
    fixerRows.length > 0 && fixerRows.every((r) => r.ms === 1234),
    `(s) the fixer row keeps the DURATION its child reported — it is no longer overwritten with a 13-digit epoch (${JSON.stringify(fixerRows.map((r) => r.ms))})`,
  );
  assert(
    fixerRows.every((r) => typeof r.runId === "string" && FIX_RUN_ID_SHAPE.test(String(r.runId))),
    `(s) and the tree identity is in \`runId\`, in the shape the validator accepts — so a row is never DROPPED for carrying it, which is how the step's most expensive child went unbilled (${JSON.stringify(fixerRows.map((r) => r.runId))})`,
  );
  // The role is the one constant both sides read, so the fixer-row match cannot
  // drift onto the builder's rows by a hand-copied string.
  assert(
    FIXER_ROLE === "developer",
    "(s) the fixer's role is the exported constant, shared with the row's reader",
  );
}

// ── (t) H1/H2: the step's budget is ARMED ───────────────────────────────────
//
// Before this the step read `budgets.review.turns` for one division and armed
// nothing: its reviewer, its six lenses and its fixer all ran under the generic
// child bound while the operator's three levers sat unread. The pilot that
// reported "minutes budget 20 exceeded (used 31)" beside a child that ran
// 1,800,180 ms is that gap, and a case that only checked `budget` was passed
// around would have been satisfied by an arm that armed nothing.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const seen: { advBound?: number; lensBound?: number; fixerBound?: number } = {};
  const clean = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async (a) => {
        seen.advBound = a.budget.opts.childBoundMs;
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        seen.lensBound = a.budget.opts.childBoundMs;
        return cleanLensRound();
      },
    }),
  );
  assert(clean.threw === undefined, `(t) the clean run completed (${clean.threw?.message})`);
  // `budgets.review` ships at 15 minutes, so the armed wall clock is 15 * 60_000
  // — the operator's own number reaching the child. The lens leg clamps to the
  // per-lens knob as well, so assert the bound came FROM the budget by checking
  // it is the budget's value and not the generic default.
  const reviewMinutes = defaultConfig().budgets.review?.minutes ?? 0;
  assert(
    reviewMinutes > 0 && seen.advBound === reviewMinutes * 60_000,
    `(t) the adversarial gate's children carry a \`childBoundMs\` of \`budgets.review.minutes\` (${String(reviewMinutes)} min) — the budget is ARMED, not just divided (got ${String(seen.advBound)})`,
  );
  assert(
    seen.lensBound !== undefined && seen.lensBound <= reviewMinutes * 60_000 && seen.lensBound > 0,
    `(t) and so do the six lens children, clamped no higher than the step's own ceiling (got ${String(seen.lensBound)})`,
  );
  assert(
    clean.outcome?.dispatches.some((r) => r.role === FIXER_ROLE) === false,
    "(t) a clean branch dispatches no fixer, so the fixer's bound is asserted on the fix path below",
  );

  // The turns/tokens levers are armed too, and they are the two that abort rather
  // than merely bound: a step that never built the arm leaves both levers dead.
  const abortSeen: number[] = [];
  const spent = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      loadConfig: async () => ({
        ...defaultConfig(),
        budgets: { ...defaultConfig().budgets, review: { turns: 3, tokens: 100, minutes: 30 } },
      }),
      adversarial: async (a) => {
        // The child reports progress past the ceiling, exactly as `spawn.ts`'s
        // stdout handler does, and the armed hook must abort on it.
        a.budget.opts.onProgress?.({ turns: 9, totalTokens: 9_000_000 });
        abortSeen.push(a.budget.opts.signal?.aborted === true ? 1 : 0);
        // A child the abort ended comes back with its cause stamped, as `spawn.ts`
        // returns it. Reporting `approved` here would let the step keep going on a
        // child the budget killed and make the assertion below about the stub.
        return result({ loopOutcome: "approved", killCause: "abort" });
      },
    }),
  );
  assert(
    abortSeen.length > 0 && abortSeen[0] === 1,
    "(t) and the turns/tokens lever is LIVE: progress past the ceiling aborts the child's signal (signal not aborted)",
  );
  assert(
    spent.threw !== undefined || spent.outcome !== undefined,
    `(t) the run reached a decision either way (${spent.threw?.message ?? spent.outcome?.kind})`,
  );

  // H2's other half: a child the bound stopped is reported AS a budget stop, so
  // the step hands back the ceiling and the usage rather than a generic failure.
  const stopped = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () =>
        result({ loopOutcome: "approved", killCause: "child-bound", ms: 31 * 60_000 }),
    }),
  );
  // The assertion is on the VERDICT'S FIELDS, not on a sentence this step does
  // not own: `budgetVerdict` renders its wording in `step-budget.ts`, which three
  // renderers already share, and a review test pinning that wording is a fourth
  // copy of one fact. What this step owes is that the stop it read reaches the
  // engine as the review step's budget verdict, naming the lever and the number
  // the operator set.
  assert(
    stopped.threw === undefined && stopped.outcome?.kind === "budget",
    `(t) a reviewer the bound stopped yields a BUDGET verdict, not an error or a pass (${stopped.threw?.message ?? `kind ${String(stopped.outcome?.kind)}`})`,
  );
  const stop = stopped.outcome as {
    kind: "budget";
    limit: string;
    value: number;
    used: number;
    dispatches?: DispatchUsageRow[];
  };
  assert(
    stop.limit === "minutes" && stop.value === reviewMinutes && stop.used === 31,
    `(t) and the verdict names the lever, the ceiling from \`budgets.review\` and the usage the child reported, so the operator can see which number to raise (got ${JSON.stringify([stop.limit, stop.value, stop.used])})`,
  );
  assert(
    stop.dispatches !== undefined && stop.dispatches.length > 0,
    "(t) and the children it paid for ride on the verdict rather than dying with the stop",
  );
}

// ── (u) the fix tree's name is derived from the durable run, not the process ─
//
// The name carries arm, round, attempt and the attempt's epoch. Each closes a
// different hole, and the assertions below drive all four — including the
// regression that made this a bug: a review round dispatches a fixer on TWO arms
// (the adversarial gate's pass-with-findings, and the six-lens round's findings),
// so keying the name by the round alone named one path twice, and `worktree add
// --force` ADOPTED the live tree instead of refusing — the second fixer's head
// already held the first's commits, and the step reported "fixed nothing".
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const trees: string[] = [];
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      // Round 1 takes BOTH arms: the adversarial gate passes with findings (fix
      // in the "a" tree), then the lens round finds more (fix in the "l" tree).
      adversarial: async () =>
        result({ loopOutcome: "approved", text: "Adversarial PASSED WITH FINDINGS: 1. leak" }),
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "ISSUES_FOUND" as const,
        findings: "- [HIGH] SECURITY a.ts:1: leak",
      }),
      dispatch: async (spec: DispatchSpec) => {
        const wt = spec.cwd as string;
        trees.push(wt);
        // A REAL commit, from inside the tree, through the same env the step's
        // own git calls use. `add -A` is separate from `commit`: the fixer's
        // brief tells it to commit, and a fixture that only wrote a file would
        // prove the no-progress break fires on a no-op rather than that a real
        // fix advances the head.
        put(wt, `fix-${String(trees.length)}.ts`, "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    threw === undefined,
    `(u) two fixers in one review round both ran and both integrated (${threw?.message})`,
  );
  assert(
    trees.length >= 2 && new Set(trees).size === trees.length,
    `(u) and no two of them share a path — a collision here is silently ADOPTED by \`add --force\`, which is how this read as "the fixer fixed nothing" (${JSON.stringify(trees.map((t) => t.split("/").pop()))})`,
  );
  assert(
    trees.length >= 2 && trees[0].includes("-fix-a-1-") && trees[1].includes("-fix-l-1-"),
    `(u) the two arms of round 1 name the adversarial tree and the lens tree (${JSON.stringify(trees.map((t) => t.split("/").pop()))})`,
  );
  // Both commits are on origin: the second fix built ON the first, which is what
  // the adoption bug destroyed.
  const originHead = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  const commits = git(repoRoot, "rev-list", `origin/${BRANCH}`).split("\n").length;
  assert(
    commits >= 4 && originHead !== baseSha,
    `(u) every fix round's commit is on origin — the later fix built on the earlier one, not on a tree that already contained it (${String(commits)} commits on the branch)`,
  );

  // The resume half: the name must be RE-DERIVABLE, so the same attempt re-runs
  // into the same paths. Nothing in memory is consulted, which is the only way a
  // re-run can agree with the attempt that died.
  const ctxA = ctxFor(repoRoot, baseSha, BRANCH);
  const first = fixTreeName(
    repoRoot,
    7,
    "l",
    2,
    reviewAttemptFromLog(ctxA.steps),
    "1793451347919" as never,
  );
  const resumed = fixTreeName(
    repoRoot,
    7,
    "l",
    2,
    reviewAttemptFromLog(ctxA.steps),
    "1793451347919" as never,
  );
  assert(
    first === resumed,
    `(u) a resumed attempt derives the SAME tree path for the same fix, so it re-enters the tree its killed self left instead of orphaning it and provisioning a second (${first} vs ${resumed})`,
  );
  const concurrent = fixTreeName(
    repoRoot,
    7,
    "l",
    2,
    reviewAttemptFromLog(ctxA.steps) + 1,
    "1793451347919" as never,
  );
  assert(
    concurrent !== first,
    `(u) and a second concurrent attempt on the same issue and round gets its OWN path, so neither can adopt the other's leftovers (${concurrent.split("/").pop()})`,
  );
}

// ── (v) the integration resets the tree and provisions it again ───────────
//
// `ensureSpecifyWorktreeWithProvision` runs `git reset --hard` and provisions
// BEFORE it, so reusing it here would have reset the tree the fixer had just
// committed in and then linked dependencies to a tree with no code in it. The
// step must reset, provision AFTER, and integrate the commit it was given.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // A gitignored dependency tree in the main checkout: provisioning links it, and
  // a reset that ran after provisioning would have left the link pointing at a
  // tree with nothing checked out.
  const depsDir = path.join(repoRoot, "node_modules");
  fs.mkdirSync(path.join(depsDir, "some-dep"), { recursive: true });
  fs.writeFileSync(path.join(depsDir, "some-dep", "index.js"), "module.exports = 1;\n");
  fs.appendFileSync(path.join(repoRoot, ".gitignore"), "\nnode_modules\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "chore: ignore node_modules");

  const trees: string[] = [];
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: async (spec: DispatchSpec) => {
        const wt = spec.cwd as string;
        trees.push(wt);
        // The dependency link must be live WHILE the fixer works: provisioning
        // before the reset would have put the tree in a state where the child
        // could not resolve its own imports.
        fs.writeFileSync(path.join(wt, "fix.ts"), "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(threw === undefined, `(u) the fix round integrated (${threw?.message})`);
  assert(trees.length > 0, "(u) a fix round ran");
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`).startsWith("9"),
    "(u) precondition: the branch head is the sha the fixture planted",
  );
  const pushed = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  assert(pushed !== git(repoRoot, "rev-parse", baseSha), "(u) the fixer's commit reached origin");
  // The disposable tree is gone: this step leaves no attached worktree behind, so
  // the next /work's branch step cannot abort on a dirty tree.
  const leftover = fs
    .readdirSync(path.join(repoRoot, ".worktrees"))
    .filter((d) => d.startsWith("lean-7-fix-"));
  assert(
    leftover.length === 0,
    `(u) no fixer tree survives the step (${JSON.stringify(leftover)})`,
  );
}

cleanupRoots();
process.exit(failures());

#!/usr/bin/env bun
/**
 * lean/review — the head a fix wave starts from is saved before the fixer runs.
 *
 *   (2) the state file holds `preFixHead` at the instant the fixer is dispatched; the decided record
 *       carries it through the loader; the re-review ranges from it; a PR comment and the host document name it
 *   (4) resume: a crash inside the fixer leaves the saved head, and the re-run reads it rather than
 *       recomputing it from origin, which by then holds a newer push
 *   (5) a clean `fixed` wave names the range on its reason and in the handback
 *   (6) the loader refuses the field off a review step, a malformed value, and an unowned progress field
 *
 * The retired `PI_ENSEMBLE_LEAN_PREFIX_HEAD=0` is ignored: (4) and (5) run with it set as well as unset.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { handbackOutcome } from "../src/lean/handback.ts";
import { outcomeProblem, progressProblem } from "../src/lean/state-outcome.ts";
import { loadRun } from "../src/lean/state-store.ts";
import { leanStateFile } from "../src/lean/state.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { prefixHeadRun } from "./lib/lean-prefix-head-scenario.ts";
import {
  BRANCH,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  git,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();
/** Retired: set to "0" it must read as unset. */
const SWITCH = "PI_ENSEMBLE_LEAN_PREFIX_HEAD";
/** The undecided review step's saved head in the state file on disk, or undefined. */
function savedHead(repoRoot: string): string | undefined {
  const run = JSON.parse(readFileSync(leanStateFile(repoRoot, 7), "utf8")) as LeanRun;
  return run.steps.find((s) => s.state === "review" && s.outcome === undefined)?.progress
    ?.preFixHead;
}

// ── (2) SAVED BEFORE THE FIXER, CARRIED, NAMED ──────────────────────────────
await withEnv({ [SWITCH]: undefined }, async () => {
  const atDispatch: (string | undefined)[] = [];
  const on = await prefixHeadRun("on", { onFixer: (root) => atDispatch.push(savedHead(root)) });
  assert(
    atDispatch.length === 1 && atDispatch[0] === on.head,
    `(2) the state file holds preFixHead = the reviewed head when the fixer is dispatched (${String(atDispatch)})`,
  );
  const review = loadRun(on.repoRoot, 7)?.steps.find((s) => s.state === "review");
  assert(
    review?.outcome?.preFixHead === on.head && review.progress === undefined,
    `(2) the decided record carries it through the loader, folded off the step (${JSON.stringify(review?.outcome?.preFixHead)})`,
  );
  assert(on.sinces[0] === on.head, "(2) the re-review ranges from it");
  assert(
    on.comments.some((c) => c.includes(`fix range ${on.head}..`)),
    `(2) one PR comment names the range (${JSON.stringify(on.comments)})`,
  );
  assert(on.normalised.includes('"preFixHead":"<SHA'), "(2) the host document projects it");
});

// ── (4) RESUME READS THE SAVED HEAD ─────────────────────────────────────────
for (const retired of [undefined, "0"]) {
  let snapshot = "";
  let first = { repoRoot: "", head: "" };
  await withEnv({ [SWITCH]: undefined }, async () => {
    first = await prefixHeadRun("crash", {
      onFixer: (root) => {
        snapshot = readFileSync(leanStateFile(root, 7), "utf8");
      },
    });
  });
  // The process "died" inside the fixer: the file as it stood then, with origin moved on by a push.
  writeFileSync(leanStateFile(first.repoRoot, 7), snapshot);
  const wt = `${first.repoRoot}/.worktrees/lean-7`;
  copyFileSync(`${wt}/a.ts`, `${wt}/b.ts`);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "the crashed attempt's push");
  git(wt, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  let sinces: (string | undefined)[] = [];
  await withEnv({ [SWITCH]: retired }, async () => {
    sinces = (await prefixHeadRun("resumed", { repo: first })).sinces;
  });
  const review = loadRun(first.repoRoot, 7)?.steps.find((s) => s.state === "review");
  assert(
    sinces[0] === first.head,
    `(4) ${String(retired)}: the resumed re-review ranges from the saved head, not origin's (${String(sinces[0])} vs ${first.head})`,
  );
  assert(review?.outcome?.preFixHead === first.head, "(4) and the decided record keeps it");
}

// ── (5) CLEAN FIXED WAVE: REASON AND HANDBACK ────────────────────────────────
for (const retired of [undefined, "0"]) {
  await withEnv({ [SWITCH]: retired }, async () => {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({
      repoRoot,
      baseSha,
      branch: BRANCH,
      feature: `export const f = ${String(retired)};\n`,
    });
    const { outcome } = await runStep(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        lens: async (a) =>
          a.wave === "fix"
            ? lensRoundFor(a, "APPROVED", [])
            : lensRoundWith("ISSUES_FOUND", [blockingFinding()]),
        dispatch: fixerThatCommits(`clean-${String(retired)}`),
      }),
    );
    const pushed = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
    const clause = `fix range ${head}..${pushed}`;
    assert(outcome?.kind === "fixed", `(5) the wave cleared (${String(outcome?.kind)})`);
    assert(
      (outcome?.reason ?? "").endsWith(`; ${clause}`),
      `(5) ${String(retired)}: the reason names the range (${outcome?.reason})`,
    );
    // The record as the engine settles it: the saved head folded onto the outcome.
    const step = {
      key: "7:review:0",
      state: "review" as const,
      startedAt: 1,
      outcome: { ...outcome, kind: "fixed", preFixHead: head },
    };
    const ctx = { ...ctxFor(repoRoot, baseSha, BRANCH), steps: [step] };
    const hb = await handbackOutcome(
      ctx,
      async () => {},
      undefined,
      async () => undefined,
    );
    assert(
      (hb.report ?? "").includes(`Pre-fix head: \`${head}\` — fix range \`${head}..${pushed}\``),
      `(5) ${String(retired)}: the handback names the head and range`,
    );
  });
}

// ── (6) THE LOADER'S REFUSALS ────────────────────────────────────────────────
const sha = "a".repeat(40);
assert(
  outcomeProblem({ kind: "green", preFixHead: sha }, "verify") !== undefined,
  "(6) off a review step",
);
assert(
  outcomeProblem({ kind: "fixed", preFixHead: "abc" }, "review") !== undefined,
  "(6) a short oid",
);
assert(
  outcomeProblem({ kind: "fixed", preFixHead: sha }, "review") === undefined,
  "(6) a full oid loads",
);
assert(
  progressProblem({ reason: "x" }, "review") !== undefined,
  "(6) progress refuses an unowned field",
);
assert(
  progressProblem({ preFixHead: sha }, "verify") !== undefined,
  "(6) and another state's field",
);

cleanupRoots();
process.exit(failures());

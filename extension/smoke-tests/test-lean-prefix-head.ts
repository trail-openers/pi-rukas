#!/usr/bin/env bun
/**
 * lean/review — the head a fix wave starts from is saved before the fixer runs (PI_ENSEMBLE_LEAN_PREFIX_HEAD).
 *
 *   (1) the switch's truth table, and its docs row
 *   (2) on: the state file holds `preFixHead` at the instant the fixer is dispatched; the decided record
 *       carries it through the loader; the re-review ranges from it; a PR comment and the host document name it
 *   (3) off: the state file, the host document, the comments and the exit code equal a golden digest captured
 *       from the pre-change build (see `lib/lean-prefix-head-scenario.ts`), and nothing is saved mid-step
 *   (4) resume: a crash inside the fixer leaves the saved head, and the re-run reads it rather than
 *       recomputing it from origin, which by then holds a newer push
 *   (5) a clean `fixed` wave names the range on its reason and in the handback; off it does not
 *   (6) the loader refuses the field off a review step, a malformed value, and an unowned progress field
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { handbackOutcome } from "../src/lean/handback.ts";
import { leanPrefixHeadEnabled } from "../src/lean/review-log.ts";
import { outcomeProblem, progressProblem } from "../src/lean/state-outcome.ts";
import { loadRun } from "../src/lean/state-store.ts";
import { leanStateFile } from "../src/lean/state.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { digest, prefixHeadRun } from "./lib/lean-prefix-head-scenario.ts";
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
const SWITCH = "PI_ENSEMBLE_LEAN_PREFIX_HEAD";
/** The off arm's digest, captured by running `prefixHeadRun` against the base commit's source. */
const GOLDEN_OFF = "7720f19fb245e2b29ee70db08f9b28fecd42352c41c5eff58a7c7c2dfb8edb0e";

/** The undecided review step's saved head in the state file on disk, or undefined. */
function savedHead(repoRoot: string): string | undefined {
  const run = JSON.parse(readFileSync(leanStateFile(repoRoot, 7), "utf8")) as LeanRun;
  return run.steps.find((s) => s.state === "review" && s.outcome === undefined)?.progress
    ?.preFixHead;
}

// ── (1) TRUTH TABLE AND DOCS ROW ─────────────────────────────────────────────
for (const [value, want] of [
  [undefined, true],
  ["1", true],
  ["", true],
  ["false", true],
  ["0", false],
] as const) {
  await withEnv({ [SWITCH]: value }, async () => {
    assert(leanPrefixHeadEnabled() === want, `(1) ${JSON.stringify(value)} reads ${String(want)}`);
  });
}
const docs = readFileSync(new URL("../../docs/configuration.md", import.meta.url), "utf8");
assert(
  docs.includes(`| \`${SWITCH}\` | \`1\` |`) &&
    docs.includes("records the head before a review fix wave so the fix range survives a resume"),
  "(1) docs/configuration.md carries the switch's row and purpose",
);

// ── (2) ON: SAVED BEFORE THE FIXER, CARRIED, NAMED ───────────────────────────
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

// ── (3) OFF: THE PRE-CHANGE BYTES ────────────────────────────────────────────
await withEnv({ [SWITCH]: "0" }, async () => {
  const atDispatch: (string | undefined)[] = [];
  const off = await prefixHeadRun("off", { onFixer: (root) => atDispatch.push(savedHead(root)) });
  assert(atDispatch[0] === undefined, "(3) off, nothing is saved before the fixer");
  const same = digest(off.normalised) === GOLDEN_OFF;
  assert(same, "(3) off, state file, host document, comments and exit code equal the golden");
  if (!same) console.error(off.normalised);
});

// ── (4) RESUME READS THE SAVED HEAD; OFF ON RESUME, IT IS NOT CARRIED ─────────
for (const offOnResume of [false, true]) {
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
  await withEnv({ [SWITCH]: offOnResume ? "0" : undefined }, async () => {
    sinces = (await prefixHeadRun("resumed", { repo: first })).sinces;
  });
  const review = loadRun(first.repoRoot, 7)?.steps.find((s) => s.state === "review");
  if (offOnResume) {
    assert(
      review?.outcome !== undefined && review.outcome.preFixHead === undefined,
      "(4) resumed with the switch off, the decided record carries no saved head",
    );
    continue;
  }
  assert(
    sinces[0] === first.head,
    `(4) the resumed re-review ranges from the saved head, not origin's (${String(sinces[0])} vs ${first.head})`,
  );
  assert(review?.outcome?.preFixHead === first.head, "(4) and the decided record keeps it");
}

// ── (5) CLEAN FIXED WAVE: REASON AND HANDBACK ────────────────────────────────
for (const off of [false, true]) {
  await withEnv({ [SWITCH]: off ? "0" : undefined }, async () => {
    const { repoRoot, baseSha } = makeRepo();
    const head = await setup({
      repoRoot,
      baseSha,
      branch: BRANCH,
      feature: `export const f = ${String(off)};\n`,
    });
    const { outcome } = await runStep(
      ctxFor(repoRoot, baseSha, BRANCH),
      depsWith({
        lens: async (a) =>
          a.wave === "fix"
            ? lensRoundFor(a, "APPROVED", [])
            : lensRoundWith("ISSUES_FOUND", [blockingFinding()]),
        dispatch: fixerThatCommits(`clean-${String(off)}`),
      }),
    );
    const pushed = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
    const clause = `fix range ${head}..${pushed}`;
    assert(outcome?.kind === "fixed", `(5) the wave cleared (${String(outcome?.kind)})`);
    assert(
      (outcome?.reason ?? "").endsWith(`; ${clause}`) !== off,
      `(5) the reason names the range only on the switch (off=${String(off)}: ${outcome?.reason})`,
    );
    // The record as the engine settles it: the saved head folded onto the outcome.
    const step = {
      key: "7:review:0",
      state: "review" as const,
      startedAt: 1,
      outcome: { ...outcome, kind: "fixed", ...(off ? {} : { preFixHead: head }) },
    };
    const ctx = { ...ctxFor(repoRoot, baseSha, BRANCH), steps: [step] };
    const hb = await handbackOutcome(
      ctx,
      async () => {},
      undefined,
      async () => undefined,
    );
    assert(
      (hb.report ?? "").includes(`Pre-fix head: \`${head}\` — fix range \`${head}..${pushed}\``) !==
        off,
      `(5) the handback names the head and range only on the switch (off=${String(off)})`,
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

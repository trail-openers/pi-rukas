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
/**
 * The other default-on lean switch that reads this scenario's bytes, pinned off for every
 * golden comparison. The golden was captured from a build that had no such knob, and #2667's
 * route legitimately adds a `handback` record to a run whose `review` threw over a certified
 * head, which is exactly this scenario. So the golden pins the PREFIX-HEAD switch's off arm,
 * and the neighbouring knob has to hold still for it: case (3) compares against it at `0`,
 * and case (7) pins what the neighbour's own arm adds. Off, this scenario's digest equals the
 * golden on this tree and on the base commit alike.
 */
const INCOMPLETE_HEAD = "PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD";

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
await withEnv({ [SWITCH]: "0", [INCOMPLETE_HEAD]: "0" }, async () => {
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

// ── (7) THE NEIGHBOURING KNOB CANNOT MOVE THE GOLDEN UNSEEN ──────────────────
// Case (3) pins bytes only while the other default-on switch is held still. Held still is not
// assumed: the same scenario at the neighbour's DEFAULT must differ from the golden, and differ
// from the pinned run only by the routed report. Anything else in the delta means the off-arm
// pin above is hiding a change.
{
  const at = async (head: "0" | undefined): Promise<string> => {
    let normalised = "";
    await withEnv({ [SWITCH]: "0", [INCOMPLETE_HEAD]: head }, async () => {
      normalised = (await prefixHeadRun("neighbour")).normalised;
    });
    return normalised;
  };
  const offRun = await at("0");
  const onRun = await at(undefined);
  assert(
    digest(offRun) === GOLDEN_OFF && digest(onRun) !== GOLDEN_OFF,
    "(7) the scenario at the neighbour's default differs from the golden the off arm equals",
  );
  const diff = (from: string, notIn: Set<string>): string[] =>
    from.split("\n").filter((l) => !notIn.has(l));
  const added = diff(onRun, new Set(offRun.split("\n")));
  const dropped = diff(offRun, new Set(onRun.split("\n")));
  // The routing writes the report's record (its key, state, verdict, reason, delivery claim,
  // body and head fields), re-stamps the run's reason, and re-renders the host document around
  // them. It also reads origin to say where the branch stands, the read the plain stamp never
  // made, so the fixer's push can gain its own normalised token. Anything the report did not
  // write, and did not read, must survive byte for byte.
  const reportLine = (l: string): boolean =>
    /"(key|state|kind|reason|posted|report|shippedHead|shippedVerified|unshippedReason)":/.test(
      l,
    ) ||
    l.includes("handback") ||
    l.includes("is handed back") ||
    l.includes("no verified head was recorded") ||
    l.includes("the review did not complete") ||
    l.includes("Fix range");
  assert(
    added.length > 0 &&
      added.filter((l) => !reportLine(l)).length === 0 &&
      added.some((l) => l.includes('"key": "7:handback:0"')) && // the routed record itself
      added.some((l) => l.includes('"unshippedReason"')) && // why origin was not moved
      added.some((l) => l.includes('"shippedHead"')) &&
      added.some((l) => l.includes('"shippedVerified": false')),
    `(7) at the neighbour's default the report did not add exactly its own record: ${JSON.stringify(
      added.map((l) => l.trim().slice(0, 90)),
    )}`,
  );
  assert(
    dropped.every(reportLine),
    `(7) at the neighbour's default, lines the report never wrote disappeared: ${JSON.stringify(
      dropped.filter((l) => !reportLine(l)).map((l) => l.trim().slice(0, 90)),
    )}`,
  );
}

cleanupRoots();
process.exit(failures());

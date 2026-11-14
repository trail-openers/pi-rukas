#!/usr/bin/env bun
/**
 * lean/review — the WRITER behind `gates.review`.
 *
 * `test-headless-work-lean-gates-engine.ts` drives the engine with a SCRIPTED `review`
 * outcome, so the record its cases assert on is the one the fixture queued, not the one
 * `noteRound`/`noteWave` built: comparing the projection against that queue proves the
 * projection prints what it is handed and says nothing about the step's tally. The
 * per-round counts and the wave's full head exist nowhere else — the reason line prints
 * a 12-char prefix and a disclosed-row count — so a writer nobody ran is a field a host
 * codes against with nothing behind it.
 *
 * So this file drives the REAL handler over real temp repos (the house rig of
 * `lib/lean-review-fixtures.ts`) and asserts on the outcome the step itself returned:
 *
 *   (w1) one tally per judged round, keyed by the four published severities, with the
 *       ADVISORY tier counted beside `reported` — the tier `review-step.ts` reads for the
 *       same reason, so a fold that read only `reported` would understate a round.
 *   (w2) the writer's caps are EXACTLY the loader's, so a record the step writes is always
 *       one `loadRun` accepts — past `ROUNDS_MAX` or `WAVES_MAX` the loader refuses the
 *       whole step's verdict over a tally, and the two bounds live in two files.
 *   (w3) the wave head is the FULL oid the fixer left — the same commit the reason line
 *       prints a 12-char prefix of, which is what catches a wave recorded before the head
 *       moved.
 *
 * Each case also runs its record back through `reviewRecordProblem` — the loader's own
 * rule — because the writer's caps and the validator's caps are two constants in two
 * files, and the only proof they agree is a case that asks both.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import {
  ROUNDS_MAX,
  WAVES_MAX,
  reviewRecordProblem,
} from "../src/lean/state-outcome-gates.ts";
import { isFullCommitSha } from "../src/commit-sha.ts";
import { GATE_SEVERITIES } from "../src/lean/gate-severities.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
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
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/** Run the real step for one scripted pair of rounds and hand back its outcome. */
async function drive(
  tag: string,
  lens: Parameters<typeof depsWith>[0]["lens"],
): Promise<Awaited<ReturnType<typeof run>>["outcome"]> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: `export const f = 1;\n` });
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens,
      dispatch: fixerThatCommits(tag),
    }),
  );
  if (threw !== undefined) throw new Error(`the ${tag} step threw: ${threw.message}`);
  return outcome;
}

// ── (w1) the tally is the step's own, and it counts the tier the step reads ─────
// The re-review reports one HIGH in `reported` and one LOW that `splitAdvisory` moved
// OUT of `reported`. A fold over `reported` alone prints `LOW: 0` for a round that
// judged a LOW row, and the host reading `gates.review.rounds` is told the run saw none.
{
  const outcome = await drive("w1", async (a) =>
    a.wave === "fix"
      ? lensRoundFor(a, "ISSUES_FOUND", [blockingFinding({ severity: "HIGH" })], [
          blockingFinding({ severity: "LOW", title: "out-of-range note" }),
        ])
      : lensRoundWith("CRITICAL_ISSUES_FOUND", [
          blockingFinding({ severity: "CRITICAL" }),
          blockingFinding({ severity: "HIGH" }),
        ]),
  );
  const record = outcome?.review;
  assert(
    outcome?.kind === "fixed" && Array.isArray(record?.rounds) && record.rounds.length === 2,
    `(w1) the step records one tally per round it judged, both tiers folded in (${JSON.stringify(record?.rounds)})`,
  );
  const [first, second] = record?.rounds ?? [];
  assert(
    JSON.stringify(Object.keys(first ?? {})) === JSON.stringify(GATE_SEVERITIES) &&
      JSON.stringify(Object.keys(second ?? {})) === JSON.stringify(GATE_SEVERITIES),
    `(w1) each tally is keyed by exactly the published four, in their order (${JSON.stringify(Object.keys(first ?? {}))})`,
  );
  assert(
    first?.CRITICAL === 1 && first?.HIGH === 1 && first?.MEDIUM === 0 && first?.LOW === 0,
    `(w1) pass 1's rows are counted at their own severities (${JSON.stringify(first)})`,
  );
  assert(
    second?.HIGH === 1 && second?.LOW === 1,
    `(w1) the re-review's ADVISORY row is counted, not only its \`reported\` rows — the tier review-step.ts reads for its own verdict (${JSON.stringify(second)})`,
  );
  assert(
    reviewRecordProblem(record) === undefined,
    `(w1) and the writer's own record passes the loader's rule (${String(reviewRecordProblem(record))})`,
  );
}

// ── (w2) the writer clips at the caps the loader refuses past ───────────────────
// The step judges at most three rounds (pass 1, the re-review, and one re-bought
// incomplete re-review) and runs at most one wave, so neither cap is reachable through
// the handler — which is exactly why the cap is asserted here rather than left to the
// loader: the writer's bound and the validator's bound are two constants in two files,
// and a step whose accumulation ran past `ROUNDS_MAX` would hand `loadRun` a record it
// refuses, losing the whole step's verdict over a tally.
{
  const rounds = Array.from({ length: ROUNDS_MAX + 2 }, () => ({
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  }));
  assert(
    reviewRecordProblem({ rounds, waves: [] }) !== undefined &&
      reviewRecordProblem({ rounds: rounds.slice(0, ROUNDS_MAX), waves: [] }) === undefined,
    `(w2) the writer's ${String(ROUNDS_MAX)}-round cap is exactly the LOADER's — one past it is a record the step could write and the load would refuse`,
  );
  const wave = { wave: "fix" as const, head: "b".repeat(40) };
  assert(
    reviewRecordProblem({
      rounds: [],
      waves: Array.from({ length: WAVES_MAX + 1 }, () => ({ ...wave })),
    }) !== undefined &&
      reviewRecordProblem({
        rounds: [],
        waves: Array.from({ length: WAVES_MAX }, () => ({ ...wave })),
      }) === undefined,
    `(w2) and the same at the writer's ${String(WAVES_MAX)}-wave cap`,
  );
}

// ── (w3) the wave names the full head the fixer left ─────────────────────────────
// The reason line prints a 12-char prefix; a host that has to check out what the fixer
// pushed cannot clone a prefix, which is the whole reason the field exists.
{
  const outcome = await drive("w3", async (a) =>
    a.wave === "fix"
      ? lensRoundFor(a, "APPROVED", [])
      : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
  );
  const wave = outcome?.review?.waves?.[0];
  assert(
    wave !== undefined && wave.wave === "fix" && isFullCommitSha(wave.head),
    `(w3) the fix wave records its FULL 40-hex head (${JSON.stringify(wave)})`,
  );
  // The wave the step named, and the head it actually integrated: the reason line prints
  // the same commit's 12-char prefix, so the two surfaces are one fact, and a record that
  // named the PRE-fix head (a `noteWave` moved above `assertFixAdvanced`) is the failure
  // this field exists to prevent.
  assert(
    (outcome?.reason ?? "").includes(wave?.head?.slice(0, 12) ?? "\u0000"),
    `(w3) and the reason line prints the 12-char prefix OF THE RECORDED HEAD — the record and the prose name one commit (${outcome?.reason?.slice(-80)})`,
  );
}

cleanupRoots();
console.log(`\nexit ${String(failures())}`);
process.exit(failures());

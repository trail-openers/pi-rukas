#!/usr/bin/env bun
/**
 * #2261 (lean path) — the lean handback names WHY the review could not run.
 *
 * The gap the issue's lean section names: lean shares the base+head diff read with
 * the review layer, and its own precondition read of the SAME range
 * (`lean/review-git.ts`, through `GIT_MAX_BUFFER`) runs at 16 MiB. A diff between
 * the layer's old 1 MiB cap and that ceiling therefore passed lean's check that the
 * branch could be reviewed and then died inside the layer — and on the lean surface
 * the cause was LOST. A blocked fan-out carries no `usage`, so `assertRan`'s
 * no-usage arm quoted only the verdict word: the operator read "the six-lens review
 * reported REVIEW_INCOMPLETE with no usage from any lens child" and nothing naming
 * the size limit, nor the provider context-length refusal, nor anything else the
 * lane actually said. The per-lens reasons exist at that moment — they are on the
 * rows the summary carries — but `LensRound` had no field for them.
 *
 * Three properties, all at the step seam (`reviewOutcome` through `depsWith`):
 *
 *   (1) a round whose lanes were all blocked hands back a cause naming the SIZE
 *       limit — the constant and its value — not just the verdict word;
 *   (2) a provider context-length refusal reaches the same handback, named, so the
 *       operator sees "the provider refused the prompt" rather than a bare exit;
 *   (3) a CLEAN round still clears with no cause clause bolted on, so the new arm
 *       is not a blanket warning;
 *   (4) when no lane said anything (`attempts: 0` rows with no `parseError`), the
 *       refusal still reads as a complete sentence — the cause clause is appended,
 *       never substituted for the existing wording.
 *
 * The rows are built by the PRODUCTION blocked-row builder
 * (`blockedRowsForRoster`, the shape a diff the layer cannot read produces) rather
 * than by a hand-written literal, so the string the step quotes is one the layer
 * itself minted. Real temp repo, stubbed models, no child spawned, no token spent.
 */

import { blockedRowsForRoster } from "../src/lens-review-diff-blocked.ts";
import { REVIEW_DIFF_READ_MAX_BYTES } from "../src/review-diff.ts";
import { CONTEXT_LENGTH_HINT } from "../src/lens-provider-cause.ts";
import type { LensRound } from "../src/lean/review-args.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import {
  BRANCH,
  ReviewInfraError,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  makeRepo,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** The bundled roster's names — the lanes a real round would have run. */
const ROSTER = [
  "SECURITY",
  "PERFORMANCE",
  "SIMPLICITY",
  "ARCHITECTURE",
  "ERROR_HANDLING",
  "TYPE_SAFETY",
].map((name) => ({ name, skill: `code-review-${name.toLowerCase()}` }));

/**
 * The round the layer hands the step when the diff could not be read: one blocked
 * row per lens, no usage, the named problem as each row's `parseError`.
 *
 * `verdict` is REVIEW_INCOMPLETE because that is what `computeVerdict` scores these
 * rows to; the step refuses the round BEFORE its verdict is read.
 */
function blockedRound(problem: string, verdict = "REVIEW_INCOMPLETE"): LensRound {
  const lenses = blockedRowsForRoster(ROSTER, problem) as LensRunResult[];
  return {
    ...cleanLensRound(),
    verdict: verdict as LensRound["verdict"],
    findings: "",
    reported: [],
    advisory: [],
    lenses,
    // A blocked fan-out bills nothing — this absence is what routes the round to
    // `assertRan`'s no-usage arm, the one that used to quote only the verdict.
    usage: undefined,
  };
}

/** The size reason the layer mints today for an over-ceiling base+head read. */
const SIZE_PROBLEM =
  `lens review: cannot compute diff for origin/main...deadbeef: ` +
  `git diff origin/main...deadbeef exceeded the limit ` +
  `REVIEW_DIFF_READ_MAX_BYTES (${String(REVIEW_DIFF_READ_MAX_BYTES)} bytes) — ` +
  `git produced 12345678 bytes`;

/** What the layer says when the provider refused a lens's prompt (#2261's delta arm). */
const PROVIDER_PROBLEM = `${CONTEXT_LENGTH_HINT}: the provider refused this lens's prompt and it was NOT retried — the change is too large for the lens prompt to inline whole (PI_ENSEMBLE_LENS_LARGE_DIFF=0 restores the old unbounded prompt): maximum context length`;

// ── (1) the size cause reaches the lean handback ────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => blockedRound(SIZE_PROBLEM) }),
  );
  assert(
    threw instanceof ReviewInfraError,
    `(1) an all-blocked round is still refused rather than passed (${threw?.message?.slice(0, 80) ?? "no throw"})`,
  );
  assert(
    threw !== undefined && threw.message.includes("REVIEW_DIFF_READ_MAX_BYTES"),
    `(1) and the handback names the size limit the read hit, not just the verdict word (${threw?.message?.slice(0, 220)})`,
  );
  assert(
    threw !== undefined && threw.message.includes(String(REVIEW_DIFF_READ_MAX_BYTES)),
    `(1) and it states the limit's value, so the operator can find the knob (${threw?.message?.slice(0, 220)})`,
  );
  assert(
    threw !== undefined && threw.message.includes("SECURITY"),
    `(1) and it names which lanes were blocked (${threw?.message?.slice(0, 220)})`,
  );
}

// ── (2) the provider context-length refusal reaches the lean handback ───────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => blockedRound(PROVIDER_PROBLEM) }),
  );
  assert(
    threw instanceof ReviewInfraError,
    `(2) the provider-refused round is refused too (${threw?.message?.slice(0, 80) ?? "no throw"})`,
  );
  assert(
    threw !== undefined && threw.message.includes(CONTEXT_LENGTH_HINT),
    `(2) and the handback says the provider refused the prompt, which reads as infrastructure today (${threw?.message?.slice(0, 220)})`,
  );
}

// ── (3) a clean round is not given a cause clause ───────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const { threw, outcome } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({}),
  );
  assert(
    threw === undefined && outcome?.kind === "done",
    `(3) a round that ran its six lenses still clears (${threw?.message ?? String(outcome?.kind)})`,
  );
  assert(
    !(outcome?.reason ?? "").includes("lane"),
    `(3) and nothing about blocked lanes appears in a clean pass's reason (${outcome?.reason})`,
  );
}

// ── (4) a round whose lanes reported nothing is still a readable refusal ────
// The layer's own silent-lens shape: blocked rows that carry no reason at all.
// The cause clause must not be the only thing the refusal says, because here there
// is no reason to quote.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const silent = blockedRound("");
  const lenses = silent.lenses.map((r) => ({ ...r, parseError: undefined }));
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => ({ ...silent, lenses }) }),
  );
  assert(
    threw instanceof ReviewInfraError &&
      /no usage from any lens child/.test(threw.message),
    `(4) a round whose lanes said nothing is still refused with its own wording (${threw?.message?.slice(0, 160) ?? "no throw"})`,
  );
}

cleanupRoots();
process.exit(failures());
